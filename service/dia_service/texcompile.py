"""LaTeX compile jobs: run a real engine, stream its log, return a PDF.

A compile is slow (seconds; tectonic's first run is a package download), so
it is a *job*, not a request/response: POST /compile hands back an id, the
client watches SSE frames, and fetches the PDF when the job says ok. This
module is loop-free on purpose — `CompileJob.run()` is an ordinary blocking
call, so `dia compile` uses it directly and the HTTP layer runs it in a
thread. One place implements the compile; two surfaces drive it.

Everything the engine sees is written into a fresh temp directory: the
source as `main.tex` plus whatever assets the client sent. The user's own
directory is never written to — only *read*, and only via TEXINPUTS when
the file came in through the CLI allowlist, so `\\includegraphics{fig/a}`
resolves without scattering .aux files next to someone's paper.

Untrusted input handling, in one place so it can be audited in one place:
asset paths are rejected unless they are relative, `..`-free, and land
inside the workdir; the engine is exec'd as an argv list, never through a
shell; and the engine name is looked up from the discovery ladder, never
taken from the request as a path.
"""

from __future__ import annotations

import base64
import gzip
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from collections import OrderedDict
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path
from typing import Any, Callable

from . import tex

# How many finished jobs stay fetchable. The PDF lives in the job's temp
# directory, so "keep the last N" is also "keep N temp directories" —
# small on purpose; eviction deletes the directory.
MAX_JOBS = 4


class CompileError(RuntimeError):
    """A compile could not be started (bad request, no engine)."""


# ---------------------------------------------------------------------------
# structured log parsing
# ---------------------------------------------------------------------------

@dataclass
class TexError:
    level: str  # "error" | "warning"
    file: str | None
    line: int | None
    message: str

    def as_dict(self) -> dict:
        return asdict(self)


# `./main.tex:12: Undefined control sequence.` — what -file-line-error buys
# us, and the only form that carries both a file and a line reliably.
_FILE_LINE = re.compile(r"^(?P<file>[^\s:][^:]*):(?P<line>\d+):\s*(?P<msg>.*)$")
# `! LaTeX Error: File `foo.sty' not found.` — engines that ignore
# -file-line-error, and tectonic, still emit this.
_BANG = re.compile(r"^!\s*(?P<msg>.*)$")
# `l.12 \badcommand` — the line reference that follows a bare `!` error.
_LNN = re.compile(r"^l\.(?P<line>\d+)\s?(?P<rest>.*)$")
_WARNING = re.compile(
    r"^(?P<kind>LaTeX Font|LaTeX|Package\s+\S+|Class\s+\S+|Module\s+\S+)"
    r"\s+Warning:\s*(?P<msg>.*)$"
)
_ON_INPUT_LINE = re.compile(r"on input line (\d+)")
# `(Font)   using ... instead` — TeX's continuation gutter for a multi-line
# warning. The `/`-free tag is what separates it from `(./main.aux`, the
# other thing in a log that starts with a paren.
_GUTTER = re.compile(r"^\((?P<tag>[A-Za-z][\w .-]*)\)\s+(?P<rest>.*)$")
# Boxes are typography noise, not problems the author asked about. They
# outnumber real findings by an order of magnitude in any real document.
_BOX = re.compile(r"^(Over|Under)full \\[hv]box")


def _clean(message: str) -> str:
    return re.sub(r"\s+", " ", message).strip()


# ---------------------------------------------------------------------------
# which FILE a finding came from: the log's open-file stack
# ---------------------------------------------------------------------------
#
# tectonic's v2 CLI has no -file-line-error, so an error inside an \input'd
# chapter arrives as a bare `! …` plus an `l.NN` that is the CHAPTER's line
# number with nothing naming the chapter. Measured with the managed
# tectonic 0.15.0 and kept verbatim as service/tests/logs/
# multifile-chapter-error.log: a broken control sequence on line 29 of
# chapters/method.tex came back as `line: 29, file: None`, and line 29 of
# the 16-line main file does not exist at all.
#
# The one thing a log always says about file identity is TeX's own
# bookkeeping: `(chapters/method` when it opens a file, `)` when it closes
# one. Tracking that nesting recovers the file current at any point. Three
# things make it fiddly, all measured on the same real tectonic output:
#
#   * the printed name is what \input ASKED for, not a path — `(chapters/
#     intro)`, with no `./` and no `.tex`. Resolving it has to put the
#     extension TeX appends back on.
#   * lines wrap at max_print_line (79 in that log) mid-path with no
#     continuation marker, so a printed name can be a prefix of the truth —
#     and a prefix can resolve to the WRONG real file (`chapters/method` is
#     a prefix of both `method.tex` and `method-v2.tex`).
#   * TeX echoes the author's own source back into the log (error context
#     under `l.NN`, the paragraph under an overfull box) and that text has
#     parentheses in it, which would corrupt the nesting.
#
# So the stack is never trusted on its own. A frame may only name a finding
# when it resolves to a .tex file this compile actually laid out in its
# workdir AND the finding's line number exists in that file. Anything else
# keeps the answer this parser has always given — `file: None` — because a
# wrong file sends an author to a paragraph that is fine, which is worse
# than no jump at all.

# TeX's max_print_line. 79 measured in tectonic 0.15.0's log; TeX Live uses
# 79 or 80. A name token that runs to the end of a line this long may have
# been cut in half, so the frame it opens is treated as unknown.
_MAX_PRINT_LINE = 79
# what ends a file name in a log: the delimiters TeX itself prints around
# them. Names with spaces in them are simply not recoverable here.
_NAME_STOP = frozenset("()[]{}<> \t\"'")
# error context and box echoes quote the document verbatim — the two places
# a `(` in the log is the AUTHOR's paren rather than TeX's bookkeeping.
_QUOTES_SOURCE = ("<recently read>", "<inserted text>", "<to be read again>",
                  "<argument>", "<template>", "Runaway argument")
# A box echo is one paragraph and ends with a lone `[]` or a blank line. All
# 168 boxes across the corpus's real logs terminated that way, the longest
# after 8 lines; the cap is only there so a log that does NOT terminate one
# cannot swallow the rest of the file.
_ECHO_MAX_LINES = 12


@dataclass(frozen=True)
class SourceMap:
    """The .tex files one compile laid out, keyed the way the CLIENT keys
    them: project-relative, posix, extension included (`chapters/method.tex`).

    `lines` maps each of those to its line count — the sanity check that
    stops a desynchronised stack from blaming a chapter for a line number
    the chapter does not have. `roots` are absolute directories a log may
    print a path against (the temp workdir, the opened document's own
    directory) — they exist to be stripped, never to be handed to a client
    that must not learn where the temp dir is.

    `root` is the file the job compiles as main.tex, and `multi_file` says
    whether it actually \\input's another source. Together they are what
    keeps a one-file document's answers byte-identical: there, the root is
    the ONLY thing a line number could mean, naming it would say nothing,
    and so it is not named. In a document that really has chapters the root
    has to be named — otherwise a typo in the preamble comes back as
    "somewhere", which is the same dead row this whole section exists to
    remove, just moved.
    """

    lines: dict[str, int] = field(default_factory=dict)
    root: str = "main.tex"
    roots: tuple[str, ...] = ()
    multi_file: bool = False

    def resolve(self, printed: str) -> str | None:
        """A name as the log printed it → the project-relative key, or None
        when it is not one of this project's sources (a bundle .sty, a font
        .fd, a stray paren in a message)."""
        name = printed.strip().strip("\"'").replace("\\", "/")
        if not name:
            return None
        if name.startswith("/"):
            for root in self.roots:
                if name.startswith(root):
                    name = name[len(root):]
                    break
            else:
                # an absolute path under no root of ours is a system or
                # bundle file; making it relative would invent a key
                return None
        while name.startswith("./"):
            name = name[2:]
        if name in self.lines:
            return name
        # \input{chapters/intro} prints without the .tex TeX appends for it
        if "." not in name.rsplit("/", 1)[-1] and f"{name}.tex" in self.lines:
            return f"{name}.tex"
        return None

    def attributable(self, name: str | None, line: int | None) -> bool:
        """May a finding be reported as belonging to `name`? Only for a
        source this compile laid out, only at a line that source actually
        has, and — for the root — only in a document with chapters at all
        (see the class docstring)."""
        if name is None or (name == self.root and not self.multi_file):
            return False
        count = self.lines.get(name)
        if count is None:
            return False
        return line is None or 1 <= line <= count


class _FileStack:
    """TeX's open-file nesting, replayed line by line.

    `current()` is the innermost open frame, or None whenever that frame is
    not a project source — a .sty, a truncated name, a paren from a
    message. It never falls through to the frame BELOW an unknown one: an
    error raised inside a class file genuinely is not in the chapter that
    included it, and saying so would be the wrong-place answer."""

    def __init__(self, sources: SourceMap) -> None:
        self.sources = sources
        self.stack: list[str | None] = []
        # a `)` with nothing open means the nesting has desynchronised and
        # every depth after it is a guess; stop answering rather than guess
        self.lost = False
        self._skip = 0
        self._echo = 0

    def current(self) -> str | None:
        if self.lost or not self.stack:
            return None
        return self.stack[-1]

    def feed(self, raw: str) -> None:
        stripped = raw.strip()
        if self._skip > 0:
            self._skip -= 1
            return
        if self._echo > 0:
            self._echo -= 1
            if not stripped or stripped == "[]":
                self._echo = 0
            return
        if _BOX.match(stripped):
            self._echo = _ECHO_MAX_LINES
            return
        if stripped.startswith("!"):
            return
        if _LNN.match(stripped) or stripped.startswith(_QUOTES_SOURCE):
            # the line under `l.NN` is the rest of the offending source line
            self._skip = 1
            return
        self._scan(raw)

    def _scan(self, line: str) -> None:
        # a token that ends flush with a full-width line may have been cut
        # by max_print_line; see the section comment
        wrapped = len(line) >= _MAX_PRINT_LINE
        i, n = 0, len(line)
        while i < n:
            c = line[i]
            if c == "(":
                j = i + 1
                while j < n and line[j] not in _NAME_STOP:
                    j += 1
                token = line[i + 1:j]
                truncated = j == n and wrapped
                self.stack.append(
                    None if truncated else self.sources.resolve(token))
                i = j
            elif c == ")":
                if self.stack:
                    self.stack.pop()
                else:
                    self.lost = True
                i += 1
            else:
                i += 1


def parse_log(text: str, sources: SourceMap | None = None) -> list[TexError]:
    """TeX log → structured findings, newest engines and oldest alike.

    Three shapes are recognised: `-file-line-error` lines (file + line +
    message), bare `! …` errors whose line arrives later as `l.NN`, and
    `… Warning:` blocks that may continue across lines and end with
    `on input line NN`. Over/underfull boxes are dropped.

    Deliberately lenient: an unrecognised line is skipped, never guessed at.
    A missed warning costs the user nothing; a hallucinated file:line sends
    them to the wrong place in their document.

    `sources` is what the compile laid out in its workdir; with it, a
    finding raised inside an \\input'd chapter is attributed to that chapter
    by replaying the log's open-file stack (see the section above). Without
    it — a caller holding only a log — every finding answers exactly what it
    answered before this existed.
    """
    findings: list[TexError] = []
    stack = _FileStack(sources) if sources is not None else None

    def attributed(name: str | None, line: int | None) -> str | None:
        """the open-file stack's answer, but only where it is allowed to
        speak — see SourceMap.attributable"""
        if sources is None or not sources.attributable(name, line):
            return None
        return name

    # bare `!` errors still waiting for a line number, each with the file
    # that was open when it was raised. A group, not a single error:
    # `! LaTeX Error: File not found.` and the `! Emergency stop.` it
    # provokes share the one `l.NN` that follows, and both are true of it.
    pending: list[tuple[TexError, str | None]] = []
    # a warning still collecting continuation lines, and the file that was
    # open when it OPENED — by the time it flushes, TeX may have moved on
    warning: TexError | None = None
    warning_where: str | None = None
    parts: list[str] = []

    def flush_warning() -> None:
        nonlocal warning, parts
        if warning is None:
            return
        body = _clean(" ".join(parts))
        m = _ON_INPUT_LINE.search(body)
        if m:
            warning.line = int(m.group(1))
        warning.message = body
        warning.file = attributed(warning_where, warning.line)
        findings.append(warning)
        warning = None
        parts = []

    def open_warning(message: str) -> None:
        nonlocal warning, warning_where, parts
        flush_warning()
        warning = TexError(level="warning", file=None, line=None, message="")
        warning_where = stack.current() if stack is not None else None
        parts = [message]
        if _ON_INPUT_LINE.search(message) or message.rstrip().endswith("."):
            flush_warning()

    for raw in text.splitlines():
        # the stack has to see every line, including the ones the finding
        # logic below skips or swallows into a warning body
        if stack is not None:
            stack.feed(raw)
        line = raw.rstrip()
        stripped = line.strip()

        if warning is not None:
            gutter = _GUTTER.match(stripped)
            if gutter is not None:
                parts.append(gutter.group("rest"))
            elif stripped and raw[:1].isspace():
                parts.append(stripped)
            else:
                flush_warning()
            if warning is not None:
                if _ON_INPUT_LINE.search(parts[-1]) or parts[-1].endswith("."):
                    flush_warning()
                continue

        if not stripped or _BOX.match(stripped):
            continue

        m = _WARNING.match(stripped)
        if m:
            open_warning(m.group("msg"))
            continue

        m = _FILE_LINE.match(line)
        if m and not line.startswith("!"):
            # -file-line-error sometimes still prefixes the message with `!`
            msg = _clean(_BANG.sub(lambda mm: mm.group("msg"), m.group("msg")))
            if msg:
                pending = []
                # the engine named the file itself, so it is authoritative;
                # resolving only rewrites `./chapters/method.tex` (or the
                # temp workdir's absolute form) into the project key the
                # client uses, and leaves anything else exactly as printed
                where = m.group("file")
                line_no = int(m.group("line"))
                if sources is not None:
                    resolved = sources.resolve(where)
                    if sources.attributable(resolved, line_no):
                        where = resolved  # type: ignore[assignment]
                findings.append(TexError(
                    level="error",
                    file=where,
                    line=line_no,
                    message=msg,
                ))
            continue

        m = _BANG.match(line)
        if m:
            msg = _clean(m.group("msg"))
            if not msg or set(msg) <= {"=", "-"}:
                continue
            where = stack.current() if stack is not None else None
            # named now so an error that never gets an `l.NN` still says
            # which chapter it came from; the `l.NN` branch re-checks it
            error = TexError(level="error", file=attributed(where, None),
                             line=None, message=msg)
            pending.append((error, where))
            findings.append(error)
            continue

        m = _LNN.match(stripped)
        if m and pending:
            for error, where in pending:
                error.line = int(m.group("line"))
                error.file = attributed(where, error.line)
            pending = []
            continue

    flush_warning()
    return findings


# ---------------------------------------------------------------------------
# biblatex's classic-bibtex compatibility backend (issue #23)
# ---------------------------------------------------------------------------
#
# `\usepackage[backend=bibtex]{biblatex}` asks biblatex to drive citations
# through classic bibtex instead of biber. That mode compiles cleanly —
# exit 0, a real PDF — but modern `biblatex.bst` is not fully supported by
# classic bibtex, and the result is WRONG citation text, not a missing one:
# measured on corpus/tex/biblatex/biblatex.tex, `\textcite{lamport1994}`
# printed the entry's TITLE where the author name belongs. The reference
# LIST from \printbibliography comes out fully correct — only the inline
# \cite-family commands are affected — which is exactly what makes this the
# worst failure shape a compiler can have: it looks finished.
#
# Installing biber does NOT fix this. biber only ever runs for biblatex's
# DEFAULT backend; a document that explicitly asked for backend=bibtex has
# opted out of biber entirely, and tectonic (verified on a real compile
# while fixing this issue) still runs — and still ignores the failure of —
# its own classic-bibtex fallback even with a working biber on PATH. The
# only real fix is dropping `backend=bibtex` so the document uses biber.

# `\usepackage[...,backend=bibtex,...]{biblatex}` — order of options inside
# the brackets does not matter, so this looks for backend=bibtex anywhere
# in them rather than parsing the whole option list.
_BACKEND_BIBTEX = re.compile(
    r"\\usepackage\s*\[[^\]]*\bbackend\s*=\s*bibtex\b[^\]]*\]\s*\{biblatex\}")
# biblatex.sty's own warning when it loads the compatibility shim — emitted
# regardless of engine, since it comes from the .sty, not the engine.
# Captured verbatim from a real compile: service/tests/logs/
# biblatex-bibtex-fallback.log.
_FALLBACK_BIBTEX_BACKEND = re.compile(
    r"Using fall-back BibTeX\(8\) backend", re.IGNORECASE)
# classic bibtex refusing biblatex.bst's own bytecode, in the .blg — the
# tell-tale that fires on EVERY entry, captured verbatim from a real
# compile: service/tests/logs/biblatex-bibtex-fallback.blg.
_BLG_CANT_MESS_WITH_ENTRIES = re.compile(r"You can't mess with entries here")

BIBER_HOMEPAGE = "https://ctan.org/pkg/biber"


def biblatex_bibtex_backend_finding(
    source: str = "", log: str = "", blg: str = "",
) -> TexError | None:
    """A finding for the problems drawer when the risk above is real, or
    None when it is not. Any ONE of the three tell-tales is sufficient —
    they were all measured firing together on the same real compile, but a
    caller may have only the source (checking before compiling), or only a
    log and no .blg (a compile that failed before bibtex ran), or a .blg
    with no matching source (main.tex was not passed in).

    Deliberately does not accept or check "is biber installed" — irrelevant
    here, since biber is not what fixes a `backend=bibtex` document (see
    the module comment above)."""
    if not (
        _BACKEND_BIBTEX.search(source)
        or _FALLBACK_BIBTEX_BACKEND.search(log)
        or _BLG_CANT_MESS_WITH_ENTRIES.search(blg)
    ):
        return None
    return TexError(
        level="warning",
        file=None,
        line=None,
        message=(
            "biblatex is compiling on the classic-bibtex compatibility "
            "backend (backend=bibtex); modern biblatex styles are not "
            "fully supported by classic bibtex, so inline citations "
            "(\\cite, \\textcite, \\autocite, …) can render the WRONG "
            "text even though the compile succeeded — the reference list "
            "itself is unaffected. Installing biber will not fix this: "
            "remove backend=bibtex so biblatex uses its default biber "
            f"backend instead ({BIBER_HOMEPAGE})."
        ),
    )


# ---------------------------------------------------------------------------
# synctex
# ---------------------------------------------------------------------------

# `(1,23:4736286,42000000` — tag, line, x, y (+ optional w,h,d)
_REC_BODY = (
    r"(?P<tag>\d+),(?P<line>\d+)"
    r":(?P<x>-?\d+),(?P<y>-?\d+)"
    r"(?::(?P<w>-?\d+),(?P<h>-?\d+),(?P<d>-?\d+))?"
)
# the scroll-target scan's record types: boxes (`[`, `(`), void boxes (`h`,
# `v`), the current point (`x`), kerns, glue and math shifts
_SYNCTEX_REC = re.compile(r"^[\[\(hvxkg\$]" + _REC_BODY)
# the box tree's, which adds one type the scroll-target scan never wanted:
# `r`, a rule. A rule sets ink with no glyphs in it (a \hrule, a table's
# separators, the bar of a \frac) and the box holding it has to know, but as
# a scroll TARGET a rule is worthless — it names no place in the text.
_SYNCTEX_ANY_REC = re.compile(r"^(?P<type>[\[\(hvxkgr\$])" + _REC_BODY)
_SP_PER_PT = 65536.0

# What `y` in parse_synctex's `lines` means, verified against a real tectonic
# compile (see the docstring below). Shipped in /compile/{id}/pages so the
# client never has to guess an axis direction — guessing it wrong flips every
# scroll target to the mirror-image position on the page.
SYNCTEX_Y_SEMANTICS = "topDownPt"
# …and the same for `x`, verified the same way. Shipped in
# /compile/{id}/synctex so a client cropping a column never has to guess
# whether x is measured from the paper edge or from TeX's 1in origin.
SYNCTEX_X_SEMANTICS = "leftPt"
# …and for the `boxes` list's rectangles, verified the same way (see
# parse_boxes). `x, y` is the box's REFERENCE POINT, not a corner: the box
# covers x .. x+w across and y-h .. y+d down, in the axes the two constants
# above declare. Saying so out loud is the same discipline as the axis
# labels: a client that read `y` as the box's top would hang every crop one
# box-height too low, and nothing in the numbers themselves would say so.
SYNCTEX_BOX_SEMANTICS = "refPointPt"


def parse_synctex(path: str | Path) -> dict[str, Any]:
    """Source-line → page/position map from a `.synctex[.gz]` file.

    `{pages: [{n, w, h}], lines: [{line, page, x, y, w?}], boxes: [...],
    inputs: [...], mainTag, xSemantics, ySemantics, boxSemantics}`,
    positions in points from the top-left.

    TWO ANSWERS, ONE FILE. `lines` is one point per (line, page) — which
    page, how far down, which column — and that is all a SCROLL TARGET has
    ever needed. `boxes` is the box tree itself, every rectangle the engine
    set and what source line's material stands in it, which is what a client
    that has to CROP the render needs (see parse_boxes). The point map came
    first and stayed: it is small, every consumer of it still wants exactly
    it, and re-deriving it from the tree would be a rewrite of a thing that
    works. Nothing reads both.

    Y AXIS — verified empirically, not inferred (see tests/test_pages.py,
    `test_synctex_y_is_top_down_points`). A 200x400pt document was compiled
    with the managed tectonic, one line at the top of the text block and one
    pushed to the bottom with `\\vfill`:

        top line     y = 2031617 sp  ->  31.00 pt
        bottom line  y = 24903681 sp  ->  380.00 pt   (page is 398.51 pt tall)

    so **y grows downward from the top edge of the page**, it is measured
    per page (page 2's top line reports 31.00 pt again, not a running
    total), and the value in the file is scaled points — 65536 per point,
    times the file's `Unit:` field. `to_pt()` below applies exactly that, so
    the numbers this function returns are already top-down points and need
    NO conversion by the caller. The wire format says so out loud:
    /compile/{id}/pages reports `ySemantics: "topDownPt"`.

    X AXIS — also verified against a real compile, and for the same reason:
    a client that crops a compiled block out of the page needs to know
    which COLUMN it is in, and getting the origin wrong crops the wrong
    half of a two-column paper. `x` is points rightward from the LEFT PAPER
    EDGE — the probe above reported 20.00 pt for its top line, which is the
    document's 20pt left margin, and a `\\documentclass[twocolumn]` probe on
    500pt paper with 25pt margins reported 25.00 pt in column one and
    255.00 pt in column two (25 + 220pt column + 10pt gutter). It is NOT
    measured from TeX's 1in reference point, though boxes that ARE anchored
    there do exist and show up at 72.27 pt — see the selection rule below,
    which is what keeps them out of the result. The wire format says the
    origin out loud too: /compile/{id}/synctex reports
    `xSemantics: "leftPt"`.

    WHICH RECORD — one per (line, page), and *which* one is what decides
    whether x means anything. A source line owns every box that was still
    open when the line was current, so the line a page break lands on owns
    the page box, the text block, the running head and both column boxes as
    well as its own type. On the two-column probe such a line's FIRST
    record is the page box at x=72.27 (TeX's 1in origin) and its
    SMALLEST-x record is the full-width text block at x=25 — both answer
    "column one" about type that is in column two. No rule based on
    position survives a page break; the eight-page probe put one such line
    on every page.

    What separates a line's own type from the containers it merely closed
    is CONTAINMENT: a container has boxes inside it, and a line of type has
    none. So we keep, per (line, page), **the first box the line opened
    that opened no box of its own** — the innermost, earliest box it owns.
    Two exclusions make it hold: a box needs a positive width, which drops
    the 1in origin marker (`x=72.27, w=0`), and a positive height+depth,
    which drops the empty running head (`w=450, h+d=0`) — both are
    innermost boxes and would otherwise win outright.

    Void boxes (`h`, `v`) do NOT count as contents, and that is not a
    detail: the paragraph-indent box sits inside a paragraph's FIRST line,
    so counting it would disqualify that line and report every paragraph
    one baseline too low. It cost two records their column on the probe as
    well. Counting only real boxes keeps `y` on the first line of the type.

    That rule fixes `y` too, which is why it replaced "first record": a
    line ending a page used to report the page box's y (405.00 pt on a
    400 pt page) rather than its own type's, sending a scroll target off
    the bottom of the page it was pointing at.

    `w` is that same box's width — the column width for body text, so a
    client can crop a block to its column instead of the full page width.
    A line whose innermost box is an inner one (an inline formula, an
    `\\item` label) reports that box, so `w` can be a few points; `x` is
    still inside the line's column, since a box cannot start outside the
    box that holds it. Clustering on `x` is what identifies a column;
    trusting a single `w` to be the column width is not.

    A line that typeset nothing on the page (the break fell between its
    paragraphs; 2 records in 77 on the probe, a third of them on a 39-page
    paper) keeps its first record, as this function always did, and omits
    `w` unless that record carries a positive one — a zero width is a
    marker, and a caller would take it literally and crop nothing.

    y is NOT clamped to the paper. The box that closes a page — attributed
    to whatever source line ended it, `\\newpage` or `\\end{document}` —
    reported 410.00 pt on a 398.51 pt page in the two-page probe. A client
    turning y into a fraction of the page height must clamp it; the records
    that matter (typeset text) are inside the paper.

    Every engine in ENGINES writes `X Offset:0`, `Y Offset:0` and
    `Magnification:1000`, so those preamble fields are ignored rather than
    applied — a transform we cannot test against a real engine that emits it
    is a guess, and a wrong guess here silently shifts every scroll target.

    `w`/`h` are the largest typeset box on the page — the text block, NOT
    the paper size, which synctex simply does not record. Paper size comes
    from the PDF instead: /compile/{id}/pages reports `wPt`/`hPt` per page,
    and a PDF panel wanting fractional positions must divide by those.
    Using `w`/`h` for that would put every target slightly too far down.

    A missing or unparseable file yields empty lists rather than raising:
    SyncTeX is an enhancement, and a compile that produced a PDF is a
    success whatever its synctex looks like.
    """
    empty = {"pages": [], "lines": [], "boxes": [], "inputs": [], "mainTag": None,
             "xSemantics": SYNCTEX_X_SEMANTICS, "ySemantics": SYNCTEX_Y_SEMANTICS,
             "boxSemantics": SYNCTEX_BOX_SEMANTICS}
    text = _synctex_text(path)
    if text is None:
        return dict(empty)

    inputs = synctex_inputs(text)
    # SyncTeX tags every record with the input FILE it came from; a .bbl or
    # an \input'd chapter reuses the same line numbers as main.tex, and
    # merging tags attributed the BIBLIOGRAPHY's boxes to body paragraphs
    # (measured: 10k of 54k records in a real paper were the .bbl). Only
    # main.tex's tag speaks for the document the editor is mapping.
    main_tag: str | None = None
    for entry in inputs:
        if entry["path"].endswith("main.tex"):
            main_tag = str(entry["tag"])
            break

    unit = _synctex_unit(text)

    def to_pt(value: int) -> float:
        return round(value * unit / _SP_PER_PT, 2)

    page: int | None = None
    extents: dict[int, tuple[float, float]] = {}
    order: list[int] = []
    # (line, page) -> (rank, record). rank (0, seq) is a box the line
    # actually typeset, (1, seq) is any other record; either way the
    # earliest wins, so a line reports the top-left of its own material and
    # falls back to its first record when it typeset nothing on this page.
    best: dict[tuple[int, int], tuple[tuple[int, int], dict[str, Any]]] = {}
    seq = 0
    # one entry per box still open, and a count of every box opened so far:
    # a box that opened none while it was open holds no other box, which is
    # what makes it the line's own type — see WHICH RECORD above
    boxes = 0
    stack: list[tuple[int, int, int, dict[str, Any] | None]] = []

    def keep(key: tuple[int, int], rank: tuple[int, int], found: dict[str, Any]) -> None:
        held = best.get(key)
        if held is None or rank < held[0]:
            best[key] = (rank, found)

    for line in text.splitlines():
        if not line:
            continue
        if line[0] == "{" and line[1:].strip().isdigit():
            page = int(line[1:].strip())
            if page not in extents:
                extents[page] = (0.0, 0.0)
                order.append(page)
            stack.clear()  # a truncated page must not leak into the next
            continue
        if line[0] == "}":
            page = None
            stack.clear()
            continue
        if page is None:
            continue
        if line[0] in ")]":
            if stack:
                src, opened, nested, found = stack.pop()
                if found is not None and boxes == nested:
                    keep((src, page), (0, opened), found)
            continue
        rec = _SYNCTEX_REC.match(line)
        if rec is None or (main_tag is not None and rec.group("tag") != main_tag):
            if line[0] in "([":
                # a box from another input file (or unreadable) still needs
                # its `)` counted, or the stack credits it to another line
                boxes += 1
                stack.append((0, seq, boxes, None))
            continue
        w = h = None
        if rec.group("w") is not None:
            w = to_pt(int(rec.group("w")))
            h = to_pt(int(rec.group("h")) + int(rec.group("d")))
            pw, ph = extents[page]
            extents[page] = (max(pw, w), max(ph, h))
        src_line = int(rec.group("line"))
        seq += 1
        found = None
        if src_line:
            found = {
                "line": src_line, "page": page,
                "x": to_pt(int(rec.group("x"))), "y": to_pt(int(rec.group("y"))),
            }
            if w:
                found["w"] = w
            keep((src_line, page), (1, seq), found)
        if line[0] in "([":
            boxes += 1
            # a box with no extent holds no type — the 1in origin marker,
            # the empty running head — so it is not a candidate even when it
            # is innermost
            material = w is not None and w > 0 and h > 0
            stack.append((src_line, seq, boxes, found if material else None))

    lines = [found for _, found in best.values()]
    lines.sort(key=lambda r: (r["line"], r["page"]))
    return {
        "pages": [{"n": n, "w": extents[n][0], "h": extents[n][1]} for n in order],
        "lines": lines,
        "boxes": parse_boxes(text, unit),
        "inputs": inputs,
        "mainTag": int(main_tag) if main_tag is not None else None,
        "xSemantics": SYNCTEX_X_SEMANTICS,
        "ySemantics": SYNCTEX_Y_SEMANTICS,
        "boxSemantics": SYNCTEX_BOX_SEMANTICS,
    }


def _synctex_text(path: str | Path) -> str | None:
    """The file's text, gunzipped if it needs it. None when it cannot be
    read at all — SyncTeX is an enhancement, never a compile failure."""
    p = Path(path)
    try:
        raw = p.read_bytes()
    except OSError:
        return None
    if raw[:2] == b"\x1f\x8b":
        try:
            raw = gzip.decompress(raw)
        except OSError:
            return None
    return raw.decode("utf-8", "replace")


def _synctex_unit(text: str) -> float:
    """The file's `Unit:` scale — every position is this many scaled points
    (65536 to the point). Missing or unreadable means 1, which is what every
    engine in ENGINES actually writes."""
    m = re.search(r"^Unit:([0-9.]+)", text, re.M)
    if m:
        try:
            return float(m.group(1)) or 1.0
        except ValueError:
            return 1.0
    return 1.0


def synctex_inputs(text: str) -> list[dict[str, Any]]:
    """Every input FILE the engine recorded, as `{tag, path, name}`.

    Reported out loud (rather than kept as this module's private business)
    because a tag is the only thing that tells one file's line 40 from
    another's, and a client mapping a document assembled from `\\input`s
    needs to key by (tag, line) rather than by line alone. Tectonic leaves
    the NAME blank for files it pulled out of its bundle — a `.bbl` written
    by the compile itself came back as `Input:84:` on a real paper — so an
    unnamed tag is reported with an empty path rather than dropped: a client
    still has to be able to say "these boxes are not mine".
    """
    out: list[dict[str, Any]] = []
    for m in re.finditer(r"^Input:(\d+):(.*)$", text, re.M):
        path = m.group(2).strip()
        out.append({"tag": int(m.group(1)), "path": path,
                    "name": path.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]})
    return out


# `x` — the "current point" record — is the one material type that does NOT
# stand for a node. It is emitted when the shipout's current tag/line
# changes, so it carries the AMBIENT context, which for a paragraph's line
# boxes is the line `\par` fired on. Measured on llama.tex p2: the box
# holding lines 163-165 of a paragraph reports `x1,166` (line 166 is blank)
# at 95.77pt, between two kerns that correctly say 163. Crediting it would
# hand every block that begins where a paragraph ended the paragraph's last
# lines. Kerns, glue, rules, void boxes and math shifts are real nodes and
# say what they mean.
_AMBIENT_REC = "x"


def parse_boxes(text: str, unit: float) -> list[dict[str, Any]]:
    """Every rectangle the engine set, and whose source line's material is
    in it — the whole answer parse_synctex's `lines` throws away.

    One entry per box:

        {page, x, y, w, h, d, src: [[tag, line], ...], parent}

    `parent` indexes back into this same list (-1 at a page's outermost
    box), so a client can ask what encloses what — which column a line box
    stands in, which text block a column belongs to — without inferring it
    from positions. Boxes come out in the order the engine shipped them,
    so a parent always precedes its children.

    THE RECTANGLE. `x, y` is TeX's reference point, `w, h, d` the box's
    width, height and depth, all in the axes SYNCTEX_X_SEMANTICS and
    SYNCTEX_Y_SEMANTICS declare: the box covers x .. x+w across and
    y-h .. y+d down. Verified against a real compile rather than inferred,
    the same discipline the axis labels get — llama.tex's paragraph on
    source lines 163-165 unions to x[71.13, 290.22] y[343.61, 489.52], and
    pdftoppm at 150dpi puts that paragraph's ink at x[71.04, 290.40]
    y[343.20, 487.68]: the box is the ink, to within the half-pixel the
    rasterizer rounds by and the fraction of a point a glyph's outline
    overshoots its metric height. The page's own outermost box confirms the
    origin from the other side — 72.27pt down and across, which is TeX's
    1 inch, so these are paper coordinates and not text-block ones.

    WHOSE MATERIAL. SyncTeX tags a BOX with the input line that was current
    when the box was built, and for a paragraph's line boxes that is the
    line `\\par` fired on — the blank line AFTER the paragraph, or the
    `\\section` that ended it. Taking that at face value is what made the
    old point map unusable for cropping. But the box's CONTENTS are tagged
    one node at a time, and those tags are the real thing: the kerns and
    glue inside llama.tex's line boxes say 163, 164, 165 while the boxes
    themselves say 166. So a box is credited with the lines of the nodes
    that stand DIRECTLY in it, and a block's crop is the union of the boxes
    its own lines' nodes are in.

    Three rules make that hold, each against a measured failure:

      - `x` records are not nodes and never credit anything (see
        _AMBIENT_REC above).
      - a node that declares an extent must HAVE one. A zero-width rule is
        a strut, and struts carry the line of the macro that defined them:
        llama.tex's figure caption holds `r1,316:...:0,692380,141880`,
        which credited the caption's rectangle to source line 316 — a
        paragraph eight pages later.
      - a box that holds other boxes is credited only by its own direct
        nodes, never by the fallback below. A frame — a column, a text
        block, a page — must not inherit a line, because its rectangle is
        every line's and cropping to it shows the whole column.

    And one fallback, for the leaf that ends up with no node witness at all
    (64 boxes in llama.tex's 3594 — a lone linked word, a `$x$`): its `x`
    records, then failing those its own tag and line. On every one of those
    64 the box's own line was already the right answer; the ladder is there
    so the LEAF case degrades to the old attribution instead of vanishing.

    ALL TAGS, not just main.tex's. A box from a `.bbl` or an `\\input`
    chapter is reported with that file's tag, so a client keyed by
    (tag, line) can crop it too — and one that only understands main.tex
    can ignore everything else by tag rather than by guessing. Boxes with
    no extent, and boxes that end up enclosing no credited box at all, are
    dropped: they are the 1in origin marker, the empty running head, and
    the leaders and struts that mark places rather than ink.
    """

    def to_pt(value: int) -> float:
        return round(value * unit / _SP_PER_PT, 2)

    page: int | None = None
    # one entry per open box: its index in `built`, or None for a box whose
    # record would not parse (its `)` still has to be counted, or every box
    # after it is credited to the wrong parent)
    stack: list[int | None] = []
    built: list[dict[str, Any]] = []
    # per box, and kept off the wire: the witnesses it collected while open
    nodes: list[set[tuple[int, int]]] = []
    ambient: list[set[tuple[int, int]]] = []
    kids: list[int] = []
    own: list[tuple[int, int]] = []

    for raw in text.splitlines():
        if not raw:
            continue
        c = raw[0]
        if c == "{" and raw[1:].strip().isdigit():
            page = int(raw[1:].strip())
            stack.clear()  # a truncated page must not leak into the next
            continue
        if c == "}":
            page = None
            stack.clear()
            continue
        if page is None:
            continue
        if c in ")]":
            if stack:
                stack.pop()
            continue
        opening = c in "(["
        rec = _SYNCTEX_ANY_REC.match(raw)
        if rec is None:
            if opening:
                stack.append(None)
            continue
        w = h = d = None
        if rec.group("w") is not None:
            w = to_pt(int(rec.group("w")))
            h = to_pt(int(rec.group("h")))
            d = to_pt(int(rec.group("d")))
        tag = int(rec.group("tag"))
        src = int(rec.group("line"))

        if opening:
            parent = next((i for i in reversed(stack) if i is not None), -1)
            if parent >= 0:
                kids[parent] += 1
            stack.append(len(built))
            built.append({"page": page,
                          "x": to_pt(int(rec.group("x"))), "y": to_pt(int(rec.group("y"))),
                          "w": w or 0.0, "h": h or 0.0, "d": d or 0.0,
                          "parent": parent})
            nodes.append(set())
            ambient.append(set())
            kids.append(0)
            own.append((tag, src))
            continue

        host = next((i for i in reversed(stack) if i is not None), -1)
        if host < 0:
            continue
        if c == _AMBIENT_REC:
            ambient[host].add((tag, src))
        elif w is None or (w > 0 and (h or 0.0) + (d or 0.0) > 0):
            nodes[host].add((tag, src))

    # credit, then keep only what is ink or a frame around ink
    witnesses: list[set[tuple[int, int]]] = []
    for i, box in enumerate(built):
        # a box with no rectangle is never anyone's ink, whatever stands in
        # it. TeX writes plenty of them and they are all markers: the 1in
        # origin box (w=0), the empty running head (h+d=0), the zero-width
        # struts a `\vphantom` leaves down a column, and beamer's negative-
        # width overlay boxes (measured: `w=-56.91` on every frame of
        # beamer.tex). Credited, each becomes a crop of nothing — 65 of
        # llama.tex's boxes and 57 of beamer.tex's.
        if not (box["w"] > 0 and box["h"] + box["d"] > 0):
            witnesses.append(set())
            continue
        witness = nodes[i]
        if not witness and kids[i] == 0:
            witness = ambient[i] or {own[i]}
        witnesses.append(set(witness))

    # CONTAINMENT DECIDES. A box that holds other boxes is a frame unless
    # everything inside it belongs to the same source lines it does. TeX
    # attributes the boxes it opens at page shipout to whatever line was
    # current then — on llama.tex page 1 that is `\section{Approach}`, and
    # the boxes so attributed are the PAGE'S TEXT BLOCK and both of its
    # columns, each of them holding real glue that says 152 in so many
    # words. Cropping that section heading to its own credited boxes would
    # have shown the whole page. What tells it from a real one is that its
    # descendants speak for other lines: a heading's own line box holds
    # nothing but the box of its section NUMBER, credited to the very same
    # line, and stays. Same rule keeps a .bbl's column vbox (credited to a
    # bibliography line by its baselineskip glue, holding 85 entries) from
    # standing for one entry.
    below: list[set[tuple[int, int]]] = [set() for _ in built]
    for i in range(len(built) - 1, -1, -1):
        parent = built[i]["parent"]
        if parent >= 0:
            below[parent] |= below[i] | witnesses[i]
    keep: set[int] = set()
    credited: list[list[list[int]]] = []
    for i in range(len(built)):
        witness = witnesses[i]
        if kids[i] > 0 and not below[i] <= witness:
            witness = set()
        credited.append([[t, l] for t, l in sorted(witness)])
        if witness:
            keep.add(i)
    frontier = list(keep)
    while frontier:
        parent = built[frontier.pop()]["parent"]
        if parent >= 0 and parent not in keep:
            keep.add(parent)
            frontier.append(parent)

    out: list[dict[str, Any]] = []
    index: dict[int, int] = {}
    for i, box in enumerate(built):
        if i not in keep:
            continue
        parent = box["parent"]
        # a dropped ancestor is skipped over, never renumbered away: the
        # chain still has to reach the frame that survived
        while parent >= 0 and parent not in index:
            parent = built[parent]["parent"]
        index[i] = len(out)
        out.append({**box, "parent": index.get(parent, -1) if parent >= 0 else -1,
                    "src": credited[i]})
    return out


# ---------------------------------------------------------------------------
# assets
# ---------------------------------------------------------------------------

class AssetError(ValueError):
    """An asset path or payload the daemon refuses to write."""


def _safe_asset_path(workdir: Path, name: str) -> Path:
    """Resolve an asset name inside the workdir or refuse.

    Three separate checks because each catches something the others miss:
    the textual `..` check catches the obvious traversal, `is_absolute`
    catches `/etc/cron.d/x`, and the final containment check catches what
    the platform decides a path means (drive letters, `\\` separators,
    symlinked temp roots)."""
    if not name or name.strip() != name:
        raise AssetError(f"asset name is empty or padded: {name!r}")
    candidate = Path(name)
    if candidate.is_absolute() or name.startswith(("/", "\\")) or ":" in name[:3]:
        raise AssetError(f"asset path must be relative: {name!r}")
    if ".." in candidate.parts:
        raise AssetError(f"asset path may not contain '..': {name!r}")
    if any(part in {"", "."} for part in candidate.parts):
        raise AssetError(f"asset path is malformed: {name!r}")
    target = (workdir / candidate).resolve()
    root = workdir.resolve()
    if root != target and root not in target.parents:
        raise AssetError(f"asset path escapes the work directory: {name!r}")
    # the workdir's OWN main.tex is the document being compiled; a
    # `chapters/main.tex` is just a file a multi-file project may honestly
    # have, and refusing it by bare name refused a real project's chapter
    if target == root / "main.tex":
        raise AssetError("asset may not overwrite main.tex")
    return target


def _adapt_source_for_engine(tex_source: str, engine: str) -> str:
    """Neutralize `\\pdfoutput=1` for XeTeX-based engines, in the WORKDIR
    copy only — the user's file is never touched.

    That line is arXiv boilerplate ("tell arXiv to use pdfLaTeX"). Under
    XeTeX the LaTeX kernel now aliases \\pdfoutput for compatibility, so
    setting it makes hyperref's driver detection load the pdfLaTeX driver,
    which dies inside hpdftex.def. Output is a PDF under XeTeX regardless,
    so commenting the assignment changes nothing the author asked for."""
    if engine not in {"tectonic", "xelatex"}:
        return tex_source
    return re.sub(
        r"^([ \t]*)\\pdfoutput[ \t]*=[ \t]*1[ \t]*$",
        r"\1% \\pdfoutput=1  (arXiv pdfLaTeX hint — inert under XeTeX; dia)",
        tex_source,
        count=1,
        flags=re.M,
    )


# How far below the opened document's directory the workdir mirror goes.
# `\input{chapters/intro}` is one level, `\input{parts/two/intro}` two;
# past that a document is no longer describing a project layout, and an
# unbounded walk of whatever directory the user happened to open is not
# something the compile needs. Matches MAX_GRANT_DEPTH on the client, which
# bounds the same reach through the browser's folder grant.
MAX_LINK_DEPTH = 3


def _link_support_files(workdir: Path, source_dir: Path, depth: int = 0) -> None:
    """Mirror the opened document's sibling files (styles, classes, figures,
    and the \\input'd chapters) into the workdir. TEXINPUTS alone is not
    enough: tectonic has no kpathsea and resolves relative inputs against
    the CURRENT directory only, so the support files must appear to live
    beside main.tex. Links are read-only by construction — the engine writes
    its outputs into the workdir, and a symlinked source file is never an
    output target. Existing workdir entries (main.tex, client-sent assets)
    always win.

    SUBDIRECTORIES ARE MIRRORED, not skipped: a multi-file document keeps
    its chapters in one, and skipping them meant a CLI-opened thesis failed
    on `File 'chapters/intro.tex' not found` no matter what TEXINPUTS said.
    They are mirrored as real directories walked FILE BY FILE, never
    symlinked whole — a symlinked directory hands the engine everything
    below it in one move and makes MAX_LINK_DEPTH a suggestion instead of a
    bound. Walking also merges: a subdirectory the client already populated
    (its edited chapters landed there as assets) keeps those copies and only
    gains what it lacked, because compiling the bytes on disk when the user
    has edited them is compiling a document nobody is looking at."""
    try:
        entries = list(source_dir.iterdir())
    except OSError:
        return
    for entry in entries:
        target = workdir / entry.name
        if entry.is_dir():
            if depth + 1 >= MAX_LINK_DEPTH:
                continue
            try:
                target.mkdir(exist_ok=True)
            except OSError:
                continue
            _link_support_files(target, entry, depth + 1)
            continue
        if target.exists() or target.is_symlink():
            continue
        try:
            target.symlink_to(entry.resolve())
        except OSError:
            # filesystems without symlinks: copy the file
            try:
                shutil.copy2(entry, target)
            except OSError:
                pass
    if depth == 0:
        _adopt_precompiled_bbl(workdir, entries)


def _adopt_precompiled_bbl(workdir: Path, entries: list[Path]) -> None:
    """arXiv bundles ship the references as a precompiled .bbl named after
    the ORIGINAL main file; our job is always main.tex, so LaTeX reads
    main.bbl and renders an empty References section. When no main.bbl and
    no .bib exists to regenerate one, adopt the sibling .bbl and rewrite
    main.tex's \\bibliography{…} to \\input it directly — tectonic reruns
    bibtex regardless, and with the .bib missing that overwrites main.bbl
    with an EMPTY one (measured on cot.tex), so the adopted copy lives
    under a name bibtex never touches and the \\bibliography command that
    would trigger the rerun is gone."""
    if (workdir / "main.bbl").exists():
        return
    if any(e.suffix == ".bib" for e in entries if e.is_file()):
        return
    bbls = sorted(e for e in entries if e.is_file() and e.suffix == ".bbl")
    if not bbls:
        return
    main = workdir / "main.tex"
    try:
        source = main.read_text(encoding="utf-8")
    except OSError:
        return
    if not re.search(r"\\bibliography\{[^}]*\}", source):
        return
    stem_match = [b for b in bbls if (b.parent / f"{b.stem}.tex").exists()]
    pick = stem_match[0] if stem_match else bbls[0]
    try:
        shutil.copy2(pick, workdir / "diarefs.bbl")
    except OSError:
        return
    main.write_text(
        re.sub(r"\\bibliography\{[^}]*\}", r"\\input{diarefs.bbl}", source, count=1),
        encoding="utf-8")


def write_assets(workdir: Path, assets: dict[str, str]) -> list[str]:
    """Write client-supplied assets into the workdir. Values are either a
    `data:…;base64,…` URI (images) or plain text (.bib, .cls, .sty).
    Returns the names written; raises AssetError on the first bad path."""
    written: list[str] = []
    for name, value in (assets or {}).items():
        target = _safe_asset_path(workdir, str(name))
        target.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(value, str) and value.startswith("data:"):
            head, sep, payload = value.partition(",")
            if not sep or ";base64" not in head:
                raise AssetError(f"asset {name!r}: data URI must be base64")
            try:
                target.write_bytes(base64.b64decode(payload, validate=True))
            except Exception as exc:  # noqa: BLE001 — one message, no traceback
                raise AssetError(f"asset {name!r}: undecodable base64") from exc
        else:
            target.write_text(str(value), encoding="utf-8")
        written.append(str(Path(name).as_posix()))
    return written


# ---------------------------------------------------------------------------
# engine argv
# ---------------------------------------------------------------------------

def engine_argv(engine: str, path: str, source: str = "main.tex") -> list[str]:
    """The argv for one run of `engine`. SyncTeX on, never interactive:
    -interaction=nonstopmode means a broken document produces a log and an
    exit code instead of a prompt at a stdin nobody is attached to."""
    if engine == "tectonic":
        # -X selects the v2 CLI; --keep-logs is what makes parse_log possible
        # (tectonic otherwise discards main.log on success).
        return [path, "-X", "compile", "--synctex", "--keep-logs",
                "--outdir", ".", source]
    if engine == "latexmk":
        return [path, "-pdf", "-synctex=1", "-interaction=nonstopmode",
                "-file-line-error", "-output-directory=.", source]
    if engine in {"xelatex", "pdflatex"}:
        return [path, "-synctex=1", "-interaction=nonstopmode",
                "-file-line-error", source]
    raise CompileError(f"unknown engine: {engine}")


def engine_passes(engine: str) -> int:
    """Raw engines need a second pass for refs/toc to settle; tectonic and
    latexmk decide for themselves."""
    return 2 if engine in {"xelatex", "pdflatex"} else 1


# ---------------------------------------------------------------------------
# the job
# ---------------------------------------------------------------------------

EventCb = Callable[[dict], None]

# Only .tex, and only what this compile actually laid out. A .sty, a .cls
# or a bundle file is not a place the editor can jump to, and admitting one
# here would change what a single-file document reports today — the one
# thing chapter attribution is not allowed to do.
_SOURCE_SUFFIX = ".tex"
# Caps on the workdir walk. It follows symlinks, and on the CLI path one of
# those symlinks is the user's own document directory, which may be a paper
# repo with a deep tree in it. The walk feeds a log parser, so running out
# of budget costs an attribution, never a compile.
_WALK_MAX_FILES = 2000
_WALK_MAX_DEPTH = 6
# A .tex big enough to be a generated blob is not a file anyone edits, and
# counting its lines is work nobody asked for.
_WALK_MAX_BYTES = 4 * 1024 * 1024


def source_map(workdir: Path, texinputs_dir: Path | None = None,
               root: str = "main.tex") -> SourceMap:
    """The .tex files this compile can honestly attribute a finding to.

    Keyed relative to the workdir, which is also the engine's cwd and
    therefore the same key `\\input{chapters/method}` resolves against — the
    project-relative path the client already uses for assets and for
    /project/file. Absolute temp paths never leave this function.

    The walk follows symlinks because that is how the CLI path puts the
    document's own folder in front of the engine (see _link_support_files),
    and it de-duplicates on the real path so a directory that links to its
    own parent cannot spin."""
    import os

    lines: dict[str, int] = {}
    roots: list[str] = []
    for base in (workdir, texinputs_dir):
        if base is None:
            continue
        for form in (str(base), str(base.resolve())):
            # both forms, because /tmp is a symlink to /private/tmp on macOS
            # and a log may print either one
            if not form.endswith("/"):
                form += "/"
            if form not in roots:
                roots.append(form)

    start = str(workdir)
    seen: set[str] = set()
    budget = _WALK_MAX_FILES
    for dirpath, dirnames, filenames in os.walk(start, followlinks=True):
        real = os.path.realpath(dirpath)
        if real in seen:
            dirnames[:] = []
            continue
        seen.add(real)
        depth = os.path.relpath(dirpath, start).count(os.sep) + 1
        if depth >= _WALK_MAX_DEPTH or budget <= 0:
            dirnames[:] = []
        for name in filenames:
            if not name.endswith(_SOURCE_SUFFIX) or budget <= 0:
                continue
            budget -= 1
            path = Path(dirpath) / name
            try:
                if path.stat().st_size > _WALK_MAX_BYTES:
                    continue
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            key = Path(os.path.relpath(path, start)).as_posix()
            lines[key] = text.count("\n") + (1 if text and not text.endswith("\n") else 0)
    built = SourceMap(lines=lines, root=root, roots=tuple(roots))
    return replace(built, multi_file=_pulls_in_another_source(workdir, built))


# `\input{chapters/method}` / `\include{chapters/method}` — the braces form
# only, which is the one the editor emits and the one the rest of this
# codebase already assumes.
_INPUTS = re.compile(r"\\(?:input|include)\s*\{([^}]*)\}")
# an unescaped `%` starts a comment; `% \input{old}` is not an input, and
# counting it would flip a one-file document into the multi-file answer
_COMMENT = re.compile(r"(?<!\\)%.*$", re.M)


def _pulls_in_another_source(workdir: Path, sources: SourceMap) -> bool:
    """Does the root really read another of this project's .tex files?

    Asked of the SOURCE rather than of the log, because the case that needs
    the answer most is the one where no chapter ever gets opened: a broken
    \\usepackage stops the run in the preamble, and the log then looks
    exactly like a single-file document's."""
    try:
        text = (workdir / sources.root).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    for m in _INPUTS.finditer(_COMMENT.sub("", text)):
        name = sources.resolve(m.group(1).strip())
        if name is not None and name != sources.root:
            return True
    return False


@dataclass
class CompileJob:
    """One compile, from temp directory to PDF (or to a list of errors)."""

    id: str
    doc_id: str
    engine: str
    engine_path: str
    workdir: Path
    timeout: float = 180.0
    texinputs_dir: Path | None = None

    status: str = "queued"  # queued | running | ok | error | cancelled | timeout
    events: list[dict] = field(default_factory=list)
    errors: list[TexError] = field(default_factory=list)
    log: str = ""
    pages: int | None = None
    duration: float = 0.0
    detail: str | None = None
    finished: bool = False

    _proc: subprocess.Popen | None = field(default=None, repr=False)
    _cancelled: bool = field(default=False, repr=False)
    # the workdir's .tex files and their line counts, walked once (sources)
    _sources: SourceMap | None = field(default=None, repr=False)
    # page rasterization state: one poppler run at a time per job, and the
    # page geometry computed once (see page_geometry)
    _render_lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    _geometry: dict | None = field(default=None, repr=False)
    _cond: threading.Condition = field(default_factory=threading.Condition, repr=False)
    # held across "am I cancelled?" + Popen, so a DELETE that lands in that
    # window cannot miss the process it is trying to kill
    _spawn: threading.Lock = field(default_factory=threading.Lock, repr=False)

    # -- event plumbing ----------------------------------------------------

    def emit(self, event: dict) -> None:
        with self._cond:
            self.events.append(event)
            self._cond.notify_all()

    def events_since(self, index: int, timeout: float = 30.0) -> list[dict]:
        """Block until there is an event after `index` (or the job ends).
        Called from a worker thread by the SSE endpoint; the timeout lets
        the stream send a keepalive rather than hold a thread forever."""
        with self._cond:
            if index >= len(self.events) and not self.finished:
                self._cond.wait(timeout)
            return self.events[index:]

    # -- paths -------------------------------------------------------------

    @property
    def pdf_path(self) -> Path:
        return self.workdir / "main.pdf"

    @property
    def synctex_path(self) -> Path | None:
        for name in ("main.synctex.gz", "main.synctex"):
            p = self.workdir / name
            if p.is_file():
                return p
        return None

    @property
    def bbl_path(self) -> Path | None:
        """The compiled bibliography — bibtex's main.bbl, or the precompiled
        one adopted from an arXiv bundle under diarefs.bbl (see
        _adopt_precompiled_bbl). Either holds \\bibitem[{label}]{key} entries
        whose optional label is the client's source for author-year cite
        text; a document with no bibliography has neither."""
        for name in ("main.bbl", "diarefs.bbl"):
            p = self.workdir / name
            if p.is_file():
                return p
        return None

    def _source_text(self) -> str:
        """The workdir's main.tex — the adapted copy (see
        _adapt_source_for_engine), which still carries the author's
        \\usepackage options untouched. Empty string, never an exception,
        if it cannot be read: this feeds a warning check, not a build step."""
        try:
            return (self.workdir / "main.tex").read_text(encoding="utf-8", errors="replace")
        except OSError:
            return ""

    def sources(self) -> SourceMap:
        """The files this job's findings may name — the identity half of a
        compile, and the reason an error inside an \\input'd chapter can say
        `chapters/method.tex` instead of a line number against the wrong
        file. Cached: parse_log asks once per run, but page/synctex requests
        arrive later against the same workdir."""
        if self._sources is None:
            self._sources = source_map(self.workdir, self.texinputs_dir)
        return self._sources

    def _blg_text(self) -> str:
        """classic bibtex's own log, if this run produced one. Empty when
        biber ran instead (biber writes no .blg) or nothing ran at all."""
        p = self.workdir / "main.blg"
        try:
            return p.read_text(encoding="utf-8", errors="replace") if p.is_file() else ""
        except OSError:
            return ""

    def status_dict(self) -> dict[str, Any]:
        return {
            "jobId": self.id,
            "docId": self.doc_id,
            "status": self.status,
            "engine": self.engine,
            "pages": self.pages,
            "durationMs": round(self.duration * 1000),
            "errors": [e.as_dict() for e in self.errors],
            "detail": self.detail,
        }

    # -- execution ---------------------------------------------------------

    def _env(self) -> dict[str, str] | None:
        """TEXINPUTS pointing at the opened document's directory, so
        relative \\includegraphics and \\input resolve. Read-only by
        construction: the engine's *output* directory is the temp workdir,
        so nothing lands beside the user's file."""
        import os

        if self.texinputs_dir is None:
            return None
        env = dict(os.environ)
        prior = env.get("TEXINPUTS", "")
        # trailing empty entry = "and the default search path too"
        env["TEXINPUTS"] = f".:{self.texinputs_dir}:{prior}" if prior else f".:{self.texinputs_dir}:"
        return env

    def cancel(self) -> None:
        """Stop the run. Safe to call before it starts, during, or after.

        A job is registered before its thread has spawned anything, so the
        common case — the editor superseding a compile it fired a moment
        ago — is precisely the race: either this sets the flag before the
        worker reads it, or the worker has published `_proc` for us to kill.
        The lock makes those the only two outcomes."""
        with self._spawn:
            self._cancelled = True
            proc = self._proc
        if proc is not None and proc.poll() is None:
            proc.kill()

    def run(self) -> "CompileJob":
        """Compile, blocking, streaming log lines as events. Never raises for
        a *document* problem — a failing document is a normal outcome with
        `status: "error"` and parsed errors."""
        started = time.monotonic()
        self.status = "running"
        self.emit({"type": "phase", "phase": "start", "engine": self.engine,
                   "jobId": self.id})
        chunks: list[str] = []
        try:
            passes = engine_passes(self.engine)
            for i in range(passes):
                if self._cancelled:
                    break
                if passes > 1:
                    self.emit({"type": "phase", "phase": "pass", "pass": i + 1,
                               "of": passes})
                code = self._run_once(chunks, remaining=self.timeout - (time.monotonic() - started))
                if code is None:  # timed out or cancelled
                    break
        except FileNotFoundError:
            self.status = "error"
            self.detail = f"engine not found: {self.engine_path}"
        except OSError as exc:
            self.status = "error"
            self.detail = f"engine failed to start: {exc}"

        self.duration = time.monotonic() - started
        self.log = "".join(chunks)
        # The log on disk is richer than the console stream (tectonic prints
        # a summary but writes the full TeX log to main.log), so prefer it.
        disk_log = self.workdir / "main.log"
        if disk_log.is_file():
            try:
                self.log = disk_log.read_text(encoding="utf-8", errors="replace")
            except OSError:
                pass
        # built here rather than at create() time: the walk is what tells
        # parse_log which files a finding may be attributed to, and by now
        # the engine has laid out everything it was going to lay out
        self.errors = parse_log(self.log, self.sources())

        if self._cancelled:
            self.status = "cancelled"
        elif self.status == "running":
            if self.pdf_path.is_file() and self.pdf_path.stat().st_size > 0:
                self.status = "ok"
                self.pages = _page_count(self.log, self.pdf_path)
                # a real PDF is exactly the case parse_log's findings do not
                # cover: the engine reported success, but the citation TEXT
                # can still be wrong (issue #23) — see the module comment
                # above biblatex_bibtex_backend_finding
                finding = biblatex_bibtex_backend_finding(
                    source=self._source_text(), log=self.log,
                    blg=self._blg_text())
                if finding is not None:
                    self.errors.append(finding)
            else:
                self.status = "error"
                if not self.errors and not self.detail:
                    self.detail = "the engine produced no PDF and no parseable error"

        self.emit({"type": "done", **self.status_dict()})
        with self._cond:
            self.finished = True
            self._cond.notify_all()
        return self

    def _run_once(self, chunks: list[str], remaining: float) -> int | None:
        """One engine invocation. Returns the exit code, or None if it was
        killed (timeout/cancel). Output is streamed line-by-line so a slow
        first tectonic run visibly downloads instead of looking hung."""
        if remaining <= 0:
            self.status = "timeout"
            self.detail = f"compile exceeded {self.timeout:g}s"
            return None
        argv = engine_argv(self.engine, self.engine_path)
        with self._spawn:
            if self._cancelled:
                return None
            self._proc = subprocess.Popen(  # noqa: S603 — argv list, never a shell
                argv,
                cwd=str(self.workdir),
                env=self._env(),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                errors="replace",
                bufsize=1,
            )
            proc = self._proc

        def pump() -> None:
            assert proc.stdout is not None
            for line in proc.stdout:
                chunks.append(line)
                self.emit({"type": "log", "line": line.rstrip("\n")})

        reader = threading.Thread(target=pump, daemon=True)
        reader.start()
        try:
            code = proc.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
            reader.join(timeout=2)
            self.status = "timeout"
            self.detail = f"compile exceeded {self.timeout:g}s — killed"
            self.emit({"type": "phase", "phase": "timeout"})
            return None
        reader.join(timeout=5)
        if self._cancelled:
            return None
        return code

    def cleanup(self) -> None:
        shutil.rmtree(self.workdir, ignore_errors=True)


# `Output written on main.pdf (12 pages, 240981 bytes).` — every engine we
# drive writes this, including tectonic (about its intermediate main.xdv).
_OUTPUT_WRITTEN = re.compile(r"^Output written on \S+ \((\d+) pages?,", re.M)


def _page_count(log: str, pdf: Path) -> int | None:
    """Pages, from the log if it says so and from the PDF bytes otherwise.

    The log is the better source: a modern PDF keeps its page objects in
    compressed object streams, so scanning for `/Type /Page` finds nothing
    at all in tectonic's output. The byte scan stays as the fallback for a
    log we could not read. A missing count is cosmetic — it dims one label
    on a status chip — so neither path is allowed to fail loudly."""
    m = _OUTPUT_WRITTEN.search(log)
    if m:
        return int(m.group(1))
    try:
        data = pdf.read_bytes()
    except OSError:
        return None
    return len(re.findall(rb"/Type\s*/Page[^s]", data)) or None


# ---------------------------------------------------------------------------
# page rasterization (poppler)
# ---------------------------------------------------------------------------
#
# The editor shows a compiled figure *inside* the document view — an "island
# preview" — which means it needs the PDF as pixels, not as a PDF. Poppler
# does that; we invoke `pdftoppm` as an argv list, exactly like the engine.
#
# Two facts the client needs and cannot compute: how many pages there are and
# how big each one is in PDF points. `pdfinfo` answers both exactly; without
# it we render and measure the pixels, which is the same answer to within
# half a pixel. Either way the client gets points, so it can place a synctex
# `y` (also points, top-down) as a fraction of the page.

PAGE_DPI_DEFAULT = 130
# 36 is a legible thumbnail; 300 is print resolution and already a ~2500px
# image for a letter page. Out-of-range values are clamped, not refused: a
# preview at the wrong zoom beats a broken image in the document view.
PAGE_DPI_MIN = 36
PAGE_DPI_MAX = 300
# poppler is doing bounded work on a local file; this only catches a wedge.
PAGE_TOOL_TIMEOUT_S = 30.0
# `pdfinfo -f 1 -l N` prints two lines per page. A document long enough to
# hit this is not one anybody previews page-by-page.
PAGE_INFO_MAX = 10000

_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
# `Page    1 size:  199.25 x 398.51 pts`
_PDFINFO_SIZE = re.compile(
    r"^Page\s+(?P<n>\d+)\s+size:\s+(?P<w>[\d.]+)\s+x\s+(?P<h>[\d.]+)\s+pts", re.M)
# `Page    1 rot:   90` — a rotated page renders transposed, so the size
# poppler reports is not the size of the image it will hand us.
_PDFINFO_ROT = re.compile(r"^Page\s+(?P<n>\d+)\s+rot:\s+(?P<rot>-?\d+)", re.M)
_PDFINFO_COUNT = re.compile(r"^Pages:\s+(\d+)", re.M)


def clamp_dpi(value: Any, default: int = PAGE_DPI_DEFAULT) -> int:
    """A usable dpi from whatever the query string said."""
    try:
        dpi = int(float(value))
    except (TypeError, ValueError):
        return default
    return max(PAGE_DPI_MIN, min(PAGE_DPI_MAX, dpi))


def _capture(argv: list[str]) -> str | None:
    """Run a poppler tool and return its stdout, or None if it failed.

    Nothing here is fatal: every caller has a fallback or a 404, and a
    missing preview must never take down a compile that succeeded."""
    try:
        proc = subprocess.run(  # noqa: S603 — argv list, never a shell
            argv,
            capture_output=True,
            text=True,
            errors="replace",
            stdin=subprocess.DEVNULL,
            timeout=PAGE_TOOL_TIMEOUT_S,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return proc.stdout if proc.returncode == 0 else None


def _png_size(path: Path) -> tuple[int, int] | None:
    """(width, height) in pixels from a PNG's IHDR — 24 bytes, no decoder.

    Pillow would do this too, and would be a hard dependency on a C build
    for the sake of reading two big-endian integers at a fixed offset."""
    try:
        with path.open("rb") as fh:
            head = fh.read(24)
    except OSError:
        return None
    if len(head) < 24 or head[:8] != _PNG_MAGIC:
        return None
    import struct

    w, h = struct.unpack(">II", head[16:24])
    return (w, h) if w and h else None


def _px_to_pt(px: int, dpi: int) -> float:
    return round(px / dpi * 72.0, 2)


def _pdfinfo_pages(pdf: Path, expected: int | None) -> tuple[int, list[dict]] | None:
    """(count, [{n, wPt, hPt}]) from pdfinfo, or None if it is not usable.

    `-l` needs a page number, and the count is what we are asking for — so
    ask for what the log claimed (the usual case: one process, exactly the
    right range) and re-ask only if the PDF turns out to have more pages
    than that."""
    tool = tex.tool_path("pdfinfo")
    if tool is None:
        return None
    wanted = expected if expected and expected > 0 else 1

    for _ in range(2):
        out = _capture([tool, "-f", "1", "-l", str(min(wanted, PAGE_INFO_MAX)), str(pdf)])
        if out is None:
            return None
        m = _PDFINFO_COUNT.search(out)
        count = int(m.group(1)) if m else 0
        rot = {int(r.group("n")): int(r.group("rot"))
               for r in _PDFINFO_ROT.finditer(out)}
        pages = []
        for size in _PDFINFO_SIZE.finditer(out):
            n = int(size.group("n"))
            w, h = float(size.group("w")), float(size.group("h"))
            # /Rotate 90 means poppler hands us a transposed image; report
            # the page as it will be rendered, or every overlay on a
            # landscape page lands on the wrong axis
            if rot.get(n, 0) % 180 == 90:
                w, h = h, w
            pages.append({"n": n, "wPt": round(w, 2), "hPt": round(h, 2)})
        if not pages:
            return None
        if count <= len(pages) or wanted >= PAGE_INFO_MAX:
            return (count or len(pages), pages)
        wanted = count  # the document is longer than the log said — ask again
    return None


def page_geometry(job: "CompileJob") -> dict[str, Any]:
    """The /compile/{id}/pages payload: what can be rendered, and how big.

    Always includes `ySemantics` — it describes parse_synctex's output, not
    poppler's, so it is true even on a machine with no poppler at all."""
    base: dict[str, Any] = {
        "available": False, "tool": None, "count": 0, "pages": [],
        "ySemantics": SYNCTEX_Y_SEMANTICS,
    }
    if job._geometry is not None:
        return dict(job._geometry)

    tool = tex.page_render_tool()
    if tool is None:
        return {**base, "reason": "pdftoppm not found on PATH (install poppler)"}
    if job.status != "ok":
        return {**base, "reason": f"job status is {job.status!r}, not 'ok'"}
    if not job.pdf_path.is_file():
        return {**base, "reason": "the job produced no pdf"}

    with job._render_lock:
        if job._geometry is None:
            job._geometry = _measure(job, tool)
    return dict(job._geometry) if job._geometry else {
        **base, "tool": tool, "reason": "could not determine the page geometry"}


def _measure(job: "CompileJob", tool: str) -> dict[str, Any] | None:
    """pdfinfo if we have it, rendered pixels if we do not. Caller holds the
    job's render lock."""
    found = _pdfinfo_pages(job.pdf_path, job.pages)
    if found is not None:
        count, pages = found
    else:
        # No pdfinfo: measure the images themselves. The renders are cached
        # under the same key the client will ask for, so this costs one pass
        # that the preview was about to pay for anyway.
        count = job.pages or 0
        if count <= 0:
            return None
        pages = []
        for n in range(1, min(count, PAGE_INFO_MAX) + 1):
            png = _render(job, n, PAGE_DPI_DEFAULT)
            size = _png_size(png) if png is not None else None
            if size is None:
                return None
            pages.append({
                "n": n,
                "wPt": _px_to_pt(size[0], PAGE_DPI_DEFAULT),
                "hPt": _px_to_pt(size[1], PAGE_DPI_DEFAULT),
            })
    if not pages:
        return None
    return {
        "available": True, "tool": tool, "count": count, "pages": pages,
        "ySemantics": SYNCTEX_Y_SEMANTICS,
    }


def render_page(job: "CompileJob", n: int, dpi: int = PAGE_DPI_DEFAULT) -> Path | None:
    """One page of the job's PDF as a PNG on disk, or None.

    Cached per (page, dpi) in the job's workdir — the same directory the
    eviction path already deletes, so a rendered preview never outlives the
    job that produced it. A repeat request is a stat(), not a render."""
    if job.status != "ok" or not job.pdf_path.is_file():
        return None
    if n < 1 or tex.page_render_tool() is None:
        return None
    with job._render_lock:
        return _render(job, n, clamp_dpi(dpi))


def _render(job: "CompileJob", n: int, dpi: int) -> Path | None:
    """The uncached-path render. Caller holds the job's render lock, so two
    tabs asking for the same page do not fork two pdftoppm processes."""
    tool = tex.tool_path("pdftoppm")
    if tool is None:
        return None
    target = job.workdir / f"page-{n}-r{dpi}.png"
    try:
        if target.is_file() and target.stat().st_size > 0:
            return target
    except OSError:
        pass
    # -singlefile writes exactly <prefix>.png; without it poppler picks its
    # own zero-padding from the page count and we would have to guess the name
    argv = [
        tool, "-png", "-r", str(dpi), "-f", str(n), "-l", str(n), "-singlefile",
        str(job.pdf_path), str(job.workdir / target.stem),
    ]
    if _capture(argv) is None:
        return None
    try:
        return target if target.stat().st_size > 0 else None
    except OSError:
        return None


# ---------------------------------------------------------------------------
# registry
# ---------------------------------------------------------------------------

_jobs: "OrderedDict[str, CompileJob]" = OrderedDict()
_active: dict[str, str] = {}  # docId -> jobId
_lock = threading.Lock()


def get(job_id: str) -> CompileJob | None:
    with _lock:
        return _jobs.get(job_id)


def create(
    tex_source: str,
    doc_id: str,
    assets: dict[str, str] | None = None,
    engine: str | None = None,
    texinputs_dir: Path | None = None,
    config: dict | None = None,
) -> CompileJob:
    """Prepare a job: pick the engine, lay out the workdir, register it.
    Does not run it — `run()` blocks, and the HTTP path wants the id first.

    Raises CompileError when no engine can serve the request and AssetError
    for a rejected asset path; both are 4xx-shaped, not crashes.
    """
    cap = tex.discover(config=config)
    if cap.engine is None or cap.path is None:
        raise CompileError(cap.detail or "no TeX engine available")
    chosen, chosen_path = cap.engine, cap.path
    if engine and engine != cap.engine:
        # An explicit engine is honored only if it is actually installed —
        # we never silently compile with something else than was asked for.
        import shutil as _shutil

        if engine not in tex.ENGINES:
            raise CompileError(f"unknown engine: {engine}")
        found = _shutil.which(engine)
        if not found:
            raise CompileError(f"engine not installed: {engine}")
        chosen, chosen_path = engine, found

    workdir = Path(tempfile.mkdtemp(prefix="dia-tex-"))
    (workdir / "main.tex").write_text(
        _adapt_source_for_engine(tex_source, chosen), encoding="utf-8")
    try:
        write_assets(workdir, assets or {})
    except AssetError:
        shutil.rmtree(workdir, ignore_errors=True)
        raise
    if texinputs_dir is not None:
        _link_support_files(workdir, texinputs_dir)

    job = CompileJob(
        id=uuid.uuid4().hex[:12],
        doc_id=doc_id or "doc",
        engine=chosen,
        engine_path=chosen_path,
        workdir=workdir,
        timeout=tex.timeout_s(config),
        texinputs_dir=texinputs_dir,
    )

    with _lock:
        # One compile per document: a second POST means the first result is
        # already stale, and two engines in two temp dirs racing to answer
        # the same chip is how you get flickering, out-of-order status.
        previous = _active.get(job.doc_id)
        prev_job = _jobs.get(previous) if previous else None
        _active[job.doc_id] = job.id
        _jobs[job.id] = job
        evictions = []
        while len(_jobs) > MAX_JOBS:
            _, evicted = _jobs.popitem(last=False)
            if evicted.doc_id in _active and _active[evicted.doc_id] == evicted.id:
                del _active[evicted.doc_id]
            evictions.append(evicted)
    if prev_job is not None and not prev_job.finished:
        prev_job.cancel()
    for evicted in evictions:
        evicted.cancel()
        evicted.cleanup()
    return job


def submit(**kwargs: Any) -> CompileJob:
    """create() + run it on a background thread. The HTTP entry point."""
    job = create(**kwargs)
    threading.Thread(target=job.run, name=f"dia-tex-{job.id}", daemon=True).start()
    return job


def compile_sync(
    tex_source: str,
    doc_id: str = "cli",
    assets: dict[str, str] | None = None,
    engine: str | None = None,
    texinputs_dir: Path | None = None,
    config: dict | None = None,
    on_log: EventCb | None = None,
) -> CompileJob:
    """Blocking compile for the CLI. Same code path, no threads, no SSE."""
    job = create(
        tex_source=tex_source, doc_id=doc_id, assets=assets, engine=engine,
        texinputs_dir=texinputs_dir, config=config,
    )
    if on_log is not None:
        job.emit = _tee(job, on_log)  # type: ignore[method-assign]
    return job.run()


def _tee(job: CompileJob, cb: EventCb) -> EventCb:
    original = CompileJob.emit.__get__(job, CompileJob)

    def emit(event: dict) -> None:
        original(event)
        cb(event)

    return emit


def reset() -> None:
    """Drop every job and its temp directory (tests, shutdown)."""
    with _lock:
        jobs = list(_jobs.values())
        _jobs.clear()
        _active.clear()
    for job in jobs:
        job.cancel()
        job.cleanup()
