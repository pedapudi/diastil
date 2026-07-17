---
name: dia-artwork
description: Draw and improve SVG figures and pictorial artwork for diastil decks — the line-art register (dandelion economy), reference recipes, the full-color pictorial style and canon, palette/setting variety rules, and the theme→analogy→draw→improve iteration loop. Use whenever creating a figure, illustrating a slide, or upgrading a deck's imagery; dia-authoring covers the surrounding dialect.
---

# Drawing deck artwork

Figures carry a diastil deck's argument; prose supports them. This
skill is the CRAFT — what to draw, in what register, and how to
iterate it. The dialect around the figure (roles, tokens, layout) is
`dia-authoring`; editable node/edge diagrams are `dia-scenes`.

The house bias is STRONG: a deck should be a sequence of figures with
supporting prose, not a sequence of paragraphs. Whenever a slide states
a relationship, a flow, a comparison, a scale, a timeline, or an
architecture, DRAW THE CLAIM — a quadrant chart, a to-scale bar, a
pipeline, an annotated sketch — and let the text argue around it. A
text-only slide is the exception that must earn its plainness; when in
doubt, add the figure. The working quota: roughly one figure per
content slide, planned before the prose.

The register's canonical shape (ambit's dandelion): a dashed
`var(--dia-rule)` envelope circle; a seed head of fine radiating
`var(--dia-ink-faint)` lines (stroke-width 0.9, opacity alternating
.5/.85) tipped with small dots; one organic stem (a gentle cubic curve,
stroke-width 1.6); and the ONLY `var(--dia-accent)` marks are the three
seeds drifting away — the escaping few are what the slide argues. Two
small mono labels name the faint structure and the accented payload.
Build every figure with that economy: faint structure, one accented
meaning, labels, caption.

Reference pieces in the same register — pick the metaphor that matches
the slide's claim and build it the same way (all strokes
`var(--dia-ink-faint)` ≈0.9–1.2 with opacity layered .4–.85, guides
dashed `var(--dia-rule)`, ONE accented element):

- **contour map** (where the difficulty concentrates): nested wobbly
  closed curves like elevation lines, spacing tightening toward one
  basin; only the innermost ring is accent; a leader tick names the
  basin.
- **constellation** (a few points matter among many): 20–30 faint dots
  of varied radius/opacity scattered with intent; the accent is one
  thin polyline joining the 4–5 that form the shape, each joined dot
  slightly larger; the rest stay noise.
- **sonar sweep** (search and the one hit): concentric dashed rings; a
  faint wedge of past sweep (low-opacity fill); blips as faint dots
  aging with opacity; ONE accent blip where the claim lands.
- **braided river** (many paths, one arrives): several faint curves
  branching and rejoining left to right; one continuous accent thread
  runs the whole way; distributaries thin and fade before the edge.
- **orbit and comet** (routine vs the exception): two or three faint
  dashed ellipses sharing a focus; small faint bodies on them; one
  accent comet on a hyperbolic path crossing the system, tail dotted
  with fading opacity.

These are metaphor seeds, not a fixed menu — draw the deck's OWN
subject with the same economy whenever a truer image exists.

Full-color pictorial pieces carry the same discipline in a richer
palette. The style (in this repo, every piece is drawn in
`docs/register-reference.html`): flat faceted polygon planes with a
lit and a shadow face, recession by atmosphere or lightness, angular
white facet glints, no gloss or 3-D shading or blur — and ONE dotted
accent path or beam with a dot terminal, recolored per ground for
contrast, that is the argument. Words inside stay in tokens. Two
variety rules for a deck's pictorial set:

- **each piece owns a palette family** (dawn, twilight, sandstone,
  slate-green, …) — never several figures in one dominant hue;
- **each piece owns a setting** (a landscape, an object study, an
  interior, a machine, …) — never nature-with-a-sun on repeat.

The canon to imitate: sherpa (a dawn summit, the dotted route as the
argument), pensieve (a twilight pool as an object study, one amber
memory surfacing), corpus (an archive wall interior, one drawer out
on a blue beam), stream (an industrial works, jittered lanes in, one
ordered lane out).

### Iterate the imagery — 3–4 passes, not one

Figures are drafted, then improved. Plan on three to four passes over
the WHOLE deck before calling it done:

1. **theme pass** — read the finished prose top to bottom; write down
   the deck's recurring themes and the one metaphor family that could
   run through it (a route up a mountain, a river system, a survey of
   a sky). Note, per slide, the single claim worth drawing.
2. **analogy pass** — assign each content slide a pictorial analogy:
   the deck's own subject first, a reference piece only as fallback.
   If two slides share a metaphor, one of them needs a truer image.
3. **draw pass** — build every figure to the register: faint
   structure, dashed guides, one accented element, cartographer
   labels, a takeaway caption.
4. **improve pass** — render or preview each slide and upgrade what
   you see: sharpen generic metaphors into subject-drawn ones, delete
   marks that don't earn their place, confirm the accent is spent
   exactly once, fix label collisions, and promote the deck's
   strongest figure to the cover. Repeat this pass until it produces
   no changes — usually once or twice more.

A recurring metaphor family is the deck's visual identity: let it
progress across slides (the route gains camps, the river gains
tributaries) instead of resetting on every slide.

- Always set a `viewBox`; size through the figure, not pixel
  width/height on the svg. Self-contained only: no external hrefs, no
  scripts, no `<foreignObject>`. Column figures ≈ 430×300; full-width
  ≈ 1180×470.
- The default register is EVOCATIVE LINE ART in deck tokens, exactly
  as in the example above: hairline strokes
  ≈0.9–1.6, `var(--dia-ink-faint)` structure, layered opacity for
  depth, dashed envelopes, organic curves — and the ACCENT spent on
  the one element that carries the meaning. Draw a metaphor from the
  subject, not a generic decoration.
- Richer color beyond the theme tokens stays licensed when the
  subject wants it (real palettes, layered fills, local `<defs>`
  gradients, sitting well on `var(--dia-paper)`) — reach for it
  because the picture needs it, not because a figure exists.
- Reserve the SVG for real visual art, not boxed-up text: repeating
  paragraph copy inside small `<rect>` cards is textual crowding and
  makes a slide feel over-stuffed. Keep prose in a `.panel` on one side
  of a `dia-columns` layout and let the figure carry a metaphor drawn
  from the subject (a contour map, converging orbs, a sonar sweep, a
  constellation) rather than restating the words.
- The boundary: words and labels INSIDE artwork still read tokens
  (`var(--dia-ink)`, `var(--dia-face-label)`), so they retheme with the
  deck; and diagram scenes (`svg.dia-scene`, see `dia-scenes`) stay
  fully token-bound — they are structure, not pictures.
- A `svg.dia-scene` must render without JS: the `data-dia-*` attributes
  are the TRUTH the editor edits and re-derives from, but the file also
  carries the derived rendering — node shapes (`path.dia-node-shape` or
  equivalent geometry), positioned `<text>` labels, and edge
  `path.dia-edge-path` with a plain anchor-to-anchor `d` — so any HTML
  preview shows the same diagram the editor does, not an empty frame.
  Write the simple rendering and trust the editor to re-route on edit;
  never treat a hand-written `d` as the source of truth.

What makes a figure BEAUTIFUL is craft, not decoration (in this repo,
`examples/what-is-dia.html` shows every rule below in use):

- **the figure carries the argument** — draw quantities to scale, put
  the punchline in the geometry, and say so ("drawn to scale");
- **every mark earns its place** — hairline strokes, one accent spent
  on the signal, no chartjunk; emphasis comes from weight and color
  contrast, never from clutter;
- **label like a cartographer** — small mono labels, staggered rows
  with leader ticks when they'd collide, a legend the moment two
  channels appear, axis endpoints named instead of arrowheads into
  nothing;
- **give containers content** — miniature glyphs (text lines, tiny
  pictures) inside boxes read better than empty rectangles;
- **arrows land** — every arrowhead's apex touches the thing it points
  at, connectors never cut through boxes (in this repo,
  `scripts/figlint.mjs` checks exactly this — run it when available);
- **caption the takeaway** — a `figcaption.dia-caption` stating what
  the reader should see, plus an `aria-label` naming the figure.

One pattern the language does NOT contain: **left-hand rail
highlights**. Never put an accent stripe on a panel's left edge — no
`border-left` callouts, quote bars, or note boxes. Panels are full
hairline borders with an accent panel label; emphasis comes from the
label and the content.
