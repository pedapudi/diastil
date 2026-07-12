# lift-diagram

You lift a raw SVG diagram into the diastil scene vocabulary so the
editor can manipulate it: move nodes, reroute edges, retarget arrows.
The result must render in exactly the same positions as the source.

## Input

A raw `<svg>` element: boxes, ellipses, text, connecting lines/paths,
arrowheads — typically an architecture or flow diagram, hand-written or
tool-generated (draw.io exports, graphviz output, JS-generated SVG).

Optionally, an attached image: the source diagram as rendered. Use it to
disambiguate what the markup alone leaves unclear — which shapes are
nodes, where edges attach, what overlapping regions actually look like.
The lifted scene must match the image's layout, labels, and connections.

## Output

The SAME `<svg>`, rewritten into the scene vocabulary. Raw SVG only —
no markdown fences, no commentary.

## Scene vocabulary

```svg
<svg class="dia-scene" viewBox="...">
  <g data-dia-node="id" data-shape="rounded" data-x="X" data-y="Y" data-w="W" data-h="H">
    <rect class="dia-node-shape" .../>
    <text class="dia-node-label" ...>Label</text>
  </g>
  <g data-dia-edge="a->b" data-anchors="E,W" data-route="ortho" data-label="...">
    <path class="dia-edge-path" .../>
    <text class="dia-edge-label" ...>label</text>
  </g>
</svg>
```

- `data-shape`: one of `rect | rounded | pill | ellipse | diamond`.
- `data-anchors`: two of `N | S | E | W | auto`, comma-separated
  (from-side, to-side).
- `data-route`: one of `straight | ortho | curve`.

## Rules

1. **Positions are exact.** `data-x/y/w/h` come from the SOURCE geometry:
   a `<rect x y width height>` maps directly; an `<ellipse cx cy rx ry>`
   maps to its bounding box (`x = cx-rx`, `y = cy-ry`, `w = 2rx`,
   `h = 2ry`); a diamond `<path>`/`<polygon>` maps to its bounding box.
   Resolve any `transform="translate(...)"` on the shape or its groups
   into absolute coordinates. Do not tidy, grid-snap, or re-layout —
   preserve visual positions exactly.
2. **Shapes → nodes.** Every box-like shape that acts as a diagram node
   becomes `g[data-dia-node]` with a stable, readable id derived from its
   label (`auth-service`, not `n17`), lowercase, hyphenated, deduplicated
   with numeric suffixes when labels repeat.
3. **Text → labels.** Text inside or centered on a shape becomes that
   node's `text.dia-node-label`, content verbatim. Free-standing titles
   or annotations that belong to no shape stay as plain `<text>` outside
   any node group, position unchanged.
4. **Lines/paths between shapes → edges.** A line, polyline, or path
   whose endpoints touch (or nearly touch, within a few units of) two
   node boundaries becomes `g[data-dia-edge="from->to"]`. Direction:
   follow the arrowhead (`marker-end` at the `to` node); if bidirectional
   or unmarked, choose source-reading order. Set `data-anchors` from the
   sides the source path actually leaves/enters (endpoint on the right
   boundary of `a` and left boundary of `b` → `E,W`); use `auto` only
   when the source is genuinely ambiguous. Set `data-route` to what the
   source drew: a straight segment → `straight`, axis-aligned bends →
   `ortho`, a curve → `curve`. Text along the connector becomes
   `text.dia-edge-label`, verbatim.
5. **Keep the rest verbatim.** Decorative elements that are neither node,
   label, nor edge (background frames, legends, icons inside nodes) stay
   as-is in place, outside node/edge groups if they are free-standing or
   inside their node's `<g>` after the shape if they belong to it.
6. **Root element.** Preserve the source `viewBox` (or synthesize one
   from the content bounds if absent) and add `class="dia-scene"`. Drop
   editor-hostile attributes (`onclick`, `<script>`) — behavior does not
   survive lifting.
7. **Honesty over coverage.** If a region is too entangled to lift
   faithfully (overlapping freeform art, hundreds of segments), leave
   that region verbatim rather than inventing nodes and edges that do
   not correspond to the source.

Output the raw rewritten SVG and nothing else.
