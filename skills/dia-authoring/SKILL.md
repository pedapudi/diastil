---
name: dia-authoring
description: Write or edit diastil dialect decks directly as HTML — document frame, text roles, layout containers, theme tokens, images with focal points, build steps, islands. Use when creating a deck from scratch, editing a .dia.html file as text, or generating dialect output from another tool.
---

# Authoring dialect decks

The dialect IS HTML — a closed profile of it (`profile/PROFILE.md` is the
contract; `examples/demo-deck.html` is a complete worked example). A deck
is one self-contained file that presents itself when opened and stays
fully editable by any agent or text editor.

## Document frame

```html
<!doctype html>
<html lang="en" data-dia-version="1">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>My deck</title>
<style id="dia-theme">/* tokens + role rules, see below */</style>
</head>
<body>
<section class="dia-slide">…</section>
<section class="dia-slide">…</section>
<script id="dia-runtime">/* embedded by diastil on save; may be empty */</script>
</body>
</html>
```

Body children are ONLY slides, `<style>` blocks, and the runtime script.
Never put scripts, inline event handlers, or iframes inside slides —
behavior is data (`data-dia-*`), and anything the dialect can't express
goes in an island.

## Theme tokens

Every rule in the deck reads tokens from `style#dia-theme`. The standard
set (one edit restyles the whole deck):

```css
:root {
  --dia-paper: #fbfaf6;      /* slide background */
  --dia-ink: #17242b;        /* primary text */
  --dia-ink-soft: #3d4a52;   /* secondary text */
  --dia-accent: #b4552d;     /* ONE accent, spent on signal */
  --dia-rule: #d9d4c8;       /* hairlines */
  --dia-face-display: Georgia, serif;
  --dia-face-body: Georgia, serif;
  --dia-face-label: ui-monospace, monospace;
  --dia-scale-1: 12px;  /* … --dia-scale-7: 48px — the type scale */
  --dia-gap: 24px;
  --dia-pad: 52px;
}
```

House style (docs/HOUSE-STYLE.md): decks default LIGHT — paper ground,
dark ink, one accent. Text and chrome never hard-code a hue; they read
tokens. The one licensed exception is illustrative artwork, below.

## Text roles & layout containers

Roles bind text to the scale — the inspector edits roles, never raw CSS:

| class | purpose |
| --- | --- |
| `dia-title` | slide title (scale step 5; `dia-cover-title` variant for covers) |
| `dia-kicker` | small tracked uppercase label above the title |
| `dia-body` | body copy (step 2, generous leading) |
| `dia-caption` / `dia-footnote` | small annotations |

Containers over grid/flex: `dia-stack` (vertical flow), `dia-columns`
(side-by-side), `dia-cover` (centered cover), `dia-figure` (media slot).
Unknown extra classes are allowed — they're deck-owned styling hooks.

### Lists and markers

Lists are native `<ul>/<ol>/<li>` — no wrapper role. Markers are a
detection ladder, richest form wins:

- **native**: plain lists keep browser bullets/numbers, restyled by the
  theme (`li::marker`)
- **glyph token**: a custom glyph for the whole list is ONE declaration —
  `<ul style="--dia-marker: '▸'; list-style: none">…` — the theme's
  `li::before` renders it on every item, ink from `--dia-marker-ink`
  (defaults to the accent), so lists retheme with the deck
- **marker slot**: arbitrary visual markers (svg icons, images, chips,
  per-item variants like ✓/✗) are REAL content in a classed slot:
  `<li><span class="dia-marker">…</span> text</li>` — the theme lays the
  item on a hanging grid (marker column + text column). Chips:
  `class="dia-marker dia-marker-chip"` renders a filled accent circle
  (step numbers, badges)

Import applies the same ladder automatically: uniform css-drawn bullets
collapse to the glyph token; icon/variant markers become slots.

## Math

Formulas are native MathML with the LaTeX source preserved on the
element — browsers typeset MathML without any runtime, and the source
keeps the formula editable as text:

```html
<div class="dia-math" data-dia-tex="\frac{a+b}{c}"><math>…</math></div>
```

Author the `data-dia-tex` and let a converter (temml, latexmlmath, or
the diastil editor's math row) produce the `<math>` content; keep the
two in sync — an agent editing the formula should edit the TeX and
re-render. Hand-authored MathML without a source is also valid.

## Media

Images carry crop and focal point as style, so photosetting is attribute
editing and exports never re-encode pixels:

```html
<img alt="…" style="width:100%; aspect-ratio:4/3; object-fit:cover; object-position:38% 42%;" src="…">
```

Prefer data-URI or adjacent-file sources; the deck should stay
self-contained.

### Illustrative artwork

Hand-authored svg illustrations live in a figure slot:

```html
<figure class="dia-figure" style="width: 58%; margin: 0;">
  <svg viewBox="0 0 430 300" role="img" aria-label="…">…</svg>
  <figcaption class="dia-caption">…</figcaption>
</figure>
```

- Always set a `viewBox`; size through the figure, not pixel
  width/height on the svg. Self-contained only: no external hrefs, no
  scripts, no `<foreignObject>`.
- BE COLORFUL — the house style biases illustrations toward rich,
  saturated color, and artwork MAY use hues beyond the theme tokens
  (real palettes, layered fills, local `<defs>` gradients) as long as
  it sits well on `var(--dia-paper)`.
- The boundary: words and labels INSIDE artwork still read tokens
  (`var(--dia-ink)`, `var(--dia-face-label)`), so they retheme with the
  deck; and diagram scenes (`svg.dia-scene`, see `dia-scenes`) stay
  fully token-bound — they are structure, not pictures.

## Behavior is data

- `data-dia-step="1"` — build order (positive integers); the runtime
  reveals stepped elements in order in present mode (a gentle fade-rise,
  motion gated behind `prefers-reduced-motion`).
- `data-dia-transition="fade|slide|rise|none"` — how a slide ENTERS in
  present mode. Per-slide on `<section>`; deck default on `<html>`.
- `data-dia-emphasis` — hover-linkage/highlight groups.
- Diagrams: see `dia-scenes` for the `svg.dia-scene` vocabulary.

## Islands — the escape hatch

A region the dialect can't express is preserved verbatim:

```html
<div class="dia-island" data-dia-island>
  <!-- original markup, styles, even scripts — untouched -->
</div>
```

Islands are exempt from every profile rule, get coarse editing only
(move/resize/replace/delete), and can be lifted into the dialect later.
Use an island rather than approximating — verified conversion or verbatim
preservation, never a silent maybe.

## Checking your work

`dia validate deck.html` (stdlib-only, exit 1 on errors) or open the deck
in the editor — the topbar status dot reads `valid · v1`. Round-trip
guarantee: a deck saved by diastil re-parses and re-serializes to
identical bytes, so text-editor diffs stay clean.
