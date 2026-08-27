"""Export a diastil dialect deck (§profile) to a .pptx — the OUTBOUND bridge.

`ingest/pptx.ts` brings PowerPoint *into* the dialect; this module takes a
saved dialect deck the other way: dialect HTML -> a native `.pptx`. Uploaded
with the Google Slides mime type it becomes a real, editable Google Slides
deck (`gdrive upload --mime-type application/vnd.google-apps.presentation`),
so a diastil deck reaches anyone who lives in Slides.

Why a .pptx and not "print to Slides": a .pptx converts to NATIVE Slides
objects — every text box, shape, and connector stays editable in Slides,
re-themeable, shareable. Charts and scene diagrams are drawn as vector shapes
(rectangles, ovals, connectors, freeforms) rather than a rasterized chart
object, because Slides rasterizes imported chart *objects* (they blur) while
plain shapes stay crisp and editable.

Fidelity model, mirroring ingest's: the dialect already carries a derived,
geometry-true rendering (scene nodes carry `data-x/y/w/h`; edges carry their
routed `<path d>`; charts carry a derived group) — so scenes and charts map
FAITHFULLY by their own coordinates (viewBox units scale linearly into the
figure box). Text/flow layout is mapped SEMANTICALLY from the dialect's layout
containers (cover / columns / stack) and text roles to slide geometry: this
yields clean, on-brand, editable Slides rather than a pixel tracing.

The dialect design space is 1280x720 px (16:9); a px maps to EMU at
9525 EMU/px (914400/96), so the deck fills a 12192000x6858000 EMU slide.

What a slide is allowed to lose: nothing, silently. The dialect profile
permits unknown classes by design, so the exporter cannot be an allowlist of
roles it recognizes — it partitions a slide into parts with prose as the
fallback (`_partition`, coverage) and deals those parts down a column as
disjoint bands (`_stack`, tiling). Content that survives the trip in a poorer
form than the dialect held it — an islanded region reduced to its text, a
slide compressed to fit — goes to the optional `warnings` sink rather than
passing quietly.

Stdlib-only HTML parsing (html.parser); python-pptx is the only third-party
dep. Entry points: `deck_to_pptx(html, warnings=None) -> bytes`,
`export_file(src, dst, warnings=None)`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from html.parser import HTMLParser
import io
import math
import re

import pptx
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Emu, Pt

# ---------------------------------------------------------------------------
# geometry: the dialect design space -> EMU
# ---------------------------------------------------------------------------

EMU_PER_PX = 9525  # 914400 EMU/inch / 96 px/inch — matches ingest/pptx.ts
DESIGN_W = 1280
DESIGN_H = 720
SLIDE_W = Emu(DESIGN_W * EMU_PER_PX)  # 12192000
SLIDE_H = Emu(DESIGN_H * EMU_PER_PX)  # 6858000


def _emu(px: float) -> int:
    return int(round(px * EMU_PER_PX))


# px -> pt for fonts (72pt/in over 96px/in).
def _pt(px: float) -> float:
    return px * 0.75


def _font_pt(size: float) -> "Pt":
    """python-pptx rejects font sizes outside 1pt..4000pt (an imported foreign

    deck can carry theme tokens that resolve to a sub-1pt size). Clamp so a weird
    input never 500s the export.
    """
    try:
        s = float(size)
    except (TypeError, ValueError):
        s = 12.0
    return Pt(max(1.0, min(4000.0, s)))


# ---------------------------------------------------------------------------
# a tiny DOM (stdlib) — enough to walk the dialect
# ---------------------------------------------------------------------------

VOID = {
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
}


@dataclass
class El:
    tag: str
    attrs: dict[str, str]
    parent: "El | None" = None
    children: list["El"] = field(default_factory=list)
    text: str = ""  # set on "#text" pseudo-children only (document order)

    def classes(self) -> set[str]:
        return set((self.attrs.get("class") or "").split())

    def has(self, cls: str) -> bool:
        return cls in self.classes()

    def find(self, pred) -> "El | None":
        for el in self.walk():
            if el is not self and pred(el):
                return el
        return None

    def find_all(self, pred) -> list["El"]:
        return [el for el in self.walk() if el is not self and pred(el)]

    def walk(self):
        yield self
        for c in self.children:
            yield from c.walk()

    def all_text(self) -> str:
        # verbatim concatenation: #text nodes carry the original whitespace,
        # so punctuation stays attached ("measures everything.") and blocks
        # keep their separating newlines; normalize once at the end
        parts = []
        for el in self.walk():
            if el.text:
                parts.append(el.text)
        return re.sub(r"\s+", " ", "".join(parts)).strip()


class _Tree(HTMLParser):

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = El("#root", {})
        self._stack = [self.root]

    def handle_starttag(self, tag, attrs):
        el = El(tag, {k: v or "" for k, v in attrs}, parent=self._stack[-1])
        self._stack[-1].children.append(el)
        if tag not in VOID:
            self._stack.append(el)

    def handle_startendtag(self, tag, attrs):
        el = El(tag, {k: v or "" for k, v in attrs}, parent=self._stack[-1])
        self._stack[-1].children.append(el)

    def handle_endtag(self, tag):
        for i in range(len(self._stack) - 1, 0, -1):
            if self._stack[i].tag == tag:
                del self._stack[i:]
                break

    def handle_data(self, data):
        # Text lands in "#text" pseudo-children, not on the element itself:
        # mixed content ("then <em>measures</em>.") must keep document order,
        # and a single per-element text field would reorder it. ALL data is
        # kept — including whitespace-only runs between blocks — so reads can
        # concatenate verbatim and normalize whitespace at the end.
        parent = self._stack[-1]
        parent.children.append(El("#text", {}, parent=parent, text=data))


def _parse(html: str) -> El:
    t = _Tree()
    t.feed(html)
    return t.root


# ---------------------------------------------------------------------------
# theme
# ---------------------------------------------------------------------------

_DEFAULTS = {
    "paper": "#ffffff",
    "ink": "#1a1a1a",
    "ink-soft": "#33312b",
    "ink-faint": "#85837a",
    "accent": "#1e6fcc",
    "rule": "#c6c3b6",
}
_SCALE_DEFAULT = {1: 12.0, 2: 15.0, 3: 18.0, 4: 22.0, 5: 30.0, 6: 38.0, 7: 48.0}


@dataclass
class Theme:
    colors: dict[str, str]
    scale: dict[int, float]
    face_display: str = "Arial"
    face_body: str = "Arial"
    face_label: str = "Consolas"
    pad: float = 52.0
    gap: float = 24.0

    def rgb(self, key: str, fallback: str = "ink") -> RGBColor:
        return _hex(
            self.colors.get(key) or self.colors.get(fallback) or "#1a1a1a"
        )


def _hex(s: str) -> RGBColor:
    s = (s or "").strip().lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    if len(s) != 6 or not re.fullmatch(r"[0-9a-fA-F]{6}", s):
        return RGBColor.from_string("1a1a1a")
    return RGBColor.from_string(s.lower())


_FIRST_FONT = re.compile(r'"([^"]+)"|\'([^\']+)\'|([^,]+)')


def _first_font(css: str) -> str:
    m = _FIRST_FONT.search(css or "")
    if not m:
        return "Arial"
    return (m.group(1) or m.group(2) or m.group(3) or "Arial").strip()


def _read_theme(root: El) -> Theme:
    style = root.find(
        lambda e: e.tag == "style" and e.attrs.get("id") == "dia-theme"
    )
    css = style.all_text() if style else ""
    # Custom properties live in :root { --dia-*: v; }
    props: dict[str, str] = {}
    for m in re.finditer(r"--dia-([a-z0-9-]+)\s*:\s*([^;}\n]+)", css, re.I):
        props[m.group(1).strip().lower()] = m.group(2).strip()

    colors = dict(_DEFAULTS)
    for k in list(colors):
        if k in props:
            colors[k] = props[k]
    scale = dict(_SCALE_DEFAULT)
    for i in range(1, 8):
        v = props.get(f"scale-{i}")
        if v:
            mm = re.search(r"(-?\d+(?:\.\d+)?)", v)
            if mm:
                scale[i] = float(mm.group(1))

    def _px(name: str, default: float) -> float:
        v = props.get(name)
        if v:
            mm = re.search(r"(-?\d+(?:\.\d+)?)", v)
            if mm:
                return float(mm.group(1))
        return default

    return Theme(
        colors=colors,
        scale=scale,
        face_display=_first_font(props.get("face-display", "")),
        face_body=_first_font(props.get("face-body", "")),
        face_label=_first_font(props.get("face-label", "")),
        pad=_px("pad", 52.0),
        gap=_px("gap", 24.0),
    )


def _resolve_color(theme: Theme, value: str | None, fallback: str) -> RGBColor:
    """A per-node/edge style value: `var(--dia-rule)` or a hex literal."""
    if not value:
        return theme.rgb(fallback)
    m = re.search(r"var\(\s*--dia-([a-z0-9-]+)", value, re.I)
    if m:
        return theme.rgb(m.group(1).lower(), fallback)
    lit = re.search(r"#[0-9a-f]{3,6}", value, re.I)
    if lit:
        return _hex(lit.group(0))
    return theme.rgb(fallback)


def _style_prop(el: El, name: str) -> str | None:
    st = el.attrs.get("style") or ""
    m = re.search(re.escape(name) + r"\s*:\s*([^;]+)", st, re.I)
    return m.group(1).strip() if m else None


# ---------------------------------------------------------------------------
# low-level drawing helpers
# ---------------------------------------------------------------------------


def _fill(
    shape,
    color: RGBColor | None,
    line: RGBColor | None = None,
    line_w: float = 0.0,
) -> None:
    if color is None:
        shape.fill.background()
    else:
        shape.fill.solid()
        shape.fill.fore_color.rgb = color
    if line is None:
        shape.line.fill.background()
    else:
        shape.line.color.rgb = line
        shape.line.width = Pt(line_w or 1.0)
    shape.shadow.inherit = False


def _bg(slide, theme: Theme, slide_el: El | None = None) -> None:
    # per-slide background override lives as an inline style on the section
    # (the tokens tab writes `style="background: var(--dia-…)|#hex"`)
    color = theme.rgb("paper")
    if slide_el is not None:
        v = _style_prop(slide_el, "background")
        if v:
            color = _resolve_color(theme, v, "paper")
    r = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, SLIDE_W, SLIDE_H)
    _fill(r, color)
    sp = r._element
    sp.getparent().remove(sp)
    slide.shapes._spTree.insert(2, sp)


def _textbox(
    slide,
    x,
    y,
    w,
    h,
    runs,
    *,
    align=PP_ALIGN.LEFT,
    anchor=MSO_ANCHOR.TOP,
    leading: float = 1.2,
    space_after=6.0,
):
    """runs: list[paragraph]; paragraph: list[(text, pt, color, bold, font)]."""
    tb = slide.shapes.add_textbox(_emu(x), _emu(y), _emu(w), _emu(h))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    # zero the default internal margins (~10px/5px) so text lands where the
    # dialect's own padding model put it
    tf.margin_left = tf.margin_right = Emu(0)
    tf.margin_top = tf.margin_bottom = Emu(0)
    for i, para in enumerate(runs):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        p.space_after = Pt(space_after)
        p.line_spacing = leading
        for txt, size, color, bold, font in para:
            r = p.add_run()
            r.text = txt
            r.font.size = _font_pt(size)
            r.font.color.rgb = color
            r.font.bold = bold
            r.font.name = font
    return tb


# ---------------------------------------------------------------------------
# scene (diagram) rendering — faithful, from the derived geometry
# ---------------------------------------------------------------------------

_SHAPE_MAP = {
    "rect": MSO_SHAPE.RECTANGLE,
    "rounded": MSO_SHAPE.ROUNDED_RECTANGLE,
    "pill": MSO_SHAPE.ROUNDED_RECTANGLE,
    "ellipse": MSO_SHAPE.OVAL,
    "diamond": MSO_SHAPE.DIAMOND,
    "cylinder": MSO_SHAPE.CAN,
    "hex": MSO_SHAPE.HEXAGON,
    "parallelogram": MSO_SHAPE.PARALLELOGRAM,
    "triangle": MSO_SHAPE.ISOSCELES_TRIANGLE,
    "cloud": MSO_SHAPE.CLOUD,
    "note": MSO_SHAPE.FOLDED_CORNER,
}


def _viewbox(svg: El) -> tuple[float, float, float, float]:
    vb = svg.attrs.get("viewbox") or svg.attrs.get("viewBox") or "0 0 340 250"
    nums = [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?", vb)][:4]
    while len(nums) < 4:
        nums.append([0, 0, 340, 250][len(nums)])
    return nums[0], nums[1], nums[2], nums[3]


def _fit(vw: float, vh: float, box: tuple[float, float, float, float]):
    """Return a mapper (vx,vy)->(px,py) fitting viewBox into a px box, centered.

    Guards against a degenerate box (a caller whose text overflowed can hand us a
    non-positive width/height); a negative scale would flip geometry off-slide, so
    clamp to a zero-scale no-op mapper collapsed at the box origin instead.
    """
    bx, by, bw, bh = box
    if vw <= 0 or vh <= 0 or bw <= 0 or bh <= 0:
        return (lambda x, y: (bx, by)), 0.0
    scale = min(bw / vw, bh / vh)
    rw, rh = vw * scale, vh * scale
    ox, oy = bx + (bw - rw) / 2, by + (bh - rh) / 2

    def m(x: float, y: float) -> tuple[float, float]:
        return ox + x * scale, oy + y * scale

    return m, scale


# One SVG number (leading-dot `.5`, trailing-dot `10.`, exponent `1e2` all legal)
# OR a path command letter. `\d*\.\d+` precedes `\d+\.?` so `10.5` matches whole.
_PATH_TOKEN = re.compile(
    r"[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?"
)


def _path_points(d: str) -> list[tuple[float, float]]:
    """Approximate a path's `d` as a polyline (M/L/H/V + bezier endpoints).

    Good enough for connectors: dialect edge paths are straight, orthogonal
    (H/V), or a single quadratic/cubic we sample at its endpoints + midpoint.
    """
    toks = _PATH_TOKEN.findall(d or "")
    pts: list[tuple[float, float]] = []
    i, cx, cy, cmd = 0, 0.0, 0.0, ""

    def num() -> float:
        nonlocal i
        if i >= len(toks):  # truncated path (too few coords) — don't IndexError
            return 0.0
        v = float(toks[i])
        i += 1
        return v

    while i < len(toks):
        t = toks[i]
        if t.isalpha():
            cmd = t
            i += 1
            if cmd in "Zz":
                continue
        rel = cmd.islower()
        c = cmd.upper()
        if c == "M" or c == "L":
            x, y = num(), num()
            cx, cy = (cx + x, cy + y) if rel else (x, y)
            pts.append((cx, cy))
        elif c == "H":
            x = num()
            cx = cx + x if rel else x
            pts.append((cx, cy))
        elif c == "V":
            y = num()
            cy = cy + y if rel else y
            pts.append((cx, cy))
        elif c == "Q":
            x1, y1, x, y = num(), num(), num(), num()
            ex, ey = (cx + x, cy + y) if rel else (x, y)
            mx, my = (cx + x1, cy + y1) if rel else (x1, y1)
            pts.append((mx, my))
            pts.append((ex, ey))
            cx, cy = ex, ey
        elif c == "C":
            x1, y1, x2, y2, x, y = (num() for _ in range(6))
            ex, ey = (cx + x, cy + y) if rel else (x, y)
            m2x, m2y = (cx + x2, cy + y2) if rel else (x2, y2)
            pts.append((m2x, m2y))
            pts.append((ex, ey))
            cx, cy = ex, ey
        else:  # unsupported command token stream — bail with what we have
            i += 1
    return pts


def _draw_node(slide, theme: Theme, node: El, m, scale: float) -> None:
    def fnum(k: str, d: float) -> float:
        try:
            return float(node.attrs.get(k, d))
        except (TypeError, ValueError):
            return d

    x, y = fnum("data-x", 0), fnum("data-y", 0)
    w, h = fnum("data-w", 120), fnum("data-h", 40)
    shape_name = (node.attrs.get("data-shape") or "rounded").lower()
    emphasis = "data-dia-emphasis" in node.attrs

    px, py = m(x, y)
    pw, ph = w * scale, h * scale
    fill = _resolve_color(theme, _style_prop(node, "--dia-node-fill"), "paper")
    stroke = _resolve_color(
        theme,
        _style_prop(node, "--dia-node-stroke"),
        "accent" if emphasis else "ink",
    )
    try:
        sw = float(
            _style_prop(node, "--dia-node-stroke-w")
            or (2.0 if emphasis else 1.3)
        )
    except (TypeError, ValueError):
        sw = 2.0 if emphasis else 1.3

    sp = None
    data_path = node.attrs.get("data-path")
    if shape_name == "path" and data_path:
        # Freeform node: data-path is a 0..100-normalized outline scaled into the
        # node box. Compose normalized -> viewBox -> slide so it lands where the
        # editor draws it (a star, ring, blob stays that shape, not a rectangle).
        def mp(nx: float, ny: float) -> tuple[float, float]:
            return m(x + nx / 100.0 * w, y + ny / 100.0 * h)

        _freeform(
            slide,
            theme,
            _path_points(data_path),
            mp,
            fill,
            stroke,
            sw,
            scale,
            close=True,
        )
    else:
        mso = _SHAPE_MAP.get(shape_name, MSO_SHAPE.ROUNDED_RECTANGLE)
        sp = slide.shapes.add_shape(mso, _emu(px), _emu(py), _emu(pw), _emu(ph))
        _fill(sp, fill, stroke, _line_pt(sw, scale))

    label = node.attrs.get("data-label")
    if not label:
        lab = node.find(lambda e: e.has("dia-node-label"))
        label = lab.all_text() if lab else ""
    if label:
        ink = _resolve_color(theme, _style_prop(node, "--dia-node-ink"), "ink")
        if sp is not None:
            tf = sp.text_frame
            tf.word_wrap = True
            tf.vertical_anchor = MSO_ANCHOR.MIDDLE
            p = tf.paragraphs[0]
            p.alignment = PP_ALIGN.CENTER
            r = p.add_run()
            r.text = label
            r.font.size = _font_pt(_pt(12 * scale + 4))
            r.font.color.rgb = ink
            r.font.name = theme.face_body
        else:  # freeform node — center a label textbox over the node box
            _textbox(
                slide,
                px,
                py,
                pw,
                ph,
                [[(label, _pt(12 * scale + 4), ink, False, theme.face_body)]],
                align=PP_ALIGN.CENTER,
                anchor=MSO_ANCHOR.MIDDLE,
            )


def _draw_edge(slide, theme: Theme, edge: El, m, scale: float) -> None:
    path = edge.find(lambda e: e.tag == "path" and e.has("dia-edge-path"))
    stroke = _resolve_color(
        theme, _style_prop(edge, "--dia-edge-stroke"), "ink"
    )
    try:
        ew = float(_style_prop(edge, "--dia-edge-w") or 1.2)
    except (TypeError, ValueError):
        ew = 1.2

    pts = _path_points(path.attrs.get("d", "")) if path else []
    if len(pts) >= 2:
        mapped = [m(x, y) for x, y in pts]
        # Freeform polyline through the routed points (keeps ortho bends/curves).
        fb = slide.shapes.build_freeform(
            _emu(mapped[0][0]), _emu(mapped[0][1]), scale=1.0
        )
        fb.add_line_segments(
            [(_emu(x), _emu(y)) for x, y in mapped[1:]], close=False
        )
        shp = fb.convert_to_shape()
        shp.fill.background()
        shp.line.color.rgb = stroke
        shp.line.width = Pt(ew)
        shp.shadow.inherit = False
        _arrow_end(shp)

    # Label: prefer the derived <text class="dia-edge-label" x y> — it carries the
    # router's own placement, so shared-corridor labels don't collide. Fall back
    # to data-label at the path midpoint only when there is no derived text.
    lab = edge.find(lambda e: e.has("dia-edge-label"))
    label = (
        (lab.all_text() if lab else "") or edge.attrs.get("data-label") or ""
    )
    if label:
        lx: float | None = None
        ly: float | None = None
        xs = lab.attrs.get("x") if lab is not None else None
        ys = lab.attrs.get("y") if lab is not None else None
        if xs is not None and ys is not None:
            try:
                lx, ly = m(float(xs), float(ys))
            except ValueError:
                lx = ly = None
        if lx is None and pts:
            mid = pts[len(pts) // 2]
            lx, ly = m(mid[0], mid[1])
        if lx is not None and ly is not None:
            _textbox(
                slide,
                lx - 60,
                ly - 16,
                120,
                20,
                [
                    [
                        (
                            label,
                            _pt(11 * scale + 3),
                            theme.rgb("ink-soft"),
                            False,
                            theme.face_label,
                        )
                    ]
                ],
                align=PP_ALIGN.CENTER,
            )


def _arrow_end(shape) -> None:
    """Set a triangular arrowhead on the line end via the drawingml XML."""
    from pptx.oxml.ns import qn

    ln = shape.line._get_or_add_ln()
    tail = ln.find(qn("a:tailEnd"))
    if tail is None:
        tail = ln.makeelement(qn("a:tailEnd"), {})
        ln.append(tail)
    tail.set("type", "triangle")
    tail.set("w", "med")
    tail.set("len", "med")


# ---------------------------------------------------------------------------
# generic inline-SVG primitives — decorative art, brand marks, freeform strokes
# ---------------------------------------------------------------------------

_DRAW_TAGS = {
    "path",
    "circle",
    "ellipse",
    "rect",
    "line",
    "polyline",
    "polygon",
    "text",
}


def _svg_paint(theme: Theme, el: El, attr: str, default: str | None):
    """Resolve an svg fill/stroke: token var(), hex, currentColor, or none."""
    v = _style_prop(el, attr) or el.attrs.get(attr)
    if v is None:
        return theme.rgb(default) if default else None
    v = v.strip().lower()
    if v in ("none", "transparent"):
        return None
    tok = re.search(r"--dia-([a-z0-9-]+)", v)
    if tok:
        return theme.rgb(tok.group(1))
    lit = re.search(r"#[0-9a-f]{3,8}", v)
    if lit:
        return _hex(lit.group(0)[:7])
    if v == "currentcolor":
        return theme.rgb("ink")
    return theme.rgb(default) if default else None


def _svg_f(el: El, name: str, d: float = 0.0) -> float:
    try:
        return float(el.attrs.get(name))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return d


def _svg_stroke_w(el: El, d: float = 1.0) -> float:
    v = _style_prop(el, "stroke-width") or el.attrs.get("stroke-width")
    try:
        return float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return d


def _svg_font_px(el: El, d: float) -> float:
    st = el.attrs.get("style", "") or ""
    mm = re.search(r"font(?:-size)?:\s*(\d+(?:\.\d+)?)px", st)
    return float(mm.group(1)) if mm else d


def _line_pt(sw: float, scale: float) -> float:
    return max(0.5, _pt(sw * scale))


def _freeform(slide, theme, coords, m, fill, stroke, sw, scale, close) -> None:
    if len(coords) < 2:
        return
    mp = [m(x, y) for x, y in coords]
    fb = slide.shapes.build_freeform(_emu(mp[0][0]), _emu(mp[0][1]), scale=1.0)
    fb.add_line_segments([(_emu(x), _emu(y)) for x, y in mp[1:]], close=close)
    shp = fb.convert_to_shape()
    if fill is not None and close:
        shp.fill.solid()
        shp.fill.fore_color.rgb = fill
    else:
        shp.fill.background()
    if stroke is not None:
        shp.line.color.rgb = stroke
        shp.line.width = Pt(_line_pt(sw, scale))
    elif fill is None:
        shp.line.color.rgb = theme.rgb("ink")
        shp.line.width = Pt(_line_pt(sw, scale))
    else:
        shp.line.fill.background()
    shp.shadow.inherit = False


def _draw_prim(slide, theme: Theme, el: El, m, scale: float) -> None:
    """Render one svg drawable primitive as a native shape/connector/textbox."""
    tag = el.tag
    fill = _svg_paint(theme, el, "fill", None)
    stroke = _svg_paint(theme, el, "stroke", None)
    sw = _svg_stroke_w(el, 1.2)
    if tag in ("circle", "ellipse"):
        cx, cy = _svg_f(el, "cx"), _svg_f(el, "cy")
        rx = _svg_f(el, "r") or _svg_f(el, "rx")
        ry = _svg_f(el, "r") or _svg_f(el, "ry")
        if fill is None and stroke is None:
            fill = theme.rgb("ink")
        x, y = m(cx - rx, cy - ry)
        sp = slide.shapes.add_shape(
            MSO_SHAPE.OVAL,
            _emu(x),
            _emu(y),
            _emu(2 * rx * scale),
            _emu(2 * ry * scale),
        )
        _fill(sp, fill, stroke, _line_pt(sw, scale))
    elif tag == "rect":
        x0, y0 = _svg_f(el, "x"), _svg_f(el, "y")
        if fill is None and stroke is None:
            fill = theme.rgb("ink")
        x, y = m(x0, y0)
        sp = slide.shapes.add_shape(
            MSO_SHAPE.RECTANGLE,
            _emu(x),
            _emu(y),
            _emu(_svg_f(el, "width") * scale),
            _emu(_svg_f(el, "height") * scale),
        )
        _fill(sp, fill, stroke, _line_pt(sw, scale))
    elif tag == "line":
        p1 = m(_svg_f(el, "x1"), _svg_f(el, "y1"))
        p2 = m(_svg_f(el, "x2"), _svg_f(el, "y2"))
        cn = slide.shapes.add_connector(
            MSO_CONNECTOR.STRAIGHT,
            _emu(p1[0]),
            _emu(p1[1]),
            _emu(p2[0]),
            _emu(p2[1]),
        )
        cn.line.color.rgb = stroke or theme.rgb("ink")
        cn.line.width = Pt(_line_pt(sw, scale))
        cn.shadow.inherit = False
    elif tag in ("polyline", "polygon"):
        nums = [
            float(n)
            for n in re.findall(
                r"-?\d+(?:\.\d+)?", el.attrs.get("points", "") or ""
            )
        ]
        coords = [(nums[i], nums[i + 1]) for i in range(0, len(nums) - 1, 2)]
        _freeform(
            slide,
            theme,
            coords,
            m,
            fill,
            stroke,
            sw,
            scale,
            close=(tag == "polygon"),
        )
    elif tag == "path":
        d = el.attrs.get("d", "") or ""
        coords = _path_points(d)
        _freeform(
            slide,
            theme,
            coords,
            m,
            fill,
            stroke,
            sw,
            scale,
            close=("z" in d.lower()) or fill is not None,
        )
    elif tag == "text":
        txt = el.all_text()
        if not txt:
            return
        fs = _svg_font_px(el, 12.0)
        size = fs * scale
        x, y = m(_svg_f(el, "x"), _svg_f(el, "y"))
        # Box the label to its own text and honour `text-anchor`. A fixed
        # 420px box hung off the glyph origin drew every `middle`- or
        # `end`-anchored label a box-width to the right of where the svg put
        # it — 46 such labels across the two example decks — and ran off the
        # page for anything in the right half of a scene.
        anchor = (
            el.attrs.get("text-anchor")
            or _style_prop(el, "text-anchor")
            or "start"
        ).strip()
        bw = max(size, len(txt) * size * ADVANCE_EM) + 8
        bh = size * 1.6 + 8
        if anchor == "middle":
            bx, align = x - bw / 2, PP_ALIGN.CENTER
        elif anchor == "end":
            bx, align = x - bw + 4, PP_ALIGN.RIGHT
        else:
            bx, align = x - 4, PP_ALIGN.LEFT
        bx = max(0.0, min(bx, DESIGN_W - bw))
        by = max(0.0, min(y - size, DESIGN_H - bh))
        _textbox(
            slide,
            bx,
            by,
            bw,
            bh,
            [
                [
                    (
                        txt,
                        _pt(size),
                        fill or theme.rgb("ink-soft"),
                        False,
                        theme.face_body,
                    )
                ]
            ],
            align=align,
        )


def _ancestor_matches(el: El, pred) -> bool:
    p = el.parent
    while p is not None:
        if pred(p):
            return True
        p = p.parent
    return False


def _draw_prims(
    slide, theme: Theme, container: El, m, scale: float, skip=None
) -> None:
    for el in container.walk():
        if el is container or el.tag not in _DRAW_TAGS:
            continue
        if skip and skip(el):
            continue
        try:
            _draw_prim(slide, theme, el, m, scale)
        except (ValueError, TypeError, IndexError, ZeroDivisionError, KeyError):
            pass  # one malformed primitive must never break the deck


def _svg_declared_size(svg: El) -> tuple[float, float]:
    """On-slide px size of a decorative svg: its style width/height, else a

    viewBox-derived default.
    """
    st = svg.attrs.get("style", "") or ""

    def px(name: str) -> float:
        mm = re.search(name + r":\s*(\d+(?:\.\d+)?)px", st)
        return float(mm.group(1)) if mm else 0.0

    _, _, vw, vh = _viewbox(svg)
    w, h = px("width"), px("height")
    ratio = (vh / vw) if vw else 0.2
    if w and not h:
        h = w * ratio
    elif h and not w:
        w = h / ratio if ratio else h * 5
    elif not w and not h:
        w, h = 120.0, 120.0 * ratio
    return w, h


def _draw_decorative(slide, theme: Theme, svg: El, x: float, y: float) -> float:
    """Render a standalone decorative svg (brand mark, rule art) at (x,y) at its

    declared size; return its height so the caller can advance the cursor.
    """
    w, h = _svg_declared_size(svg)
    _, _, vw, vh = _viewbox(svg)
    m, scale = _fit(vw, vh, (x, y, w, h))
    _draw_prims(
        slide,
        theme,
        svg,
        m,
        scale,
        skip=lambda e: _ancestor_matches(
            e, lambda p: p.tag in ("defs", "marker")
        ),
    )
    return h


def _draw_scene(slide, theme: Theme, svg: El, box) -> None:
    _, _, vw, vh = _viewbox(svg)
    m, scale = _fit(vw, vh, box)
    # edges first (under nodes), then nodes. Each is isolated: one malformed
    # derived path/geometry skips that shape, never aborts the whole deck.
    for edge in svg.find_all(lambda e: "data-dia-edge" in e.attrs):
        try:
            _draw_edge(slide, theme, edge, m, scale)
        except (ValueError, TypeError, IndexError, ZeroDivisionError, KeyError):
            pass
    for node in svg.find_all(lambda e: "data-dia-node" in e.attrs):
        try:
            _draw_node(slide, theme, node, m, scale)
        except (ValueError, TypeError, IndexError, ZeroDivisionError, KeyError):
            pass
    # loose decorative primitives (freeform strokes, standalone labels) that live
    # directly in the scene — not inside a node/edge group or <defs>/<marker>.
    _draw_prims(
        slide,
        theme,
        svg,
        m,
        scale,
        skip=lambda e: _ancestor_matches(
            e,
            lambda p: "data-dia-node" in p.attrs
            or "data-dia-edge" in p.attrs
            or p.tag in ("defs", "marker"),
        ),
    )


# ---------------------------------------------------------------------------
# chart rendering — vector, from data attributes
# ---------------------------------------------------------------------------


def _parse_values(raw: str) -> list[tuple[str, float]]:
    out: list[tuple[str, float]] = []
    for part in re.split(r"[,;]", raw or ""):
        if ":" not in part:
            continue
        # rpartition: the LAST colon splits label from value, so labels may
        # themselves contain colons ("10:30" : 5) — matches chart.ts backtracking
        label, _, num = part.rpartition(":")
        try:
            out.append((label.strip(), float(num.strip())))
        except ValueError:
            pass
    return out


def _draw_chart(slide, theme: Theme, svg: El, box) -> None:
    kind = (svg.attrs.get("data-chart") or "bar").lower()
    data = _parse_values(svg.attrs.get("data-values") or "")
    if not data:
        return
    bx, by, bw, bh = box
    unit = svg.attrs.get("data-unit") or ""
    try:
        vmax = float(svg.attrs.get("data-max") or 0) or max(v for _, v in data)
    except (TypeError, ValueError):
        vmax = max(v for _, v in data) or 1.0
    vmax = vmax or 1.0

    plot_t = by + 10
    plot_h = bh - 48
    base_y = plot_t + plot_h
    accent = theme.rgb("accent")

    base = slide.shapes.add_shape(
        MSO_SHAPE.RECTANGLE, _emu(bx), _emu(base_y), _emu(bw), _emu(1.2)
    )
    _fill(base, theme.rgb("rule"))

    n = len(data)
    if kind in ("bar", "column"):
        slot = bw / n
        bar_w = slot * 0.6
        for i, (label, v) in enumerate(data):
            bh_px = (v / vmax) * plot_h if v > 0 else 0
            cx = bx + i * slot + (slot - bar_w) / 2
            if bh_px > 0:
                rect = slide.shapes.add_shape(
                    MSO_SHAPE.RECTANGLE,
                    _emu(cx),
                    _emu(base_y - bh_px),
                    _emu(bar_w),
                    _emu(bh_px),
                )
                _fill(rect, accent)
            _textbox(
                slide,
                cx - 20,
                base_y - bh_px - 22,
                bar_w + 40,
                18,
                [
                    [
                        (
                            _fmt(v) + unit,
                            _pt(13),
                            theme.rgb("ink"),
                            True,
                            theme.face_label,
                        )
                    ]
                ],
                align=PP_ALIGN.CENTER,
            )
            _textbox(
                slide,
                bx + i * slot,
                base_y + 6,
                slot,
                22,
                [
                    [
                        (
                            label,
                            _pt(13),
                            theme.rgb("ink-soft"),
                            False,
                            theme.face_body,
                        )
                    ]
                ],
                align=PP_ALIGN.CENTER,
            )
    else:  # line / scatter -> points + connecting polyline
        slot = bw / max(1, n - 1) if n > 1 else bw
        pts = []
        for i, (_, v) in enumerate(data):
            cx = bx + (i * slot if n > 1 else bw / 2)
            cy = base_y - (v / vmax) * plot_h
            pts.append((cx, cy))
        if kind == "line" and len(pts) >= 2:
            fb = slide.shapes.build_freeform(_emu(pts[0][0]), _emu(pts[0][1]))
            fb.add_line_segments(
                [(_emu(x), _emu(y)) for x, y in pts[1:]], close=False
            )
            shp = fb.convert_to_shape()
            shp.fill.background()
            shp.line.color.rgb = accent
            shp.line.width = Pt(2.0)
            shp.shadow.inherit = False
        for (cx, cy), (label, v) in zip(pts, data):
            dot = slide.shapes.add_shape(
                MSO_SHAPE.OVAL, _emu(cx - 4), _emu(cy - 4), _emu(8), _emu(8)
            )
            _fill(dot, accent)
            _textbox(
                slide,
                cx - 30,
                base_y + 6,
                60,
                22,
                [
                    [
                        (
                            label,
                            _pt(12),
                            theme.rgb("ink-soft"),
                            False,
                            theme.face_body,
                        )
                    ]
                ],
                align=PP_ALIGN.CENTER,
            )


def _fmt(v: float) -> str:
    return str(int(v)) if v == int(v) else f"{v:.1f}"


# ---------------------------------------------------------------------------
# text measurement — how a string becomes a height
# ---------------------------------------------------------------------------

# Average glyph advance as a fraction of the font size. Every height in the
# layout comes from this number, so the DIRECTION of its error is what
# matters: over-estimating leaves whitespace, under-estimating puts one band's
# text on top of the next. The exporter cannot ask the renderer that will
# really lay the text out — Google Slides substitutes its own face for
# whatever the theme names — so these sit above the widest realistic case
# rather than at the average. Measured at 100px over Liberation Sans (Arial
# metrics), Liberation Mono and DejaVu Sans: mixed proportional prose runs
# 0.41–0.55 em/char, a monospace body face (what the `what-is-dia` theme sets
# for prose) is exactly 0.600, and text this module uppercases itself —
# kickers and table headers — reaches 0.674.
ADVANCE_EM = 0.62
ADVANCE_EM_CAPS = 0.70


def _lines_of(text: str, w: float, size: float, caps: bool = False) -> int:
    per_char = max(0.1, size) * (ADVANCE_EM_CAPS if caps else ADVANCE_EM)
    per_line = max(4.0, w / per_char)
    total = 0
    for seg in (text or "").split("\n"):
        total += max(1, math.ceil(len(seg) / per_line))
    return max(1, total)


def _text_h(
    text: str, w: float, size: float, leading: float = 1.4, caps: bool = False
) -> float:
    """The height `text` needs at `size` in a `w`-wide box."""
    return _lines_of(text, w, size, caps) * size * leading


# ---------------------------------------------------------------------------
# table rendering — native pptx table, styled per the house conventions
# ---------------------------------------------------------------------------

# "No Style, No Grid" — kills the template's banded blue table style so the
# explicit per-cell fills/fonts below fully define the look
_TABLE_NO_STYLE = "{2D5ABB26-0587-4C30-8999-92F81FD0307C}"


def _cell_rule_bottom(cell, color: RGBColor, w_pt: float) -> None:
    """A hairline bottom border on one cell (the rule under the header row).

    python-pptx has no border API; write the a:lnB directly. Inserted at the
    FRONT of tcPr: border elements precede fill elements in the schema.
    """
    from pptx.oxml.ns import qn

    tc_pr = cell._tc.get_or_add_tcPr()
    ln = tc_pr.makeelement(
        qn("a:lnB"), {"w": str(int(w_pt * 12700)), "cap": "flat"}
    )
    fill = ln.makeelement(qn("a:solidFill"), {})
    clr = fill.makeelement(qn("a:srgbClr"), {"val": str(color)})
    fill.append(clr)
    ln.append(fill)
    tc_pr.insert(0, ln)


# Cell padding this module writes, in design px (a side each way).
_CELL_PAD_X = 16.0
_CELL_PAD_Y = 10.0
_ROW_MIN = 26.0
# How far the type may be taken down before a table is unreadable rather than
# merely tight.
_TABLE_MIN_SCALE = 0.55


@dataclass
class TablePlan:
    """A table's own geometry: what `_draw_table` writes, and what the layout
    reserves. One object so the two cannot disagree."""

    grid: list[list[El]]
    ncols: int
    rows: list[float]  # row heights, design px
    col_w: list[float]
    height: float
    scale: float
    fits: bool
    th_px: float
    td_px: float

    def size_px(self, is_th: bool) -> float:
        return self.th_px if is_th else self.td_px


def _table_plan(
    theme: Theme, tbl: El, w: float, max_h: float | None = None
) -> TablePlan | None:
    """Measure a table at width `w`, shrinking the type to fit `max_h`.

    A table's height is not a guess made at the call site. Every row height
    here is written back as an explicit row height, so the table occupies the
    space the layout reserved for it. The exporter used to hand a table
    whatever box was left over and let the renderer grow the rows past it,
    which is how reserving a band beneath one turned a clipped table into two
    shapes drawn on top of each other."""
    grid = [
        r.find_all(lambda e: e.tag in ("th", "td"))
        for r in tbl.find_all(lambda e: e.tag == "tr")
    ]
    grid = [g for g in grid if g]
    if not grid:
        return None
    ncols = max(len(g) for g in grid)
    col_w = w / ncols
    inner = max(24.0, col_w - _CELL_PAD_X)
    scale = 1.0
    while True:
        th_px = theme.scale[1] * scale
        td_px = theme.scale[2] * scale
        rows = []
        for cells in grid:
            row_h = _ROW_MIN * scale
            for cell in cells:
                is_th = cell.tag == "th"
                row_h = max(
                    row_h,
                    _text_h(
                        cell.all_text(), inner,
                        th_px if is_th else td_px, 1.25, caps=is_th,
                    )
                    + _CELL_PAD_Y,
                )
            rows.append(row_h)
        total = sum(rows)
        if max_h is None or total <= max_h or scale <= _TABLE_MIN_SCALE:
            return TablePlan(
                grid, ncols, rows, [col_w] * ncols, total, scale,
                max_h is None or total <= max_h, th_px, td_px,
            )
        # sqrt of the overshoot: smaller type also fits more per line, so a
        # linear step overshoots and the loop chatters toward the floor.
        scale = max(_TABLE_MIN_SCALE, scale * (max_h / total) ** 0.5)


def _draw_table(slide, theme: Theme, tbl: El, box, plan=None) -> None:
    """A dialect <table> -> a native, editable pptx table. House conventions:
    label-face uppercase th over a rule, body-face td, `.num` right-aligned.

    Every row height and column width is written explicitly, from the same
    `_table_plan` the layout reserved space with, so the table occupies the
    box it was given. Leaving them to the renderer is what used to make a
    reserved footnote band collide with a table that grew past its box."""
    bx, by, bw, bh = box
    if plan is None:
        plan = _table_plan(theme, tbl, bw, bh)
    if plan is None:
        return
    frame = slide.shapes.add_table(
        len(plan.rows), plan.ncols, _emu(bx), _emu(by), _emu(bw),
        _emu(plan.height),
    )
    table = frame.table
    try:  # strip the template's banded style; ignore layout-internal misses
        from pptx.oxml.ns import qn

        style_id = table._tbl.find(qn("a:tblPr")).find(qn("a:tableStyleId"))
        if style_id is not None:
            style_id.text = _TABLE_NO_STYLE
    except (AttributeError, KeyError):
        pass
    table.first_row = False
    table.horz_banding = False
    for col, w_px in zip(table.columns, plan.col_w):
        col.width = Emu(_emu(w_px))
    for i, cells in enumerate(plan.grid):
        table.rows[i].height = Emu(_emu(plan.rows[i]))
        for j in range(plan.ncols):
            cell = table.cell(i, j)
            cell.fill.background()
            cell.margin_left = cell.margin_right = Emu(_emu(_CELL_PAD_X / 2))
            cell.margin_top = cell.margin_bottom = Emu(_emu(_CELL_PAD_Y / 2))
            src = cells[j] if j < len(cells) else None
            if src is None:
                continue
            is_th = src.tag == "th"
            if is_th:
                _cell_rule_bottom(cell, theme.rgb("rule"), 1.0)
            tf = cell.text_frame
            tf.word_wrap = True
            p = tf.paragraphs[0]
            p.alignment = PP_ALIGN.RIGHT if src.has("num") else PP_ALIGN.LEFT
            run = p.add_run()
            txt = src.all_text()
            run.text = txt.upper() if is_th else txt
            run.font.size = _font_pt(_pt(plan.size_px(is_th)))
            run.font.bold = is_th
            run.font.name = (
                theme.face_label
                if (is_th or src.has("num"))
                else theme.face_body
            )
            run.font.color.rgb = theme.rgb("ink-faint" if is_th else "ink-soft")


# ---------------------------------------------------------------------------
# figures — the primary visual of a slide, drawn natively
# ---------------------------------------------------------------------------


def _draw_visual(slide, theme: Theme, vis: El, box) -> None:
    if vis.tag == "svg" and vis.has("dia-chart"):
        _draw_chart(slide, theme, vis, box)
    elif vis.tag == "svg":
        _draw_scene(slide, theme, vis, box)
    elif vis.tag == "table":
        _draw_table(slide, theme, vis, box)
    elif vis.tag == "img":
        _draw_image(slide, theme, vis, box)


def _draw_image(slide, theme: Theme, img: El, box) -> None:
    src = img.attrs.get("src") or ""
    bx, by, bw, bh = box
    m = re.match(r"data:image/(png|jpe?g|gif);base64,(.+)$", src, re.I | re.S)
    if m:
        import base64

        try:
            raw = base64.b64decode(m.group(2))
            # Placed at its native size first, then fitted: giving both width
            # and height stretches the picture to the box, and the box is the
            # room the layout had rather than the picture's own proportions.
            pic = slide.shapes.add_picture(io.BytesIO(raw), _emu(bx), _emu(by))
            if pic.width and pic.height:
                k = min(_emu(bw) / pic.width, _emu(bh) / pic.height)
                pic.width, pic.height = (
                    int(pic.width * k), int(pic.height * k)
                )
                pic.left = _emu(bx + (bw - pic.width / EMU_PER_PX) / 2)
                pic.top = _emu(by + (bh - pic.height / EMU_PER_PX) / 2)
            return
        except (ValueError, OSError):
            pass
    # SVG data-URI: decode + render its primitives as native vector shapes.
    svg_m = re.match(r"data:image/svg\+xml(;base64)?,(.+)$", src, re.I | re.S)
    if svg_m:
        import base64
        import urllib.parse

        payload = svg_m.group(2)
        try:
            markup = (
                base64.b64decode(payload).decode("utf-8")
                if svg_m.group(1)
                else urllib.parse.unquote(payload)
            )
            svg = _parse(markup).find(lambda e: e.tag == "svg")
            if svg is not None:
                _, _, vw, vh = _viewbox(svg)
                mm, scale = _fit(vw, vh, box)
                _draw_prims(
                    slide,
                    theme,
                    svg,
                    mm,
                    scale,
                    skip=lambda e: _ancestor_matches(
                        e, lambda p: p.tag in ("defs", "marker")
                    ),
                )
                return
        except (ValueError, OSError, UnicodeDecodeError):
            pass
    # remote refs can't embed directly — draw a labeled frame.
    frame = slide.shapes.add_shape(
        MSO_SHAPE.RECTANGLE, _emu(bx), _emu(by), _emu(bw), _emu(bh)
    )
    _fill(frame, theme.rgb("rule"), theme.rgb("ink-faint"), 1.0)
    _textbox(
        slide,
        bx,
        by + bh / 2 - 14,
        bw,
        28,
        [
            [
                (
                    img.attrs.get("alt") or "figure",
                    _pt(theme.scale[1]),
                    theme.rgb("ink-soft"),
                    False,
                    theme.face_label,
                )
            ]
        ],
        align=PP_ALIGN.CENTER,
    )


# ---------------------------------------------------------------------------
# slide layout — a total partition of the slide, then disjoint bands
# ---------------------------------------------------------------------------
#
# Two invariants stand in for what used to be a single forward pass over a
# hardcoded list of role names:
#
#   coverage — `_partition` assigns EVERY element of a slide to a part, with
#     prose as the fallback, so `unplaced_text()` comes back empty for any
#     slide. The old shape drew what a fixed set of `find()` calls named and
#     said nothing about the rest, so a subtitle, a quote, an attribution, a
#     code block, an island, a bare paragraph, a bulleted list outside
#     `dia-body`, a second table, a second figure and a second column all left
#     the deck without a word — ten roles, one bug. An allowlist cannot be
#     sound here in the first place: the profile permits unknown classes by
#     design ("unknown classes are permitted ... and are not flagged"), so the
#     mapping has to be total and the unrecognized case has to render.
#
#   tiling — `_stack` deals bands down a column from one moving cursor, so two
#     bands cannot overlap and none can leave the column. When a column is
#     over-subscribed the bands shrink toward their floors together and the
#     leftover is reported through the warning sink. The old shape advanced a
#     cursor by a character-count estimate and drew wherever it landed, which
#     is how a long footnote ended up below the page edge and a table grew
#     under the band reserved beneath it.


@dataclass
class Part:
    """One role-tagged piece of a slide, and the subtree it accounts for."""

    role: str
    el: El


# Class -> band, most specific first. `dia-body` lands on prose because its
# contents are paragraphs; the roles above it are their own band because they
# carry their own type, color and place in the flow.
#
# `dia-subtitle`, `dia-quote`, `dia-attribution`, `dia-code` and `dia-list`
# are NOT profile roles (§2 Class vocabulary names five text roles and five
# layout containers, and coins nothing for a quotation or a list). They are
# here because decks in the wild carry them — earlier revisions of
# `translate-slide` told models to emit them — and giving them a band of
# their own reads better than the prose fallback. Nothing depends on them:
# remove a row and its class falls through to prose, which is the whole point
# of the mapping being total.
_ROLE_BY_CLASS = (
    ("dia-notes", "notes"),
    ("dia-island", "island"),
    ("dia-columns", "columns"),
    ("dia-math", "math"),
    ("dia-kicker", "kicker"),
    ("dia-title", "title"),
    ("dia-subtitle", "subtitle"),
    ("dia-caption", "caption"),
    ("dia-footnote", "footnote"),
    ("dia-quote", "quote"),
    ("dia-attribution", "attribution"),
    ("dia-code", "code"),
    ("dia-body", "prose"),
    ("dia-list", "prose"),
)

# Tags that carry text of their own rather than wrapping other blocks.
_PROSE_TAGS = {
    "p", "ul", "ol", "dl", "li", "dt", "dd",
    "h1", "h2", "h3", "h4", "h5", "h6",
}

# Not content: markup that lives inside a slide but has nothing to say on it.
_MUTE_TAGS = {"style", "script", "template", "link", "meta", "br", "hr"}


def _role_of(el: El) -> str | None:
    """The band that draws `el`, or None for a wrapper the walk descends into.

    Class first — a role class is the deck's own statement of what a region
    is — then tag. None must always mean "look inside", never "skip": the
    only thing that drops out of the partition is `_MUTE_TAGS`, and that is
    an explicit decision rather than an omission."""
    if el.tag in _MUTE_TAGS:
        return "mute"
    for cls, role in _ROLE_BY_CLASS:
        if el.has(cls):
            return role
    if el.tag == "aside":
        return "notes"
    if el.tag == "svg":
        # A scene, a chart, or artwork inside a `dia-figure` IS the figure; a
        # bare svg (the brand mark on a cover) is decoration drawn at the size
        # it declares.
        if (
            el.has("dia-scene")
            or el.has("dia-chart")
            or _ancestor_matches(el, lambda p: p.has("dia-figure"))
        ):
            return "figure"
        return "deco"
    if el.tag in ("img", "table"):
        return "figure"
    if el.tag == "figcaption":
        return "caption"
    if el.tag == "pre":
        return "code"
    if el.tag == "blockquote":
        return "quote"
    if el.tag == "math":
        return "math"
    if el.tag in _PROSE_TAGS:
        return "prose"
    return None


def _holds_only_prose(el: El) -> bool:
    """No descendant of `el` carries a band of its own.

    Such an element is one run of prose, not a container to descend into:
    `<div>text <em>emphasis</em> more</div>` is one paragraph, and splitting
    it at the inline boundaries would set three."""
    return all(
        _role_of(d) in (None, "mute")
        for d in el.walk()
        if d is not el and d.tag != "#text"
    )


def _partition(root: El) -> list[Part]:
    """Every element under `root`, in document order, as role-tagged parts.

    A part claims its whole subtree, so the parts are disjoint and their union
    is `root`. An element with no role of its own is descended into; one whose
    descendants have none either becomes prose. That total is what the
    coverage invariant rests on: nothing falls between the cases."""
    parts: list[Part] = []

    def visit(el: El) -> None:
        for c in el.children:
            if c.tag == "#text":
                if c.text and c.text.strip():
                    parts.append(Part("prose", c))
                continue
            role = _role_of(c)
            if role is not None:
                parts.append(Part(role, c))
            elif _holds_only_prose(c):
                if c.all_text():
                    parts.append(Part("prose", c))
            else:
                visit(c)

    visit(root)
    return parts


def unplaced_text(slide_el: El) -> str:
    """Text on a slide that the partition does not account for.

    Always empty — `_partition` is total. Exported because an invariant no
    test can read is a promise, not a guarantee, and silent loss here is the
    one failure that looks like success."""
    claimed: set[int] = set()
    for part in _partition(slide_el):
        for el in part.el.walk():
            claimed.add(id(el))
    loose = [
        el.text
        for el in slide_el.walk()
        if el.text and el.text.strip() and id(el) not in claimed
    ]
    return re.sub(r"\s+", " ", " ".join(loose)).strip()


@dataclass
class Band:
    """One thing to draw and the vertical room it needs.

    `ask` is its height at the width it was measured for, `floor` the least it
    can be squeezed to, and `grow` marks the band that absorbs a column's
    slack (the primary figure, which has no natural size of its own)."""

    kind: str
    ask: float
    paint: object  # (slide, theme, x, y, w, h) -> None
    floor: float = 0.0
    grow: bool = False
    push: bool = False  # a column's slack goes in front of this band
    gap_after: float = 12.0


def _stack(slide, theme, bands, x, y, w, h, center: bool = False) -> float:
    """Deal `bands` down a column as disjoint rects; return the shortfall px.

    Because every rect comes off one cursor, bands cannot overlap and cannot
    leave the column, whatever the measurement said. Over-subscription is
    absorbed by shrinking every band toward its floor by one common factor;
    a column that still does not fit reports how much it is over instead of
    drawing past the bottom edge."""
    if not bands:
        return 0.0
    gaps = sum(b.gap_after for b in bands[:-1])
    avail = max(0.0, h - gaps)
    ask = sum(b.ask for b in bands)
    floor = sum(b.floor for b in bands)
    shortfall = 0.0
    heights = [b.ask for b in bands]
    if ask > avail:
        if floor >= avail:
            shrink = avail / max(1e-6, floor)
            heights = [b.floor * shrink for b in bands]
            shortfall = floor - avail
        else:
            keep = (avail - floor) / max(1e-6, ask - floor)
            heights = [b.floor + (b.ask - b.floor) * keep for b in bands]
    lead = 0.0
    if ask <= avail:
        growers = [i for i, b in enumerate(bands) if b.grow]
        pushed = next((i for i, b in enumerate(bands) if b.push), None)
        if growers:
            share = (avail - ask) / len(growers)
            for i in growers:
                heights[i] += share
        elif pushed is not None and not center:
            # `.foot { margin-top: auto }` in the dialect's own stylesheet: a
            # trailing caption sits at the foot of its column, not under the
            # last paragraph. A centered column is already placed by its own
            # rule, so the two must not both spend the same slack.
            lead = avail - ask
    cy = y
    if center:
        cy += max(0.0, (h - (sum(heights) + gaps)) / 2)
    for i, (band, bh) in enumerate(zip(bands, heights)):
        if lead and band.push:
            cy += lead
            lead = 0.0
        band.paint(slide, theme, x, cy, w, bh)
        cy += bh + band.gap_after
    return shortfall


# ---------------------------------------------------------------------------
# bands — one builder per role
# ---------------------------------------------------------------------------


def _prose_runs(els, theme: Theme, size: float, color, face: str):
    """`<p>`/`<li>` across `els` as paragraphs, a bullet run leading each item.

    The fallback matters: an element with text but no block children — a bare
    text node, a `<div>` of loose prose, an islanded region — contributes its
    own text rather than being passed over for not looking like a paragraph."""
    paras = []
    for el in els:
        blocks = [e for e in el.walk() if e.tag in ("p", "li")]
        if not blocks:
            txt = el.all_text()
            if txt:
                paras.append([(txt, _pt(size), color, False, face)])
            continue
        for b in blocks:
            txt = b.all_text()
            if not txt:
                continue
            if b.tag == "li":
                paras.append(
                    [
                        ("•  ", _pt(size), theme.rgb("accent"), True, face),
                        (txt, _pt(size), color, False, face),
                    ]
                )
            else:
                paras.append([(txt, _pt(size), color, False, face)])
    return paras


def _paras_h(paras, w: float, size: float, leading: float, space_after: float):
    h = 0.0
    for i, para in enumerate(paras):
        h += _text_h("".join(t for t, *_ in para), w, size, leading)
        if i:
            h += space_after
    return h


def _fit_size(text: str, w: float, h: float, start: float, leading: float,
              caps: bool = False, floor: float = 7.0) -> float:
    """The largest size at or below `start` whose text fits `w` x `h`."""
    size = start
    while size > floor and _text_h(text, w, size, leading, caps) > h:
        size -= 0.5
    return size


def _text_band(kind, text, w, *, size, color, face, bold=False, leading=1.4,
               caps=False, align=PP_ALIGN.LEFT, gap_after=12.0, extra=6.0):
    body = text.upper() if caps else text
    ask = _text_h(body, w, size, leading, caps) + extra

    def paint(slide, theme, x, y, bw, bh):
        _textbox(
            slide, x, y, bw, bh,
            [[(body, _pt(size), color, bold, face)]],
            align=align, leading=leading, space_after=0.0,
        )

    return Band(kind, ask, paint, floor=min(ask, size * leading + extra),
                gap_after=gap_after)


def _prose_band(kind, els, w, *, theme, size, color, face, leading=1.5,
                space_after=10.0, gap_after=12.0):
    paras = _prose_runs(els, theme, size, color, face)
    if not paras:
        return None
    ask = _paras_h(paras, w, size, leading, space_after) + 6

    def paint(slide, theme_, x, y, bw, bh):
        _textbox(slide, x, y, bw, bh, paras, leading=leading,
                 space_after=space_after)

    return Band(kind, ask, paint, floor=min(ask, size * leading + 6),
                gap_after=gap_after)


def _figure_band(el: El, w: float, theme: Theme, primary: bool, warn):
    """A figure's band. A table declares its real height; a scene, chart or
    image has none of its own and grows into whatever the column has left."""
    if el.tag == "table":
        plan = _table_plan(theme, el, w)
        if plan is None:
            return None

        def paint(slide, theme_, x, y, bw, bh):
            fitted = _table_plan(theme_, el, bw, bh)
            if fitted is not None and not fitted.fits and warn is not None:
                warn(
                    f"a {len(fitted.rows)}-row table needs "
                    f"{fitted.height:.0f}px and the column had {bh:.0f}px; it "
                    "is drawn at the smallest type that still reads"
                )
            _draw_table(slide, theme_, el, (x, y, bw, bh), fitted)

        return Band("figure", plan.height, paint,
                    floor=min(plan.height, 3 * _ROW_MIN), gap_after=14.0)

    def paint(slide, theme_, x, y, bw, bh):
        _draw_visual(slide, theme_, el, (x, y, bw, bh))

    nominal = 240.0 if primary else 150.0
    return Band("figure", nominal, paint, floor=80.0, grow=primary,
                gap_after=14.0)


def _island_band(el: El, w: float, theme: Theme, warn):
    """An islanded region, recovered as its own text.

    An island is markup the translation could not express in the dialect, so
    the exporter renders its TEXT and says it did. Laying out its internals
    would be exactly the plausible reconstruction the import rule forbids —
    but dropping it, which is what used to happen, is worse: `translate-slide`
    tells the model to island whatever it cannot express, so the more honest
    the translation the more of the deck went missing."""
    text = el.all_text()
    if not text:
        return None
    if warn is not None:
        warn(
            "an islanded region cannot be laid out natively; its text is on "
            "the slide but its markup and appearance are not"
        )
    size = theme.scale[2] * 0.92
    return _text_band("island", text, w, size=size,
                      color=theme.rgb("ink-soft"), face=theme.face_body,
                      leading=1.4)


def _deco_band(el: El, theme: Theme):
    _, dh = _svg_declared_size(el)

    def paint(slide, theme_, x, y, bw, bh):
        _draw_decorative(slide, theme_, el, x, y)

    return Band("deco", dh, paint, floor=dh, gap_after=14.0)


def _math_band(el: El, w: float, theme: Theme):
    """A formula, as the LaTeX the profile calls its truth.

    The rendered MathML is derived content whose element text concatenates
    into nonsense ("E = m c 2"), so the source is both more faithful and more
    readable in a deck that has no MathML renderer."""
    tex = (el.attrs.get("data-dia-tex") or "").strip() or el.all_text()
    if not tex:
        return None
    return _text_band("math", tex, w, size=theme.scale[2],
                      color=theme.rgb("ink"), face=theme.face_label,
                      leading=1.35)


def _band_for(part: Part, theme: Theme, w: float, title_px: float,
              primary_figure: bool, warn):
    role, el = part.role, part.el
    if role == "kicker":
        txt = el.all_text()
        if not txt:
            return None
        return _text_band("kicker", txt, w, size=theme.scale[1],
                          color=theme.rgb("accent"), face=theme.face_label,
                          bold=True, leading=1.2, caps=True, gap_after=12.0)
    if role == "title":
        txt = el.all_text()
        if not txt:
            return None
        return _text_band("title", txt, w, size=title_px,
                          color=theme.rgb("ink"), face=theme.face_display,
                          bold=True, leading=1.14, extra=10.0, gap_after=14.0)
    if role == "subtitle":
        txt = el.all_text()
        if not txt:
            return None
        return _text_band("subtitle", txt, w, size=theme.scale[4],
                          color=theme.rgb("ink-soft"), face=theme.face_body,
                          leading=1.3, gap_after=10.0)
    if role == "quote":
        return _prose_band("quote", [el], w, theme=theme, size=theme.scale[4],
                           color=theme.rgb("ink"), face=theme.face_body,
                           leading=1.4, gap_after=8.0)
    if role == "attribution":
        txt = el.all_text()
        if not txt:
            return None
        return _text_band("attribution", txt, w, size=theme.scale[1],
                          color=theme.rgb("ink-faint"), face=theme.face_label,
                          leading=1.3)
    if role == "code":
        txt = el.all_text()
        if not txt:
            return None
        return _text_band("code", txt, w, size=theme.scale[2] * 0.92,
                          color=theme.rgb("ink-soft"), face=theme.face_label,
                          leading=1.35)
    if role == "caption":
        txt = el.all_text()
        if not txt:
            return None
        return _text_band("caption", txt, w, size=theme.scale[1],
                          color=theme.rgb("ink-soft"), face=theme.face_label,
                          leading=1.4)
    if role == "island":
        return _island_band(el, w, theme, warn)
    if role == "math":
        return _math_band(el, w, theme)
    if role == "deco":
        return _deco_band(el, theme)
    if role == "figure":
        return _figure_band(el, w, theme, primary_figure, warn)
    if role == "columns":
        return _columns_band(el, w, theme, title_px, warn)
    return _prose_band("prose", [el], w, theme=theme, size=theme.scale[2],
                       color=theme.rgb("ink-soft"), face=theme.face_body)


def _column_bands(parts, theme: Theme, w: float, title_px: float, warn):
    """Parts -> bands at width `w`, consecutive prose merged into one band.

    Merging matters for text that arrives in fragments (mixed content around
    an inline element): a band each would space them like separate blocks."""
    parts = [p for p in parts if p.role not in ("mute", "notes")]
    bands = []
    seen_figure = False
    i = 0
    while i < len(parts):
        part = parts[i]
        if part.role == "prose":
            group = []
            while i < len(parts) and parts[i].role == "prose":
                group.append(parts[i].el)
                i += 1
            band = _prose_band("prose", group, w, theme=theme,
                               size=theme.scale[2],
                               color=theme.rgb("ink-soft"),
                               face=theme.face_body)
            if band is not None:
                bands.append(band)
            continue
        primary = False
        if part.role == "figure" and part.el.tag != "table" and not seen_figure:
            primary = seen_figure = True
        band = _band_for(part, theme, w, title_px, primary, warn)
        if band is not None:
            bands.append(band)
        i += 1
    if bands and bands[-1].kind in ("caption", "attribution"):
        bands[-1].push = True
    return bands


def _columns_band(el: El, w: float, theme: Theme, title_px: float, warn):
    """A `dia-columns` container: its children side by side, each its own stack.

    The exporter used to read only the FIRST `dia-body` on a slide, so a
    second column left the deck entirely; the `what-is-dia` example puts
    `dia-columns` on a div inside the slide rather than on the section, which
    is the shape that used to lose half its text."""
    cols = [c for c in el.children if c.tag != "#text" and _role_of(c) != "mute"]
    if not cols:
        return None
    gap = theme.gap
    if len(cols) == 2:  # 1.05fr 1fr, mirroring the dialect's own grid
        widths = [(w - gap) * 1.05 / 2.05, (w - gap) * 1.0 / 2.05]
    else:
        each = (w - gap * (len(cols) - 1)) / len(cols)
        widths = [each] * len(cols)
    stacks = [
        _column_bands(_partition(c), theme, cw, title_px, warn)
        for c, cw in zip(cols, widths)
    ]
    ask = max(
        (sum(b.ask for b in s) + sum(b.gap_after for b in s[:-1]))
        for s in stacks
    ) if any(stacks) else 0.0
    if ask <= 0:
        return None

    def paint(slide, theme_, x, y, bw, bh):
        cx = x
        for stack, cw in zip(stacks, widths):
            _stack(slide, theme_, stack, cx, y, cw, bh)
            cx += cw + gap

    # The dialect lays a slide out as a flex column, so a `dia-columns` grid
    # stretches: let it take the slack rather than leaving a hole under it.
    return Band("columns", ask, paint, floor=min(ask, 80.0), grow=True,
                gap_after=14.0)


# ---------------------------------------------------------------------------
# the slide
# ---------------------------------------------------------------------------


def _add_notes(slide, note_els) -> None:
    txt = " ".join(el.all_text() for el in note_els).strip()
    if txt:
        slide.notes_slide.notes_text_frame.text = txt


def _footnote_band(parts, theme: Theme, w: float, h: float):
    """(band, height) for the footnote, or (None, 0).

    The footnote's room comes off the pool BEFORE anything else is measured,
    so reserving it can only make the content area smaller — it can never
    land under a band that was placed without knowing about it. It used to be
    a fixed 20px box pinned at `DESIGN_H - pad + 4`, below the bottom of the
    padded box: a note of any length ran off the page and the renderer clipped
    it. Real provenance notes run to ~1000 characters."""
    text = " ".join(p.el.all_text() for p in parts).strip()
    if not text:
        return None, 0.0
    # A third of the slide is as much as a footnote may take before it is the
    # slide; past that it shrinks instead of pushing the content out.
    cap = DESIGN_H * 0.34
    size = _fit_size(text, w, cap, theme.scale[1], 1.32)
    fh = min(cap, _text_h(text, w, size, 1.32) + 4)

    def paint(slide, theme_, x, y, bw, bh):
        _textbox(
            slide, x, y, bw, bh,
            [[(text, _pt(size), theme_.rgb("ink-faint"), False,
               theme_.face_label)]],
            leading=1.32, space_after=0.0,
        )

    return Band("footnote", fh, paint, floor=fh), fh


def _render_slide(prs, theme: Theme, slide_el: El, warn=None) -> None:
    blank = prs.slide_layouts[6]
    slide = prs.slides.add_slide(blank)
    _bg(slide, theme, slide_el)

    parts = _partition(slide_el)
    _add_notes(slide, [p.el for p in parts if p.role == "notes"])
    parts = [p for p in parts if p.role not in ("mute", "notes")]

    pad = theme.pad
    x, y = pad, pad
    w = DESIGN_W - 2 * pad
    h = DESIGN_H - 2 * pad

    title_el = next((p.el for p in parts if p.role == "title"), None)
    title_px = (
        theme.scale[7]
        if (title_el is not None and title_el.has("dia-cover-title"))
        else theme.scale[5]
    )

    foot_band, foot_h = _footnote_band(
        [p for p in parts if p.role == "footnote"], theme, w, h
    )
    parts = [p for p in parts if p.role != "footnote"]
    if foot_band is not None:
        h = max(120.0, h - (foot_h + 10))
        foot_band.paint(slide, theme, x, DESIGN_H - 12 - foot_h, w, foot_h)

    figures = [p for p in parts if p.role == "figure"]
    shortfall = 0.0
    if slide_el.has("dia-columns") and figures:
        # The section itself declares the two-column layout: text left, the
        # figure and its caption right.
        gap = theme.gap
        left_w = (w - gap) * 1.05 / 2.05
        right_w = (w - gap) - left_w
        right_roles = {id(figures[0])} | {
            id(p) for p in parts if p.role == "caption"
        }
        left = [p for p in parts if id(p) not in right_roles]
        right = [p for p in parts if id(p) in right_roles]
        shortfall = _stack(
            slide, theme, _column_bands(left, theme, left_w, title_px, warn),
            x, y, left_w, h,
        )
        shortfall = max(shortfall, _stack(
            slide, theme, _column_bands(right, theme, right_w, title_px, warn),
            x + left_w + gap, y, right_w, h,
        ))
    else:
        bands = _column_bands(parts, theme, w, title_px, warn)
        shortfall = _stack(
            slide, theme, bands, x, y, w, h, center=slide_el.has("dia-cover")
        )
    if shortfall > 1.0 and warn is not None:
        warn(
            f"the content needs {shortfall:.0f}px more than the slide has; "
            "every band was compressed to keep it on the page"
        )


# ---------------------------------------------------------------------------
# public API
# ---------------------------------------------------------------------------


def deck_to_pptx(html: str, warnings: list[str] | None = None) -> bytes:
    """Convert a dialect deck (HTML string) to .pptx bytes.

    `warnings` is an optional sink. The exporter maps text SEMANTICALLY and
    estimates block heights, so some slides are placed approximately; anything
    it had to recover or could not place cleanly is appended here rather than
    passing silently. A caller that ignores it behaves exactly as before."""
    root = _parse(html)
    theme = _read_theme(root)
    slides = root.find_all(lambda e: e.tag == "section" and e.has("dia-slide"))
    prs = pptx.Presentation()
    prs.slide_width = SLIDE_W
    prs.slide_height = SLIDE_H
    for _i, slide_el in enumerate(slides, 1):
        def _warn(msg: str, _n=_i) -> None:
            if warnings is not None:
                warnings.append(f"slide {_n}: {msg}")
        try:
            _render_slide(prs, theme, slide_el, _warn)
        except Exception:  # pylint: disable=broad-except
            _warn("render failed; emitted a blank slide in its place")
            # One malformed slide (common with imported foreign decks) must never
            # abort the whole export — emit a blank slide in its place and continue.
            try:
                prs.slides.add_slide(prs.slide_layouts[6])
            except Exception:  # pylint: disable=broad-except
                pass
    buf = io.BytesIO()
    prs.save(buf)
    return buf.getvalue()


def deck_title(html: str) -> str:
    root = _parse(html)
    t = root.find(lambda e: e.tag == "title")
    if t and t.all_text():
        return t.all_text()
    # first cover/slide title
    st = root.find(lambda e: e.has("dia-title"))
    return st.all_text() if st else "Presentation"


def deck_slide_count(html: str) -> int:
    """Number of `<section class="dia-slide">` in the deck (0 = not a deck)."""
    root = _parse(html)
    return len(
        root.find_all(lambda e: e.tag == "section" and e.has("dia-slide"))
    )


def export_file(src: str, dst: str, warnings: list[str] | None = None) -> int:
    with open(src, "r", encoding="utf-8") as f:
        html = f.read()
    data = deck_to_pptx(html, warnings)
    with open(dst, "wb") as f:
        f.write(data)
    root = _parse(html)
    n = len(root.find_all(lambda e: e.tag == "section" and e.has("dia-slide")))
    return n
