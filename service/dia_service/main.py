"""dia service HTTP surface.

FastAPI on 127.0.0.1:8317, spoken to only by the local diastil editor.
Endpoints:
  GET  /health                  -> {ok, model} (ok:false when adk missing)
  POST /chat                    -> SSE stream of ChatEvent frames
  POST /skills/translate-slide  -> {slideHtml} (single-shot skill run)
  POST /skills/repair-fidelity  -> {slideHtml} (one fidelity-loop round)
  POST /skills/lift-diagram     -> {sceneHtml} (raw SVG -> scene vocabulary)
  GET  /file?path=              -> {html, mtime} (CLI-opened files only)
  PUT  /file                    -> {mtime}       (CLI-opened files only)
  /editor/*                     -> built editor bundle (mounted by the CLI)

No telemetry. The only outbound traffic is to the endpoint the user
configured in config.toml. The editor is fully functional when this
process is not running.
"""

from __future__ import annotations

import json
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

CONFIG = agents.load_config()

app = FastAPI(title="dia service", version="0.1.0")

# Browser origins allowed to call the service. "null" is a file:// page —
# the standalone single-file editor (dist/diastil.html). The service binds
# to 127.0.0.1 regardless, so this list only restrains which LOCAL browser
# pages may call it; native local processes were never restrained by CORS.
# The editor served by THIS process (/editor mount) needs no entry at all:
# the client uses relative URLs there (src/service/client.ts), so those
# calls are same-origin whatever hostname the user typed. Keep this list
# narrow — any origin added here can reach the /file bridge and spend
# model tokens via /skills/*.
# Override with  [service] allow_origins = [...]  in config.toml.
_DEFAULT_ORIGINS = [
    "http://localhost:5199",
    "http://127.0.0.1:5199",
    "null",  # file:// — the standalone editor
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=CONFIG.get("service", {}).get("allow_origins", _DEFAULT_ORIGINS),
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
    # PNG data URIs: [original slide render] — optional
    images: list[str] = []
    # reviewer notes from the import flow — optional
    feedback: str = ""


class FileWrite(BaseModel):
    path: str
    html: str


class RepairRequest(BaseModel):
    sourceHtml: str
    candidateHtml: str
    tokensCss: str = ""
    mismatch: str = ""
    # PNG data URIs: [original render, candidate render, diff heatmap] —
    # optional; a vision-capable endpoint sees the mismatch directly
    images: list[str] = []
    # reviewer notes from the import flow — optional
    feedback: str = ""


class LiftRequest(BaseModel):
    svgHtml: str
    # PNG data URIs: [render of the source diagram] — optional
    images: list[str] = []
    # reviewer notes from the import flow — optional
    feedback: str = ""


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
    neighbors = ctx.get("flowNeighborsHtml") or []
    if neighbors:
        lines.append("slides-in-view (document order around the current slide):")
        for n in neighbors:
            lines.append(str(n))
    original = ctx.get("originalHtml")
    if original:
        lines.append(
            "original-slide (the imported source this slide was converted from"
            " — reference for the content and intent the conversion aimed at):"
        )
        lines.append(str(original))
    has_render = bool(ctx.get("slideImage"))
    has_original_render = bool(ctx.get("originalImage"))
    if has_render and has_original_render:
        lines.append(
            "two images are attached, in order: (1) the current slide as"
            " rendered, (2) the ORIGINAL imported slide as rendered"
        )
    elif has_render:
        lines.append("a render of the current slide is attached as an image")
    elif has_original_render:
        lines.append("a render of the ORIGINAL imported slide is attached as an image")
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
        parts = [genai_types.Part(text=_compose_message(req))]
        # the copilot's eyes: current render first, then the imported
        # original's render — the order the composed message promises
        for key in ("slideImage", "originalImage"):
            image = (req.context or {}).get(key)
            if isinstance(image, str):
                decoded = agents.decode_data_uri(image)
                if decoded is not None:
                    mime, data = decoded
                    parts.append(
                        genai_types.Part(inline_data=genai_types.Blob(mime_type=mime, data=data))
                    )
        content = genai_types.Content(role="user", parts=parts)
        streamed_text = False
        async for event in runner.run_async(
            user_id=USER_ID, session_id=req.sessionId, new_message=content
        ):
            parts = event.content.parts if event.content else []
            for part in parts or []:
                call = getattr(part, "function_call", None)
                if call is not None and call.name == "propose_ops":
                    # models mangle the payload in creative ways (JSON-string
                    # lists, singleton dicts, numeric values) — recover what
                    # is recoverable and report the rest as `dropped` so the
                    # editor can ask for a correction instead of going quiet
                    ops, dropped = agents.coerce_ops((call.args or {}).get("ops", []))
                    yield _frame({"type": "ops", "ops": ops, "dropped": dropped})
                    continue
                text = getattr(part, "text", None)
                if not text:
                    continue
                # reasoning parts (genai marks them part.thought) stream as
                # their own event type — the editor renders them as a quiet,
                # collapsible block instead of mixing them into the answer
                kind = "thinking" if getattr(part, "thought", False) else "text"
                if getattr(event, "partial", False):
                    # only ANSWER partials mark the stream as delivered — a
                    # thinking-only stream must not swallow the final text
                    if kind == "text":
                        streamed_text = True
                    yield _frame({"type": kind, "delta": text})
                elif not streamed_text:
                    # non-streaming model path: the final event carries it all
                    yield _frame({"type": kind, "delta": text})
    except Exception as exc:  # noqa: BLE001 — surface, never crash the stream
        yield _frame({"type": "error", "message": f"chat failed: {exc}"})
    yield _frame({"type": "done"})


@app.post("/chat")
async def chat(req: ChatRequest) -> EventSourceResponse:
    return EventSourceResponse(_chat_events(req))


# ---------------------------------------------------------------------------
# /skills/* — single-shot skill runs
# ---------------------------------------------------------------------------

async def _run_skill(skill: str, prompt: str, images: list[str] | None = None) -> tuple[str, str]:
    """HTTP wrapper over agents.run_skill_once → (output, thinking)."""
    if not agents.ADK_AVAILABLE:
        raise HTTPException(status_code=503, detail=INSTALL_HINT)
    try:
        return await agents.run_skill_once(skill, prompt, CONFIG, images=images)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"{skill} failed: {exc}")


async def _run_html_skill(
    skill: str, prompt: str, images: list[str] | None, root: str
) -> tuple[str, str]:
    """Run an html-producing skill and hold it to its contract: ONE raw
    <root> element. A malformed reply (prose, fences the extractor can't
    unwrap, missing element) gets ONE correction round — the model sees its
    own bad reply and is asked again. Still malformed → 422 with the reason,
    never mystery markup passed downstream."""
    out, thinking = await _run_skill(skill, prompt, images)
    html = agents.extract_root_html(out, root)
    if html is not None:
        return html, thinking
    correction = (
        prompt
        + "\n\n<previous-reply>\n" + out[:2000] + "\n</previous-reply>\n"
        + f"Your previous reply (quoted above) did not contain the required raw "
        + f"<{root}> element. Reply again with ONLY the corrected <{root}>…</{root}> "
        + "markup — no prose, no markdown fences, nothing before or after it."
    )
    out2, thinking2 = await _run_skill(skill, correction, images)
    html = agents.extract_root_html(out2, root)
    thinking = "\n\n".join(filter(None, [
        thinking, f"[reply had no <{root}> element — ran a correction round]", thinking2,
    ]))
    if html is None:
        raise HTTPException(
            status_code=422,
            detail=f"{skill}: the model returned no <{root}> element, even after a correction round",
        )
    return html, thinking


def _feedback_block(feedback: str) -> str:
    """Reviewer notes from the import flow, folded into the prompt. The
    reviewer is the human looking at both renders — their notes outrank
    machine summaries when the two disagree."""
    if not feedback.strip():
        return ""
    return (
        "\n\n<reviewer-feedback>\n" + feedback.strip() + "\n</reviewer-feedback>\n"
        "The reviewer wrote the notes above while comparing the original and "
        "converted slides. Honor them; they outrank the machine-generated "
        "summaries when the two disagree."
    )


TRANSLATE_IMAGE_NOTE = (
    "\n\nAttached image: the ORIGINAL slide as rendered. Your translation "
    "must reproduce this layout and content in the dialect."
)

REPAIR_IMAGE_NOTE = (
    "\n\nAttached images, in order: (1) the ORIGINAL slide as rendered, "
    "(2) the current CANDIDATE as rendered, (3) a diff heatmap — red marks "
    "the mismatched regions, dim grayscale matches. Fix what the images show; "
    "the mismatch text above is only a machine summary."
)

LIFT_IMAGE_NOTE = (
    "\n\nAttached image: the source diagram as rendered. Match its layout, "
    "labels, and connections in the lifted scene."
)


@app.post("/skills/translate-slide")
async def translate_slide(req: TranslateRequest) -> dict[str, str]:
    prompt = (
        "<token-css>\n" + req.tokensCss + "\n</token-css>\n\n"
        "<source-slide>\n" + req.sourceHtml + "\n</source-slide>"
    )
    if req.images:
        prompt += TRANSLATE_IMAGE_NOTE
    prompt += _feedback_block(req.feedback)
    out, thinking = await _run_html_skill("translate-slide", prompt, req.images, "section")
    return {"slideHtml": out, "thinking": thinking}


@app.post("/skills/repair-fidelity")
async def repair_fidelity(req: RepairRequest) -> dict[str, str]:
    prompt = (
        "<token-css>\n" + req.tokensCss + "\n</token-css>\n\n"
        "<converted-slide>\n" + req.candidateHtml + "\n</converted-slide>\n\n"
        "<mismatch>\n" + req.mismatch + "\n\n"
        "Relevant source excerpt:\n" + req.sourceHtml + "\n</mismatch>"
    )
    if req.images:
        prompt += REPAIR_IMAGE_NOTE
    prompt += _feedback_block(req.feedback)
    out, thinking = await _run_html_skill("repair-fidelity", prompt, req.images, "section")
    return {"slideHtml": out, "thinking": thinking}


@app.post("/skills/lift-diagram")
async def lift_diagram(req: LiftRequest) -> dict[str, str]:
    prompt = req.svgHtml + (LIFT_IMAGE_NOTE if req.images else "") + _feedback_block(req.feedback)
    out, thinking = await _run_html_skill("lift-diagram", prompt, req.images, "svg")
    return {"sceneHtml": out, "thinking": thinking}


# ---------------------------------------------------------------------------
# /file — local file bridge for the CLI (`dia <deck.html>`)
# ---------------------------------------------------------------------------

# Only paths the CLI explicitly opened are readable/writable — the service
# is localhost-only, but a file API still gets an allowlist, not trust.
OPENED_FILES: set[Path] = set()


def _resolve_opened(path: str) -> Path:
    p = Path(path).resolve()
    if p not in OPENED_FILES:
        raise HTTPException(status_code=403, detail="path was not opened by the dia CLI")
    return p


@app.get("/file")
async def read_file(path: str) -> dict[str, Any]:
    p = _resolve_opened(path)
    if not p.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    return {"html": p.read_text(encoding="utf-8"), "mtime": p.stat().st_mtime}


@app.put("/file")
async def write_file(req: FileWrite) -> dict[str, Any]:
    p = _resolve_opened(req.path)
    p.write_text(req.html, encoding="utf-8")
    return {"mtime": p.stat().st_mtime}


def mount_editor(dist: Path) -> None:
    """Serve the built editor bundle at /editor (same origin as the API)."""
    from fastapi.staticfiles import StaticFiles

    app.mount("/editor", StaticFiles(directory=dist, html=True), name="editor")


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------

def run() -> None:
    """`dia-serve` console script."""
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT, log_level="info")


if __name__ == "__main__":
    run()
