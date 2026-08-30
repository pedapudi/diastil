---
name: dia-artwork
description: Draw and improve SVG figures and pictorial artwork for diastil decks — the line-art register (dandelion economy), reference recipes, animation craft (SMIL motion in the register), the full-color pictorial style and canon, palette/setting variety rules, and the theme→analogy→draw→improve iteration loop. Use whenever creating a figure, illustrating or animating a slide, or upgrading a deck's imagery; dia-authoring covers the surrounding dialect and color schemes.
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

## Draw the claim in its own kind

A metaphor is one way to draw a claim, not the way. Before choosing an
image, name what the slide asserts, because the kind decides the register:

- **a mechanism, a sequence, a structure, an architecture, a protocol,
  a data path** — draw the THING, not a picture of how it feels. An
  annotated technical drawing: the real parts in their real
  arrangement, each named object carrying its object mark (below), the
  accent on the step or path the slide is about. A request crossing
  four services is drawn as four services; a metaphor here costs the
  reader the detail they came for.
- **a scale, a proportion, a distribution, a rate** — draw it to
  scale and say so. Quantity is its own picture.
- **an exception, a trajectory, a search, a tradeoff, a transition** —
  these are where a metaphor is often TRUER than the literal thing,
  because the claim is about shape rather than parts. The seeds above
  live here.
- **the deck's argument as a whole** — the cover and the section
  openers are where a whole-figure metaphor belongs, and where the
  recurring family should be established.

So a technical deck is mostly technical drawings with a metaphor at its
covers and its turns, not a metaphor per slide. When both would work,
the technical drawing wins on a slide the reader will act on, and the
metaphor wins on a slide they must remember.

## Object marks — the small unit

An **object mark** is a ~24-unit line drawing that stands for ONE named
noun and sits inside a box, beside a label, or at a node of a diagram.
It is not an illustration and not an icon set: it is the same hairline
register as the figure around it, at the smallest size that still
reads.

Marks are the highest-leverage thing in a technical figure. They
satisfy the rule below — *give containers content* — and once the same
mark appears on two slides the reader carries the meaning across the
deck without a legend.

Construction:

- **24×24 unit box**, drawn on a 2-unit inner margin so marks of
  different shapes optically match.
- **stroke-width 1.5 in the mark's own box**, scaled with the mark —
  which lands near the figure's hairline weight once placed. Never
  filled: a filled mark reads as an accent and the figure only has one.
- **`var(--dia-ink-faint)` like the rest of the structure.** A mark
  turns `var(--dia-accent)` only when its object is the one the slide
  argues, and then it is the figure's single accent.
- **three to six strokes.** A mark that needs more detail to be
  recognized is the wrong mark — pick a blunter noun.
- **a mark earns its place by repeating.** One appearance is
  decoration; the second is where it starts paying. If a noun appears
  once in the deck, label it and move on.

A seed vocabulary — the recurring nouns, and the drawing each resolves
to. Derive new ones the same way: take the noun's most distinctive
silhouette and cut it to five strokes.

| noun | mark |
| --- | --- |
| a pool of like things | three rounded rects, stacked with a 3-unit offset |
| a single instance | one rounded rect with a dot at its top-left |
| an identity, a permission | a shield outline with one dot at its centre |
| a rule, a policy | two circles joined by a short line, one open one dotted |
| a store, a database | a cylinder: an ellipse over two verticals and a base arc |
| a queue, a buffer | four short parallel bars of equal length, one gap |
| a stream | two long parallel curves with three ticks crossing them |
| a metadata or lookup service | a hub dot with three spokes to open dots |
| a counter, a metric | three bars of falling height on a baseline |
| a document, a status report | a page outline with a folded top-right corner |
| a scheduler, a clock | a circle with two hands at 10 and 2 |
| a key, a secret | a circle with a toothed stem |
| a boundary, a network edge | a dashed vertical with a small gate gap |
| a cache | a rounded rect with a second offset behind it and a lightning tick |
| a build, an artifact | a cube in three faces, isometric |
| a person, a caller | a circle over a shallow arc |

Reuse them rather than redrawing them. `<defs><symbol id="…"
viewBox="0 0 24 24">` once near the top of the figure — or in the first
figure of the deck — and `<use href="#…" x y width height>` at every
occurrence. Both are ordinary inline SVG: self-contained, no external
href, and the validator treats them like any other figure content. A
twenty-slide deck that copy-pastes the same twelve paths four times
each is carrying three quarters of its path data for nothing, and the
copies drift.

```html
<svg viewBox="0 0 430 300" role="img" aria-label="…">
  <defs>
    <symbol id="m-pool" viewBox="0 0 24 24">
      <g fill="none" stroke="currentColor" stroke-width="1.5">
        <rect x="2" y="8" width="14" height="10" rx="2"/>
        <path d="M5 8V5h14v10h-3"/>
        <path d="M8 5V2h14v10h-3"/>
      </g>
    </symbol>
  </defs>
  <g color="var(--dia-ink-faint)"><use href="#m-pool" x="40" y="60" width="24" height="24"/></g>
  <g color="var(--dia-accent)"><use href="#m-pool" x="40" y="140" width="24" height="24"/></g>
</svg>
```

`currentColor` inside the symbol and `color` on the placing `<g>` is
what lets one definition be faint in most places and accented in the
one place that argues — without a second copy of the path data.

## Animating figures

Animation follows the same economy as ink: **motion is the accent's
privilege**. The faint structure holds still; what moves is the one
accented element that carries the claim — the seeds drift, the comet
crosses, the thread flows. One moving idea per figure, never a busy
scene. A figure should breathe, not perform.

The mechanics — self-contained, script-free, valid dialect:

- **SMIL children** are the default: `<animate>`, `<animateTransform>`,
  `<animateMotion>` (with `<mpath>` to follow a drawn path), `<set>`.
  They live inside the element they animate and survive every
  round-trip byte-for-byte. `@keyframes` in a `<style>` embedded IN the
  svg are equally legal; never external CSS, never scripts.
- **The resting frame IS the figure.** Thumbnails, prints, and `.pptx`
  export rasterize a single frame — so every `values` list starts and
  ends on the complete pose (`values="0 0; 0 -4; 0 0"`), and a
  draw-in reveal must settle into the finished drawing, never leave it
  half-made.
- **Slow and quiet**: cycles of 4–14s, `calcMode="spline"` or
  palindromic `values` for seamless loops, amplitudes of 2–6 viewBox
  units. Stagger a family of marks with negative `begin` offsets
  (`begin="-3s"`) so nothing marches in step.
- **Reduced motion**: keyframe-driven motion goes inside
  `@media (prefers-reduced-motion: no-preference)`; SMIL is exempt
  only while it stays a gentle drift at the amplitudes above.
- **Never animate**: text or labels (they are for reading), color
  cycles, spins on symbols, anything bouncing. Easing is always gentle
  (`keySplines=".4 0 .6 1"` or ease-in-out).

Recipes in the register — each reference piece has one natural motion,
already implied by its metaphor:

- **dandelion**: the three accent seeds drift a few units along their
  flight direction and ease back, opacities breathing, each on its own
  period (7s / 9s / 11s) so the drift never synchronizes; the seed
  head and stem are still.
- **sonar sweep**: one accent radius line rotates slowly about the
  center (`animateTransform type="rotate"`, 12s linear loop); the hit
  blip pulses opacity `1;.4;1` on its own 5s; rings stay fixed.
- **orbit and comet**: the comet runs its hyperbolic path once per
  ~12s via `animateMotion` + `<mpath>`, tail dots fading behind it;
  the orbiting bodies creep a few degrees, no more.
- **braided river**: the accent thread flows — a long
  `stroke-dasharray` with an animated `stroke-dashoffset` loop reads
  as current; distributaries stay still.
- **constellation**: the joined accent dots twinkle gently (r or
  opacity ±20%, staggered); the noise dots do not.
- **contour map**: the innermost accent ring breathes (r ±1.5, 8s);
  everything else is geology and does not move.

The improve pass applies to motion too: preview the slide, and delete
any animation you stop noticing FOR the figure rather than noticing
the figure through — motion that decorates instead of arguing is
chartjunk with a clock.

Full-color pictorial pieces carry the same discipline in a richer
palette. The style (in this repo, every piece is drawn in
`docs/register-reference.html`): flat faceted polygon planes with a
lit and a shadow face, recession by atmosphere or lightness, angular
white facet glints, no gloss or 3-D shading or blur — and ONE accent
that is the argument, recolored per ground for contrast. Words inside
stay in tokens.

**The accent is not always a path.** A dotted route with a dot terminal
is one device and the most over-used: a set where every picture has a
line pointing at something reads as diagrammed rather than drawn, and
the line usually restates what the composition already says. Spend the
accent on whatever carries the claim — the one lit face among shadowed
ones, the one object at a different scale, the single filled form among
outlines, a gap where the eye expects continuation, the one warm
element in a cool ground, a horizon or a threshold the composition is
built around. Draw a route only when the claim IS a route, and draw a
leader into a picture only when the picture is genuinely ambiguous
without it — a picture that needs a line to be understood usually needs
a better composition instead.

Two variety rules for a deck's pictorial set:

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
2. **kind pass** — for each slide, name what the claim IS (mechanism,
   scale, exception, argument — see *Draw the claim in its own kind*)
   and let that pick the register. Mechanisms and structures get
   technical drawings with object marks; shapes and exceptions get an
   analogy, the deck's own subject first and a reference piece only as
   fallback; the cover and the section openers carry the recurring
   metaphor family. If two slides share a metaphor, one of them needs a
   truer image — and if every slide has one, most of them are wrong.
3. **draw pass** — build every figure to the register: faint
   structure, dashed guides, one accented element, cartographer
   labels, a takeaway caption. Every named object in a technical
   drawing gets its object mark, defined once as a `<symbol>` and
   `<use>`d wherever the noun recurs.
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
- **Figures inherit the deck's color scheme through tokens** — the
  deck is NOT always paper-cream; `dia-authoring` carries eight ready
  schemes, light and dark, and the deck's author picks one to fit the
  subject. Token-bound line art rethemes for free; a pictorial
  piece's own palette must be checked against the deck's actual
  `--dia-paper` (a dawn palette that sings on cream can die on
  near-black — shift the family or add a grounding plane rather than
  fighting the paper).
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
