# diastil document profile, v1

The dialect's second document kind: a LaTeX-backed long-form document. Where
a deck is slides, a document is flowing prose — but the same doctrine holds:
the saved artifact is plain self-contained HTML, behavior is data, nothing
executes, and a validator can say exactly what is and is not in profile.

The **LaTeX source is the truth**. The rendered body exists so the artifact
reads in any browser with zero runtime dependencies; editors regenerate it
from the source on load, and when the two disagree, the source wins. This is
the `data-dia-tex` math convention (PROFILE.md §2) applied to a whole file.

Rule ids below are implemented in lockstep by `src/model/validate.ts`
(`validateDocHtml`) and `service/dia_service/validate.py`
(`validate_doc_html`) — same ids, same levels, changed only together with
this file.

## 1. Frame

```html
<!doctype html>
<html lang="en" data-dia-doc-version="1">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>…</title>
  <script type="application/json" id="dia-source">{"version":1,"fileName":"paper.tex","tex":"…"}</script>
  <script type="application/json" id="dia-comments">{"version":1,"threads":[]}</script>
  <style id="dia-theme">…</style>
</head>
<body>
  <article class="dia-doc">…</article>
  <script id="dia-doc-runtime">…</script>   <!-- only when comments exist -->
</body>
</html>
```

- `doc/version` (error) — `data-dia-doc-version` present on `<html>`.
- `doc/version-exclusive` (error) — a file is a deck **or** a document:
  `data-dia-version` and `data-dia-doc-version` never coexist.
- `frame/theme` (error) — exactly one `<style id="dia-theme">` (shared rule
  with the deck profile).
- `doc/root` (error) — exactly one `article.dia-doc`.
- `doc/stray-content` (error) — body children are the article, style blocks,
  and `script#dia-doc-runtime` (§6) only.

## 2. The source block

- `doc/source` (error) — exactly one `<script type="application/json"
  id="dia-source">` whose JSON carries `version: 1` and a non-empty `tex`
  string. JSON (with `<` escaped as `<`) is the transport because raw
  LaTeX may legally contain `</script>` inside verbatim regions; JSON gives
  exact byte recovery, the same reasoning as the `text/x-dia-original`
  blocks of PROFILE.md §8.
- `fileName` in the block preserves the original `.tex` name for export.

## 3. The rendered body

Inside `article.dia-doc`:

| construct | rendering |
|---|---|
| preamble `\title`/`\author` | `header.dia-doc-header` > `h1.dia-title`, `.dia-doc-authors` (derived) |
| `abstract` | `section.dia-abstract` |
| `\section`…`\subparagraph` | `h2`–`h5` with class `dia-sec`, `\label` as `data-dia-label` |
| paragraph | `<p>` |
| `itemize` / `enumerate` / `description` | `ul` / `ol` / `dl` |
| `figure` / `table` floats | `figure.dia-figure[data-dia-float]`, caption → `figcaption`, `\includegraphics` → `img.dia-graphic[data-dia-graphic-opts]` (pdf/eps → `div.dia-graphic-slot[data-dia-graphic-path]`, a labeled placeholder — browsers cannot render those in `<img>`) |
| `tabular` | `<table data-dia-colspec>` |
| display math / math environments | `div.dia-math[data-dia-tex][data-dia-env][data-dia-label]` with MathML content (PROFILE.md §2) |
| inline math | `span.dia-math.dia-math-inline[data-dia-tex]` |
| verbatim / lstlisting / minted | `pre.dia-verbatim[data-dia-env]` |
| `\textbf` `\textit` `\emph` `\texttt` `\underline` `\textsc` | `strong` `i` `em` `code` `u` `span.dia-smallcaps` |
| `\ref` family | `a.dia-ref[data-dia-ref][data-dia-ref-cmd]` — text is DERIVED (resolved number) |
| `\cite` family | `a.dia-cite[data-dia-cite][data-dia-cite-opt][data-dia-cite-pre][data-dia-cite-cmd]` — text is DERIVED (author-year from the compile's .bbl, once one exists); `[key]` otherwise |
| `\footnote` | `span.dia-footnote` |
| `\url` / `\href` | `a.dia-url[href]` |
| `\label` in flow | `span.dia-label[data-dia-label]` (hidden) |
| center/quote/framed/multicols… | `div.dia-wrap.dia-wrap-<env>[data-dia-env]` |
| anything unmapped | `div.dia-tex-island[data-dia-island="tex"]` (block) or `span.dia-tex-island` (inline) rendering its raw source |

Islands carry `data-dia-island="tex"` — the deck island attribute with a
defined value; their raw LaTeX is the content, HTML-escaped, so the artifact
never hides anything. The block's exact source span lives in the source
block, not on the element (spans are session state, never persisted).

Two reading-surface refinements, byte-exact underneath (the island's
textContent is still the raw source, and emit reads only that): an island
whose source provably sets no type (`\looseness=-1`, `\clearpage`,
`\pgfplotsset{…}`) adds class `dia-tex-quiet` and the theme hides it; an
island that is one parameterless text macro (`\model`) adds class
`dia-tex-macro` + `data-dia-expand="<expansion>"`, hides the raw source in
an inner `span.dia-tex-src`, and shows the expansion via CSS `::after` —
display only, never emitted.

Persisted document attributes beyond PROFILE.md §7, the complete list:
`data-dia-doc-version` · `data-dia-float` (`doc/float`, error: figure ·
table) · `data-dia-label` · `data-dia-env` · `data-dia-ref` ·
`data-dia-ref-cmd` · `data-dia-cite` · `data-dia-cite-opt` ·
`data-dia-cite-cmd` · `data-dia-cite-pre` · `data-dia-graphic-opts` ·
`data-dia-graphic-path` · `data-dia-colspec` · `data-dia-expand`.
Anything else `data-dia-*` is `content/unknown-dia-attr` (error).

Content rules shared with the deck profile, scoped to the article:
`content/script`, `content/embed`, `content/event-handler`,
`content/editor-artifact`, `content/inline-color` (advisory).

- `doc/ref-known` (advisory) — a `data-dia-ref` key with no matching
  `data-dia-label` anywhere in the article.

## 4. Comments

- `doc/comments` (error when present) — at most one
  `<script type="application/json" id="dia-comments">`; JSON with a
  `threads` array. Thread schema (owned by the comment store):
  `{id, status: open|resolved|orphaned, anchor, notes: [{by, at, text}]}`
  where `anchor` is a block locator + character offsets + exact quote with
  prefix/suffix context. Comments are annotations, NOT edits: creating one
  never changes the LaTeX source or the rendered body.

`.tex` export carries comments as a trailer every TeX toolchain ignores:

```
% === dia:comments v1 ===
% dia:comment {"id":"…","anchor":{…},"notes":[…]}
```

Import strips the trailer back into the comments block, so
tex → diastil → tex round-trips comments.

Anchors are maintained, never trusted blindly. On load and after every edit
the store walks a ladder — recorded offsets still cut out the quote; the
quote plus its context found elsewhere in the block; a unique occurrence
anywhere in the article; otherwise `orphaned`. An orphaned thread is kept
and shown, never dropped, and returns to `open` if its text comes back.

## 5. Round-trip guarantees

- `serializeDoc(loadDoc(x)) === x` byte-for-byte for any artifact this
  serializer wrote (`src/model/doc.roundtrip.test.ts`).
- Opening a `.tex` and exporting untouched returns the source byte-identical
  (spans, not a re-serializer: unedited blocks re-emit their exact bytes).
- Editing one block leaves every other byte of the exported `.tex`
  unchanged.

## 6. The document runtime

`script#dia-doc-runtime` is the artifact's ONLY script, and the one
exception to "nothing executes" — it exists so a reader who opens the file
in a plain browser can see that a passage carries discussion instead of
having to open the editor to find out. It is emitted verbatim from a
constant (`src/doc/runtime.ts`), only when the comments block holds at
least one thread, and it is bounded by construction: zero dependencies,
fail-silent, read-only. It reads `#dia-comments`, finds each open thread's
quote by text search, and wraps it in a `<span data-doc-note>` with a dotted
underline and the first note as its `title`. It writes nothing back, adds no
`data-dia-*` attribute, and the editor regenerates the body from the LaTeX
source on load, so its marks can never enter a saved file.

Because the string is constant, `serializeDoc` stays byte-stable with it.
Validators accept the block's absence and presence.

Still reserved: the `doc/source-sync` advisory (body-vs-source divergence
reporting at save time).
