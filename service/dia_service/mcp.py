"""`dia mcp` — a Model Context Protocol server over stdio, stdlib-only.

The MCP surface exists for agents WITHOUT shell access (or with it
disabled): everything here is reachable through the CLI too, and both
run the same code. Deck tools (new/validate/manual) run in-process;
inference tools (translate/repair/lift) proxy to the local dia service
over HTTP — start it with `dia serve`. No service ⇒ those tools return
a clear error instead of failing opaquely.

Protocol: JSON-RPC 2.0, newline-delimited, initialize/tools-list/
tools-call — the minimal subset every MCP client speaks.
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .validate import validate_html

SERVICE = "http://127.0.0.1:8317"
PROTOCOL_VERSION = "2024-11-05"

TOOLS: list[dict[str, Any]] = [
    {
        "name": "dia_new",
        "description": "Scaffold a profile-valid diastil deck at the given path (refuses to overwrite). The generation loop: scaffold, edit the html, hold yourself to dia_validate.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "file path for the new deck (.html)"},
                "title": {"type": "string", "description": "deck title (default: derived from the filename)"},
            },
            "required": ["path"],
        },
    },
    {
        "name": "dia_validate",
        "description": "Profile-validate a diastil deck — the contract gate. Pass a file path OR raw html. Returns rule-id findings; error-level findings mean the dialect contract is broken.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "deck file to validate"},
                "html": {"type": "string", "description": "raw deck html to validate (alternative to path)"},
            },
        },
    },
    {
        "name": "dia_manual",
        "description": "The diastil operating manual for agents: dialect grammar in brief, the generate-validate loop, CLI operations, and where the deep skills live.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "dia_translate_slide",
        "description": "Model-assisted translation of one foreign slide's html into the diastil dialect (needs `dia serve` running). Returns the converted <section class=\"dia-slide\">.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "source_html": {"type": "string", "description": "the foreign slide's html"},
                "tokens_css": {"type": "string", "description": "the deck's :root token css, if known"},
            },
            "required": ["source_html"],
        },
    },
    {
        "name": "dia_repair_slide",
        "description": "One repair round: given the source slide and a converted candidate that mismatches it, returns a corrected candidate (needs `dia serve` running).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "source_html": {"type": "string", "description": "the original slide html"},
                "candidate_html": {"type": "string", "description": "the current converted slide html"},
                "mismatch": {"type": "string", "description": "what is wrong, as concretely as possible"},
                "tokens_css": {"type": "string", "description": "the deck's :root token css, if known"},
            },
            "required": ["source_html", "candidate_html"],
        },
    },
    {
        "name": "dia_lift_diagram",
        "description": "Lift a raw <svg> diagram into the diastil scene vocabulary (movable nodes, self-routing edges). Needs `dia serve` running. Returns the rewritten svg.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "svg": {"type": "string", "description": "the raw <svg> element to lift"},
            },
            "required": ["svg"],
        },
    },
    {
        "name": "dia_service_health",
        "description": "Whether the local dia inference service is up, and which model it is configured for.",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


# ---------------------------------------------------------------------------
# tool implementations
# ---------------------------------------------------------------------------

def _post(path: str, body: dict[str, Any], timeout: float = 300) -> dict[str, Any]:
    req = urllib.request.Request(
        f"{SERVICE}{path}",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read())


def _service_error(exc: Exception) -> str:
    if isinstance(exc, urllib.error.HTTPError):
        try:
            detail = json.loads(exc.read()).get("detail", "")
        except Exception:
            detail = ""
        return f"dia service error {exc.code}{f': {detail}' if detail else ''}"
    return (
        "dia service unreachable — start it with `dia serve` "
        f"(expected at {SERVICE}); underlying error: {exc}"
    )


def _validation_text(html: str, label: str) -> str:
    report = validate_html(html)
    errors = [f for f in report["findings"] if f["level"] == "error"]
    lines = [
        f"{label}: {'ok' if report['ok'] else 'OUT OF PROFILE'} — "
        f"{report['slideCount']} slides, {len(errors)} errors, "
        f"{len(report['findings']) - len(errors)} advisories"
    ]
    for f in report["findings"]:
        loc = f" at {f['locator']}" if f["locator"] else ""
        lines.append(f"[{f['level']}] {f['rule']}{loc}: {f['message']}")
    return "\n".join(lines)


def call_tool(name: str, args: dict[str, Any]) -> tuple[str, bool]:
    """→ (text, isError). Every branch returns text a model can act on."""
    if name == "dia_new":
        from .scaffold import deck_html

        p = Path(str(args.get("path", "")))
        if not str(p):
            return "path is required", True
        if p.exists():
            return f"{p} already exists — not overwriting", True
        title = str(args.get("title") or p.stem.replace("-", " ").replace("_", " "))
        html = deck_html(title)
        p.write_text(html, encoding="utf-8")
        return f"wrote {p} (profile-valid). Edit the html, then validate with dia_validate.", False

    if name == "dia_validate":
        if args.get("html"):
            return _validation_text(str(args["html"]), "input"), False
        p = Path(str(args.get("path", "")))
        if not p.is_file():
            return f"no such file: {p}", True
        text = _validation_text(p.read_text(encoding="utf-8"), str(p))
        return text, "OUT OF PROFILE" in text

    if name == "dia_manual":
        from .scaffold import AGENTS_SNIPPET

        return AGENTS_SNIPPET, False

    if name == "dia_service_health":
        try:
            req = urllib.request.Request(f"{SERVICE}/health")
            with urllib.request.urlopen(req, timeout=5) as res:
                return res.read().decode(), False
        except Exception as exc:  # noqa: BLE001
            return _service_error(exc), True

    try:
        if name == "dia_translate_slide":
            out = _post("/skills/translate-slide", {
                "sourceHtml": str(args.get("source_html", "")),
                "tokensCss": str(args.get("tokens_css", "")),
            })
            return out.get("slideHtml", ""), False
        if name == "dia_repair_slide":
            out = _post("/skills/repair-fidelity", {
                "sourceHtml": str(args.get("source_html", "")),
                "candidateHtml": str(args.get("candidate_html", "")),
                "tokensCss": str(args.get("tokens_css", "")),
                "mismatch": str(args.get("mismatch", "")),
            })
            return out.get("slideHtml", ""), False
        if name == "dia_lift_diagram":
            out = _post("/skills/lift-diagram", {"svgHtml": str(args.get("svg", ""))})
            return out.get("sceneHtml", ""), False
    except Exception as exc:  # noqa: BLE001
        return _service_error(exc), True

    return f"unknown tool: {name}", True


# ---------------------------------------------------------------------------
# JSON-RPC over stdio
# ---------------------------------------------------------------------------

def _reply(msg_id: Any, result: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg_id, "result": result}) + "\n")
    sys.stdout.flush()


def _reply_error(msg_id: Any, code: int, message: str) -> None:
    sys.stdout.write(json.dumps(
        {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}) + "\n")
    sys.stdout.flush()


def serve() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        method = msg.get("method", "")
        msg_id = msg.get("id")
        if msg_id is None:
            continue  # notifications need no response
        if method == "initialize":
            _reply(msg_id, {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "dia", "version": "0.1.0"},
            })
        elif method == "ping":
            _reply(msg_id, {})
        elif method == "tools/list":
            _reply(msg_id, {"tools": TOOLS})
        elif method == "tools/call":
            params = msg.get("params") or {}
            try:
                text, is_error = call_tool(
                    str(params.get("name", "")), params.get("arguments") or {})
            except Exception as exc:  # noqa: BLE001 — a tool crash must not kill the server
                text, is_error = f"tool failed: {exc}", True
            _reply(msg_id, {
                "content": [{"type": "text", "text": text}],
                "isError": is_error,
            })
        else:
            _reply_error(msg_id, -32601, f"method not found: {method}")
    return 0
