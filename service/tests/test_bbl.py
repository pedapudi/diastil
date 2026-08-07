"""GET /compile/{id}/bbl — the raw bibliography the client resolves cite
text from. The fake engine never runs bibtex, so these tests write the
job's .bbl straight into its workdir rather than teach the stand-in a
bibliography it does not need for anything else it is asked to prove."""

from __future__ import annotations

import pytest

pytest.importorskip("httpx", reason="TestClient needs httpx")

from fastapi.testclient import TestClient  # noqa: E402

from dia_service import main, tex, texcompile  # noqa: E402

HELLO = "\\documentclass{article}\\begin{document}hi\\end{document}\n"
BBL = (
    "\\begin{thebibliography}{1}\n"
    "\\bibitem[{Brown et~al.(2020)Brown, Mann, and Ryder}]{brown2020gpt3}\n"
    "Tom Brown, Catherine Mann, and Nick Ryder. 2020.\n"
    "\\newblock Language models are few-shot learners.\n"
    "\\end{thebibliography}\n"
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


def test_no_bibliography_is_404(client, engine):
    job_id = client.post("/compile", json={"texSource": HELLO, "docId": "d1"}).json()["jobId"]
    client.get(f"/compile/{job_id}/events")  # drain to `done` before asserting
    assert client.get(f"/compile/{job_id}/bbl").status_code == 404


def test_bibtex_bbl_is_served_verbatim(client, engine):
    job_id = client.post("/compile", json={"texSource": HELLO, "docId": "d1"}).json()["jobId"]
    client.get(f"/compile/{job_id}/events")
    job = texcompile.get(job_id)
    (job.workdir / "main.bbl").write_text(BBL, encoding="utf-8")

    res = client.get(f"/compile/{job_id}/bbl")
    assert res.status_code == 200
    assert res.text == BBL
    assert res.headers["content-type"].startswith("text/plain")


def test_adopted_precompiled_bbl_is_served_too(client, engine):
    """_adopt_precompiled_bbl (texcompile.py) names the adopted copy
    diarefs.bbl, never main.bbl — the endpoint has to check both."""
    job_id = client.post("/compile", json={"texSource": HELLO, "docId": "d1"}).json()["jobId"]
    client.get(f"/compile/{job_id}/events")
    job = texcompile.get(job_id)
    (job.workdir / "diarefs.bbl").write_text(BBL, encoding="utf-8")

    res = client.get(f"/compile/{job_id}/bbl")
    assert res.status_code == 200
    assert res.text == BBL


def test_unknown_job_is_404(client):
    assert client.get("/compile/nosuchjob/bbl").status_code == 404
