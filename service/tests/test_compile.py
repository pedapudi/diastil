"""End-to-end compile jobs against the fake engine.

The fake writes a log, a synctex and a PDF exactly like a real engine
would, so everything between "here is some LaTeX" and "here is a PDF" is
under test: argv construction, the workdir, streamed events, timeouts,
supersede-per-document, and LRU eviction with its temp directories.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from dia_service import tex, texcompile

from conftest import LOGS

HELLO ="\\documentclass{article}\\begin{document}hi\\end{document}\n"


@pytest.fixture
def engine(fake_engine, monkeypatch):
    """Make discovery return the fake, named as a real engine so the argv
    builder is exercised for real."""
    def use(name: str = "tectonic") -> str:
        monkeypatch.setattr(tex, "discover", lambda **_: tex.TexCapability(
            engine=name, path=str(fake_engine), version="fake-tex 1.0",
            synctex=True, downloadable=False,
        ))
        return name
    use()
    return use


def test_compile_produces_a_pdf(engine):
    job = texcompile.compile_sync(tex_source=HELLO, doc_id="d1")
    assert job.status == "ok"
    assert job.pdf_path.is_file()
    assert job.pages == 1
    assert (job.workdir / "main.tex").read_text() == HELLO
    # warnings from the engine's log come back structured
    assert [(e.level, e.line) for e in job.errors] == [("warning", 4)]
    job.cleanup()


def test_failing_document_is_an_outcome_not_an_exception(engine):
    job = texcompile.compile_sync(tex_source="%FAIL\n" + HELLO, doc_id="d1")
    assert job.status == "error"
    assert not job.pdf_path.exists()
    assert [(e.file, e.line, e.level) for e in job.errors] == [("./main.tex", 3, "error")]
    job.cleanup()


def test_raw_engines_run_twice_and_tectonic_once(engine):
    engine("tectonic")
    job = texcompile.compile_sync(tex_source=HELLO, doc_id="d1")
    assert (job.workdir / "passes").read_text() == "1"
    job.cleanup()

    engine("pdflatex")
    job = texcompile.compile_sync(tex_source=HELLO, doc_id="d2")
    assert (job.workdir / "passes").read_text() == "2"
    job.cleanup()


def test_argv_per_engine():
    assert texcompile.engine_argv("tectonic", "/e") == [
        "/e", "-X", "compile", "--synctex", "--keep-logs", "--outdir", ".", "main.tex"]
    assert texcompile.engine_argv("latexmk", "/e") == [
        "/e", "-pdf", "-synctex=1", "-interaction=nonstopmode", "-file-line-error",
        "-output-directory=.", "main.tex"]
    for raw in ("xelatex", "pdflatex"):
        assert texcompile.engine_argv(raw, "/e") == [
            "/e", "-synctex=1", "-interaction=nonstopmode", "-file-line-error",
            "main.tex"]
    with pytest.raises(texcompile.CompileError):
        texcompile.engine_argv("luatex-but-we-never-said-so", "/e")


def test_events_tell_the_whole_story(engine):
    seen: list[dict] = []
    job = texcompile.compile_sync(tex_source=HELLO, doc_id="d1", on_log=seen.append)
    kinds = [e["type"] for e in seen]
    assert kinds[0] == "phase" and kinds[-1] == "done"
    assert any(e["type"] == "log" and "wrote main.pdf" in e["line"] for e in seen)
    assert seen[-1]["status"] == "ok"
    assert job.events == seen
    job.cleanup()


def test_timeout_kills_the_engine(engine, monkeypatch):
    monkeypatch.setattr(tex, "timeout_s", lambda *_: 1.0)
    job = texcompile.compile_sync(tex_source="%HANG\n" + HELLO, doc_id="d1")
    assert job.status == "timeout"
    assert "exceeded 1s" in job.detail
    job.cleanup()


def test_synctex_comes_back_parsed(engine):
    job = texcompile.compile_sync(tex_source=HELLO, doc_id="d1")
    assert job.synctex_path is not None
    out = texcompile.parse_synctex(job.synctex_path)
    assert out["lines"] == [
        {"line": 4, "page": 1, "x": 72.27, "y": 79.5, "w": 469.75}]
    job.cleanup()


def test_texinputs_points_at_the_document_directory(engine, tmp_path):
    figures = tmp_path / "paper"
    figures.mkdir()
    job = texcompile.create(tex_source=HELLO, doc_id="d1", texinputs_dir=figures)
    env = job._env()
    assert env["TEXINPUTS"].startswith(f".:{figures}:")
    job.cleanup()

    # and stays unset when no directory was granted
    plain = texcompile.create(tex_source=HELLO, doc_id="d2")
    assert plain._env() is None
    plain.cleanup()


# ---------------------------------------------------------------------------
# file identity: which of the job's files a finding may name
# ---------------------------------------------------------------------------

CHAPTERS = {
    "chapters/intro.tex": "\\section{Introduction}\n\nShort on purpose.\n",
    "chapters/method.tex": "\\section{Method}\n" + "\nProse.\n" * 12 + "\n\\gradiant{f}\n",
    "chapters/results.tex": "\\section{Results}\n\nAlso short.\n",
}


def test_the_source_map_keys_chapters_the_way_the_client_does(engine):
    """Project-relative, posix, extension included — the same string the
    client sent as an asset name and the same one \\input resolves."""
    job = texcompile.create(tex_source=HELLO, doc_id="d1", assets=dict(CHAPTERS))
    sources = job.sources()
    assert set(sources.lines) == {"main.tex", *CHAPTERS}
    assert sources.lines["chapters/intro.tex"] == 3
    assert sources.root == "main.tex"
    job.cleanup()


def test_the_source_map_follows_the_symlinked_document_folder(engine, tmp_path):
    """The CLI path never sends chapters as assets — it puts the document's
    own folder in front of the engine, and the walk has to see through the
    symlinks that puts there."""
    paper = tmp_path / "paper"
    (paper / "chapters").mkdir(parents=True)
    for name, text in CHAPTERS.items():
        (paper / name).write_text(text, encoding="utf-8")
    (paper / "paper.tex").write_text(HELLO, encoding="utf-8")
    (paper / "notes.txt").write_text("not a source\n", encoding="utf-8")

    job = texcompile.create(tex_source=HELLO, doc_id="d1", texinputs_dir=paper)
    lines = job.sources().lines
    assert set(CHAPTERS) <= set(lines)
    assert "notes.txt" not in lines  # only .tex is a place the editor jumps
    job.cleanup()


def test_a_real_chapter_error_survives_the_whole_job(engine, monkeypatch):
    """The golden log is real tectonic 0.15.0 output (see test_parse_log);
    replaying it through a job with the same chapters laid out is what shows
    the workdir walk and the parser agreeing end to end."""
    monkeypatch.setenv("DIA_FAKE_LOG", str(LOGS / "multifile-chapter-error.log"))
    method = "\\section{Method}\n" + "\nProse.\n" * 13 + "\n\\gradiant{f}\n"
    assert method.count("\n") == 29  # the log's `l.29` is this file's last line
    job = texcompile.compile_sync(
        tex_source="x\n" * 16, doc_id="d1",
        assets={**CHAPTERS, "chapters/method.tex": method})
    assert job.status == "error"
    assert [(e.file, e.line, e.message) for e in job.errors] == [
        ("chapters/method.tex", 29, "Undefined control sequence.")]
    # the temp workdir is the daemon's business, not the client's
    assert str(job.workdir) not in str(job.status_dict())
    job.cleanup()


# ---------------------------------------------------------------------------
# job registry
# ---------------------------------------------------------------------------

def test_one_active_job_per_document(engine):
    first = texcompile.create(tex_source=HELLO, doc_id="paper")
    second = texcompile.create(tex_source=HELLO, doc_id="paper")
    # the newer POST supersedes: the older job is cancelled, not left racing
    assert first._cancelled is True
    assert second._cancelled is False
    assert texcompile.get(first.id) is first
    assert texcompile.get(second.id) is second


def test_cancel_lands_even_before_the_engine_spawns(engine, monkeypatch):
    """The regression this guards: cancelling in the window between submit()
    and Popen used to set a flag nobody read again, leaving a real engine
    running until its timeout — invisibly, since the job said 'cancelled'."""
    import time

    monkeypatch.setattr(tex, "timeout_s", lambda *_: 30.0)
    job = texcompile.submit(tex_source="%HANG\n" + HELLO, doc_id="d1")
    job.cancel()
    deadline = time.monotonic() + 10
    while not job.finished and time.monotonic() < deadline:
        time.sleep(0.02)
    assert job.finished, "cancel did not stop the job"
    assert job.status == "cancelled"
    assert job.duration < 10
    job.cleanup()


def test_lru_keeps_four_jobs_and_deletes_their_workdirs(engine):
    jobs = [texcompile.create(tex_source=HELLO, doc_id=f"d{i}") for i in range(6)]
    assert [texcompile.get(j.id) is not None for j in jobs] == \
        [False, False, True, True, True, True]
    for evicted in jobs[:2]:
        assert not evicted.workdir.exists()
    for kept in jobs[2:]:
        assert kept.workdir.is_dir()


def test_no_engine_is_a_clean_refusal(monkeypatch):
    monkeypatch.setattr(tex, "discover", lambda **_: tex.TexCapability(
        detail="no TeX engine found"))
    with pytest.raises(texcompile.CompileError, match="no TeX engine"):
        texcompile.create(tex_source=HELLO, doc_id="d1")


def test_requested_engine_must_exist(engine, monkeypatch):
    monkeypatch.setattr("shutil.which", lambda _name: None)
    with pytest.raises(texcompile.CompileError, match="not installed"):
        texcompile.create(tex_source=HELLO, doc_id="d1", engine="xelatex")
    with pytest.raises(texcompile.CompileError, match="unknown engine"):
        texcompile.create(tex_source=HELLO, doc_id="d1", engine="/bin/sh")


def test_pdfoutput_neutralized_for_xetex_engines():
    """arXiv's `\\pdfoutput=1` boilerplate breaks hyperref driver detection
    under XeTeX (hpdftex.def loads and dies); the workdir copy comments it."""
    from dia_service.texcompile import _adapt_source_for_engine

    src = "% arXiv hint\n\\pdfoutput=1\n\\documentclass{article}\n"
    out = _adapt_source_for_engine(src, "tectonic")
    assert "% \\pdfoutput=1" in out
    assert "\n\\pdfoutput=1\n" not in out
    # pdftex-family engines keep the line — it is correct there
    assert _adapt_source_for_engine(src, "pdflatex") == src
    # only a whole-line assignment is touched, nothing mid-document
    prose = "text about \\pdfoutput=1 in prose\n"
    assert _adapt_source_for_engine(prose, "tectonic") == prose
