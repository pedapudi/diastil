"""biblatex's classic-bibtex compatibility backend (issue #23).

`backend=bibtex` compiles cleanly — exit 0, a real PDF — but the citation
TEXT can be silently wrong (biblatex.bst is not fully supported by classic
bibtex). These tests hold two things to account: the detection predicate
against real captured `.log`/`.blg` text, and that a full CompileJob run
actually surfaces the finding instead of reporting a clean `ok`.
"""

from __future__ import annotations

import stat
import sys
from pathlib import Path

from dia_service import tex, texcompile
from dia_service.texcompile import biblatex_bibtex_backend_finding

from conftest import LOGS

HELLO = "\\documentclass{article}\\begin{document}hi\\end{document}\n"

BACKEND_BIBTEX_SOURCE = (
    "\\documentclass{article}\n"
    "\\usepackage[backend=bibtex,style=numeric]{biblatex}\n"
    "\\addbibresource{refs.bib}\n"
    "\\begin{document}\\textcite{lamport1994}\\printbibliography\\end{document}\n"
)


def read(name: str) -> str:
    return (LOGS / name).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# the pure predicate
# ---------------------------------------------------------------------------

def test_fires_on_source_alone():
    """Checkable before ever compiling — the source pins the backend."""
    finding = biblatex_bibtex_backend_finding(source=BACKEND_BIBTEX_SOURCE)
    assert finding is not None
    assert finding.level == "warning"
    assert "backend=bibtex" in finding.message
    # installing biber does not fix this document — say so, or a user
    # installs it and is baffled when nothing changes
    assert "not fix this" in finding.message


def test_fires_on_a_real_captured_log_alone():
    """biblatex.sty's own warning, captured on a real tectonic compile of
    corpus/tex/biblatex/biblatex.tex — see the fixture file for provenance."""
    finding = biblatex_bibtex_backend_finding(log=read("biblatex-bibtex-fallback.log"))
    assert finding is not None


def test_fires_on_a_real_captured_blg_alone():
    """classic bibtex refusing biblatex.bst, captured the same way."""
    finding = biblatex_bibtex_backend_finding(blg=read("biblatex-bibtex-fallback.blg"))
    assert finding is not None


def test_a_clean_document_is_silent():
    assert biblatex_bibtex_backend_finding(
        source=HELLO, log=read("warnings.log"), blg="") is None
    assert biblatex_bibtex_backend_finding() is None


def test_biblatex_on_the_default_backend_is_silent():
    """No `backend=bibtex` in the options — this document uses biber, the
    one path that is not this bug."""
    source = "\\usepackage[style=numeric]{biblatex}\n"
    assert biblatex_bibtex_backend_finding(source=source) is None


# ---------------------------------------------------------------------------
# a full compile job
# ---------------------------------------------------------------------------

def _stub_engine(tmp_path: Path, *, log: str = "", blg: str | None = None,
                  pdf: bool = True) -> Path:
    """An engine stand-in that writes exactly the given artifacts, so a
    CompileJob can be driven through real captured text without a real
    tectonic or biber anywhere on this machine."""
    lines = [f"#!{sys.executable}", "import sys"]
    lines.append(f"open('main.log', 'w', encoding='utf-8').write({log!r})")
    if blg is not None:
        lines.append(f"open('main.blg', 'w', encoding='utf-8').write({blg!r})")
    if pdf:
        lines.append("open('main.pdf', 'wb').write(b'%PDF-1.4\\n%%EOF\\n')")
    else:
        lines.append("sys.exit(1)")
    script = tmp_path / "fake-tex"
    script.write_text("\n".join(lines) + "\n", encoding="utf-8")
    script.chmod(script.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return script


def _use(monkeypatch, path: Path, engine: str = "tectonic") -> None:
    monkeypatch.setattr(tex, "discover", lambda **_: tex.TexCapability(
        engine=engine, path=str(path), version="fake-tex 1.0", synctex=True))


def test_ok_compile_still_warns_when_the_backend_is_degraded(tmp_path, monkeypatch):
    """The exact regression this issue is about: status stays 'ok' (a real
    PDF was produced, and lying about that would be its own dishonesty) but
    the compile is no longer SILENT — a warning finding rides along."""
    engine = _stub_engine(
        tmp_path,
        log=read("biblatex-bibtex-fallback.log"),
        blg=read("biblatex-bibtex-fallback.blg"),
    )
    _use(monkeypatch, engine)
    job = texcompile.compile_sync(tex_source=BACKEND_BIBTEX_SOURCE, doc_id="d1")
    assert job.status == "ok"
    warnings = [e for e in job.errors if e.level == "warning"]
    assert any("backend=bibtex" in w.message for w in warnings)
    job.cleanup()


def test_a_document_with_no_bibliography_never_warns(tmp_path, monkeypatch):
    engine = _stub_engine(tmp_path, log="This is fake-tex\nOutput written on main.pdf (1 page, 1 bytes).\n")
    _use(monkeypatch, engine)
    job = texcompile.compile_sync(tex_source=HELLO, doc_id="d1")
    assert job.status == "ok"
    assert job.errors == []
    job.cleanup()


def test_the_default_backend_failing_loudly_is_not_this_finding(tmp_path, monkeypatch):
    """The OTHER shape a document without biber can take, and NOT this
    issue: biblatex's default (biber) backend, with no biber installed.
    Verified on a real compile (this repo's own managed tectonic, no biber
    on PATH) — tectonic already refuses to produce a PDF at all (exit 1,
    'error: No such file or directory' looking for the biber binary), which
    is an honest failure already. No finding should ride along with an
    outcome that was never silent in the first place."""
    engine = _stub_engine(
        tmp_path,
        log="This is XeTeX\n(./main.tex\nPackage biblatex Warning: Please (re)run Biber on the file:\n(biblatex)                main\n(biblatex)                and rerun LaTeX afterwards.\n",
        pdf=False,
    )
    _use(monkeypatch, engine)
    job = texcompile.compile_sync(tex_source="\\usepackage{biblatex}\n" + HELLO, doc_id="d1")
    assert job.status == "error"
    assert not job.pdf_path.exists()
    assert not any("backend=bibtex" in e.message for e in job.errors)
