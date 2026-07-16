---
name: dia-authoring
description: Write or edit diastil dialect decks directly as HTML — document frame, text roles, layout containers, theme tokens, images with focal points, build steps, islands. Use when creating a deck from scratch, editing a .dia.html file as text, or generating dialect output from another tool.
---

# Authoring dialect decks

The dialect IS HTML — a closed profile of it (`profile/PROFILE.md` is the
contract; `examples/demo-deck.html` is a complete worked example). A deck
is one self-contained file that presents itself when opened and stays
fully editable by any agent or text editor.

**Figures first.** Before writing any prose, plan one visualization per
content slide — a deck of ten slides should carry roughly eight
hand-drawn svg figures ("Visualize by default", below, includes a
complete worked example to imitate). Decks that read as walls of text
are out of house style even when they validate.

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
  --dia-paper: #F2EEDE;      /* slide background */
  --dia-ink: #1A1A1A;        /* primary text */
  --dia-ink-soft: #33312B;   /* secondary text */
  --dia-ink-faint: #85837A;  /* tertiary / figure structure */
  --dia-accent: #1E6FCC;     /* ONE accent, spent on signal */
  --dia-rule: #C6C3B6;       /* hairlines */
  --dia-face-display: "Source Sans 3", system-ui, sans-serif;
  --dia-face-body: "Source Sans 3", system-ui, sans-serif;
  --dia-face-label: "Source Code Pro", ui-monospace, monospace;
  --dia-scale-1: 12px;  /* … --dia-scale-7: 48px — the type scale */
  --dia-gap: 24px;
  --dia-pad: 52px;
}
```

House style (docs/HOUSE-STYLE.md): decks default LIGHT, and palettes
come from the zicato theme set below — NEVER invented ad hoc (warm
creams with terracotta accents and serif body faces are a known LLM
tell, not the house). Faces follow the zicato role split: sans for
prose (display/body), mono ONLY for labels/data. Text and chrome never
hard-code a hue; they read tokens. The one licensed exception is
illustrative artwork, below.

### The palettes

Map a zicato theme onto the deck tokens 1:1 (`paper → --dia-paper`,
`ink → --dia-ink`, …). The house default is **paper**; the other four
light themes are the first alternates.

| theme | paper | ink | ink-soft | ink-faint | rule | accent |
| --- | --- | --- | --- | --- | --- | --- |
| **paper** (default) | `#F2EEDE` | `#1A1A1A` | `#33312B` | `#85837A` | `#C6C3B6` | `#1E6FCC` |
| solarized-light | `#FDF6E3` | `#586E75` | `#657B83` | `#93A1A1` | `#E7DCBE` | `#268BD2` |
| google-light | `#FFFFFF` | `#474A4E` | `#5F6368` | `#9FA1A4` | `#E2E3E4` | `#1B9CB8` |
| lunaria-light | `#EBE4E1` | `#363434` | `#484646` | `#898584` | `#CEC8C5` | `#3778A9` |
| belafonte-day | `#D5CCBA` | `#34292D` | `#45373C` | `#7F736E` | `#BBB1A3` | `#426A79` |
| monokai | `#1e1f1c` | `#f8f8f2` | `#c9cabf` | `#8f908a` | `#3a3b34` | `#66d9ef` |
| solarized-dark | `#04222B` | `#93A1A1` | `#839496` | `#5E7079` | `#0E3540` | `#2AA198` |
| google-dark | `#202124` | `#FFFFFF` | `#E8EAED` | `#989A9D` | `#444548` | `#24C1E0` |
| lunaria-eclipse | `#323F46` | `#DFE2ED` | `#C9CDD7` | `#8D949D` | `#4D5960` | `#C8429F` |
| belafonte-night | `#20111B` | `#D5CCBA` | `#968C83` | `#675B59` | `#35272E` | `#6F8E97` |
| zenburn | `#3A3A3A` | `#DCDCCC` | `#C5C5B8` | `#83837C` | `#575754` | `#8CD0D3` |
| selenized-black | `#181818` | `#DEDEDE` | `#B9B9B9` | `#606060` | `#353535` | `#56D8C9` |
| relaxed | `#353A44` | `#F7F7F7` | `#D9D9D9` | `#7F8287` | `#53575F` | `#7EAAC7` |
| espresso | `#323232` | `#FFFFFF` | `#D9D9D9` | `#8A8A8A` | `#4C4C4C` | `#6C99BB` |
| dracula | `#282A36` | `#F8F8F2` | `#D4D4CF` | `#6272A4` | `#44475A` | `#BD93F9` |
| ubuntu | `#300A24` | `#EEEEEC` | `#CBC3C9` | `#8A7383` | `#4B2640` | `#34E2E2` |

When a deck needs `good`/`bad` semantics (checkmarks, deltas, pass/fail
figures), take them from the same theme — e.g. paper: good `#216609`,
bad `#CC3E28`; solarized-light: good `#6B9B0B`, bad `#DC322F`;
google-light: good `#34A853`, bad `#EA4335`; lunaria-light: good
`#497D46`, bad `#783C1F`; belafonte-day: good `#6E6A4E`, bad `#BE100E`.

Faces, T9 by default (the role split):

```css
--dia-face-display: "Source Sans 3", system-ui, sans-serif;
--dia-face-body: "Source Sans 3", system-ui, sans-serif;
--dia-face-label: "Source Code Pro", ui-monospace, monospace;
```

For an all-mono technical register (zicato's own presentation style),
set all three faces to a mono stack (`"Google Sans Mono", "Noto Sans
Mono", ui-monospace, monospace`); for an editorial register, display
and body may be a serif (`"Fraunces"`, `"Bitter"`, `"Literata"`,
Georgia fallback) while labels STAY mono.

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

### Visualize by default

The house bias is STRONG: a deck should be a sequence of figures with
supporting prose, not a sequence of paragraphs. Whenever a slide states
a relationship, a flow, a comparison, a scale, a timeline, or an
architecture, DRAW THE CLAIM — a quadrant chart, a to-scale bar, a
pipeline, an annotated sketch — and let the text argue around it. A
text-only slide is the exception that must earn its plainness; when in
doubt, add the figure. The working quota: roughly one figure per
content slide, planned before the prose.

A complete figure in the house register — copy this shape, not just
the idea (a seed head whose faint spokes are structure and whose
drifting seeds carry the accent — the color IS the argument):

```html
<figure class="dia-figure" style="width: 56%; margin: 0;">
  <svg viewBox="0 0 430 300" role="img"
       aria-label="a seed head of faint radiating spokes inside a dashed envelope; three seeds drift away in the accent color"
       style="width: 100%; font-family: var(--dia-face-label); font-size: 10px;">
    <circle cx="150" cy="152" r="104" style="fill: none; stroke: var(--dia-rule); stroke-width: 1; stroke-dasharray: 2 5;"></circle>
    <path d="M150,152 C 146,212 158,250 152,296" style="fill: none; stroke: var(--dia-ink-faint); stroke-width: 1.6; stroke-linecap: round;"></path>
    <g style="stroke: var(--dia-ink-faint); stroke-width: 0.9; fill: none;">
      <line x1="150" y1="152" x2="244" y2="118" opacity=".85"></line>
      <line x1="150" y1="152" x2="220" y2="72"  opacity=".5"></line>
      <line x1="150" y1="152" x2="162" y2="52"  opacity=".85"></line>
      <line x1="150" y1="152" x2="102" y2="62"  opacity=".5"></line>
      <line x1="150" y1="152" x2="60"  y2="104" opacity=".85"></line>
      <line x1="150" y1="152" x2="50"  y2="166" opacity=".5"></line>
      <line x1="150" y1="152" x2="82"  y2="222" opacity=".85"></line>
    </g>
    <g style="fill: var(--dia-ink-faint);">
      <circle cx="244" cy="118" r="2.4" opacity=".85"></circle><circle cx="220" cy="72" r="2.4" opacity=".5"></circle>
      <circle cx="162" cy="52"  r="2.4" opacity=".85"></circle><circle cx="102" cy="62" r="2.4" opacity=".5"></circle>
      <circle cx="60"  cy="104" r="2.4" opacity=".85"></circle><circle cx="50"  cy="166" r="2.4" opacity=".5"></circle>
      <circle cx="82"  cy="222" r="2.4" opacity=".85"></circle>
    </g>
    <g style="stroke: var(--dia-accent); stroke-width: 0.85; fill: none;" opacity=".95">
      <path d="M282,100 q16,-12 26,-30"></path>
      <path d="M318,128 q18,-8 34,-22"></path>
      <path d="M330,168 q20,-2 38,-12"></path>
    </g>
    <g style="fill: var(--dia-accent);">
      <circle cx="308" cy="70" r="2.6"></circle><circle cx="352" cy="106" r="2.6"></circle><circle cx="368" cy="156" r="2.6"></circle>
    </g>
    <text x="24" y="282" style="fill: var(--dia-ink-faint);">the head — structure, kept faint</text>
    <text x="296" y="52" style="fill: var(--dia-accent);">the escaping few — the point</text>
  </svg>
  <figcaption class="dia-caption">the accent is spent only on what the slide argues; everything else is hairline structure</figcaption>
</figure>
```

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
- The boundary: words and labels INSIDE artwork still read tokens
  (`var(--dia-ink)`, `var(--dia-face-label)`), so they retheme with the
  deck; and diagram scenes (`svg.dia-scene`, see `dia-scenes`) stay
  fully token-bound — they are structure, not pictures.

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
