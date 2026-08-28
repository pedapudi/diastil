"""validate_html survives pathologically nested DOM trees.

Both cases below are RecursionError regressions, and they are distinct: one
is about DEPTH (the tree walk), the other about identically-shaped SIBLINGS
(node equality). A generated full-colour hero <svg> hits the first, and a
slide repeating that figure hits the second, so neither test subsumes the
other. Pure parsing, no engine and no service — this runs anywhere.
"""

from __future__ import annotations

from dia_service import validate

_OK_DECK = """<!doctype html>
<html><head><title>t</title></head><body>
<section class="dia-slide"><h1>Title</h1></section>
</body></html>"""


def test_deeply_nested_svg_does_not_recursionerror() -> None:
    # walk() used to be a recursive generator (`yield from c.walk()`), so a
    # tree deeper than Python's ~1000-frame limit crashed validate_html. An
    # unclosed tag is enough to produce one: _TreeBuilder.handle_endtag can
    # only pop to a matching tag, so every later element nests one deeper.
    depth = 3000
    hero = '<svg class="dia-art">' + "<g>" * depth + "</g>" * depth + "</svg>"
    deck = _OK_DECK.replace("<h1>Title</h1>", "<h1>Title</h1>" + hero)
    report = validate.validate_html(deck)  # must not raise RecursionError
    assert report["slideCount"] == 1


def test_repeated_sibling_subtrees_do_not_recursionerror() -> None:
    # El was a dataclass with the default eq=True, whose __eq__ compares
    # nodes structurally, recursing through `children`. path() calls
    # parent.children.index(cur), and index() compares cur against every
    # preceding sibling — so identical deep siblings recursed past the limit
    # even though no single one of them is too deep to walk.
    deep = "<g>" * 1500 + "</g>" * 1500
    charts = ('<svg class="dia-chart">' + deep + "</svg>") * 3
    deck = _OK_DECK.replace("<h1>Title</h1>", "<h1>Title</h1>" + charts)
    report = validate.validate_html(deck)  # must not raise RecursionError
    assert report["slideCount"] == 1
