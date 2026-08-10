"""biblatex's two ways of not producing correct citations (issue #23).

`backend=bibtex` compiles cleanly — exit 0, a real PDF — but the citation
TEXT can be silently wrong (biblatex.bst is not fully supported by classic
bibtex). The DEFAULT backend needs `biber`, a separate program nothing here
bundles or downloads, and without it the citations never resolve at all.
Both look like a broken document and neither is one, so both owe the user a
sentence. These tests hold two things to account for each: the detection
predicate against real captured `.log`/`.blg`/console text, and that a full
CompileJob run actually surfaces the finding.
"""

from __future__ import annotations

import stat
import sys
from pathlib import Path

from dia_service import tex, texcompile
from dia_service.texcompile import (
    biblatex_biber_missing_finding,
    biblatex_bibtex_backend_finding,
)

from conftest import LOGS

HELLO = "\\documentclass{article}\\begin{document}hi\\end{document}\n"

BACKEND_BIBTEX_SOURCE = (
    "\\documentclass{article}\n"
    "\\usepackage[backend=bibtex,style=numeric]{biblatex}\n"
    "\\addbibresource{refs.bib}\n"
    "\\begin{document}\\textcite{lamport1994}\\printbibliography\\end{document}\n"
)

DEFAULT_BACKEND_SOURCE = (
    "\\documentclass{article}\n"
    "\\usepackage[style=numeric]{biblatex}\n"
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


def test_the_default_backend_failure_is_the_other_finding(tmp_path, monkeypatch):
    """The OTHER shape a document without biber can take: the default
    (biber) backend with no biber installed. It is not this finding — that
    one is about a document that opted OUT of biber — and the two must not
    both fire on one compile, or the drawer contradicts itself."""
    engine = _stub_engine(tmp_path, log=read("biblatex-biber-missing.log"), pdf=False)
    _use(monkeypatch, engine)
    _no_biber(monkeypatch)
    job = texcompile.compile_sync(tex_source=DEFAULT_BACKEND_SOURCE, doc_id="d1")
    assert job.status == "error"
    assert not job.pdf_path.exists()
    assert not any("classic-bibtex compatibility" in e.message for e in job.errors)
    assert sum(1 for e in job.errors if "no biber is installed" in e.message) == 1
    job.cleanup()


# ---------------------------------------------------------------------------
# the default (biber) backend with no biber — the other half of the issue
# ---------------------------------------------------------------------------

def _no_biber(monkeypatch) -> None:
    """Pin "no biber on this machine" rather than inheriting it. The
    machine this was written on has none, which is exactly why the absence
    has to be stated: a test that passes only because a developer never
    installed biber is not a test."""
    monkeypatch.setattr(tex, "biber_path", lambda: None)


def test_biber_missing_fires_on_source_alone():
    """Checkable before ever compiling: no backend option means biber."""
    finding = biblatex_biber_missing_finding(source=DEFAULT_BACKEND_SOURCE)
    assert finding is not None
    # unlike the backend=bibtex case, installing biber IS the fix here
    assert "Installing biber is the fix" in finding.message
    # …and the obvious wrong turn away from it is named, because #27's
    # warning read backwards invites exactly that swap
    assert "backend=bibtex is not a fix" in finding.message


def test_biber_missing_fires_on_a_real_captured_log_alone():
    """biblatex.sty's own plea, from a real tectonic compile of
    corpus/tex/biblatex/biblatex.tex with the backend option removed."""
    assert biblatex_biber_missing_finding(log=read("biblatex-biber-missing.log")) is not None


def test_biber_missing_fires_on_the_engine_console_alone():
    """tectonic naming the tool it could not exec. This is the ONLY place
    the true cause is ever written — main.log, which replaces the console
    stream on disk, never mentions biber's absence at all."""
    console = read("biblatex-biber-missing-console.log")
    assert "No such file or directory" in console
    assert "No such file or directory" not in read("biblatex-biber-missing.log")
    assert biblatex_biber_missing_finding(console=console) is not None


def test_an_installed_biber_is_never_told_to_install_biber():
    """The whole predicate hangs off this: a machine WITH biber that failed
    for some other reason must not be handed a remedy it already has."""
    assert biblatex_biber_missing_finding(
        source=DEFAULT_BACKEND_SOURCE,
        log=read("biblatex-biber-missing.log"),
        console=read("biblatex-biber-missing-console.log"),
        biber="/usr/bin/biber",
    ) is None


def test_a_pinned_bibtex_backend_vetoes_the_biber_finding():
    """`backend=bibtex` never runs biber, so its absence is irrelevant —
    that document is biblatex_bibtex_backend_finding's, and telling its
    author to install biber would be the precise lie #27 refused to tell."""
    assert biblatex_biber_missing_finding(source=BACKEND_BIBTEX_SOURCE) is None
    # bibtex8/bibtexu are the same opt-out under different names
    assert biblatex_biber_missing_finding(
        source="\\usepackage[backend=bibtex8]{biblatex}\n") is None
    # and the fall-back log the OTHER finding keys on must not reach this one
    assert biblatex_biber_missing_finding(
        log=read("biblatex-bibtex-fallback.log")) is None


def test_a_document_with_no_biblatex_is_silent():
    assert biblatex_biber_missing_finding(
        source=HELLO, log=read("warnings.log")) is None
    assert biblatex_biber_missing_finding() is None


def test_the_two_symptoms_are_described_separately():
    """A missing biber does different visible damage per engine, and the
    message says which one the user is looking at. Both measured: tectonic
    exits 1 with no PDF (biblatex-biber-missing-console.log), while a raw
    engine carries on and emits a PDF whose citations are all undefined and
    whose bibliography is empty (biblatex-biber-missing.log's own
    warnings). One wording for both would be wrong for one of them."""
    log = read("biblatex-biber-missing.log")
    no_pdf = biblatex_biber_missing_finding(log=log, pdf=False)
    with_pdf = biblatex_biber_missing_finding(log=log, pdf=True)
    assert no_pdf.level == "error"
    assert "no PDF at all" in no_pdf.message
    assert with_pdf.level == "warning"
    assert "empty list" in with_pdf.message
    assert "unaffected" in with_pdf.message


def test_the_version_lock_is_named_from_the_log():
    """biber and biblatex are version-locked, so "install biber" is only
    half an instruction. The version is read out of the log rather than
    hardcoded — the bundle moves, and a stale number is worse than none."""
    finding = biblatex_biber_missing_finding(log=read("biblatex-biber-missing.log"))
    assert "biblatex v3.17" in finding.message
    # no version in the log, no claim about versions
    assert "version-locked" not in biblatex_biber_missing_finding(
        source=DEFAULT_BACKEND_SOURCE).message


def test_a_failed_default_backend_compile_says_why(tmp_path, monkeypatch):
    """The regression this half of the issue is about. Measured before the
    fix, on a real tectonic compile with no biber: status 'error', detail
    None, and twenty findings — every one a warning, none naming biber, and
    one of them ("Please (re)run Biber") advice the user cannot act on.
    Now the cause is in the drawer, at error level so it sorts above the
    noise it explains."""
    engine = _stub_engine(tmp_path, log=read("biblatex-biber-missing.log"), pdf=False)
    _use(monkeypatch, engine)
    _no_biber(monkeypatch)
    job = texcompile.compile_sync(tex_source=DEFAULT_BACKEND_SOURCE, doc_id="d1")
    assert job.status == "error"
    errors = [e for e in job.errors if e.level == "error"]
    assert any("no biber is installed" in e.message for e in errors)
    job.cleanup()


def test_an_ok_default_backend_compile_still_warns(tmp_path, monkeypatch):
    """A raw engine produces a PDF anyway, and `ok` with an empty
    bibliography is the silent-wrong-output shape all over again."""
    script = _stub_engine(tmp_path, log=read("biblatex-biber-missing.log"))
    _use(monkeypatch, script, "xelatex")
    _no_biber(monkeypatch)
    job = texcompile.compile_sync(tex_source=DEFAULT_BACKEND_SOURCE, doc_id="d1")
    assert job.status == "ok"
    warnings = [e for e in job.errors if e.level == "warning"]
    assert any("no biber is installed" in w.message for w in warnings)
    job.cleanup()


def test_a_machine_with_biber_compiles_without_comment(tmp_path, monkeypatch):
    """Same document, same log, biber present: nothing to say."""
    engine = _stub_engine(tmp_path, log=read("biblatex-biber-missing.log"))
    _use(monkeypatch, engine)
    monkeypatch.setattr(tex, "biber_path", lambda: "/usr/bin/biber")
    job = texcompile.compile_sync(tex_source=DEFAULT_BACKEND_SOURCE, doc_id="d1")
    assert not any("no biber is installed" in e.message for e in job.errors)
    job.cleanup()
