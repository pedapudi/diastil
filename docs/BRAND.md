# diastīl — brand

## The name

**diastīl**, lowercase, from *dia* (through) + *style* — traced to its
root, Latin **stīlus**, the pointed writing instrument. Classical Latin
spells that word with a genuinely long ī, so the macron is philological,
not decorative: it marks the Latin vowel quantity and gives the
pronunciation *dee-ah-STEEL*. "Through the pen": documents written
directly, in their own style.

(The *y* in English "style"/"stylus" is a historical confusion with
Greek στῦλος, "column" — the root of the architectural term *diastyle*.
diastīl keeps the honest Latin *i*.)

The condensation mark adds a second, deliberate reading — *distill* —
many messy sources pass through and come out as one verified document.
The pun is welcome; the etymology is stīlus.

**Where the macron goes.** Display contexts only: the editor wordmark,
deck footers and covers, headlines, marketing. Everything a machine
touches stays ascii — the repository and package are `diastil`, the CLI
is `dia`, class names are `dia-*`, the file is `deck.html`. Never write
`diastīl` in code, paths, identifiers, or shell examples.

## The condensation mark

Three slide-lines converge toward a single accent drop:

```
———————\
—————————   ●
———————/
```

- geometry: three horizontal strokes (outer two tilted inward, ~55–80%
  opacity; the middle one full and longest), round caps, and one filled
  circle at the vanishing point
- the strokes take a neutral ink (`--dia-ink-soft` on decks, chrome
  `--ink-faint` in the editor); the drop is ALWAYS the accent — it is
  the only colored element
- clear space: at least one drop-diameter on every side; don't stretch,
  outline, gradient, or animate it
- it reads at 13px (topbar), 24px (deck cover), and as the favicon

Meaning first: slides (the lines) distilled (the convergence) to one
verified document (the drop). If a rendering can't keep that reading,
use the wordmark alone.

## Color

One accent, spent on signal — never decoration. Everything else is role
tokens (`--dia-paper/ink/ink-soft/ink-faint/rule` on decks; the chrome
tokens in the editor). Good/bad coloring is earned by direction (a score
improving, a floor holding), never by identity. No second accent, no
gradients, no literal hex in content — tokens only, so every surface
retints with its theme.

## Type registers

- **editor chrome** — the zicato role split: sans for prose and
  controls; mono RESERVED for data, code, and keyboard (scores, paths,
  token values, kbd). The wordmark itself sets in the brand mono.
- **presentation** — decks speak their own theme. The house deck
  (`examples/what-is-dia.html`) uses the all-mono Technical register:
  three-tier ink, tabular numerals, hairline panels, trailing periods on
  declarative titles, `NN / NN` + wordmark footers.

## Companion marks

- **kicker glyph**: a tiny slide-outline rectangle before kickers —
  diastīl's own bullet, never zicato's ∿
- **research-preview pill**: a stacked two-line mono tag with a hairline
  divider, sitting quietly beside the wordmark — informational, never
  interactive

## Voice

Lowercase, declarative, measured. Claims come with numbers (a fidelity
score, a floor, a round count). Prefer "measured" to "magical"; the
product's promise is verification, and the brand should never promise
more than the metric does.
