# Import fidelity — what the importer must understand, and how that bounds conversion

The importer's job is not "parse the HTML." It is: **observe what the
audience actually sees, then re-express as much of it as possible in the
dialect — and be honest about the rest.** Every quality property of the
pipeline traces back to one epistemic rule:

> Conversion quality is bounded by observation quality. A slide observed
> in the wrong state converts to the wrong thing, and — worse — the
> fidelity loop then *verifies* against the wrong truth.

This document names the layers of understanding, how each one feeds the
conversion, and the escape-hatch ladder that keeps the result honest.

## 1. The layers of understanding

### A. Presentation model — how the document IS a deck

1. **Slide segmentation.** Which elements are slides. Detected from
   recurring structural siblings, viewport-sized boxes, framework
   markers (`.reveal .slides > section`, `.step`, `.slide`).
2. **Presentation mode.** All-slides-visible flow, one-visible-at-a-time,
   or scroll-driven. Detected by rendered geometry (multiple roots with
   `offsetWidth === 0` ⇒ one-at-a-time), never by reading CSS.
3. **The navigation contract.** How the deck advances: framework API
   (`Reveal.slide`, `impress().goto`), key handlers (often checking
   legacy `keyCode`), hash routing, next/prev controls. The importer
   must LEARN this per deck (probe → verify visibility → remember what
   worked), because it cannot observe slide N's truth without reaching
   slide N *through the deck's own runtime*.
4. **Activation semantics.** What happens when a slide becomes current:
   classes toggled, layouts split, reveals played, figures lazily drawn
   into canvases. The settled, activated state is the ground truth —
   forcing `display:block` on a hidden slide shows its *pre-activation*
   DOM, which is not what the audience sees.

### B. Design system — the deck's visual language

5. **Tokens.** Palette (paper, ink, accent), faces, the type scale,
   spacing rhythm, per-slide backgrounds — harvested from computed
   styles and emitted as `--dia-*` tokens, sizes converted to
   container-relative units so the deck scales.
6. **Text roles.** Title / kicker / body / caption assigned from visual
   evidence (size rank, weight, position within the slide), never from
   tag names.
7. **Layout topology.** Columns, stacks, covers, figure slots, and
   their proportions — mapped to dialect containers.

### C. Content classes — what each region IS

Each region is classified before it is converted, because the class
decides the conversion strategy:

| region class | strategy |
| --- | --- |
| text (incl. inline-run sentences) | dialect roles; inline runs kept whole |
| images / video | `<img>` with crop + focal point |
| node-and-edge vector diagrams | lift to `svg.dia-scene` (editable objects) |
| decorative / freeform vector art | verbatim SVG (inside or outside a scene), computed paint inlined |
| canvas-rendered figures | snapshot to `<img>` (aspect preserved) |
| tables, code blocks | structural HTML, theme-token styling |
| animated / interactive widgets | island (verbatim, coarse editing) |

### D. The honesty layer

8. **Pixel ground truth.** Every slide is rasterized in its activated
   state on both sides and diffed; the score is reported, not asserted.
   Rasterization failure yields `null`, never a fake score.
9. **Provenance.** Every region that could not be fully understood is
   *visibly* marked: islands in the review UI, snapshot figures, low
   structure advisories. A degraded observation (e.g. a deck whose
   navigation could not be learned) must be flagged the same way —
   a fidelity score computed against an under-activated original is
   labeled as such, or it is a lie.

## 2. How understanding influences conversion

The conversion decision per region is a ladder, ordered by how much the
importer understood, and it never skips to approximation:

1. **Understood structurally** → dialect (roles, containers, scenes).
   Fully editable; participates in tokens, steps, emphasis.
2. **Understood visually but not structurally** → faithful pixels with
   coarse editing: verbatim SVG with inlined paint, canvas snapshots,
   `path`-shaped scene nodes for freeform marks.
3. **Not understood** → island. Verbatim markup, scripts intact.
4. **Never**: a plausible-looking reconstruction that silently drops
   what it didn't understand. Verified conversion or verbatim
   preservation — no silent maybe.

The same ladder runs in reverse during review: repair rounds and
diagram lifts may *promote* a region up the ladder (island → scene),
but only when the pixel gate proves the promotion lost nothing.

## 3. Consequences for the pipeline stages

- **execute** must settle the deck (fonts, first paint, animation
  quiescence) before anything is measured.
- **extract** must observe every slide *activated* (via the learned
  navigation contract), because samples taken from a pre-activation DOM
  mis-measure geometry, visibility, and lazily-drawn content.
- **convert** consumes classified regions; its role/layout decisions are
  only as good as the samples.
- **fidelity** must rasterize the original in the same activated state
  the audience sees, or the loop optimizes toward the wrong target.
- **review** must present the original through the deck's own runtime —
  it is the user's ground-truth pane; presenting a forced render there
  hides exactly the failures the review exists to catch.

## 4. Primitive coverage — "almost arbitrary visuals"

The dialect covers arbitrary visuals through three tiers, from most to
least structured:

1. **Scene objects** — nodes (shape vocabulary: `rect`, `rounded`,
   `pill`, `ellipse`, `diamond`, `cylinder`, `hex`, `parallelogram`,
   `triangle`, `cloud`, `note`, and `path` for arbitrary normalized
   outlines), edges (straight/ortho/curve, anchored), labels. The
   `path` shape is the coverage backstop: any closed or open vector
   mark — annotation rings, braces, stars, blobs, arrows-at-nothing —
   becomes a movable, resizable node carrying its outline in a
   100×100-normalized `data-path`.
2. **Faithful fragments** — verbatim SVG children inside a scene (the
   lift keeps unliftable regions as-is), standalone verbatim `<svg>`,
   snapshot `<img>` for raster/canvas content, plain HTML with
   deck-owned classes for decorative boxes (unknown classes are legal
   dialect).
3. **Islands** — everything else, verbatim, scripts intact.

Tier 1 is editable per-object; tier 2 is editable coarsely (move,
resize, replace); tier 3 is opaque but preserved. "Enough primitives"
means: tier 1 keeps growing so common visuals (flowchart glyphs,
callouts, annotation marks) don't fall to tier 2 — but tiers 2 and 3
guarantee that *nothing* is unrepresentable meanwhile.
