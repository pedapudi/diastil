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

async def run_skill_once(skill: str, prompt: str, config: dict[str, Any]) -> str:
    """One skill agent, one fresh session, one prompt, final text out.
    Raises RuntimeError when adk is unavailable; model errors propagate."""
    if not ADK_AVAILABLE:
        raise RuntimeError(f"adk not installed: {ADK_IMPORT_ERROR}")

    from google.genai import types as genai_types

    agent = make_skill_agent(skill, config)
    session_service = make_session_service()
    runner = Runner(agent=agent, app_name="dia", session_service=session_service)
    session = await session_service.create_session(app_name="dia", user_id="local")

    content = genai_types.Content(role="user", parts=[genai_types.Part(text=prompt)])
    chunks: list[str] = []
    async for event in runner.run_async(
        user_id="local", session_id=session.id, new_message=content
    ):
        if getattr(event, "partial", False):
            continue  # collect only final content
        for part in (event.content.parts if event.content else []) or []:
            text = getattr(part, "text", None)
            if text:
                chunks.append(text)
    return strip_fences("".join(chunks).strip())


def strip_fences(text: str) -> str:
    """Skill prompts demand raw HTML, but smaller models fence anyway."""
    if text.startswith("```"):
        first_newline = text.find("\n")
        if first_newline != -1 and text.rstrip().endswith("```"):
            return text[first_newline + 1 :].rstrip().removesuffix("```").rstrip()
    return text
