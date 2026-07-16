# the diastil house style

The defaults dia ships with — what a fresh install looks like, what the
scaffold produces, and the aesthetic the copilot is instructed toward.
Everything here is a *default*, never a lock: every value is a theme
token or a preference the user can change in one gesture.

## light first

- The editor chrome defaults to the **paper** theme: warm paper
  (`#F2EEDE`), near-black ink, restrained functional accents. Dark
  themes stay one click away in the topbar picker and are remembered
  per machine.
- Scaffolded and demo decks are paper-and-ink: light `--dia-paper`
  (`#fbfaf6`), dark `--dia-ink`, one accent. A deck should read like a
  well-set document before it reads like a screen.

## the zicato role split

Type and color carry *roles*, not decoration (see docs/BRAND.md for the
wordmark rules):

- **sans for prose and controls, mono only for data** — code, paths,
  numbers, kbd, kickers. The default type preset is T9 (Source Sans 3 +
  Source Code Pro), not an all-mono face.
- **colors are role tokens** — paper, ink (3 weights), accent, rule,
  good/bad. Chrome and slide text never hard-code a hue; they read
  `var(--dia-*)`. Imported decks bind their colors to the same tokens.

## beautiful svg — the dandelion register

The house prefers **drawn, evocative svg** — lots of it. The exemplars
are ambit's title-slide dandelion and every figure in
`examples/what-is-dia.html`:

- **fine line art in deck tokens** — hairline strokes (≈0.9–1.6),
  `var(--dia-ink-faint)` structure, layered opacity for depth, dashed
  envelopes, organic curves; the drawing feels made by hand, not
  emitted by a chart library;
- **the accent is spent on the meaning** — in the dandelion, every
  spoke is faint ink and only the seeds drifting away carry the accent:
  the color IS the argument. One accented element per figure, earned;
- **metaphor from the subject** — the best figures draw the idea
  (seeds losing their room, a prompt distilled to scale), not a generic
  decoration;
- **cartographer labeling** — small mono labels, leader ticks, legends
  when two channels appear, a `figcaption` stating the takeaway.

Richer color beyond the theme tokens stays **licensed** for
illustrations whose subject wants it (real palettes, layered fills,
local `<defs>` gradients — sitting well on `var(--dia-paper)`), but the
dandelion register is the default: reach for saturated color because
the picture needs it, not because a figure exists.

The boundary that keeps this coherent:

- **words and chrome inside artwork** always read tokens
  (`var(--dia-ink)`, `var(--dia-face-label)`), so labels retheme;
- **diagram scenes** (`svg.dia-scene` nodes/edges) stay fully
  token-bound — they are document structure, not pictures;
- **conversion is exempt in the other direction**: the import pipeline
  reproduces the source's colors faithfully (fidelity outranks house
  taste); the house register applies to artwork dia *generates*.

## what the language does NOT contain

- **No left-hand rail highlights.** Neither zicato nor the exemplar
  decks put an accent stripe on a panel's left edge — no
  `border-left` callouts, quote bars, or "note" boxes. Panels are full
  hairline borders (`var(--dia-rule)`) with an accent panel LABEL;
  emphasis comes from the label and the content, never a colored rail.
  The one hairline divider in the language is the research-preview
  pill's, and it is `var(--dia-rule)`, not accent.

The copilot's artwork doctrine (service skill `copilot.md`) carries
this register into every generated figure.
