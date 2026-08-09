"""parse_synctex: the coarse source-line → page/x/y map."""

from __future__ import annotations

import gzip
from pathlib import Path

from dia_service.texcompile import parse_synctex

FIXTURE = Path(__file__).parent / "synctex" / "main.synctex"


def write(tmp_path: Path, body: str) -> dict:
    path = tmp_path / "probe.synctex"
    path.write_text(body)
    return parse_synctex(path)


def test_pages_and_lines():
    out = parse_synctex(FIXTURE)
    # 30785863sp / 65536 = 469.75pt — the TEXT BLOCK, not the paper: synctex
    # records no page dimensions, and pretending otherwise would send a PDF
    # panel to the wrong place on every page
    assert out["pages"] == [
        {"n": 1, "w": 469.75, "h": 721.26},
        {"n": 2, "w": 469.75, "h": 721.26},
    ]
    assert out["lines"] == [
        {"line": 4, "page": 1, "x": 72.27, "y": 79.5, "w": 469.75},
        {"line": 9, "page": 1, "x": 72.27, "y": 110.01, "w": 469.75},
        {"line": 21, "page": 2, "x": 72.27, "y": 79.5, "w": 469.75},
    ]
    assert out["xSemantics"] == "leftPt"
    assert out["ySemantics"] == "topDownPt"


def test_gzipped_reads_identically(tmp_path):
    """Engines write main.synctex.gz by default; the same file gzipped must
    parse to the same map, not to an empty one."""
    packed = tmp_path / "main.synctex.gz"
    packed.write_bytes(gzip.compress(FIXTURE.read_bytes()))
    assert parse_synctex(packed) == parse_synctex(FIXTURE)


def test_missing_or_garbage_file_is_empty_not_fatal(tmp_path):
    """No lines and no boxes, but still the semantics labels: they describe
    the format, not the file, so a client parsing an empty answer keeps its
    bearings."""
    empty = {"pages": [], "lines": [], "boxes": [], "inputs": [], "mainTag": None,
             "xSemantics": "leftPt", "ySemantics": "topDownPt",
             "boxSemantics": "refPointPt"}
    assert parse_synctex(tmp_path / "nope.synctex") == empty
    junk = tmp_path / "junk.synctex"
    junk.write_bytes(b"\x1f\x8bnot actually gzip")
    assert parse_synctex(junk) == empty


# ---------------------------------------------------------------------------
# which record a line keeps
# ---------------------------------------------------------------------------

# One two-column page, transcribed from a real tectonic run and trimmed to
# the records that matter. 500pt paper, 25pt margins, 10pt gutter, so the
# columns start at x=25 and x=255 and are 220pt wide.
#
# Source line 7 is the line the page break landed on, so it owns the page
# box, the text block, the empty running head, BOTH column boxes — and,
# under all of that, its own two lines of type in column two. Line 5's
# paragraph is what fills column one.
NESTED = """SyncTeX Version:1
Input:1:/tmp/dia-tex-x/main.tex
Output:pdf
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
[1,7:4736287,26542081:26393314,21805794,0
(1,7:4736287,4736287:0,0,0
)
[1,7:1638401,26542081:29491200,27328512,0
[1,7:1638401,1:29491200,786432,0
(1,7:1638401,1:29491200,0,0
h1,7:1638401,1:29491200,0,0
)
]
[1,7:1638401,24576001:29491200,22937600,0
(1,7:1638401,24576001:14417920,22937600,0
(1,5:1638401,2293761:14417920,469238,14417
h1,5:1638401,2293761:655360,0,0
)
)
k1,7:16384001,24576001:327680
(1,7:16711681,24576001:14417920,22937600,0
(1,7:16711681,2293761:14417920,483656,14417
)
(1,7:16711681,3080193:14417920,469238,14417
)
)
]
]
]
}1
Postamble:
Count:24
Post scriptum:
"""


def test_a_line_keeps_its_own_type_not_the_boxes_it_closed(tmp_path):
    """The rule that makes `x` mean a column.

    Line 7's FIRST record is the page box at TeX's 1in origin (72.27) and
    its LEFTMOST is the full-width text block (25.00) — both would say
    "column one" about type that is in column two. Only the innermost box
    it owns gets the column right."""
    out = write(tmp_path, NESTED)
    lines = {r["line"]: r for r in out["lines"]}

    assert lines[5] == {"line": 5, "page": 1, "x": 25.0, "y": 35.0, "w": 220.0}
    assert lines[7] == {"line": 7, "page": 1, "x": 255.0, "y": 35.0, "w": 220.0}
    # …and the containers it closed are still measured for the extent
    assert out["pages"] == [{"n": 1, "w": 450.0, "h": 417.0}]


def test_degenerate_boxes_are_never_a_line_position(tmp_path):
    """A box with no extent holds no type — the 1in origin marker at
    (72.27, 72.27) and the empty running head at (25, 0) are both innermost
    boxes of line 7's, and both would otherwise win it outright."""
    picked = {(r["x"], r["y"]) for r in write(tmp_path, NESTED)["lines"]}
    assert (72.27, 72.27) not in picked, "kept the 1in origin marker"
    assert (25.0, 0.0) not in picked, "kept the empty running head"


def test_a_paragraph_reports_its_first_line_not_its_last(tmp_path):
    """Line 7 typeset two lines in column two; the scroll target is the top
    of the type, so the earlier box wins. The two differ in height (the
    taller one has an ascender in it), which is why height cannot be what
    picks the box."""
    lines = {r["line"]: r for r in write(tmp_path, NESTED)["lines"]}
    assert lines[7]["y"] == 35.0, "took the paragraph's second line"


def test_a_line_with_no_typeset_box_still_reports_a_position(tmp_path):
    """A line whose only record on the page is a kern — the page broke
    between its paragraphs — keeps its first record, as this function
    always did, and omits `w` rather than inventing a zero."""
    out = write(tmp_path, NESTED.replace(
        "k1,7:16384001,24576001:327680", "k1,9:16384001,24576001:327680"))
    line9 = [r for r in out["lines"] if r["line"] == 9]
    assert line9 == [{"line": 9, "page": 1, "x": 250.0, "y": 375.0}]


def test_a_zero_width_fallback_omits_w_rather_than_reporting_it(tmp_path):
    """The 1in origin marker is 0x0. When it is all a line has, `w: 0` is
    worse than no `w` at all — a client would crop nothing and believe it.
    A real paper hit this on 298 of 1632 records."""
    out = write(tmp_path, NESTED.replace("(1,5:1638401,2293761:14417920,469238,14417",
                                         "(1,5:1638401,2293761:0,0,0"))
    line5 = [r for r in out["lines"] if r["line"] == 5]
    assert line5 == [{"line": 5, "page": 1, "x": 25.0, "y": 35.0}]


def test_an_unbalanced_file_does_not_leak_across_pages(tmp_path):
    """A truncated page leaves boxes open. They must not swallow the next
    page's records — a synctex file we cannot fully trust still has to
    produce a usable map."""
    out = write(tmp_path, NESTED.replace("]\n]\n]\n}1", "}1"))
    assert [r["page"] for r in out["lines"]] == [1, 1]
    assert {r["line"] for r in out["lines"]} == {5, 7}


def test_an_unreadable_box_does_not_desync_the_stack(tmp_path):
    """A box we cannot parse still has a `)` coming. Losing count of it
    would credit that `)` to the wrong box and hand line 7 a container."""
    out = write(tmp_path, NESTED.replace(
        "(1,7:16711681,2293761:14417920,483656,14417", "(garbage"))
    line7 = [r for r in out["lines"] if r["line"] == 7]
    assert line7 == [{"line": 7, "page": 1, "x": 255.0, "y": 47.0, "w": 220.0}]


def test_records_from_other_input_files_are_dropped(tmp_path):
    """A .bbl (or any \\input) reuses main.tex's line numbers; merging tags
    attributed bibliography boxes to body paragraphs. Only main.tex's tag
    joins the line map."""
    synctex = "\n".join([
        "SyncTeX Version:1",
        "Input:1:/tmp/dia-tex-x/main.tex",
        "Input:2:/tmp/dia-tex-x/refs.bbl",
        "Unit:1",
        "Content:",
        "{1",
        "(1,10:4736286,5209886:30785863,655360,196608",
        "h1,10:4736286,5209886:30785863,655360,196608",
        ")1,10:4736286,5209886:30785863,655360,196608",
        "(2,10:4736286,9000000:30785863,655360,196608",
        "h2,10:4736286,9000000:30785863,655360,196608",
        ")2,10:4736286,9000000:30785863,655360,196608",
        "}1",
    ])
    path = tmp_path / "main.synctex"
    path.write_text(synctex, encoding="utf-8")
    out = parse_synctex(path)
    lines = out["lines"]
    assert len(lines) == 1  # the .bbl's line-10 record is gone
    assert lines[0]["line"] == 10
    assert lines[0]["y"] == 79.5  # main.tex's box, not the .bbl's


# ---------------------------------------------------------------------------
# the box tree
# ---------------------------------------------------------------------------

def boxes_of(out, tag=1):
    """the credited boxes, as (lines, rect) — the shape a client crops from"""
    got = []
    for b in out["boxes"]:
        lines = sorted(l for t, l in b["src"] if t == tag)
        if not lines:
            continue
        got.append((lines, (b["x"], round(b["x"] + b["w"], 2),
                            round(b["y"] - b["h"], 2), round(b["y"] + b["d"], 2))))
    return got


def test_boxes_report_the_rectangle_the_engine_set(tmp_path):
    """`x, y` is TeX's reference point: the box covers x..x+w across and
    y-h..y+d down. Verified against a real compile — see parse_boxes."""
    out = write(tmp_path, NESTED)
    got = dict((tuple(lines), rect) for lines, rect in boxes_of(out))
    # line 5's own line of type: 220pt wide, 7.16pt tall, 0.22pt deep
    assert got[(5,)] == (25.0, 245.0, 27.84, 35.22)
    assert out["boxSemantics"] == "refPointPt"


def test_a_container_is_not_credited_to_the_line_that_closed_it(tmp_path):
    """The rule the whole box tree turns on. Source line 7 is the line the
    page break landed on, so it owns the page box, the text block and BOTH
    column boxes as well as its own two lines of type. Every one of those
    containers holds boxes that speak for other lines, and crediting them
    would crop the whole page to line 7."""
    out = write(tmp_path, NESTED)
    rects = [rect for lines, rect in boxes_of(out) if 7 in lines]
    # only line 7's own two lines of type, both in column two
    assert rects == [(255.0, 475.0, 27.62, 35.22), (255.0, 475.0, 39.84, 47.22)]


def test_a_box_holding_only_its_own_line_survives_the_containment_rule(tmp_path):
    """…and the rule must not eat a real one. A section heading's line box
    holds nothing but the box of its section NUMBER, credited to the very
    same source line."""
    synctex = NESTED.replace(
        "h1,5:1638401,2293761:655360,0,0",
        "(1,5:1638401,2293761:1638400,469238,14417\n"
        "h1,5:1638401,2293761:655360,0,0\n"
        ")\n"
        "k1,5:3276801,2293761:65536")
    rects = [rect for lines, rect in boxes_of(write(tmp_path, synctex)) if lines == [5]]
    assert (25.0, 245.0, 27.84, 35.22) in rects, "lost the heading's own line box"


def test_a_zero_extent_box_is_never_credited(tmp_path):
    """TeX writes plenty of boxes with no rectangle — the 1in origin marker
    (w=0), the empty running head (h+d=0) — and each would be a crop of
    nothing. Measured: 65 such boxes in llama.tex, 57 in beamer.tex."""
    for lines, rect in boxes_of(write(tmp_path, NESTED)):
        assert rect[1] > rect[0] and rect[3] > rect[2], f"credited an empty box: {lines} {rect}"


def test_a_strut_does_not_credit_the_box_it_stands_in(tmp_path):
    """A rule with no width is a strut, and struts carry the line of the
    MACRO that defined them. llama.tex's figure caption holds
    `r1,316:...:0,692380,141880`, which credited the caption's rectangle to
    a paragraph eight pages later."""
    synctex = NESTED.replace(
        "h1,5:1638401,2293761:655360,0,0",
        "k1,5:1638401,2293761:65536\nr1,999:1638401,2293761:0,692380,141880")
    assert [l for l, _ in boxes_of(write(tmp_path, synctex)) if 999 in l] == []


def test_the_current_point_record_is_not_a_witness(tmp_path):
    """`x` records carry the AMBIENT tag/line — for a paragraph's line boxes
    that is the line \\par fired on, which is usually blank. They credit
    nothing while a real node is there to."""
    synctex = NESTED.replace(
        "h1,5:1638401,2293761:655360,0,0",
        "x1,998:1638401,2293761\nk1,5:1638401,2293761:65536")
    assert [l for l, _ in boxes_of(write(tmp_path, synctex)) if 998 in l] == []


def test_a_leaf_with_no_node_witness_falls_back_to_its_own_line(tmp_path):
    """64 of llama.tex's 3594 content boxes are a lone linked word or a
    `$x$` with no kern or glue in them at all. On every one the box's own
    tag and line was the right answer; the ladder is there so the leaf
    degrades to it instead of vanishing."""
    synctex = NESTED.replace("h1,5:1638401,2293761:655360,0,0", "x1,5:1638401,2293761")
    assert [l for l, _ in boxes_of(write(tmp_path, synctex)) if l == [5]] != []


def test_parent_indexes_back_into_the_same_list(tmp_path):
    """Containment is what tells a hanging `\\item` label from a second
    column, so the chain has to resolve — and a parent always precedes its
    children."""
    out = write(tmp_path, NESTED)
    for i, b in enumerate(out["boxes"]):
        assert -1 <= b["parent"] < i


def test_boxes_keep_every_input_file_and_name_the_main_one(tmp_path):
    """Only main.tex's lines mean anything to the editor's source — but a
    `.bbl`'s boxes are still reported, keyed by ITS tag, so a client that
    grows multi-file support has them and one that has not can ignore them
    by tag rather than by guessing."""
    synctex = "\n".join([
        "SyncTeX Version:1",
        "Input:1:/tmp/dia-tex-x/main.tex",
        "Input:2:/tmp/dia-tex-x/refs.bbl",
        "Input:3:",
        "Unit:1",
        "Content:",
        "{1",
        "(1,10:4736286,5209886:30785863,655360,196608",
        "h1,10:4736286,5209886:30785863,655360,196608",
        ")",
        "(2,10:4736286,9000000:30785863,655360,196608",
        "h2,10:4736286,9000000:30785863,655360,196608",
        ")",
        "}1",
    ])
    path = tmp_path / "main.synctex"
    path.write_text(synctex, encoding="utf-8")
    out = parse_synctex(path)
    assert out["mainTag"] == 1
    assert out["inputs"] == [
        {"tag": 1, "path": "/tmp/dia-tex-x/main.tex", "name": "main.tex"},
        {"tag": 2, "path": "/tmp/dia-tex-x/refs.bbl", "name": "refs.bbl"},
        # tectonic leaves the name blank for files it wrote itself; reported
        # anyway, so a client can still say "these boxes are not mine"
        {"tag": 3, "path": "", "name": ""},
    ]
    assert [b["src"] for b in out["boxes"]] == [[[1, 10]], [[2, 10]]]
