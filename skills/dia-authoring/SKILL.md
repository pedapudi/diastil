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
hand-drawn svg figures ("Visualize by default" below; the craft lives
in the `dia-artwork` skill). Decks that read as walls of text are out
of house style even when they validate.

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

### Four ready themes — paste one, whole

Do not derive tokens from the table below or from any css file: pick
one of these four blocks and paste it into `style#dia-theme` verbatim
(then adjust scales/gap/pad if the content needs it). **paper** is the
default; use a dark theme only when the deck's subject or venue calls
for it.

```css
/* paper — the house default (light) */
:root {
  --dia-paper: #F2EEDE; --dia-ink: #1A1A1A; --dia-ink-soft: #33312B;
  --dia-ink-faint: #85837A; --dia-accent: #1E6FCC; --dia-rule: #C6C3B6;
  --dia-good: #216609; --dia-bad: #CC3E28;
  --dia-face-display: "Source Sans 3", system-ui, sans-serif;
  --dia-face-body: "Source Sans 3", system-ui, sans-serif;
  --dia-face-label: "Source Code Pro", ui-monospace, monospace;
  --dia-scale-1: 12px; --dia-scale-2: 15px; --dia-scale-3: 18px;
  --dia-scale-4: 22px; --dia-scale-5: 30px; --dia-scale-6: 38px;
  --dia-scale-7: 48px; --dia-gap: 24px; --dia-pad: 52px;
}
```

```css
/* solarized-light — the warm light alternate */
:root {
  --dia-paper: #FDF6E3; --dia-ink: #586E75; --dia-ink-soft: #657B83;
  --dia-ink-faint: #93A1A1; --dia-accent: #268BD2; --dia-rule: #E7DCBE;
  --dia-good: #6B9B0B; --dia-bad: #DC322F;
  --dia-face-display: "Source Sans 3", system-ui, sans-serif;
  --dia-face-body: "Source Sans 3", system-ui, sans-serif;
  --dia-face-label: "Source Code Pro", ui-monospace, monospace;
  --dia-scale-1: 12px; --dia-scale-2: 15px; --dia-scale-3: 18px;
  --dia-scale-4: 22px; --dia-scale-5: 30px; --dia-scale-6: 38px;
  --dia-scale-7: 48px; --dia-gap: 24px; --dia-pad: 52px;
}
```

```css
/* selenized-black — the neutral near-black (dark) */
:root {
  --dia-paper: #181818; --dia-ink: #DEDEDE; --dia-ink-soft: #B9B9B9;
  --dia-ink-faint: #606060; --dia-accent: #56D8C9; --dia-rule: #353535;
  --dia-good: #83C746; --dia-bad: #FF5E56;
  --dia-face-display: "Source Sans 3", system-ui, sans-serif;
  --dia-face-body: "Source Sans 3", system-ui, sans-serif;
  --dia-face-label: "Source Code Pro", ui-monospace, monospace;
  --dia-scale-1: 12px; --dia-scale-2: 15px; --dia-scale-3: 18px;
  --dia-scale-4: 22px; --dia-scale-5: 30px; --dia-scale-6: 38px;
  --dia-scale-7: 48px; --dia-gap: 24px; --dia-pad: 52px;
}
```

```css
/* ubuntu — the aubergine dark (what-is-dia wears it) */
:root {
  --dia-paper: #300A24; --dia-ink: #EEEEEC; --dia-ink-soft: #CBC3C9;
  --dia-ink-faint: #8A7383; --dia-accent: #34E2E2; --dia-rule: #4B2640;
  --dia-good: #8AE234; --dia-bad: #CC0000;
  --dia-face-display: "Source Sans 3", system-ui, sans-serif;
  --dia-face-body: "Source Sans 3", system-ui, sans-serif;
  --dia-face-label: "Source Code Pro", ui-monospace, monospace;
  --dia-scale-1: 12px; --dia-scale-2: 15px; --dia-scale-3: 18px;
  --dia-scale-4: 22px; --dia-scale-5: 30px; --dia-scale-6: 38px;
  --dia-scale-7: 48px; --dia-gap: 24px; --dia-pad: 52px;
}
```

### The full palette set (reference)

Twelve more zicato themes when a deck needs a different mood — map
1:1 onto the deck tokens (`paper → --dia-paper`, `ink → --dia-ink`, …).

| theme | paper | ink | ink-soft | ink-faint | rule | accent |
| --- | --- | --- | --- | --- | --- | --- |
| google-light | `#FFFFFF` | `#474A4E` | `#5F6368` | `#9FA1A4` | `#E2E3E4` | `#1B9CB8` |
| lunaria-light | `#EBE4E1` | `#363434` | `#484646` | `#898584` | `#CEC8C5` | `#3778A9` |
| belafonte-day | `#D5CCBA` | `#34292D` | `#45373C` | `#7F736E` | `#BBB1A3` | `#426A79` |
| monokai | `#1e1f1c` | `#f8f8f2` | `#c9cabf` | `#8f908a` | `#3a3b34` | `#66d9ef` |
| solarized-dark | `#04222B` | `#93A1A1` | `#839496` | `#5E7079` | `#0E3540` | `#2AA198` |
| google-dark | `#202124` | `#FFFFFF` | `#E8EAED` | `#989A9D` | `#444548` | `#24C1E0` |
| lunaria-eclipse | `#323F46` | `#DFE2ED` | `#C9CDD7` | `#8D949D` | `#4D5960` | `#C8429F` |
| belafonte-night | `#20111B` | `#D5CCBA` | `#968C83` | `#675B59` | `#35272E` | `#6F8E97` |
| zenburn | `#3A3A3A` | `#DCDCCC` | `#C5C5B8` | `#83837C` | `#575754` | `#8CD0D3` |
| relaxed | `#353A44` | `#F7F7F7` | `#D9D9D9` | `#7F8287` | `#53575F` | `#7EAAC7` |
| espresso | `#323232` | `#FFFFFF` | `#D9D9D9` | `#8A8A8A` | `#4C4C4C` | `#6C99BB` |
| dracula | `#282A36` | `#F8F8F2` | `#D4D4CF` | `#6272A4` | `#44475A` | `#BD93F9` |

When a deck needs `good`/`bad` semantics (checkmarks, deltas, pass/fail
figures), take them from the same theme (`good`/`bad` in the four
blocks above; for table themes, look up the zicato palette or reuse
the nearest block's pair).

### Faces — prescriptive

The house faces are **Source Sans 3** (display and body) and **Source
Code Pro** (labels, data, code) — exactly the stacks shown in the four
theme blocks. Use them verbatim in every deck you author; do not
substitute another sans, and never set body text in a serif or a mono.
The ONLY sanctioned departures, and only when the user explicitly asks
for that register by name: all-mono technical (all three faces
`"Google Sans Mono", "Noto Sans Mono", ui-monospace, monospace` —
zicato's own presentation style) or serif editorial (display/body
`"Fraunces"`, `"Bitter"`, or `"Literata"` with a Georgia fallback).
Labels stay mono in every register, no exceptions.

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

### Tables

Native `<table>` with the theme conventions: mono uppercase `th` over
an ink rule, hairline row rules, and `class="num"` on numeric columns
(right-aligned, `tabular-nums`, label face). The scaffold theme carries
the rules; keep numbers in `.num` cells so they align.

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
architecture, DRAW THE CLAIM. A text-only slide is the exception that
must earn its plainness. Hand-authored svg lives in a figure slot:

```html
<figure class="dia-figure" style="width: 58%; margin: 0;">
  <svg viewBox="0 0 430 300" role="img" aria-label="…"
       style="width: 100%; font-family: var(--dia-face-label); font-size: 10px;">…</svg>
  <figcaption class="dia-caption">…</figcaption>
</figure>
```

**The craft is its own skill: read `dia-artwork` before drawing.** It
carries the line-art register and its reference recipes, the
full-color pictorial style and canon, the palette/setting variety
rules, and the theme→analogy→draw→improve iteration loop. In brief:
faint token-bound structure, ONE accented element that is the
argument, cartographer labels, a takeaway caption — and iterate the
whole deck's imagery 3–4 passes, never one draft.


## Behavior is data

- `data-dia-step="1"` — build order (positive integers); the runtime
  reveals stepped elements in order in present mode (a gentle fade-rise,
  motion gated behind `prefers-reduced-motion`).
- `data-dia-step-until="N"` — the element EXITS when step N arrives
  (build-and-replace sequences).
- `data-dia-spotlight` on a container — already-shown steps recede to
  35% while the newest speaks (walking through a list).
- `data-dia-part="section name"` on a slide — talk structure for
  agenda/progress tooling.
- `data-dia-auto="page"` on any element — runtime-owned page furniture:
  the runtime AND the editor fill it as "N / N"; never hand-number
  footers again.
- Speaker notes: `<aside class="dia-notes">…</aside>` inside a slide —
  hidden when presenting (theme + runtime), shown in the editor.
- Charts are data — see `dia-scenes` for `svg.dia-chart`
  (`data-chart="bar|line|scatter"`, `data-values="Q1:12, Q2:19"`).
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
