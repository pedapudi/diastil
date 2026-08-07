"""parse_log against real-shaped engine logs.

The contract these pin down: a finding's file:line must be somewhere the
user can actually go. Missing a warning is cheap; inventing a location is
not, so every assertion here is about what got attached to what.
"""

from __future__ import annotations

from dia_service.texcompile import parse_log

from conftest import LOGS


def read(name: str) -> str:
    return (LOGS / name).read_text(encoding="utf-8")


def test_file_line_errors_carry_file_and_line():
    findings = parse_log(read("undefined-control-sequence.log"))
    errors = [f for f in findings if f.level == "error"]
    assert [(e.file, e.line) for e in errors] == [("./main.tex", 8), ("./main.tex", 12)]
    assert errors[0].message == "Undefined control sequence."


def test_boxes_are_dropped():
    findings = parse_log(read("undefined-control-sequence.log"))
    assert not [f for f in findings if "hbox" in f.message.lower()]
    findings = parse_log(read("warnings.log"))
    assert not [f for f in findings if "full" in f.message.lower()[:8]]


def test_bare_bang_errors_take_the_line_that_follows():
    findings = parse_log(read("missing-package.log"))
    errors = [f for f in findings if f.level == "error"]
    messages = [e.message for e in errors]
    assert messages == [
        "LaTeX Error: File `siunitx.sty' not found.",
        "Emergency stop.",
    ]
    # `l.4` closes the whole block: both records are true of line 4, and
    # pointing the user at the \usepackage is the entire value here
    assert [e.line for e in errors] == [4, 4]
    assert all(e.file is None for e in errors)


def test_warning_blocks_join_their_continuation_lines():
    findings = parse_log(read("warnings.log"))
    warnings = [f for f in findings if f.level == "warning"]
    assert len(warnings) == 4

    font = warnings[0]
    assert font.message == (
        "Font shape `OT1/cmr/bx/sc' undefined using `OT1/cmr/bx/n' instead "
        "on input line 21."
    )
    assert font.line == 21

    assert warnings[1].message.startswith("Reference `sec:method'")
    assert warnings[1].line == 34

    # the `(hyperref)` gutter is a continuation, not a new record
    assert warnings[2].line == 40
    assert "removing `\\textbf'" in warnings[2].message

    # a warning with no line at all keeps line=None rather than guessing
    assert warnings[3].message == "There were undefined references."
    assert warnings[3].line is None


def test_clean_log_yields_nothing():
    assert parse_log(
        "This is pdfTeX, Version 3.141592653\n"
        "(./main.tex (./main.aux) )\n"
        "Output written on main.pdf (3 pages, 40201 bytes).\n"
    ) == []


def test_noise_never_becomes_a_finding():
    """Lines that merely contain a colon and digits are not file:line
    records — this is the failure mode that sends a user to line 17 of a
    font definition."""
    noise = (
        "Document Class: article 2023/05/17 v1.4n Standard LaTeX document class\n"
        "(/usr/share/texlive/texmf-dist/tex/latex/base/size10.clo)\n"
        "Package: hyperref 2023-11-26 v7.01g\n"
        "LaTeX2e <2023-11-01> patch level 1\n"
        "[1{/usr/share/texmf/fonts/map/pdftex/updmap/pdftex.map}]\n"
    )
    assert parse_log(noise) == []
