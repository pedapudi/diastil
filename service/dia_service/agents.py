"""Agent construction for the dia service.

Skills are named agents with versioned instruction files in skills/.
The model registry is configuration, not code: build_llm() maps any
OpenAI-compatible endpoint through LiteLLM, selectable per skill.

google-adk imports are wrapped so the service degrades gracefully when
the dependency is missing: /health reports it, /chat explains it, and
nothing crashes at import time.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

SKILLS_DIR = Path(__file__).parent / "skills"

try:  # graceful degradation: the editor works fully without inference
    from google.adk.agents import LlmAgent
    from google.adk.models.lite_llm import LiteLlm
    from google.adk.runners import Runner
    from google.adk.sessions import InMemorySessionService

    ADK_AVAILABLE = True
    ADK_IMPORT_ERROR: str | None = None
except Exception as _exc:  # pragma: no cover - environment-dependent
    LlmAgent = LiteLlm = Runner = InMemorySessionService = None  # type: ignore[assignment]
    ADK_AVAILABLE = False
    ADK_IMPORT_ERROR = str(_exc)


# ---------------------------------------------------------------------------
# skills (managed prompt files)
# ---------------------------------------------------------------------------

def load_skill(name: str) -> str:
    """Read a skill instruction file (skills/<name>.md). Raises if absent —
    a missing managed prompt is a packaging bug, not a runtime condition."""
    path = SKILLS_DIR / f"{name}.md"
    return path.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# endpoint config
# ---------------------------------------------------------------------------

def load_config() -> dict[str, Any]:
    """config.toml from the working directory, then the service directory.
    Missing config is fine: defaults point at a local endpoint."""
    import tomllib

    for candidate in (
        Path.cwd() / "config.toml",
        Path(__file__).parent.parent / "config.toml",
    ):
        if candidate.is_file():
            with candidate.open("rb") as f:
                return tomllib.load(f)
    return {}


_DEFAULT_ENDPOINT: dict[str, str] = {
    "base_url": "http://localhost:11434/v1",
    "model": "openai/qwen2.5-coder:14b",
    "api_key_env": "DIA_API_KEY",
}


def endpoint_for(config: dict[str, Any], skill: str | None = None) -> dict[str, str]:
    """Resolve the endpoint for a skill: [endpoint] overlaid with the
    optional [skills.<name>] table. Unset fields inherit the base."""
    ep = dict(_DEFAULT_ENDPOINT)
    ep.update({k: v for k, v in config.get("endpoint", {}).items() if isinstance(v, str)})
    if skill:
        override = config.get("skills", {}).get(skill, {})
        ep.update({k: v for k, v in override.items() if isinstance(v, str)})
    return ep


def build_llm(config: dict[str, Any], skill: str | None = None):
    """LiteLLM model wrapper for the configured endpoint — ANY
    OpenAI-compatible URL works (hosted, OpenRouter, vLLM, Ollama, ...).
    The API key is read from the environment variable named in config;
    it is never stored in config itself."""
    ep = endpoint_for(config, skill)
    api_key = os.environ.get(ep["api_key_env"], "") or "sk-local"
    return LiteLlm(model=ep["model"], api_base=ep["base_url"], api_key=api_key)


# ---------------------------------------------------------------------------
# tools
# ---------------------------------------------------------------------------

def propose_ops(ops: list[dict]) -> dict:
    """Propose typed edit operations to the editor.

    Each item is a ProposedOp: {action, target, value?, extra?, label}.
    The editor renders the proposal as an op-diff card; nothing is applied
    until the user accepts. The service intercepts this call and forwards
    the ops to the editor as an SSE frame.
    """
    return {"status": "proposed", "count": len(ops)}


# ---------------------------------------------------------------------------
# agents
# ---------------------------------------------------------------------------

def make_copilot_agent(session_service: Any, config: dict[str, Any]):
    """The one genuinely agentic skill: conversational, selection-aware,
    proposes ops via the propose_ops tool — never edits directly."""
    agent = LlmAgent(
        name="copilot",
        model=build_llm(config, "copilot"),
        instruction=load_skill("copilot"),
        tools=[propose_ops],
    )
    return Runner(agent=agent, app_name="dia", session_service=session_service)


def make_skill_agent(name: str, config: dict[str, Any]):
    """Single-shot skill agent (translate-slide, repair-fidelity,
    lift-diagram, discover-island-params): one instruction file, no tools."""
    return LlmAgent(
        name=name.replace("-", "_"),
        model=build_llm(config, name),
        instruction=load_skill(name),
    )


def make_session_service():
    """One in-memory session store for the whole service; one ADK session
    per deck sessionId keeps copilot context consistent across turns."""
    return InMemorySessionService()


# ---------------------------------------------------------------------------
# single-shot skill execution (shared by the HTTP surface and the evals)
# ---------------------------------------------------------------------------

def decode_data_uri(uri: str) -> tuple[str, bytes] | None:
    """data:<mime>;base64,<payload> -> (mime, bytes); None for anything else.
    Undecodable images are dropped, never fatal — the skill still runs on text."""
    import base64

    if not uri.startswith("data:"):
        return None
    head, sep, payload = uri.partition(",")
    if not sep or ";base64" not in head:
        return None
    mime = head[5:].split(";", 1)[0] or "application/octet-stream"
    try:
        return mime, base64.b64decode(payload, validate=True)
    except Exception:
        return None


async def run_skill_once(
    skill: str, prompt: str, config: dict[str, Any], images: list[str] | None = None
) -> tuple[str, str]:
    """One skill agent, one fresh session, one prompt → (output, thinking).
    Reasoning parts (part.thought) are COLLECTED, not dropped — the editor
    shows the full transcript of every skill run. images are base64 data
    URIs attached as inline parts — a vision-capable endpoint sees them.
    Raises RuntimeError when adk is unavailable; model errors propagate."""
    if not ADK_AVAILABLE:
        raise RuntimeError(f"adk not installed: {ADK_IMPORT_ERROR}")

    from google.genai import types as genai_types

    agent = make_skill_agent(skill, config)
    session_service = make_session_service()
    runner = Runner(agent=agent, app_name="dia", session_service=session_service)
    session = await session_service.create_session(app_name="dia", user_id="local")

    parts = [genai_types.Part(text=prompt)]
    for uri in images or []:
        decoded = decode_data_uri(uri)
        if decoded is not None:
            mime, data = decoded
            parts.append(
                genai_types.Part(inline_data=genai_types.Blob(mime_type=mime, data=data))
            )
    content = genai_types.Content(role="user", parts=parts)
    chunks: list[str] = []
    thoughts: list[str] = []
    async for event in runner.run_async(
        user_id="local", session_id=session.id, new_message=content
    ):
        if getattr(event, "partial", False):
            continue  # collect only final content
        for part in (event.content.parts if event.content else []) or []:
            text = getattr(part, "text", None)
            if not text:
                continue
            if getattr(part, "thought", False):
                thoughts.append(text)
            else:
                chunks.append(text)
    return strip_fences("".join(chunks).strip()), "".join(thoughts).strip()


def strip_fences(text: str) -> str:
    """Skill prompts demand raw HTML, but smaller models fence anyway."""
    if text.startswith("```"):
        first_newline = text.find("\n")
        if first_newline != -1 and text.rstrip().endswith("```"):
            return text[first_newline + 1 :].rstrip().removesuffix("```").rstrip()
    return text


def extract_root_html(text: str, root: str) -> str | None:
    """The html-skill contract is ONE raw <root> element. Models wrap it in
    fences, preface it with prose, or trail commentary — recover the element
    from the noise, or return None so the caller can ask for a correction.
    Never invents markup: the slice runs from the first real opening tag to
    the LAST closing tag, keeping everything the model put inside."""
    t = strip_fences(text.strip())
    low = t.lower()
    open_prefix = f"<{root}"
    start = low.find(open_prefix)
    # the opening tag must be a real tag, not a prefix (<svg vs <svg-sprite)
    while start != -1:
        nxt = low[start + len(open_prefix) : start + len(open_prefix) + 1]
        if nxt in ("", " ", ">", "\n", "\t", "/"):
            break
        start = low.find(open_prefix, start + 1)
    if start == -1:
        return None
    close = f"</{root}>"
    end = low.rfind(close)
    if end == -1 or end < start:
        return None
    return t[start : end + len(close)]


def coerce_ops(raw: object) -> tuple[list[dict], int]:
    """Normalize a model's propose_ops payload into a clean list of op dicts.
    Models emit the list as JSON strings, singleton dicts, {'ops': [...]}
    wrappers, numeric values, and missing labels — recover everything
    recoverable and count what was dropped, so the editor can report the
    loss honestly and ask for a correction."""
    import json as _json

    dropped = 0
    if isinstance(raw, str):
        try:
            raw = _json.loads(raw)
        except Exception:
            return [], 1
    if isinstance(raw, dict) and isinstance(raw.get("ops"), (list, str)):
        return coerce_ops(raw["ops"])
    if isinstance(raw, dict):
        raw = [raw]
    if not isinstance(raw, list):
        return [], 1
    ops: list[dict] = []
    for item in raw:
        if isinstance(item, str):
            try:
                item = _json.loads(item)
            except Exception:
                dropped += 1
                continue
        if not isinstance(item, dict):
            dropped += 1
            continue
        action = item.get("action")
        target = item.get("target")
        if not isinstance(action, str) or not action:
            dropped += 1
            continue
        if not isinstance(target, str):
            target = str(target) if isinstance(target, (int, float)) else None
        if target is None:
            dropped += 1
            continue
        label = item.get("label")
        if not isinstance(label, str) or not label:
            label = f"{action} {target}".strip()
        op: dict = {"action": action, "target": target, "label": label}
        value = item.get("value")
        if value is not None:
            op["value"] = value if isinstance(value, str) else str(value)
        extra = item.get("extra")
        if isinstance(extra, dict):
            op["extra"] = {
                str(k): v for k, v in extra.items() if isinstance(v, (str, int, float))
            }
        ops.append(op)
    return ops, dropped
