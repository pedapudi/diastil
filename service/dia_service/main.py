"""dia service HTTP surface.

FastAPI on 127.0.0.1:8317, spoken to only by the local diastil editor.
Endpoints:
  GET  /health                  -> {ok, model} (ok:false when adk missing)
  POST /chat                    -> SSE stream of ChatEvent frames
  POST /skills/translate-slide  -> {slideHtml} (single-shot skill run)
  POST /skills/repair-fidelity  -> {slideHtml} (one fidelity-loop round)
  POST /skills/lift-diagram     -> {sceneHtml} (raw SVG -> scene vocabulary)

No telemetry. The only outbound traffic is to the endpoint the user
configured in config.toml. The editor is fully functional when this
process is not running.
"""

from __future__ import annotations

import json
import tomllib
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from . import agents

HOST = "127.0.0.1"
PORT = 8317
USER_ID = "local"
APP_NAME = "dia"

INSTALL_HINT = (
    "adk not installed — create a venv and run "
    "`.venv/bin/pip install -e service/` (see service/README.md)"
)


# ---------------------------------------------------------------------------
# config
# ---------------------------------------------------------------------------

def load_config() -> dict[str, Any]:
    """config.toml from the working directory, then the service directory.
    Missing config is fine: defaults point at a local endpoint."""
    for candidate in (
        Path.cwd() / "config.toml",
        Path(__file__).parent.parent / "config.toml",
    ):
        if candidate.is_file():
            with candidate.open("rb") as f:
                return tomllib.load(f)
    return {}


CONFIG = load_config()

app = FastAPI(title="dia service", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5199",
        "http://127.0.0.1:5199",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# lazy singletons (one session service; one copilot runner over it)
# ---------------------------------------------------------------------------

_session_service: Any = None
_copilot_runner: Any = None


def _get_copilot_runner() -> Any:
    global _session_service, _copilot_runner
    if _copilot_runner is None:
        _session_service = agents.make_session_service()
        _copilot_runner = agents.make_copilot_agent(_session_service, CONFIG)
    return _copilot_runner


async def _ensure_session(session_id: str) -> None:
    """One ADK session per deck sessionId — turn 30 remembers turn 3."""
    existing = await _session_service.get_session(
        app_name=APP_NAME, user_id=USER_ID, session_id=session_id
    )
    if existing is None:
        await _session_service.create_session(
            app_name=APP_NAME, user_id=USER_ID, session_id=session_id
        )


# ---------------------------------------------------------------------------
# request bodies
# ---------------------------------------------------------------------------

class ChatRequest(BaseModel):
    sessionId: str
    message: str
    context: dict[str, Any] = {}


class TranslateRequest(BaseModel):
    sourceHtml: str
    tokensCss: str = ""


class RepairRequest(BaseModel):
    sourceHtml: str
    candidateHtml: str
    tokensCss: str = ""
    mismatch: str = ""


class LiftRequest(BaseModel):
    svgHtml: str


# ---------------------------------------------------------------------------
# /health
# ---------------------------------------------------------------------------

@app.get("/health")
async def health() -> dict[str, Any]:
    if not agents.ADK_AVAILABLE:
        return {"ok": False, "detail": "adk not installed"}
    return {"ok": True, "model": agents.endpoint_for(CONFIG)["model"]}


# ---------------------------------------------------------------------------
# /chat — SSE stream of ChatEvent frames
# ---------------------------------------------------------------------------

def _frame(event: dict[str, Any]) -> dict[str, str]:
    """One SSE frame: the editor parses `data: {...}\\n\\n` as a ChatEvent."""
    return {"data": json.dumps(event)}


def _compose_message(req: ChatRequest) -> str:
    """Fold the editor's ChatContext into the user turn so the agent sees
    exactly what the context line in the rail claims it sees."""
    ctx = req.context or {}
    lines = ["<editor-context>"]
    lines.append(f"altitude: {ctx.get('altitude', 'stage')}")
    lines.append(f"slide-index: {ctx.get('slideIndex', 0)}")
    selection = ctx.get("selectionHtml")
    if selection:
        lines.append("selection:")
        lines.append(str(selection))
    tokens = ctx.get("tokensCss")
    if tokens:
        lines.append("theme-tokens:")
        lines.append(str(tokens))
    lines.append("</editor-context>")
    lines.append("")
    lines.append(req.message)
    return "\n".join(lines)


async def _chat_events(req: ChatRequest) -> AsyncIterator[dict[str, str]]:
    if not agents.ADK_AVAILABLE:
        yield _frame({"type": "error", "message": INSTALL_HINT})
        yield _frame({"type": "done"})
        return

    from google.genai import types as genai_types

    try:
        runner = _get_copilot_runner()
        await _ensure_session(req.sessionId)
        content = genai_types.Content(
            role="user", parts=[genai_types.Part(text=_compose_message(req))]
        )
        streamed_text = False
        async for event in runner.run_async(
            user_id=USER_ID, session_id=req.sessionId, new_message=content
        ):
            parts = event.content.parts if event.content else []
            for part in parts or []:
                call = getattr(part, "function_call", None)
                if call is not None and call.name == "propose_ops":
                    ops = (call.args or {}).get("ops", [])
                    yield _frame({"type": "ops", "ops": ops})
                    continue
                text = getattr(part, "text", None)
                if not text:
                    continue
                if getattr(event, "partial", False):
                    streamed_text = True
                    yield _frame({"type": "text", "delta": text})
                elif not streamed_text:
                    # non-streaming model path: the final event carries it all
                    yield _frame({"type": "text", "delta": text})
    except Exception as exc:  # noqa: BLE001 — surface, never crash the stream
        yield _frame({"type": "error", "message": f"chat failed: {exc}"})
    yield _frame({"type": "done"})


@app.post("/chat")
async def chat(req: ChatRequest) -> EventSourceResponse:
    return EventSourceResponse(_chat_events(req))


# ---------------------------------------------------------------------------
# /skills/* — single-shot skill runs
# ---------------------------------------------------------------------------

async def _run_skill(skill: str, prompt: str) -> str:
    """One skill agent, one fresh session, one prompt, final text out."""
    if not agents.ADK_AVAILABLE:
        raise HTTPException(status_code=503, detail=INSTALL_HINT)

    from google.genai import types as genai_types

    agent = agents.make_skill_agent(skill, CONFIG)
    session_service = agents.make_session_service()
    runner = agents.Runner(
        agent=agent, app_name=APP_NAME, session_service=session_service
    )
    session = await session_service.create_session(app_name=APP_NAME, user_id=USER_ID)

    content = genai_types.Content(role="user", parts=[genai_types.Part(text=prompt)])

    chunks: list[str] = []
    try:
        async for event in runner.run_async(
            user_id=USER_ID, session_id=session.id, new_message=content
        ):
            if getattr(event, "partial", False):
                continue  # collect only final content
            for part in (event.content.parts if event.content else []) or []:
                text = getattr(part, "text", None)
                if text:
                    chunks.append(text)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"{skill} failed: {exc}")

    return _strip_fences("".join(chunks).strip())


def _strip_fences(text: str) -> str:
    """Skill prompts demand raw HTML, but smaller models fence anyway."""
    if text.startswith("```"):
        first_newline = text.find("\n")
        if first_newline != -1 and text.rstrip().endswith("```"):
            return text[first_newline + 1 :].rstrip().removesuffix("```").rstrip()
    return text


@app.post("/skills/translate-slide")
async def translate_slide(req: TranslateRequest) -> dict[str, str]:
    prompt = (
        "<token-css>\n" + req.tokensCss + "\n</token-css>\n\n"
        "<source-slide>\n" + req.sourceHtml + "\n</source-slide>"
    )
    return {"slideHtml": await _run_skill("translate-slide", prompt)}


@app.post("/skills/repair-fidelity")
async def repair_fidelity(req: RepairRequest) -> dict[str, str]:
    prompt = (
        "<token-css>\n" + req.tokensCss + "\n</token-css>\n\n"
        "<converted-slide>\n" + req.candidateHtml + "\n</converted-slide>\n\n"
        "<mismatch>\n" + req.mismatch + "\n\n"
        "Relevant source excerpt:\n" + req.sourceHtml + "\n</mismatch>"
    )
    return {"slideHtml": await _run_skill("repair-fidelity", prompt)}


@app.post("/skills/lift-diagram")
async def lift_diagram(req: LiftRequest) -> dict[str, str]:
    return {"sceneHtml": await _run_skill("lift-diagram", req.svgHtml)}


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------

def run() -> None:
    """`dia-serve` console script."""
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT, log_level="info")


if __name__ == "__main__":
    run()
