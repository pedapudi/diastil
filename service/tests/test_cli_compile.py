"""`dia compile` — the headless surface.

Same job code as the endpoint, so these tests cover only what the CLI adds:
finding the LaTeX (a .tex file, or the JSON source block inside a dialect
document), the exit code, and the file:line error lines an agent or editor
parses back out of stderr.
"""

from __future__ import annotations

import json

import pytest

from dia_service import cli, tex

HELLO = "\\documentclass{article}\\begin{document}hi\\end{document}\n"


def artifact(source: str) -> str:
    """A dialect document artifact, minimal but shaped like the real one."""
    payload = json.dumps({"version": 1, "fileName": "paper.tex", "tex": source})
    # `<\/` is valid JSON for `</` and is what keeps a verbatim `</script>`
    # inside the document from closing the block that carries it
    payload = payload.replace("</", "<\\/")
    return (
        '<html lang="en" data-dia-doc-version="1"><head>'
        '<style id="dia-theme">:root{--dia-ink:#111}</style>'
        f'<script type="application/json" id="dia-source">{payload}</script>'
        '</head><body><article class="dia-doc"><p>hi</p></article></body></html>'
    )


@pytest.fixture
def engine(fake_engine, monkeypatch):
    monkeypatch.setattr(tex, "discover", lambda **_: tex.TexCapability(
        engine="tectonic", path=str(fake_engine), version="fake-tex 1.0",
        synctex=True))


def test_tex_from_html_recovers_the_source():
    # `</script>` is legal inside a verbatim environment — the JSON block
    # exists precisely so that byte survives the round trip
    source = "\\begin{verbatim}\n</script>\n\\end{verbatim}\n"
    assert cli.tex_from_html(artifact(source)) == (source, "")


def test_tex_from_html_complains_clearly():
    assert cli.tex_from_html("<html><body>a deck, not a doc</body></html>")[0] is None
    broken = artifact("x").replace('{"version"', '{version')
    assert "not valid JSON" in cli.tex_from_html(broken)[1]


def test_compile_a_tex_file(engine, tmp_path, capsys):
    src = tmp_path / "paper.tex"
    src.write_text(HELLO, encoding="utf-8")
    assert cli.cmd_compile(str(src), None, None, quiet=True) == 0
    assert (tmp_path / "paper.pdf").read_bytes().startswith(b"%PDF")
    assert "wrote" in capsys.readouterr().out


def test_compile_a_dialect_document(engine, tmp_path, capsys):
    doc = tmp_path / "paper.html"
    doc.write_text(artifact(HELLO), encoding="utf-8")
    out = tmp_path / "elsewhere.pdf"
    assert cli.cmd_compile(str(doc), str(out), None, quiet=True) == 0
    assert out.is_file()


def test_failure_exits_1_and_prints_file_line(engine, tmp_path, capsys):
    src = tmp_path / "bad.tex"
    src.write_text("%FAIL\n" + HELLO, encoding="utf-8")
    assert cli.cmd_compile(str(src), None, None, quiet=True) == 1
    err = capsys.readouterr().err
    assert "./main.tex:3: error: Undefined control sequence." in err
    assert not (tmp_path / "bad.pdf").exists()


def test_export_pdf_branch_delegates_to_compile(engine, tmp_path):
    doc = tmp_path / "paper.html"
    doc.write_text(artifact(HELLO), encoding="utf-8")
    assert cli.cmd_export(str(doc), None, pdf=str(tmp_path / "o.pdf")) == 0
    assert (tmp_path / "o.pdf").is_file()


def test_missing_input_exits_2(tmp_path, capsys):
    assert cli.cmd_compile(str(tmp_path / "nope.tex"), None, None) == 2
    assert "no such file" in capsys.readouterr().err


def test_no_engine_exits_2_with_a_way_forward(tmp_path, monkeypatch, capsys):
    src = tmp_path / "paper.tex"
    src.write_text(HELLO, encoding="utf-8")
    monkeypatch.setattr(tex, "discover", lambda **_: tex.TexCapability(
        detail="no TeX engine found", downloadable=True))
    assert cli.cmd_compile(str(src), None, None) == 2
    err = capsys.readouterr().err
    assert "no TeX engine found" in err and "tectonic" in err
