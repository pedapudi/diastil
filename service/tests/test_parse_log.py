"""parse_log against real-shaped engine logs.

The contract these pin down: a finding's file:line must be somewhere the
user can actually go. Missing a warning is cheap; inventing a location is
not, so every assertion here is about what got attached to what.
"""

from __future__ import annotations

from dia_service.texcompile import SourceMap, parse_log

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


# ---------------------------------------------------------------------------
# which FILE a finding came from
# ---------------------------------------------------------------------------
#
# multifile-chapter-error.log is REAL output: the managed tectonic 0.15.0
# compiling a main file that \input's three chapters, with an undefined
# control sequence on the last line of chapters/method.tex. Everything below
# it is hand-written, and each one says what it stands in for.

# the project that log came from, keyed the way the client keys it
MULTIFILE = SourceMap(
    lines={"main.tex": 16, "chapters/intro.tex": 4,
           "chapters/method.tex": 29, "chapters/results.tex": 5},
    multi_file=True,
)


def test_a_chapter_error_names_the_chapter_and_its_own_line():
    """The defect this exists for: before it, the finding below came back
    `line: 29, file: None`, and line 29 of the 16-line main file does not
    exist at all."""
    findings = parse_log(read("multifile-chapter-error.log"), MULTIFILE)
    errors = [f for f in findings if f.level == "error"]
    assert [(e.file, e.line) for e in errors] == [("chapters/method.tex", 29)]
    assert errors[0].message == "Undefined control sequence."


def test_without_a_source_map_the_answer_is_exactly_what_it_always_was():
    """A caller holding only a log gets the pre-existing answer, not a guess
    dressed up as a new feature."""
    errors = parse_log(read("multifile-chapter-error.log"))
    assert [(e.file, e.line) for e in errors] == [(None, 29)]


def test_a_single_file_document_reports_what_it_did_before():
    """The root source is never named, so nothing about a one-file document
    changes when a source map arrives."""
    single = SourceMap(lines={"main.tex": 20})
    for name in ("undefined-control-sequence.log", "missing-package.log",
                 "warnings.log"):
        assert parse_log(read(name), single) == parse_log(read(name)), name


def test_a_line_the_named_chapter_does_not_have_is_not_claimed():
    """The stack said `chapters/intro.tex`, the line said 29, and intro has
    4 lines. Two sources disagreeing is not a location — report the error,
    decline the file."""
    log = (
        "(main.tex\n"
        " (chapters/intro\n"
        "! Undefined control sequence.\n"
        "l.29 \\gradiant\n"
    )
    assert [(e.file, e.line) for e in parse_log(log, MULTIFILE)] == [(None, 29)]


def test_a_name_cut_by_max_print_line_is_not_resolved():
    """TeX wraps at max_print_line (79, measured in the real log) mid-path
    with no continuation marker. `chapters/method` is a prefix of both
    method.tex and a method-v2.tex that could sit beside it, so a token that
    ran to the end of a full-width line opens an UNKNOWN frame."""
    padding = "x" * (79 - len("(chapters/method") - 1)
    log = (
        "(main.tex\n"
        f"{padding} (chapters/method\n"
        "! Undefined control sequence.\n"
        "l.29 \\gradiant\n"
    )
    assert len(log.splitlines()[1]) >= 79
    assert [(e.file, e.line) for e in parse_log(log, MULTIFILE)] == [(None, 29)]


def test_source_echoed_back_into_the_log_does_not_move_the_stack():
    """TeX prints the author's own text under `l.NN` and under an overfull
    box, parentheses and all. Counted as bookkeeping they would close
    method.tex and blame intro.tex — the exact wrong-place failure."""
    log = (
        "(main.tex\n"
        " (chapters/intro) (chapters/method\n"
        "Overfull \\hbox (18.44pt too wide) in paragraph at lines 3--5\n"
        "[]\\OT1/cmr/m/n/10 a paragraph with (parentheses) and a stray )\n"
        " []\n"
        "\n"
        "! Undefined control sequence.\n"
        "l.29 \\gradiant\n"
        "              {f} (and more source with a paren\n"
    )
    assert [(e.file, e.line) for e in parse_log(log, MULTIFILE)] == \
        [("chapters/method.tex", 29)]


def test_a_desynchronised_stack_stops_answering_rather_than_guessing():
    """A `)` with nothing open means the nesting is lost, and depth after
    that point is arithmetic on a number known to be wrong."""
    log = (
        ")\n"
        "(main.tex\n"
        " (chapters/method\n"
        "! Undefined control sequence.\n"
        "l.29 \\gradiant\n"
    )
    assert [(e.file, e.line) for e in parse_log(log, MULTIFILE)] == [(None, 29)]


def test_an_error_inside_a_class_file_is_not_blamed_on_the_chapter():
    """The frame below an unknown one is not the answer: an error raised
    inside a .sty genuinely is not in the chapter that pulled it in."""
    log = (
        "(main.tex\n"
        " (chapters/method (fancyhdr.sty\n"
        "! Undefined control sequence.\n"
        "l.91 \\fancy@setoffs\n"
    )
    assert [(e.file, e.line) for e in parse_log(log, MULTIFILE)] == [(None, 91)]


def test_a_warning_inside_a_chapter_carries_the_chapter():
    """`on input line 12` is a line in whatever file is open — which for a
    chapter warning is the chapter, not the main file."""
    log = (
        "(main.tex\n"
        " (chapters/method\n"
        "LaTeX Warning: Reference `fig:setup' on page 1 undefined on input line 12.\n"
        ")\n"
        "LaTeX Warning: There were undefined references.\n"
    )
    findings = parse_log(log, MULTIFILE)
    # and the second one, raised after `)` closed the chapter, is the main
    # file's — with no line, because LaTeX gave it none
    assert [(f.file, f.line) for f in findings] == \
        [("chapters/method.tex", 12), ("main.tex", None)]


def test_a_file_line_error_prefix_is_rewritten_to_the_project_key():
    """Hand-written: no -file-line-error engine is installed on this machine
    to measure it against. pdflatex, xelatex and latexmk get the flag (see
    engine_argv) and prefix the error with the path as they resolved it; the
    client's key has no `./` on the front of it."""
    log = (
        "(./main.tex (./chapters/method.tex\n"
        "./chapters/method.tex:29: Undefined control sequence.\n"
        "l.29 \\gradiant\n"
    )
    assert [(e.file, e.line) for e in parse_log(log, MULTIFILE)] == \
        [("chapters/method.tex", 29)]


def test_an_absolute_temp_path_never_reaches_the_client():
    workdir = "/tmp/dia-tex-abc123"
    sources = SourceMap(lines=dict(MULTIFILE.lines), roots=(workdir + "/",))
    log = (
        f"({workdir}/main.tex ({workdir}/chapters/method.tex\n"
        f"{workdir}/chapters/method.tex:29: Undefined control sequence.\n"
        "l.29 \\gradiant\n"
    )
    errors = parse_log(log, sources)
    assert [(e.file, e.line) for e in errors] == [("chapters/method.tex", 29)]
    assert workdir not in str([e.as_dict() for e in errors])


def test_resolve_only_answers_for_files_the_compile_laid_out():
    assert MULTIFILE.resolve("chapters/method") == "chapters/method.tex"
    assert MULTIFILE.resolve("./chapters/method.tex") == "chapters/method.tex"
    assert MULTIFILE.resolve("main.tex") == "main.tex"
    # not ours: a bundle file, an absolute path under no root of ours, a
    # chapter the project does not have, a paren out of a message
    assert MULTIFILE.resolve("fancyhdr.sty") is None
    assert MULTIFILE.resolve("/usr/share/texlive/tex/latex/base/size10.clo") is None
    assert MULTIFILE.resolve("chapters/nope") is None
    assert MULTIFILE.resolve("Font") is None
    assert MULTIFILE.resolve("") is None


def test_the_root_is_named_only_where_naming_it_says_something():
    """In a one-file document the root is the only thing a line could mean,
    so naming it adds nothing and changing the answer costs something. In a
    document with chapters it is one file among several, and a preamble
    error that did not name it would be as unjumpable as the chapter error
    this all started with."""
    assert MULTIFILE.attributable("main.tex", 3) is True
    solo = SourceMap(lines={"main.tex": 16})
    assert solo.attributable("main.tex", 3) is False

    assert MULTIFILE.attributable("chapters/method.tex", 29) is True
    assert MULTIFILE.attributable("chapters/method.tex", 30) is False
    assert MULTIFILE.attributable("chapters/method.tex", None) is True
    assert MULTIFILE.attributable(None, 1) is False


def test_a_preamble_error_in_a_multi_file_document_names_the_main_file():
    """The case the log cannot help with: a broken \\usepackage stops the
    run before any chapter is opened, so the log looks single-file. The
    source map is what knows better."""
    log = (
        "(main.tex\n"
        "! LaTeX Error: File `siunitx.sty' not found.\n"
        "l.4 \\usepackage{siunitx}\n"
    )
    assert [(e.file, e.line) for e in parse_log(log, MULTIFILE)] == [("main.tex", 4)]
    solo = SourceMap(lines={"main.tex": 16})
    assert [(e.file, e.line) for e in parse_log(log, solo)] == [(None, 4)]
