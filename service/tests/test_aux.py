"""texcompile.aux_text and GET /compile/{id}/aux — the engine's own
numbering, served verbatim for the client to parse (src/doc/auxnumbers.ts).

The fake engine writes no .aux, so these tests put one in the job's workdir
by hand; what is being pinned is the READING (root plus \\@input'd chapter
auxes, and the workdir containment around them), not the compiling."""

from __future__ import annotations

import pytest

pytest.importorskip("httpx", reason="TestClient needs httpx")

from fastapi.testclient import TestClient  # noqa: E402

from dia_service import main, tex, texcompile  # noqa: E402

HELLO = "\\documentclass{article}\\begin{document}hi\\end{document}\n"
# the shape a real compile writes: number and page, and with hyperref the
# title and the anchor too (measured, tectonic 0.15.0)
AUX = (
    "\\relax \n"
    "\\newlabel{sec:a}{{1}{1}}\n"
    "\\newlabel{sec:app}{{A}{2}{Appendix}{appendix.A}{}}\n"
)


@pytest.fixture
def client():
    with TestClient(main.app) as c:
        yield c


@pytest.fixture
def engine(fake_engine, monkeypatch):
    monkeypatch.setattr(tex, "discover", lambda **_: tex.TexCapability(
        engine="tectonic", path=str(fake_engine), version="fake-tex 1.0",
        synctex=True, downloadable=True))


def test_no_aux_is_404(client, engine):
    job_id = client.post("/compile", json={"texSource": HELLO, "docId": "d1"}).json()["jobId"]
    client.get(f"/compile/{job_id}/events")  # drain to `done` before asserting
    assert client.get(f"/compile/{job_id}/aux").status_code == 404


def test_aux_is_served_verbatim(client, engine):
    job_id = client.post("/compile", json={"texSource": HELLO, "docId": "d1"}).json()["jobId"]
    client.get(f"/compile/{job_id}/events")
    job = texcompile.get(job_id)
    (job.workdir / "main.aux").write_text(AUX, encoding="utf-8")

    res = client.get(f"/compile/{job_id}/aux")
    assert res.status_code == 200
    assert res.text == AUX
    assert res.headers["content-type"].startswith("text/plain")


def test_unknown_job_is_404(client):
    assert client.get("/compile/nosuchjob/aux").status_code == 404


def test_input_chapter_auxes_are_concatenated(tmp_path):
    """\\include (not \\input) gives each chapter its own .aux and leaves the
    root holding only `\\@input{chapters/one.aux}` — measured on a report
    compiled with the managed tectonic. Following it here is what lets the
    client stay a single-text parser for both multi-file shapes."""
    (tmp_path / "chapters").mkdir()
    (tmp_path / "main.aux").write_text(
        "\\relax \n\\@input{chapters/one.aux}\n\\newlabel{sec:root}{{1.2}{2}}\n",
        encoding="utf-8")
    (tmp_path / "chapters" / "one.aux").write_text(
        "\\newlabel{ch:in}{{1}{1}}\n", encoding="utf-8")

    text = texcompile.aux_text(tmp_path)
    assert text is not None
    assert "\\newlabel{sec:root}" in text
    assert "\\newlabel{ch:in}" in text


def test_missing_root_aux_is_none(tmp_path):
    assert texcompile.aux_text(tmp_path) is None


def test_at_input_cycles_terminate(tmp_path):
    """A self-referential \\@input chain costs a numbering, never a hung
    request — the visited set is what stops it."""
    (tmp_path / "main.aux").write_text(
        "\\@input{other.aux}\n\\newlabel{a}{{1}{1}}\n", encoding="utf-8")
    (tmp_path / "other.aux").write_text(
        "\\@input{main.aux}\n\\newlabel{b}{{2}{1}}\n", encoding="utf-8")

    text = texcompile.aux_text(tmp_path)
    assert text is not None
    assert text.count("\\newlabel{a}") == 1
    assert text.count("\\newlabel{b}") == 1


def test_at_input_cannot_escape_the_workdir(tmp_path):
    """An .aux is engine output, but it is output shaped by an untrusted
    document — a \\@input pointing outside the workdir is refused."""
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.aux").write_text("\\newlabel{leak}{{9}{9}}\n", encoding="utf-8")
    workdir = tmp_path / "work"
    workdir.mkdir()
    (workdir / "main.aux").write_text(
        "\\@input{../outside/secret.aux}\n\\newlabel{ok}{{1}{1}}\n", encoding="utf-8")

    text = texcompile.aux_text(workdir)
    assert text is not None
    assert "\\newlabel{ok}" in text
    assert "leak" not in text
