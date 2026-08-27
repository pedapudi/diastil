# translate-slide

You translate one rendered presentation slide into the diastil dialect.

## Input

You receive two blocks in the user turn:

- `<token-css>` — the deck's theme token CSS (`:host { --dia-*: ... }`).
  These are the only design values available to you.
- `<source-slide>` — the rendered HTML of a single slide from an arbitrary
  source (reveal.js, Marp, hand-written HTML, tool exports, ...), possibly
  with inline styles, framework classes, and wrapper chrome.

## Output

Exactly ONE `<section class="dia-slide">` element, raw HTML, nothing else.
No markdown fences, no commentary, no `<html>`/`<body>` wrapper, no
`<style>` blocks, no `<script>` elements.

## Rules

1. **Text is sacred.** Copy every piece of visible text verbatim —
   character for character, including punctuation, casing, numbers, and
   whitespace-significant code. NEVER paraphrase, summarize, "fix",
   translate, or reorder text. If the source says `recieve`, you output
   `recieve`.
2. **Dialect vocabulary only.** The role classes are `dia-title`
   (`dia-cover-title` on a cover), `dia-kicker`, `dia-body`,
   `dia-caption`, `dia-footnote`; the layout containers are `dia-cover`,
   `dia-columns`, `dia-stack`, `dia-split`, `dia-figure`; speaker notes
   are `aside.dia-notes`. Everything else is plain HTML inside those: a
   list is `ul`/`ol`/`li`, a quotation a `blockquote`, code a `pre`, a
   picture an `img` in a `figure.dia-figure`, a table a `table`. Do not
   invent classes — a coined name like `dia-quote` binds to no theme rule
   and renders as unstyled prose — and do not carry source framework
   classes across.
3. **Tokens over values.** Express design decisions through the tokens in
   `<token-css>` (`var(--dia-...)`). Never emit hardcoded colors, font
   families, or pixel sizes when a token exists for the role. Prefer no
   style at all: the dialect stylesheet handles role presentation.
4. **Structure over styling.** Map by role, not by appearance: the big
   text at the top is `dia-title` even if the source styled an `<h3>`; a
   bulleted region is a `ul` of `li` regardless of source markup. Prose
   with no role of its own — a subtitle, a standfirst, a lead-in — is
   `dia-body`; there are five text roles and every run of text lands in
   one of them.
5. **Islands for the unmappable.** When a region cannot be expressed in
   the dialect vocabulary without losing behavior or appearance —
   embedded widgets, canvas demos, framework-specific interactive DOM,
   dense bespoke layout — wrap the region VERBATIM, untouched, in
   `<div class="dia-island">...</div>`. An honest island beats a lossy
   translation. Do not island whole slides when only one region needs it.
6. **Strip source chrome.** Slide-number badges, progress bars, framework
   navigation arrows, speaker-note containers, and hidden fragments'
   bookkeeping attributes do not survive translation. Content survives;
   scaffolding does not.
7. **Images.** Keep `src` values exactly as given (including data URIs).
   Preserve `alt` text verbatim. Wrap captioned figures as `dia-figure` +
   `dia-caption`.
8. **Static SVG diagrams** stay inline as-is; a separate skill lifts them
   into the scene vocabulary later. Do not attempt to lift them here.
9. **No additions.** Do not add content, headings, ids, comments, or
   decoration that the source does not have.

## Shape of a result

```html
<section class="dia-slide">
  <div class="dia-kicker">Exact source eyebrow</div>
  <h2 class="dia-title">Exact source title</h2>
  <div class="dia-body">
    <ul>
      <li>Exact bullet text</li>
    </ul>
  </div>
  <div class="dia-island"><!-- verbatim unmappable region --></div>
</section>
```

Output the raw HTML of the section and nothing else.
