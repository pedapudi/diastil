"""The MCP dispatch, both directly and through the /mcp HTTP endpoint.

`handle_request` is transport-agnostic — the stdio `dia mcp` loop and the
FastAPI `/mcp` route both call it. Tests exercise it directly (no FastAPI
needed for the pure-function surface) and, when httpx/fastapi are on hand,
verify the HTTP route drives the same responses.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from dia_service import mcp


# ---------------------------------------------------------------------------
# handle_request (pure dispatch)
# ---------------------------------------------------------------------------

def _rpc(method: str, params: dict | None = None, msg_id: int | str = 1) -> dict:
    body = {"jsonrpc": "2.0", "id": msg_id, "method": method}
    if params is not None:
        body["params"] = params
    return body


def test_initialize_advertises_tools_resources_and_ui_extension():
    reply = mcp.handle_request(_rpc("initialize"))
    assert reply["jsonrpc"] == "2.0" and reply["id"] == 1
    caps = reply["result"]["capabilities"]
    assert "tools" in caps and "resources" in caps
    assert mcp.UI_EXTENSION_ID in caps["extensions"]
    assert reply["result"]["serverInfo"]["name"] == "dia"
    assert reply["result"]["protocolVersion"] == mcp.PROTOCOL_VERSION


def test_ping_returns_empty_result():
    reply = mcp.handle_request(_rpc("ping"))
    assert reply == {"jsonrpc": "2.0", "id": 1, "result": {}}


def test_notifications_produce_no_response():
    # No `id` field = notification, per JSON-RPC 2.0.
    assert mcp.handle_request({"jsonrpc": "2.0", "method": "ping"}) is None
    assert mcp.handle_request({"jsonrpc": "2.0", "method": "notifications/initialized"}) is None


def test_tools_list_returns_every_tool():
    reply = mcp.handle_request(_rpc("tools/list"))
    names = {t["name"] for t in reply["result"]["tools"]}
    # scaffolding + validation + inference + the MCP App entrypoint
    for expected in ("dia_open_editor", "dia_new", "dia_validate",
                     "dia_manual", "dia_translate_slide", "dia_service_health"):
        assert expected in names


def test_tools_call_dia_manual_runs_in_process():
    reply = mcp.handle_request(_rpc("tools/call", {
        "name": "dia_manual", "arguments": {},
    }))
    result = reply["result"]
    assert result["isError"] is False
    assert result["content"][0]["type"] == "text"
    # AGENTS_SNIPPET has real content — assert it is non-trivial without
    # coupling to the exact wording
    assert len(result["content"][0]["text"]) > 100


def test_unknown_tool_returns_a_tool_error_not_a_transport_error():
    # Malformed tools/call names surface as isError=True on the tool result,
    # not as a JSON-RPC error — the model gets to see and react.
    reply = mcp.handle_request(_rpc("tools/call", {
        "name": "no_such_tool", "arguments": {},
    }))
    assert "error" not in reply
    assert reply["result"]["isError"] is True
    assert "unknown tool" in reply["result"]["content"][0]["text"]


def test_unknown_method_is_a_jsonrpc_error():
    reply = mcp.handle_request(_rpc("no/such/method"))
    assert reply["error"]["code"] == -32601


def test_resources_list_advertises_the_editor_ui_resource():
    reply = mcp.handle_request(_rpc("resources/list"))
    resources = reply["result"]["resources"]
    assert len(resources) == 1
    assert resources[0]["uri"] == mcp.EDITOR_RESOURCE_URI
    assert resources[0]["mimeType"] == mcp.UI_MIME_TYPE


def test_resources_read_unknown_uri_errors():
    reply = mcp.handle_request(_rpc("resources/read", {"uri": "ui://nope"}))
    assert reply["error"]["code"] == -32002


def test_resources_read_editor_returns_inlined_bundle(monkeypatch, tmp_path):
    # Stand in for `npm run standalone` output — the tool must inline it
    # verbatim so an HTTP host can render it in a sandboxed iframe.
    fake = tmp_path / "diastil.html"
    fake.write_text("<html><body>fake editor</body></html>", encoding="utf-8")
    monkeypatch.setenv("DIA_MCP_APP_HTML", str(fake))

    reply = mcp.handle_request(_rpc("resources/read", {
        "uri": mcp.EDITOR_RESOURCE_URI,
    }))
    contents = reply["result"]["contents"]
    assert contents[0]["uri"] == mcp.EDITOR_RESOURCE_URI
    assert contents[0]["mimeType"] == mcp.UI_MIME_TYPE
    assert "fake editor" in contents[0]["text"]


def test_resources_read_missing_bundle_returns_actionable_error(monkeypatch, tmp_path):
    # No env override, no dist/diastil.html on the repo path, no cwd/dist.
    monkeypatch.delenv("DIA_MCP_APP_HTML", raising=False)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(mcp, "_find_standalone_html", lambda: None)

    reply = mcp.handle_request(_rpc("resources/read", {
        "uri": mcp.EDITOR_RESOURCE_URI,
    }))
    assert reply["error"]["code"] == -32002
    assert "npm run standalone" in reply["error"]["message"]


def test_open_editor_returns_the_deck_in_structured_content():
    reply = mcp.handle_request(_rpc("tools/call", {
        "name": "dia_open_editor",
        "arguments": {"html": "<section class=\"dia-slide\">hi</section>"},
    }))
    result = reply["result"]
    assert result["isError"] is False
    assert result["structuredContent"]["name"] == "deck.html"
    assert "dia-slide" in result["structuredContent"]["deckHtml"]


# ---------------------------------------------------------------------------
# /mcp HTTP endpoint — same dispatch, different transport
# ---------------------------------------------------------------------------

fastapi = pytest.importorskip("fastapi", reason="the HTTP route needs fastapi")
httpx = pytest.importorskip("httpx", reason="TestClient needs httpx")

# Importing main pulls in agents/tex/texcompile; guard so this file still
# loads on machines without every optional dep.
try:
    from fastapi.testclient import TestClient  # noqa: E402
    from dia_service import main as service_main  # noqa: E402
    _HTTP_READY = True
except Exception:  # pragma: no cover
    _HTTP_READY = False


http_only = pytest.mark.skipif(not _HTTP_READY,
                               reason="main.py deps not importable")


@pytest.fixture
def client():
    with TestClient(service_main.app) as c:
        yield c


@http_only
def test_http_mcp_initialize(client):
    reply = client.post("/mcp", json=_rpc("initialize")).json()
    assert reply["result"]["serverInfo"]["name"] == "dia"


@http_only
def test_http_mcp_tools_list(client):
    reply = client.post("/mcp", json=_rpc("tools/list")).json()
    names = {t["name"] for t in reply["result"]["tools"]}
    assert "dia_open_editor" in names and "dia_manual" in names


@http_only
def test_http_mcp_tools_call_dia_manual(client):
    reply = client.post("/mcp", json=_rpc("tools/call", {
        "name": "dia_manual", "arguments": {},
    })).json()
    assert reply["result"]["isError"] is False
    assert reply["result"]["content"][0]["type"] == "text"


@http_only
def test_http_mcp_resources_read_editor(client, monkeypatch, tmp_path):
    fake = tmp_path / "diastil.html"
    fake.write_text("<html><body>fake editor</body></html>", encoding="utf-8")
    monkeypatch.setenv("DIA_MCP_APP_HTML", str(fake))

    reply = client.post("/mcp", json=_rpc("resources/read", {
        "uri": mcp.EDITOR_RESOURCE_URI,
    })).json()
    assert "fake editor" in reply["result"]["contents"][0]["text"]


@http_only
def test_http_mcp_notification_returns_202(client):
    # Notifications have no id, and per JSON-RPC 2.0 the transport
    # sends nothing back — 202 with an empty body is the HTTP echo of that.
    resp = client.post("/mcp", json={"jsonrpc": "2.0", "method": "ping"})
    assert resp.status_code == 202
    assert resp.content == b""


@http_only
def test_http_mcp_unknown_method_returns_jsonrpc_error(client):
    reply = client.post("/mcp", json=_rpc("no/such/method")).json()
    assert reply["error"]["code"] == -32601
