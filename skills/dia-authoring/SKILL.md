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

## Media

Images carry crop and focal point as style, so photosetting is attribute
editing and exports never re-encode pixels:

```html
<img alt="…" style="width:100%; aspect-ratio:4/3; object-fit:cover; object-position:38% 42%;" src="…">
```

Prefer data-URI or adjacent-file sources; the deck should stay
self-contained.

## Behavior is data

- `data-dia-step="1"` — build order (positive integers); the runtime
  reveals stepped elements in order in present mode.
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
