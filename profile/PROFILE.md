# The diastil dialect profile — v1

The dialect is HTML: a closed, enumerable profile of it. A deck either
validates against this profile, or the validator (`src/model/validate.ts`,
`dia validate`) says exactly which regions are out-of-profile and why.
Rule ids referenced below appear verbatim in validator findings.

Findings have two levels. **error** — the construct breaks the dialect
contract (the editor cannot promise full direct manipulation over it).
**advisory** — in-dialect but low-structure; editing works, quality of
token-level operations degrades.

## 1. Document frame

| rule | level | contract |
| --- | --- | --- |
| `frame/version` | error | `<html data-dia-version="…">` present |
| `frame/theme` | error | exactly one `<style id="dia-theme">` |
| `frame/theme-tokens` | advisory | the theme defines `--dia-*` custom properties |
| `frame/runtime` | advisory | one `<script id="dia-runtime">` (the embedded runtime; absent in never-saved decks) |
| `frame/slides` | error | at least one `<section class="dia-slide">` |
| `frame/stray-content` | error | `<body>` children are only slides, styles, and the runtime script |

## 2. Slide content

Inside a slide, everything is dialect unless it sits under a
`[data-dia-island]` region (§6), which is exempt from all content rules.

| rule | level | contract |
| --- | --- | --- |
| `content/script` | error | no `<script>` in dialect regions — behavior is data (§5) |
| `content/event-handler` | error | no inline `on*=` handlers |
| `content/embed` | error | no `iframe` / `object` / `embed` outside islands |
| `content/unknown-dia-attr` | error | every `data-dia-*` attribute is in the vocabulary (§7) |
| `content/editor-artifact` | error | no editor session attrs (`data-dia-id`, `contenteditable`, `data-dia-selected`, …) in a saved document |
| `content/inline-color` | advisory | inline `style` colors should read tokens (`var(--dia-…)`), not literals |

Text roles (`dia-title`, `dia-kicker`, `dia-body`, `dia-caption`,
`dia-footnote`) and layout containers (`dia-stack`, `dia-columns`,
`dia-split`, `dia-cover`, `dia-figure`) are class conventions bound to
theme rules; unknown classes are permitted (they are deck-owned styling
hooks) and are not flagged.

## 3. Scenes (diagrams)

A scene is `<svg class="dia-scene" viewBox="…">` containing node and edge
groups. The runtime and editor compute all geometry from attributes; the
child shapes/paths are derived artifacts.

```html
<g data-dia-node="id" data-shape="rounded" data-x="20" data-y="18" data-w="120" data-h="40">
  <rect class="dia-node-shape"/><text class="dia-node-label">…</text>
</g>
<g data-dia-edge="a->b" data-anchors="E,W" data-route="ortho" data-label="…">
  <path class="dia-edge-path"/><text class="dia-edge-label">…</text>
</g>
```

| rule | level | contract |
| --- | --- | --- |
| `scene/node-id-duplicate` | error | node ids unique within a scene |
| `scene/node-geometry` | error | `data-x/y/w/h`, when present, are finite numbers |
| `scene/node-shape` | error | `data-shape` ∈ rect · rounded · pill · ellipse · diamond · cylinder · hex · parallelogram · triangle · cloud · note · path |
| `scene/node-path` | error | shape `path` carries `data-path` (SVG path data in a 100×100-normalized space, scaled into the node box) |
| `scene/edge-format` | error | `data-dia-edge` matches `a->b` |
| `scene/edge-endpoint` | error | both edge endpoints name nodes in the same scene |
| `scene/edge-route` | error | `data-route` ∈ straight · ortho · curve |
| `scene/edge-anchors` | error | `data-anchors` sides ∈ N · S · E · W · auto |

**Shapes** are label-less nodes — a circle is an `ellipse` node with equal
sides, a square a `rect`; nothing further is required. The parametric
shapes (`cylinder`, `hex`, `parallelogram`, `triangle`, `cloud`, `note`)
derive their outline from the box like `diamond` does. Shape `path` is
the freeform backstop: the outline lives in `data-path` as SVG path data
in a 100×100-normalized coordinate space and is scaled into the node box
on render — any vector mark (annotation ring, brace, star, blob) becomes
a movable, resizable node. Scenes may also contain verbatim SVG children
(plain `<path>`, `<text>`, …) that are neither nodes nor edges; they are
preserved as-is and are not validated beyond the general content rules.

**Per-node / per-edge styling** is expressed as scoped custom properties on
the group element, consumed by theme rules with token fallbacks:

```html
<g data-dia-node="disc" data-shape="ellipse" …
   style="--dia-node-fill: var(--dia-rule); --dia-node-stroke-w: 2.5">
```

Recognized properties: `--dia-node-fill`, `--dia-node-stroke`,
`--dia-node-stroke-w`, `--dia-node-ink` (label) · `--dia-edge-stroke`,
`--dia-edge-w`, `--dia-edge-ink` (label). Values should be token
references (`var(--dia-…)`); literals fall under `content/inline-color`
advisory like anywhere else. Decks written before these rules existed
gain the consuming CSS automatically the first time the editor styles a
scene.

## 4. Media

Figures carry crop and focal point as style (`object-fit`,
`object-position`, or `--dia-focal-*`) so photosetting is attribute
editing. No rule enforces this shape; a plain `<img>` is in-dialect.

## 5. Behavior is data

| rule | level | contract |
| --- | --- | --- |
| `behavior/step` | error | `data-dia-step` is a positive integer (build order) |

`data-dia-emphasis` (highlight linkage) and `data-dia-island` take any
value including empty.

## 6. Islands

`data-dia-island` marks a region preserved verbatim — original markup,
styles, and scripts intact. Islands get coarse editing only (move,
resize, replace, delete) and are exempt from every content rule. Nothing
inside an island is validated.

## 7. Attribute vocabulary (persisted)

`data-dia-version` (html) · `data-dia-node`, `data-dia-edge`,
`data-shape`, `data-path`, `data-x`, `data-y`, `data-w`, `data-h`,
`data-anchors`, `data-route`, `data-label` (scene) · `data-dia-step`,
`data-dia-emphasis` (behavior) · `data-dia-island` (islands).

Session-only attributes (`data-dia-id`, `data-dia-selected`,
`data-dia-current`, `data-dia-step-shown`, `contenteditable`,
`spellcheck`) are stripped by the serializer and are `error`-level if
found in a saved document.

## 8. Round-trip guarantee

`serialize(parse(deck))` is byte-stable: attribute order untouched,
2-space top-level layout, editor artifacts stripped. The golden tests in
`src/model/*.test.ts` hold this line.
