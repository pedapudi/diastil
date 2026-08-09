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
    # A loopback Host, because the disk bridges refuse anything else (the
    # DNS-rebinding defence): a name that resolves to 127.0.0.1 sends a
    # non-loopback Host, and that is exactly what these endpoints decline.
    with TestClient(main.app, base_url="http://127.0.0.1:8317") as c:
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


# ---------------------------------------------------------------------------
# /project/file — a multi-file document's other .tex files
# ---------------------------------------------------------------------------

@pytest.fixture
def project(tmp_path):
    """A CLI-opened main file with one \\input'd chapter beside it."""
    root = tmp_path / "thesis"
    (root / "chapters").mkdir(parents=True)
    main_tex = root / "thesis.tex"
    main_tex.write_text("\\documentclass{book}\n\\input{chapters/intro}\n")
    (root / "chapters" / "intro.tex").write_text("\\chapter{Intro}\n")
    (root / "secret.env").write_text("TOKEN=hunter2")
    main.OPENED_FILES.add(main_tex.resolve())
    try:
        yield root, str(main_tex.resolve())
    finally:
        main.OPENED_FILES.discard(main_tex.resolve())


def test_reads_a_chapter_relative_to_the_opened_main_file(client, project):
    root, main_path = project
    r = client.get("/project/file", params={"main": main_path, "path": "chapters/intro.tex"})
    assert r.status_code == 200
    assert r.json()["tex"] == "\\chapter{Intro}\n"


def test_writes_a_chapter_back(client, project):
    """The half that matters most: an edit that shows on screen and never
    reaches disk is worse than one that never happened."""
    root, main_path = project
    r = client.put("/project/file", json={
        "main": main_path, "path": "chapters/intro.tex", "tex": "\\chapter{Edited}\n"})
    assert r.status_code == 200
    assert (root / "chapters" / "intro.tex").read_text() == "\\chapter{Edited}\n"


def test_the_main_file_must_have_been_opened_by_the_cli(client, project, tmp_path):
    _, main_path = project
    stranger = tmp_path / "elsewhere.tex"
    stranger.write_text("x")
    r = client.get("/project/file",
                   params={"main": str(stranger), "path": "chapters/intro.tex"})
    assert r.status_code == 403


@pytest.mark.parametrize("bad", [
    "../../etc/passwd",
    "/etc/passwd",
    "chapters/../../escape.tex",
    "",
])
def test_refuses_paths_that_leave_the_project(client, project, bad):
    _, main_path = project
    r = client.get("/project/file", params={"main": main_path, "path": bad})
    assert r.status_code in (400, 404, 422)


def test_serves_tex_only(client, project):
    """The bridge exists to serve \\input. Handing back any file beside the
    document is a different, larger promise."""
    _, main_path = project
    r = client.get("/project/file", params={"main": main_path, "path": "secret.env"})
    assert r.status_code == 400
    w = client.put("/project/file",
                   json={"main": main_path, "path": "secret.env", "tex": "pwn"})
    assert w.status_code == 400


def test_the_main_file_keeps_its_own_door(client, project):
    _, main_path = project
    r = client.get("/project/file", params={"main": main_path, "path": "thesis.tex"})
    assert r.status_code == 400


def test_does_not_scaffold_missing_directories(client, project):
    _, main_path = project
    r = client.put("/project/file",
                   json={"main": main_path, "path": "nowhere/new.tex", "tex": "x"})
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# /project/file is a WRITER, so it does not answer an origin anyone can mint
# ---------------------------------------------------------------------------

def test_project_file_refuses_an_opaque_origin(tmp_path):
    """A sandboxed iframe on any site sends `Origin: null`. This endpoint
    writes .tex anywhere under the opened document's directory, so it declines
    that caller server-side — never relying on the CORS list, which a config
    may loosen for /skills (issue #25)."""
    from fastapi.testclient import TestClient
    from dia_service.main import app, OPENED_FILES

    main_tex = tmp_path / "thesis.tex"
    main_tex.write_text("\\documentclass{book}\n", encoding="utf-8")
    chapter_dir = tmp_path / "chapters"
    chapter_dir.mkdir()
    chapter = chapter_dir / "intro.tex"
    chapter.write_text("original\n", encoding="utf-8")
    OPENED_FILES.add(main_tex.resolve())
    try:
        c = TestClient(app, base_url="http://127.0.0.1:8317")

        r = c.put("/project/file", headers={"Origin": "null"}, json={
            "main": str(main_tex), "path": "chapters/intro.tex", "tex": "PWNED"})
        assert r.status_code == 403
        assert chapter.read_text(encoding="utf-8") == "original\n"

        r = c.get(f"/project/file?main={main_tex}&path=chapters/intro.tex",
                  headers={"Origin": "null"})
        assert r.status_code == 403

        # the editor the daemon serves is unaffected: a real loopback origin
        r = c.put("/project/file", headers={"Origin": "http://127.0.0.1:8317"}, json={
            "main": str(main_tex), "path": "chapters/intro.tex", "tex": "edited\n"})
        assert r.status_code == 200, r.text
        assert chapter.read_text(encoding="utf-8") == "edited\n"

        # and so is a native caller, which sends no Origin at all
        r = c.get(f"/project/file?main={main_tex}&path=chapters/intro.tex")
        assert r.status_code == 200
        assert r.json()["tex"] == "edited\n"
    finally:
        OPENED_FILES.discard(main_tex.resolve())


# ---------------------------------------------------------------------------
# /file is a read AND write disk bridge — issue #25. It is the residual the
# CORS "null" allowance left exposed: a drive-by page mints an opaque origin
# with <iframe sandbox> and reaches the exact file the CLI opened. The bridge
# now refuses that caller itself, because CORS says who may READ a response,
# never who may ACT.
# ---------------------------------------------------------------------------

def test_file_bridge_refuses_an_opaque_origin(tmp_path):
    """`Origin: null` — a sandboxed iframe on any site — cannot read or
    overwrite the CLI-opened file. The same-origin editor (loopback Origin)
    and a native caller (no Origin) are unaffected."""
    from fastapi.testclient import TestClient
    from dia_service.main import app, OPENED_FILES

    deck = tmp_path / "deck.html"
    deck.write_text("<html>original</html>", encoding="utf-8")
    OPENED_FILES.add(deck.resolve())
    try:
        c = TestClient(app, base_url="http://127.0.0.1:8317")

        # the drive-by write is refused and the file is untouched
        r = c.put("/file", headers={"Origin": "null"},
                  json={"path": str(deck), "html": "<html>PWNED</html>"})
        assert r.status_code == 403
        assert deck.read_text(encoding="utf-8") == "<html>original</html>"

        # the drive-by read is refused — and because it is refused BEFORE the
        # allowlist check, the 403 body is no longer a path-enumeration oracle
        r = c.get(f"/file?path={deck}", headers={"Origin": "null"})
        assert r.status_code == 403

        # the editor the daemon serves at /editor sends a real loopback Origin
        r = c.get(f"/file?path={deck}", headers={"Origin": "http://127.0.0.1:8317"})
        assert r.status_code == 200
        assert r.json()["html"] == "<html>original</html>"

        r = c.put("/file", headers={"Origin": "http://127.0.0.1:8317"},
                  json={"path": str(deck), "html": "<html>edited</html>"})
        assert r.status_code == 200
        assert deck.read_text(encoding="utf-8") == "<html>edited</html>"

        # a native caller (dia CLI, curl) sends no Origin at all
        r = c.get(f"/file?path={deck}")
        assert r.status_code == 200
    finally:
        OPENED_FILES.discard(deck.resolve())


def test_file_bridge_refuses_a_rebinding_host(tmp_path):
    """DNS rebinding sidesteps Origin: the attacker's own domain resolves to
    127.0.0.1, so the request is same-origin and carries no cross-origin
    Origin. The bridge therefore also insists it was addressed as loopback —
    the same defence /mcp already applies."""
    from fastapi.testclient import TestClient
    from dia_service.main import app, OPENED_FILES

    deck = tmp_path / "deck.html"
    deck.write_text("<html>original</html>", encoding="utf-8")
    OPENED_FILES.add(deck.resolve())
    try:
        c = TestClient(app, base_url="http://attacker.example")
        r = c.put("/file", json={"path": str(deck), "html": "<html>PWNED</html>"})
        assert r.status_code == 403
        assert deck.read_text(encoding="utf-8") == "<html>original</html>"

        r = c.get(f"/file?path={deck}")
        assert r.status_code == 403
    finally:
        OPENED_FILES.discard(deck.resolve())


def test_default_cors_allowlist_excludes_the_null_origin():
    """The opaque origin is DELIBERATELY not in the shipped defaults: it is
    what any site mints with <iframe sandbox>, so its presence would hand a
    drive-by page a preflight pass to /skills/* (token burn). A user who
    wants the file:// standalone to reach the skills opts in explicitly."""
    from dia_service import main
    assert "null" not in main._DEFAULT_ORIGINS


def test_skills_refuse_a_rebinding_host_before_spending_tokens(monkeypatch):
    """/skills/* spends model tokens, so it must gate the caller, not lean on
    CORS alone. A DNS-rebound page reaches the daemon same-origin with a
    non-loopback Host; the skill declines it BEFORE the model runs. A loopback
    caller passes the gate and reaches the model as before."""
    from fastapi.testclient import TestClient
    from dia_service import main

    calls = []

    async def _fake_skill(skill, prompt, images, root):
        calls.append(skill)
        return "<section>ok</section>", ""

    monkeypatch.setattr(main, "_run_html_skill", _fake_skill)
    body = {"sourceHtml": "<section>x</section>", "tokensCss": ""}

    # DNS-rebound Host — refused, and the model is never touched
    c = TestClient(main.app, base_url="http://attacker.example")
    r = c.post("/skills/translate-slide", json=body)
    assert r.status_code == 403
    assert calls == []

    # loopback Host — the real editor's address — passes the gate
    c = TestClient(main.app, base_url="http://127.0.0.1:8317")
    r = c.post("/skills/translate-slide", json=body)
    assert r.status_code == 200, r.text
    assert calls == ["translate-slide"]
