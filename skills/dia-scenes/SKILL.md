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
| `data-shape` | `rect` `rounded` `pill` `ellipse` `diamond` | default `rounded` |
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

## Editing in the editor

Enter a scene by double-clicking into the diagram (deep work is best on
the stage altitude). Direct manipulation — all pure DOM mutation through
the op log, no inference:

- drag nodes → live edge rerouting; snapping to node edges/centers and the
  grid; smart guides for equal spacing/aligned centers
- connector handles on hover → drag to retarget an edge's anchor
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
