"""The HTTP surface, driven through FastAPI's TestClient.

Covers the wiring the unit tests cannot see: status codes, the SSE framing
the editor's sseData() expects, and the OPENED_FILES gate on TEXINPUTS.
"""

from __future__ import annotations

import json

import pytest

pytest.importorskip("httpx", reason="TestClient needs httpx")

from fastapi.testclient import TestClient  # noqa: E402

from dia_service import main, tex, texcompile  # noqa: E402

HELLO = "\\documentclass{article}\\begin{document}hi\\end{document}\n"


@pytest.fixture
def client():
    with TestClient(main.app) as c:
        yield c


@pytest.fixture
def engine(fake_engine, monkeypatch):
    monkeypatch.setattr(tex, "discover", lambda **_: tex.TexCapability(
        engine="tectonic", path=str(fake_engine), version="fake-tex 1.0",
        synctex=True, downloadable=True))


def frames(text: str) -> list[dict]:
    return [json.loads(line[6:]) for line in text.splitlines()
            if line.startswith("data: ")]


def test_health_reports_tex(client, engine):
    body = client.get("/health").json()
    assert body["tex"] == {
        "engine": "tectonic", "path": body["tex"]["path"], "version": "fake-tex 1.0",
        "synctex": True, "downloadable": True, "managed": False, "detail": None,
        # this capability is about poppler, not the engine — see test_pages.py
        "pageRender": False,
        # and this one is about biber, not the engine either — see test_discover.py
        "biber": False,
    }
    # the pre-existing keys are untouched
    assert "ok" in body


def test_health_on_a_machine_with_no_tex(client, monkeypatch, fake_path):
    monkeypatch.setenv("PATH", str(fake_path))
    tex.reset_cache()
    capability = client.get("/health").json()["tex"]
    assert capability["engine"] is None
    assert capability["detail"] == "no TeX engine found"


def test_compile_to_pdf_and_synctex(client, engine):
    body = client.post("/compile", json={"texSource": HELLO, "docId": "d1"}).json()
    job_id = body["jobId"]
    assert body["engine"] == "tectonic"
    assert body["texinputs"] is False

    events = frames(client.get(f"/compile/{job_id}/events").text)
    assert events[0]["type"] == "phase"
    assert events[-1]["type"] == "done" and events[-1]["status"] == "ok"
    assert any(e["type"] == "log" for e in events)

    pdf = client.get(f"/compile/{job_id}/pdf")
    assert pdf.status_code == 200
    assert pdf.headers["content-type"] == "application/pdf"
    assert pdf.content.startswith(b"%PDF")

    body = client.get(f"/compile/{job_id}/synctex").json()
    assert body["lines"] == [
        {"line": 4, "page": 1, "x": 72.27, "y": 79.5, "w": 469.75}]
    # a client cropping a column must never have to guess the origin
    assert body["xSemantics"] == "leftPt" and body["ySemantics"] == "topDownPt"
    assert client.get(f"/compile/{job_id}").json()["status"] == "ok"


def test_failed_compile_has_no_pdf_but_has_errors(client, engine):
    job_id = client.post(
        "/compile", json={"texSource": "%FAIL\n" + HELLO, "docId": "d1"}).json()["jobId"]
    done = frames(client.get(f"/compile/{job_id}/events").text)[-1]
    assert done["status"] == "error"
    assert done["errors"][0]["line"] == 3
    assert client.get(f"/compile/{job_id}/pdf").status_code == 404


def test_traversal_is_422_and_no_engine_is_503(client, engine, monkeypatch):
    bad = client.post("/compile", json={
        "texSource": HELLO, "docId": "d1", "assets": {"../out.tex": "x"}})
    assert bad.status_code == 422 and "'..'" in bad.json()["detail"]

    monkeypatch.setattr(tex, "discover", lambda **_: tex.TexCapability(
        detail="no TeX engine found"))
    gone = client.post("/compile", json={"texSource": HELLO, "docId": "d1"})
    assert gone.status_code == 503


def test_unknown_job_is_404(client):
    for suffix in ("", "/pdf", "/synctex", "/events"):
        assert client.get(f"/compile/nosuchjob{suffix}").status_code == 404
    assert client.delete("/compile/nosuchjob").status_code == 404


def test_texinputs_only_for_cli_opened_files(client, engine, tmp_path):
    paper = tmp_path / "paper.tex"
    paper.write_text(HELLO, encoding="utf-8")
    payload = {"texSource": HELLO, "docId": "d1", "docPath": str(paper)}

    # not opened by the CLI: the compile still runs, it just gets no
    # read access to the user's directory
    assert client.post("/compile", json=payload).json()["texinputs"] is False

    main.OPENED_FILES.add(paper.resolve())
    try:
        assert client.post("/compile", json=payload).json()["texinputs"] is True
    finally:
        main.OPENED_FILES.discard(paper.resolve())


def test_cancel_stops_a_running_job(client, engine, monkeypatch):
    monkeypatch.setattr(tex, "timeout_s", lambda *_: 30.0)
    job_id = client.post(
        "/compile", json={"texSource": "%HANG\n" + HELLO, "docId": "d1"}).json()["jobId"]
    job = texcompile.get(job_id)
    assert client.delete(f"/compile/{job_id}").status_code == 200
    assert frames(client.get(f"/compile/{job_id}/events").text)[-1]["status"] == "cancelled"
    assert job.status == "cancelled"


def test_tex_refresh_reprobes(client, monkeypatch, fake_path):
    monkeypatch.setenv("PATH", str(fake_path))
    tex.reset_cache()
    assert client.post("/tex/refresh").json()["tex"]["engine"] is None
