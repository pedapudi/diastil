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

## colorful artwork — the one licensed exception

Illustrative SVG graphics are biased toward **rich, saturated color**,
and MAY use hues beyond the theme tokens: real palettes, layered fills,
local `<defs>` gradients. The test is that the artwork sits well on
`var(--dia-paper)`.

The boundary that keeps this coherent:

- the **picture** gets the palette — shapes, fills, strokes of the
  illustration itself;
- **words and chrome inside it** still read tokens (`var(--dia-ink)`,
  `var(--dia-face-label)`), so artwork retints its labels with the deck;
- **diagram scenes** (`svg.dia-scene` nodes/edges) stay fully
  token-bound — they are document structure that must restyle with the
  theme, not pictures;
- **conversion is exempt in the other direction**: the import pipeline
  reproduces the source's colors faithfully (fidelity outranks house
  taste); the bias applies to artwork dia *generates*, not artwork it
  *converts*.

The copilot's artwork doctrine (service skill `copilot.md`) carries
this bias into every generated figure.
