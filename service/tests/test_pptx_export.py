"""The outbound pptx bridge: what reaches the slide, and what says it didn't.

Every case here is a regression for content that the exporter used to drop
with no error, no warning and no island marker -- the failure mode IMPORT.md
rules out ("Never: a plausible-looking reconstruction that silently drops what
it didn't understand"). Silent loss is the worst possible failure for this
module, because the deck still opens, still looks plausible, and the missing
paragraph is only discovered by the person presenting it.

These need no model, no network and no Drive: a dialect string goes in, a pptx
comes back, and the assertions read the shapes. python-pptx is a hard
dependency of the service, so there is nothing to skip.
"""

from __future__ import annotations

import io

import pytest
from pptx import Presentation
from pptx.util import Emu

from dia_service.pptx_export import DESIGN_H, DESIGN_W, deck_to_pptx

THEME = (
    '<style id="dia-theme">:root{'
    "--dia-paper:#FFFFFF;--dia-ink:#202124;--dia-ink-soft:#3C4043;"
    "--dia-ink-faint:#5F6368;--dia-accent:#4285F4;--dia-rule:#DADCE0;"
    "--dia-scale-1:15px;--dia-scale-2:16px;--dia-scale-5:34px;"
    "--dia-gap:24px;--dia-pad:53px;}</style>"
)


def deck(body: str) -> str:
    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        f"<title>t</title>{THEME}</head><body>"
        f'<section class="dia-slide">{body}</section>'
        "</body></html>"
    )


def render(body: str):
    """(presentation, warnings) for a one-slide dialect deck."""
    warnings: list[str] = []
    prs = Presentation(io.BytesIO(deck_to_pptx(deck(body), warnings)))
    return prs, warnings


def walk(shapes):
    for sh in shapes:
        yield sh
        if sh.shape_type == 6 and hasattr(sh, "shapes"):  # GROUP
            yield from walk(sh.shapes)


def all_text(prs) -> str:
    """Every string that reaches the canvas. Speaker notes are deliberately
    excluded: text parked in the notes is not text the audience can read."""
    out = []
    for slide in prs.slides:
        for sh in walk(slide.shapes):
            if sh.has_table:
                out += [c.text for r in sh.table.rows for c in r.cells]
            elif sh.has_text_frame:
                out.append(sh.text_frame.text)
    return " ".join(out)


TITLE = '<h2 class="dia-title">A title</h2>'


def test_island_content_reaches_the_slide():
    """dia-island had no code path at all, so an islanded region vanished.

    That is the worst case of the three, because translate-slide's rule 5
    actively instructs the model to island anything it cannot express -- so
    the more honest the translation, the more content was lost."""
    prs, warnings = render(
        TITLE + '<div class="dia-island"><p>ISLANDCANARY</p></div>'
    )
    assert "ISLANDCANARY" in all_text(prs)
    assert warnings, "recovering an island must not be silent"


def test_second_table_reaches_the_slide():
    """_figure_of() returns the FIRST table/img/svg; every later one was
    dropped -- not even flowed as text."""
    prs, warnings = render(
        TITLE
        + "<table><tr><td>first_a</td></tr></table>"
        + "<table><tr><td>second_b</td></tr></table>"
    )
    text = all_text(prs)
    assert "first_a" in text
    assert "second_b" in text
    assert warnings, "recovering a second table must not be silent"


def test_subtitle_is_rendered():
    """dia-subtitle is in the vocabulary translate-slide tells the model to
    emit, but _render_slide never looked for it, so it was always dropped."""
    prs, _ = render(TITLE + '<p class="dia-subtitle">SUBCANARY text</p>')
    assert "SUBCANARY" in all_text(prs)


def footnote_box(prs):
    for sh in walk(prs.slides[0].shapes):
        if sh.has_text_frame and "Provenance" in sh.text_frame.text:
            return sh
    pytest.fail("the footnote never reached the slide at all")


def test_footnote_box_grows_with_its_text():
    """The footnote used to be drawn in a FIXED 20px box pinned at
    DESIGN_H - pad + 4, whatever it contained. Real provenance notes run to
    ~1000 characters, so the tail rendered outside its own box and the
    renderer clipped it -- the study's caveats were the part that vanished.

    Note the shape of this assertion. Checking that the BOX sits inside the
    page does NOT catch the bug: a 20px box at y=672 is comfortably on the
    page, and the old code passed that check while losing most of the text.
    What distinguishes fixed-height from sized is whether the box responds to
    how much text it holds at all."""
    short = render(TITLE + '<p class="dia-footnote">Provenance, briefly.</p>')[0]
    long_ = render(
        TITLE
        + '<p class="dia-footnote">Provenance '
        + ("sentence that keeps going and carries the caveats. " * 18)
        + "</p>"
    )[0]
    h_short = int(footnote_box(short).height)
    h_long = int(footnote_box(long_).height)
    assert h_long > h_short * 3, (
        "the footnote box does not grow with its text, so a long note "
        f"overflows it: short={Emu(h_short).pt:.0f}pt long={Emu(h_long).pt:.0f}pt"
    )


def test_footnote_stays_inside_the_page():
    """Sizing the box must not push it off the bottom instead."""
    prs, _ = render(
        TITLE
        + '<p class="dia-footnote">Provenance '
        + ("sentence that keeps going and carries the caveats. " * 18)
        + "</p>"
    )
    sh = footnote_box(prs)
    page_h = int(Emu(DESIGN_H * 9525))
    assert int(sh.top) >= 0
    assert int(sh.top) + int(sh.height) <= page_h, (
        f"footnote runs past the bottom edge: "
        f"bottom={Emu(int(sh.top) + int(sh.height)).pt:.0f}pt "
        f"page={Emu(page_h).pt:.0f}pt"
    )


def test_everything_lands_inside_the_frame():
    """A dense slide -- subtitle, table, island and a long footnote together --
    must not put any shape outside the page."""
    prs, _ = render(
        TITLE
        + '<p class="dia-subtitle">Subtitle line</p>'
        + '<div class="dia-body"><p>Body copy.</p></div>'
        + "<table><tr><th>H</th></tr><tr><td>cell</td></tr></table>"
        + '<div class="dia-island"><p>island text</p></div>'
        + '<p class="dia-footnote">' + ("Caveat words. " * 30) + "</p>"
    )
    pw, ph = Emu(DESIGN_W * 9525), Emu(DESIGN_H * 9525)
    for sh in walk(prs.slides[0].shapes):
        if not (sh.width and sh.height):
            continue
        assert int(sh.left) >= 0 and int(sh.top) >= 0
        assert int(sh.left) + int(sh.width) <= int(pw)
        assert int(sh.top) + int(sh.height) <= int(ph)


def test_a_clean_slide_warns_about_nothing():
    """The warning sink must stay quiet on a slide the exporter placed fully,
    or callers will learn to ignore it."""
    _, warnings = render(TITLE + '<div class="dia-body"><p>Just prose.</p></div>')
    assert warnings == []


def test_warnings_are_optional():
    """The sink is opt-in; existing callers that pass nothing keep working."""
    assert deck_to_pptx(deck(TITLE)), "no-warnings call must still return bytes"
