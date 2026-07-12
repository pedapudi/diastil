---
name: dia-scenes
description: Create and edit diastil scene diagrams — nodes, edges, anchors, routing, labels, build steps — both as SVG markup and through the direct-manipulation editor. Use when drawing architecture/flow diagrams in a deck, editing diagram geometry, or lifting a raw SVG into the scene vocabulary.
---

# Scenes — diagrams in the dialect

A scene is SVG plus semantics in attributes. **Author the attributes;
the runtime computes the geometry**: shapes are (re)built from
`data-x/y/w/h`, labels are centered in their shapes, and edge paths are
routed — move a node and its edges reroute. Never hand-write `d`
attributes on edge paths; they're derived artifacts.

## Vocabulary

```html
<svg class="dia-scene" viewBox="0 0 340 250" role="img" aria-label="pipeline">
  <g data-dia-node="original" data-shape="rounded" data-x="20" data-y="18" data-w="120" data-h="40">
    <text class="dia-node-label">original.html</text>
  </g>
  <g data-dia-node="execute" data-shape="rounded" data-x="200" data-y="18" data-w="120" data-h="40">
    <text class="dia-node-label">execute</text>
  </g>
  <g data-dia-edge="original->execute" data-anchors="E,W" data-route="straight" data-label="compare"></g>
</svg>
```

| attribute | values | notes |
| --- | --- | --- |
| `data-dia-node` | unique id within the scene | ids are what edges reference |
| `data-shape` | `rect` `rounded` `pill` `ellipse` `diamond` `cylinder` `hex` `parallelogram` `triangle` `cloud` `note` `path` | default `rounded` |
| `data-path` | SVG path data, 100×100-normalized | shape `path` only: freeform outline (ring, brace, star, blob), scaled into the node box on render |
| `data-x/y/w/h` | numbers in viewBox units | position + size; w/h default 120×40 |
| `data-dia-edge` | `from->to` | both ends must name nodes in this scene |
| `data-anchors` | two of `N S E W auto`, comma-separated | from-side, to-side; `auto` picks facing sides |
| `data-route` | `straight` `ortho` `curve` | default `ortho` |
| `data-label` / `text.dia-edge-label` | edge label | sits at the path's midpoint |
| `data-dia-emphasis` | any value | accent-stroked highlight |
| `data-dia-step` | positive int | reveal order in present mode |

Orthogonal routing avoids other nodes automatically (A* around node rects
inflated 12px, bend-penalized) and falls back to a calm 1–2 bend route
when boxed in. The attribute format is routing-algorithm-neutral — only
the emitted path changes between versions.

Styling comes from the theme (`.dia-node-shape`, `.dia-node-label`,
`.dia-edge-path`, `.dia-edge-label` read `--dia-*` tokens); don't inline
colors on scene elements.

## Shapes and styling

A **shape** (circle, square, …) is a node without a label — same element,
same abilities (drag, resize, connect, undo), no text until you
double-click and add some. **Per-shape/per-edge styling** is scoped custom
properties on the group, always as token references:

```html
<g data-dia-node="disc" data-shape="ellipse" data-x="34" data-y="36" data-w="88" data-h="88"
   style="--dia-node-fill: var(--dia-rule); --dia-node-stroke: var(--dia-accent); --dia-node-stroke-w: 2.5">
  <text class="dia-node-label"></text>
</g>
<g data-dia-edge="a->b" style="--dia-edge-stroke: var(--dia-ink-soft); --dia-edge-w: 2">…</g>
```

Properties: `--dia-node-fill` · `--dia-node-stroke` · `--dia-node-stroke-w`
· `--dia-node-ink` (label) · `--dia-edge-stroke` · `--dia-edge-w` ·
`--dia-edge-ink` (label). Theme rules consume them with token fallbacks,
so unset = theme default.

## Editing in the editor

Enter a scene by double-clicking into the diagram (deep work is best on
the stage altitude). Direct manipulation — all pure DOM mutation through
the op log, no inference:

- drag nodes → live edge rerouting; snapping to node edges/centers and the
  grid; smart guides for equal spacing/aligned centers
- resize via corner handles; hold `⇧` to lock the aspect (true circles/squares)
- select a slide → `+ diagram` in the inspector adds a FULL-SLIDE diagram
  layer (`svg.dia-scene.dia-scene-full`, viewBox 0 0 1280 720, absolutely
  positioned over the whole slide): shapes/nodes/edges/strokes can land
  anywhere, layered with the text. Idle clicks pass through to the text
  beneath; painted content stays interactive; selecting the slide (or the
  scene background) puts the creation tools in the INSPECTOR rail
  (`+ node · + circle · + square · draw · make diagram`). Floating
  toolbars appear only for concrete selections (node/edge/free element)
  and disappear with them
- node toolbar rows: `fill` / `line` / `w` — per-shape color and weight as
  token-scoped properties; edge toolbar rows: `ink` / `w`
- edges: drag from a selected node's anchor dot to start one; while aiming,
  the candidate node shows its anchor dots — **drop on a dot to pin the
  side the edge lands on** (else auto); endpoint handles retarget the same way
- **free elements**: ANY other svg content — imported art, drawn strokes,
  raw paths/text/groups — is selectable (moves as its top-level group),
  draggable, scalable via handles (⇧ = uniform), nudgeable, deletable,
  restylable (fill/line/w rows set style properties), and z-orderable
  (front/back). Plain svgs in slides get the same treatment; 'make diagram'
  opts one into the node/edge vocabulary
- **drawing**: with the scene background selected, toggle `line` or `pen`
  in the toolbar — strokes commit as token-styled `path.dia-draw` elements
  (one op each); Esc exits the tool
- double-click a node → edit its label in place
- double-click empty scene space → create a node with the label editor open
- box-select (marquee), group operations, align/distribute via the
  contextual toolbar; keyboard nudge (arrows, with modifiers for bigger
  steps); z-order controls
- `⌘Z`/`⇧⌘Z` — every scene edit is one undo step

## Getting diagrams INTO scenes

- Hand-author the markup above (fastest for agents).
- `createNode`/`createEdge` in `src/scene/route.ts` for programmatic use.
- Lift a raw `<svg>` (draw.io/graphviz/d3 output) via the service's
  `lift-diagram` skill — in import review the "lift diagrams" button lifts
  every static SVG on the slide; each lift is profile-validated and
  fidelity-verified or discarded. A diagram that won't lift faithfully
  stays a plain figure (or island) you can lift manually later.
