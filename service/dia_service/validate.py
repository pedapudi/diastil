"""Profile validator — the Python mirror of src/model/validate.ts.

Same rules, same rule ids, same levels (see profile/PROFILE.md); this copy
exists so `dia validate` works headless with no browser and no Node. The
TypeScript validator remains the reference implementation — keep rule ids
in lockstep when either changes.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from html.parser import HTMLParser

NODE_SHAPES = {
    "rect", "rounded", "pill", "ellipse", "diamond",
    "cylinder", "hex", "parallelogram", "triangle", "cloud", "note", "path",
}
# loose SVG path-data check for data-path (shape "path")
PATH_DATA = re.compile(r"[Mm][0-9MmLlHhVvCcSsQqTtAaZz\s,.+eE-]+\Z")
EDGE_ROUTES = {"straight", "ortho", "curve"}
ANCHOR_SIDES = {"N", "S", "E", "W", "auto"}

DIA_ATTRS = {
    "data-dia-version", "data-dia-node", "data-dia-edge", "data-dia-step",
    "data-dia-emphasis", "data-dia-island", "data-dia-transition",
    "data-dia-tex",  # LaTeX source of a .dia-math element; content is MathML
}
EDITOR_ONLY_ATTRS = {
    "data-dia-id", "data-dia-selected", "data-dia-current", "data-dia-step-shown",
}

VOID_TAGS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
    "meta", "param", "source", "track", "wbr",
}

COLOR_LITERAL = re.compile(r"(#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\()", re.IGNORECASE)
TOKEN_DECL = re.compile(r"--dia-[a-z-]+\s*:")


@dataclass
class El:
    tag: str
    attrs: dict[str, str]
    parent: "El | None" = None
    children: list["El"] = field(default_factory=list)
    text: str = ""

    def classes(self) -> set[str]:
        return set((self.attrs.get("class") or "").split())

    def walk(self):
        yield self
        for c in self.children:
            yield from c.walk()

    def find_all(self, tag: str | None = None, cls: str | None = None):
        for el in self.walk():
            if tag is not None and el.tag != tag:
                continue
            if cls is not None and cls not in el.classes():
                continue
            yield el

    def in_island(self, stop: "El") -> bool:
        cur = self.parent
        while cur is not None and cur is not stop:
            if "data-dia-island" in cur.attrs:
                return True
            cur = cur.parent
        return False

    def path(self) -> str:
        parts: list[str] = []
        cur: El | None = self
        while cur is not None and cur.tag != "body" and cur.tag != "#doc":
            if cur.tag == "section" and "dia-slide" in cur.classes():
                siblings = [
                    c for c in (cur.parent.children if cur.parent else [cur])
                    if c.tag == "section" and "dia-slide" in c.classes()
                ]
                parts.insert(0, f"section.dia-slide:nth-of-type({siblings.index(cur) + 1})")
                break
            idx = (cur.parent.children.index(cur) + 1) if cur.parent else 1
            parts.insert(0, f"{cur.tag}:nth-child({idx})")
            cur = cur.parent
        return " > ".join(parts)


class _TreeBuilder(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = El("#doc", {})
        self.stack = [self.root]

    def handle_starttag(self, tag: str, attrs) -> None:
        el = El(tag, {k: (v or "") for k, v in attrs}, parent=self.stack[-1])
        self.stack[-1].children.append(el)
        if tag not in VOID_TAGS:
            self.stack.append(el)

    def handle_startendtag(self, tag: str, attrs) -> None:
        el = El(tag, {k: (v or "") for k, v in attrs}, parent=self.stack[-1])
        self.stack[-1].children.append(el)

    def handle_endtag(self, tag: str) -> None:
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                return

    def handle_data(self, data: str) -> None:
        self.stack[-1].text += data


def _parse(html: str) -> El:
    builder = _TreeBuilder()
    builder.feed(html)
    return builder.root


def _first(root: El, tag: str, **attr_eq: str) -> El | None:
    for el in root.find_all(tag):
        if all(el.attrs.get(k) == v for k, v in attr_eq.items()):
            return el
    return None


def validate_html(html: str) -> dict:
    """Mirror of validateDocument(): {ok, findings[], slideCount, version}."""
    root = _parse(html)
    findings: list[dict] = []

    def add(level: str, rule: str, locator: str, message: str) -> None:
        findings.append({"level": level, "rule": rule, "locator": locator, "message": message})

    html_el = _first(root, "html")
    version = html_el.attrs.get("data-dia-version") if html_el else None
    if version is None:
        add("error", "frame/version", "", "missing data-dia-version on <html>")

    themes = [el for el in root.find_all("style") if el.attrs.get("id") == "dia-theme"]
    if len(themes) != 1:
        add("error", "frame/theme",
            "", "missing <style id=\"dia-theme\">" if not themes
            else f"{len(themes)} theme blocks — exactly one expected")
    elif not TOKEN_DECL.search(themes[0].text):
        add("advisory", "frame/theme-tokens", "style#dia-theme",
            "theme defines no --dia-* tokens; token-level editing is unavailable")

    if _first(root, "script", id="dia-runtime") is None:
        add("advisory", "frame/runtime", "", "no embedded runtime — the deck will not present standalone")

    slides = [el for el in root.find_all("section") if "dia-slide" in el.classes()]
    if not slides:
        add("error", "frame/slides", "", 'no <section class="dia-slide"> found')

    body = _first(root, "body")
    for child in (body.children if body else []):
        is_slide = child.tag == "section" and "dia-slide" in child.classes()
        is_runtime = child.tag == "script" and child.attrs.get("id") == "dia-runtime"
        if not is_slide and not is_runtime and child.tag != "style":
            add("error", "frame/stray-content", child.path(), f"unexpected <{child.tag}> at body top level")

    for slide in slides:
        for el in slide.walk():
            if el is not slide and el.in_island(slide):
                continue

            if el.tag == "script":
                add("error", "content/script", el.path(),
                    "script in a dialect region — behavior must be data-dia-* attributes")
            if el.tag in ("iframe", "object", "embed"):
                add("error", "content/embed", el.path(), f"<{el.tag}> outside an island")

            for name in el.attrs:
                if re.match(r"^on[a-z]", name):
                    add("error", "content/event-handler", el.path(), f"inline handler {name}")
                elif name in EDITOR_ONLY_ATTRS or name == "contenteditable":
                    add("error", "content/editor-artifact", el.path(),
                        f"editor session attribute {name} leaked into the document")
                elif name.startswith("data-dia-") and name not in DIA_ATTRS:
                    add("error", "content/unknown-dia-attr", el.path(), f"unknown dialect attribute {name}")

            step = el.attrs.get("data-dia-step")
            if step is not None and not re.fullmatch(r"[1-9]\d*", step):
                add("error", "behavior/step", el.path(), f'data-dia-step="{step}" is not a positive integer')
            transition = el.attrs.get("data-dia-transition")
            if transition is not None and transition not in ("none", "fade", "slide", "rise"):
                add("error", "behavior/transition", el.path(),
                    f'data-dia-transition="{transition}" is not one of none - fade - slide - rise')

            style = el.attrs.get("style")
            if style and COLOR_LITERAL.search(style):
                add("advisory", "content/inline-color", el.path(),
                    "inline literal color — prefer var(--dia-…) tokens")

        for scene in slide.find_all("svg", cls="dia-scene"):
            if scene.in_island(slide):
                continue
            ids: set[str] = set()
            for node in scene.walk():
                if "data-dia-node" not in node.attrs:
                    continue
                node_id = node.attrs["data-dia-node"]
                if node_id in ids:
                    add("error", "scene/node-id-duplicate", node.path(), f'duplicate node id "{node_id}"')
                ids.add(node_id)
                for g in ("data-x", "data-y", "data-w", "data-h"):
                    v = node.attrs.get(g)
                    if v is not None and not _finite(v):
                        add("error", "scene/node-geometry", node.path(), f'{g}="{v}" is not a finite number')
                rotate = node.attrs.get("data-rotate")
                if rotate is not None and not _finite(rotate):
                    add("error", "scene/node-rotate", node.path(), f'data-rotate="{rotate}" is not a finite number')
                shape = node.attrs.get("data-shape")
                if shape is not None and shape not in NODE_SHAPES:
                    add("error", "scene/node-shape", node.path(), f'unknown shape "{shape}"')
                if shape == "path":
                    d = node.attrs.get("data-path")
                    if not d or not PATH_DATA.fullmatch(d.strip()):
                        add("error", "scene/node-path", node.path(),
                            "data-path is not SVG path data" if d else 'shape "path" requires data-path')
            for edge in scene.walk():
                if "data-dia-edge" not in edge.attrs:
                    continue
                spec = edge.attrs["data-dia-edge"]
                m = re.fullmatch(r"(.+?)->(.+)", spec)
                if not m:
                    add("error", "scene/edge-format", edge.path(), f'data-dia-edge="{spec}" is not "a->b"')
                else:
                    for end in (m.group(1), m.group(2)):
                        if end not in ids:
                            add("error", "scene/edge-endpoint", edge.path(),
                                f'edge endpoint "{end}" names no node in this scene')
                route = edge.attrs.get("data-route")
                if route is not None and route not in EDGE_ROUTES:
                    add("error", "scene/edge-route", edge.path(), f'unknown route "{route}"')
                anchors = edge.attrs.get("data-anchors")
                if anchors is not None and not all(s.strip() in ANCHOR_SIDES for s in anchors.split(",")):
                    add("error", "scene/edge-anchors", edge.path(),
                        f'data-anchors="{anchors}" — sides are N,S,E,W,auto')
                via = edge.attrs.get("data-via")
                if via is not None and not re.fullmatch(r"\s*-?[\d.]+\s*,\s*-?[\d.]+\s*", via):
                    add("error", "scene/edge-via", edge.path(),
                        f'data-via="{via}" is not an "x,y" waypoint')

    return {
        "ok": not any(f["level"] == "error" for f in findings),
        "findings": findings,
        "slideCount": len(slides),
        "version": version,
    }


def _finite(v: str) -> bool:
    try:
        float(v)
        return True
    except ValueError:
        return False
