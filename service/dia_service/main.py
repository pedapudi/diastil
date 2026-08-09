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
  POST /compile                 -> {jobId} (LaTeX -> PDF, runs a real engine)
  GET  /compile/{id}/events     -> SSE stream of phase/log/done frames
  GET  /compile/{id}/pdf        -> the compiled PDF (404 until the job is ok)
  GET  /compile/{id}/synctex    -> coarse source-line -> page/x/y map
  GET  /compile/{id}/bbl        -> raw .bbl text (404 when there is none)
  GET  /compile/{id}/pages      -> {available, tool, count, pages, ySemantics}
  GET  /compile/{id}/page/{n}.png?dpi= -> one page rasterized by poppler
  DELETE /compile/{id}          -> cancel a running compile
  POST /tex/install             -> SSE progress for the managed tectonic install
  POST /tex/refresh             -> {tex} (re-probe the engine ladder)
  POST /mcp                     -> JSON-RPC 2.0 MCP endpoint (same dispatch as `dia mcp`)
  /editor/*                     -> built editor bundle (mounted by the CLI)

No telemetry. The only outbound traffic is to the endpoint the user
configured in config.toml. The editor is fully functional when this
process is not running.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from . import agents, mcp, tex, texcompile

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
    # `tex` rides on both branches: compiling needs no model, so a machine
    # with tectonic and no adk still reports a usable engine. The probe is
    # memoized — /health is polled, and re-running four --version calls per
    # poll would be a self-inflicted load problem.
    capability = tex.discover(config=CONFIG).as_dict()
    if not agents.ADK_AVAILABLE:
        return {"ok": False, "detail": "adk not installed", "tex": capability}
    return {"ok": True, "model": agents.endpoint_for(CONFIG)["model"], "tex": capability}


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
    if ctx.get("docMode"):
        return _compose_doc_message(req, ctx)
    lines = ["<editor-context>"]
    lines.append(f"altitude: {ctx.get('altitude', 'stage')}")
    # ONE numbering for the whole conversation: slides are 1-based in the
    # context, in targets ("slide 3"), and in scene ops (extra.slide) —
    # mixed bases were a reliable off-by-one factory
    lines.append(f"current-slide: {int(ctx.get('slideIndex', 0)) + 1} (slide numbers are 1-based everywhere)")
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
    highlights = ctx.get("highlights") or []
    if highlights:
        lines.append(
            f"the user shaded {len(highlights)} region(s) on the current slide's render "
            "(orange boxes on the attached image; fractions of the slide, origin "
            "top-left) — treat them as the focus of the request:"
        )
        for r in highlights:
            if isinstance(r, dict):
                lines.append(
                    f"- x={r.get('x')} y={r.get('y')} w={r.get('w')} h={r.get('h')}"
                )
    auto = ctx.get("autoHighlights") or []
    if auto:
        lines.append(
            f"the tool MEASURED {len(auto)} region(s) where this slide's render still "
            "mismatches its imported original (also drawn as orange boxes on the attached "
            "render; fractions of the slide, origin top-left) — the highest-value repair "
            "targets, exactly as if the user had shaded them:"
        )
        for r in auto:
            if isinstance(r, dict):
                lines.append(
                    f"- x={r.get('x')} y={r.get('y')} w={r.get('w')} h={r.get('h')}"
                )
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


def _compose_doc_message(req: ChatRequest, ctx: dict[str, Any]) -> str:
    """The document turn. Same envelope, different document kind: the truth
    is LaTeX source, the unit is a section, and the wire fields the deck uses
    for its slide (slideIndex, slideImage) carry the block and the section
    render — so the image loop below is one code path, not two."""
    lines = ["<editor-context>"]
    lines.append(
        "document-mode: this artifact is a LaTeX-backed DOCUMENT, not a deck."
        " Its truth is the .tex source; every op you propose is applied to the"
        " rendered block AND its source slice together."
    )
    lines.append(f"current-block: {int(ctx.get('slideIndex', 0)) + 1} (1-based, like every number here)")
    section = ctx.get("sectionHtml")
    if section:
        lines.append("current-section (rendered dialect markup — what the user is reading):")
        lines.append(str(section))
    source = ctx.get("sourceExcerpt")
    if source:
        lines.append(
            "current-section-source (the LaTeX behind that markup — reason in"
            " tex, and keep the document's own conventions):"
        )
        lines.append(str(source))
    selection = ctx.get("selectionHtml")
    if selection:
        lines.append("selection:")
        lines.append(str(selection))
    tokens = ctx.get("tokensCss")
    if tokens:
        lines.append("theme-tokens:")
        lines.append(str(tokens))
    comments = ctx.get("comments") or []
    if comments:
        lines.append(
            f"open comment threads in this section ({len(comments)}) — each is a REQUEST"
            " about the quoted text; address them unless the user says otherwise:"
        )
        for c in comments:
            if isinstance(c, dict):
                lines.append(
                    f"- {c.get('id')} on \"{c.get('quote')}\": {c.get('note')}"
                )
    errors = ctx.get("compileErrors") or []
    if errors:
        lines.append(
            f"the last compile FAILED with {len(errors)} error(s) (line numbers are"
            " into the .tex source):"
        )
        for e in errors:
            if isinstance(e, dict):
                line_no = e.get("line")
                where = f"line {line_no}: " if line_no else ""
                lines.append(f"- {where}{e.get('message')}")
    if ctx.get("slideImage"):
        lines.append("a render of the current section is attached as an image")
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
    # binary formats (.pptx) travel base64 — a text read would mangle them
    if p.suffix.lower() == ".pptx":
        import base64

        return {"b64": base64.b64encode(p.read_bytes()).decode("ascii"),
                "mtime": p.stat().st_mtime}
    return {"html": p.read_text(encoding="utf-8"), "mtime": p.stat().st_mtime}


@app.put("/file")
async def write_file(req: FileWrite) -> dict[str, Any]:
    p = _resolve_opened(req.path)
    p.write_text(req.html, encoding="utf-8")
    return {"mtime": p.stat().st_mtime}


# ---------------------------------------------------------------------------
# /project/file — the OTHER .tex files of a multi-file document
# ---------------------------------------------------------------------------

# A thesis is a main file plus \input'd chapters, and the editor has to be
# able to both read and write those chapters — an edit that shows on screen
# and never reaches disk is worse than one that never happened.
#
# The allowlist does not change shape: the CLI still has to have opened the
# MAIN file, and a chapter is addressed only as a path RELATIVE to it. The
# containment rule is texcompile's `_safe_asset_path`, reused rather than
# restated — it is the same question (may this relative name touch this
# directory?), and two copies of a security check drift.
#
# Only .tex: this endpoint exists to serve \input, and a bridge that will
# hand back any file beside the document is a different, larger promise.


def _project_caller_ok(request: Request) -> str | None:
    """None when this caller may reach /project/file, else why not.

    An opaque origin — what a sandboxed iframe on ANY site gets — is spelled
    "null", and CORS allows it here so the standalone file:// editor can talk
    to the daemon. That is a capability a drive-by page can mint, and this
    endpoint WRITES: refusing it keeps the reach of a hostile page at the one
    file the CLI opened (/file, issue #25) instead of every .tex under that
    file's directory. A same-origin editor sends its real loopback origin and
    a native caller sends none, so neither is affected.
    """
    origin = request.headers.get("origin")
    if origin is not None and origin.strip().lower() == "null":
        return ("/project/file does not answer an opaque origin — any page can "
                "mint one with a sandboxed iframe, and this endpoint writes "
                "files. Use the editor the daemon serves at /editor.")
    return None


def _project_file(main_path: str, rel: str) -> Path:
    main = _resolve_opened(main_path)
    if not rel.lower().endswith(".tex"):
        raise HTTPException(status_code=400, detail="project files are .tex only")
    try:
        target = texcompile._safe_asset_path(main.parent, rel)
    except texcompile.AssetError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if target == main:
        # the main file has its own door, with its own mtime bookkeeping
        raise HTTPException(status_code=400, detail="use /file for the main document")
    return target


@app.get("/project/file")
async def read_project_file(main: str, path: str, request: Request) -> dict[str, Any]:
    refused = _project_caller_ok(request)
    if refused is not None:
        raise HTTPException(status_code=403, detail=refused)
    target = _project_file(main, path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    return {"tex": target.read_text(encoding="utf-8"), "mtime": target.stat().st_mtime}


class ProjectFileWrite(BaseModel):
    main: str
    path: str
    tex: str


@app.put("/project/file")
async def write_project_file(req: ProjectFileWrite, request: Request) -> dict[str, Any]:
    refused = _project_caller_ok(request)
    if refused is not None:
        raise HTTPException(status_code=403, detail=refused)
    target = _project_file(req.main, req.path)
    # a chapter's directory already exists (we read the chapter from it);
    # refusing to create one keeps this endpoint a writer, not a scaffolder
    if not target.parent.is_dir():
        raise HTTPException(status_code=404, detail="directory not found")
    target.write_text(req.tex, encoding="utf-8")
    return {"mtime": target.stat().st_mtime}


class ExportPptx(BaseModel):
    html: str
    title: str | None = None


@app.post("/export/pptx")
async def export_pptx(req: ExportPptx) -> Response:
    """Render the dialect deck to a .pptx and return it as a download. The file
    opens in PowerPoint / Keynote and converts to native, editable Google Slides
    on import (text roles -> text boxes, scenes -> shapes + connectors, charts ->
    vector shapes, inline SVG -> shapes, speaker notes -> notes)."""
    import re

    from .pptx_export import deck_slide_count, deck_title, deck_to_pptx

    if deck_slide_count(req.html) == 0:
        raise HTTPException(
            status_code=422, detail="no dia-slide sections found in the deck")
    try:
        data = deck_to_pptx(req.html)
    except Exception as exc:  # noqa: BLE001 - never surface a raw 500 traceback
        raise HTTPException(
            status_code=500, detail=f"deck render failed: {exc}") from exc
    title = (req.title or deck_title(req.html) or "presentation").strip()
    safe = re.sub(r"[^\w .-]+", " ", title).strip() or "presentation"
    return Response(
        content=data,
        media_type=(
            "application/vnd.openxmlformats-officedocument"
            ".presentationml.presentation"),
        headers={"Content-Disposition": f'attachment; filename="{safe}.pptx"'},
    )


# ---------------------------------------------------------------------------
# /compile — LaTeX -> PDF, as a job (compiles are slow)
# ---------------------------------------------------------------------------

class CompileRequest(BaseModel):
    texSource: str
    docId: str
    # relative path -> plain text (.bib/.sty) or a data: URI (images)
    assets: dict[str, str] = {}
    # force a specific engine; unset means "best available"
    engine: str | None = None
    # the file this document was opened from; grants read-only TEXINPUTS
    # access to its directory, but only if the CLI opened it
    docPath: str | None = None


def _texinputs_for(doc_path: str | None) -> Path | None:
    """The directory relative \\includegraphics may read from, or None.

    Only paths the CLI opened qualify — the same allowlist the /file bridge
    uses. A docPath outside it is ignored rather than refused: the compile
    still works, it just cannot see the user's figures, and the response
    says so instead of failing a whole document over one image."""
    if not doc_path:
        return None
    try:
        resolved = Path(doc_path).resolve()
    except OSError:
        return None
    if resolved not in OPENED_FILES:
        return None
    return resolved.parent


@app.post("/compile")
async def compile_tex(req: CompileRequest) -> dict[str, Any]:
    texinputs = _texinputs_for(req.docPath)
    try:
        job = texcompile.submit(
            tex_source=req.texSource,
            doc_id=req.docId,
            assets=req.assets,
            engine=req.engine,
            texinputs_dir=texinputs,
            config=CONFIG,
        )
    except texcompile.AssetError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except texcompile.CompileError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"jobId": job.id, "engine": job.engine, "texinputs": texinputs is not None}


def _job_or_404(job_id: str) -> texcompile.CompileJob:
    job = texcompile.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="no such compile job")
    return job


async def _compile_events(job: texcompile.CompileJob) -> AsyncIterator[dict[str, str]]:
    """Replay the job's frames and follow it live. Late subscribers get the
    whole history — the client may POST and connect a beat later, and a
    stream that started mid-compile would show a log with no beginning."""
    index = 0
    while True:
        # events_since blocks on a Condition; off the event loop it goes
        batch = await asyncio.to_thread(job.events_since, index, 15.0)
        index += len(batch)
        for event in batch:
            yield _frame(event)
            if event.get("type") == "done":
                return
        if not batch and job.finished:
            return


@app.get("/compile/{job_id}/events")
async def compile_events(job_id: str) -> EventSourceResponse:
    return EventSourceResponse(_compile_events(_job_or_404(job_id)))


@app.get("/compile/{job_id}/pdf")
async def compile_pdf(job_id: str) -> Response:
    job = _job_or_404(job_id)
    if job.status != "ok" or not job.pdf_path.is_file():
        raise HTTPException(
            status_code=404,
            detail=f"no pdf for job {job_id} (status: {job.status})")
    return Response(
        content=job.pdf_path.read_bytes(),
        media_type="application/pdf",
        headers={"Content-Disposition": 'inline; filename="document.pdf"'},
    )


@app.get("/compile/{job_id}/synctex")
async def compile_synctex(job_id: str) -> dict[str, Any]:
    """`{pages, lines: [{line, page, x, y, w?}], xSemantics, ySemantics}`.

    `x` and `y` are points from the top-left of the PAPER and `w` is the
    width of the box the line typeset — the column's, for body text — so a
    client can crop a block to the column it is in rather than to the full
    page width. `w` is absent for a line that typeset nothing on the page.
    parse_synctex documents which of a line's boxes is reported and why."""
    job = _job_or_404(job_id)
    path = job.synctex_path
    if path is None:
        return {"pages": [], "lines": [],
                "xSemantics": texcompile.SYNCTEX_X_SEMANTICS,
                "ySemantics": texcompile.SYNCTEX_Y_SEMANTICS}
    return texcompile.parse_synctex(path)


@app.get("/compile/{job_id}/bbl")
async def compile_bbl(job_id: str) -> Response:
    """The raw .bbl text this compile ran with — bibtex's own output, or the
    precompiled one adopted from an arXiv bundle. The client parses its
    \\bibitem labels into author-year cite text; this endpoint stays a dumb
    file read so that parsing (and its tests) lives in one place, not two."""
    job = _job_or_404(job_id)
    path = job.bbl_path
    if path is None:
        raise HTTPException(
            status_code=404,
            detail=f"no bibliography for job {job_id}")
    return Response(
        content=path.read_text(encoding="utf-8"),
        media_type="text/plain; charset=utf-8")


@app.get("/compile/{job_id}/pages")
async def compile_pages(job_id: str) -> dict[str, Any]:
    """Page count and per-page size in PDF points, plus what the synctex `y`
    axis means. Everything the client needs to place a rendered page and put
    an overlay on it; `available: false` with a `reason` when it cannot be
    rendered here, which is a state the UI shows rather than an error."""
    job = _job_or_404(job_id)
    return await asyncio.to_thread(texcompile.page_geometry, job)


@app.get("/compile/{job_id}/page/{n}.png")
async def compile_page_png(job_id: str, n: int, dpi: int = texcompile.PAGE_DPI_DEFAULT) -> Response:
    """One full page as a PNG. `dpi` is clamped rather than validated —
    see texcompile.clamp_dpi."""
    job = _job_or_404(job_id)
    png = await asyncio.to_thread(texcompile.render_page, job, n, dpi)
    if png is None:
        raise HTTPException(
            status_code=404,
            detail=f"no page {n} for job {job_id} (status: {job.status})")
    return Response(
        content=png.read_bytes(),
        media_type="image/png",
        # a job id names one immutable PDF, so this render can never change;
        # re-scrolling past an island should not re-fetch it
        headers={"Cache-Control": "private, max-age=86400, immutable"},
    )


@app.get("/compile/{job_id}")
async def compile_status(job_id: str) -> dict[str, Any]:
    return _job_or_404(job_id).status_dict()


@app.delete("/compile/{job_id}")
async def compile_cancel(job_id: str) -> dict[str, Any]:
    job = _job_or_404(job_id)
    job.cancel()
    return {"jobId": job.id, "status": job.status}


# ---------------------------------------------------------------------------
# /tex/* — engine discovery and the managed tectonic install
# ---------------------------------------------------------------------------

async def _install_events() -> AsyncIterator[dict[str, str]]:
    """Run the install on a thread, forwarding its progress dicts as frames.
    The callback fires from the worker thread, so it hands events to the
    loop rather than touching the queue directly."""
    from .texdl import InstallError, install_tectonic

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[dict | None] = asyncio.Queue()

    def progress(event: dict) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, event)

    async def run() -> None:
        try:
            await asyncio.to_thread(install_tectonic, progress)
        except InstallError as exc:
            await queue.put({"phase": "error", "message": str(exc)})
        except Exception as exc:  # noqa: BLE001 — the stream reports, never crashes
            await queue.put({"phase": "error", "message": f"install failed: {exc}"})
        await queue.put(None)

    task = asyncio.create_task(run())
    try:
        while True:
            event = await queue.get()
            if event is None:
                break
            yield _frame({"type": "install", **event})
    finally:
        task.cancel()
    yield _frame({"type": "done", "tex": tex.discover(refresh=True, config=CONFIG).as_dict()})


@app.post("/tex/install")
async def tex_install() -> EventSourceResponse:
    """Download the pinned tectonic into the diastil cache (SSE progress).
    Nothing about the URL is client-controlled — see texdl.py."""
    return EventSourceResponse(_install_events())


@app.post("/tex/refresh")
async def tex_refresh() -> dict[str, Any]:
    """Re-probe the engine ladder — after installing TeX outside the app,
    or editing `[tex] engine` in config.toml."""
    return {"tex": tex.discover(refresh=True, config=CONFIG).as_dict()}


# ---------------------------------------------------------------------------
# /mcp — MCP JSON-RPC 2.0 over HTTP (same dispatch as `dia mcp` stdio)
# ---------------------------------------------------------------------------
#
# Minimal, widely-supported "JSON-RPC over POST" transport: one request
# object in the body, one response object back (or 202 for a notification).
# This is the non-streaming form of MCP Streamable HTTP. Notifications
# from server -> client (SSE) are a follow-up if a use case demands it.
#
# Auth is intentionally not enforced here: when a deployment fronts this
# (a reverse proxy so a remote connector can reach it), the deployment is
# the natural place to gate access — a token, mTLS, an IP allowlist — and
# this code should not assume a scheme.
#
# But NO BROWSER PAGE may reach it, and CORS alone cannot enforce that.
# The tool surface writes files (`dia_new` scaffolds at any path it is
# given) and spends model tokens, so a reachable /mcp is a drive-by
# arbitrary write. Two gates, because each catches what the other misses:
#
#   Origin — a browser attaches it to every cross-origin fetch, and native
#     MCP clients (stdio proxies, desktop hosts, curl) never do. Presence
#     alone therefore means "a web page is calling", and the answer is no.
#     Relying on the CORS list instead would not do: it allows "null" for
#     the file:// standalone editor, and ANY site can mint an opaque
#     origin with <iframe sandbox> — verified writing a file from an
#     ordinary third-party page before this gate existed.
#   Host — DNS rebinding sidesteps Origin entirely by making the attacker's
#     own domain resolve to 127.0.0.1, at which point the request is
#     same-origin and carries no cross-origin Origin at all. A loopback
#     service must therefore also insist it was addressed as loopback.

# Loopback by default. A deployment that legitimately fronts /mcp with a
# reverse proxy sets its own public name here — the proxy is then the thing
# that authenticates, which is the arrangement this endpoint was written for.
#   [service] mcp_allow_hosts = ["mcp.internal"]
_DEFAULT_MCP_HOSTS = ["127.0.0.1", "localhost", "[::1]", "::1"]


def _mcp_hosts() -> set[str]:
    return set(CONFIG.get("service", {}).get("mcp_allow_hosts", _DEFAULT_MCP_HOSTS))


def _mcp_caller_ok(request: Request) -> str | None:
    """None when the caller may use /mcp, else the reason it may not."""
    if request.headers.get("origin") is not None:
        return ("/mcp is not reachable from a browser page — it writes files "
                "and spends tokens. Call it from an MCP client over stdio "
                "(`dia mcp`), or front it with a proxy that authenticates.")
    host = (request.headers.get("host") or "").rsplit(":", 1)[0]
    if host and host not in _mcp_hosts():
        return (f"/mcp answers only to a loopback Host, not {host!r} — a name "
                "that resolves to 127.0.0.1 is how DNS rebinding reaches a "
                "local service.")
    return None


@app.post("/mcp")
async def mcp_endpoint(msg: dict[str, Any], request: Request) -> Response:
    """One MCP JSON-RPC request in, one response out.

    Dispatches through `mcp.handle_request` — the same pure function
    the stdio `dia mcp` server calls per line. Reads/urllib inside a
    tool call would block the event loop, so the dispatch runs on a
    worker thread. Notifications (no `id`) get a 202 with an empty body,
    per the JSON-RPC convention.
    """
    refused = _mcp_caller_ok(request)
    if refused is not None:
        raise HTTPException(status_code=403, detail=refused)
    response = await asyncio.to_thread(mcp.handle_request, msg)
    if response is None:
        return Response(status_code=202)
    return JSONResponse(response)


def mount_editor(dist: Path) -> None:
    """Serve the built editor bundle at /editor (same origin as the API).

    The index is served with a one-line marker injected so the client KNOWS
    it is same-origin with the service. Topology is DECLARED by the server,
    never guessed from port numbers — the client's old `port == 8317` check
    (and a `port != 5199` denylist just as easily) is the bug class this
    replaces: any non-default port, moved dev server, or third-party static
    host breaks a port-based guess. See src/service/client.ts SERVICE_BASE.
    """
    from fastapi.responses import HTMLResponse
    from fastapi.staticfiles import StaticFiles

    marker = "<script>window.__diaServiceSameOrigin = true</script>"
    try:
        index = (dist / "index.html").read_text(encoding="utf-8")
        marked = index.replace("<head>", "<head>" + marker, 1) \
            if "<head>" in index else marker + index
    except OSError:
        marked = None

    if marked is not None:
        @app.get("/editor/", include_in_schema=False)
        @app.get("/editor/index.html", include_in_schema=False)
        def _editor_index() -> HTMLResponse:
            # Never framable. A localhost page that ANY website may iframe is a
            # cross-origin read of whatever the user has open — and this editor
            # speaks a postMessage protocol (the MCP App bridge), so a hostile
            # parent could drive it. The MCP App is unaffected: hosts render the
            # ui:// resource they read over stdio, not this mount.
            return HTMLResponse(marked, headers={
                "X-Frame-Options": "DENY",
                "Content-Security-Policy": "frame-ancestors 'none'",
            })

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
