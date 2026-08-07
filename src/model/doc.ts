/* Document (LaTeX-backed) lifecycle: load, serialize, .tex import/export.
 *
 * The LaTeX source is the TRUTH. The saved artifact is self-contained HTML
 * carrying (a) the full source in an inert JSON block, (b) the rendered
 * dialect body so the file reads in any browser with zero runtime deps,
 * (c) comments as an inert JSON block. On load the body is REGENERATED from
 * the source — the stored body exists for plain-browser reading, and when
 * it diverges (out-of-band edit) the source wins, loudly.
 *
 * Round-trip contract, held by doc.roundtrip.test.ts:
 *   serializeDoc(loadDoc(x)) === x           for any x this module wrote
 *   exportTex(loadDocFromTex(t))  === t      when untouched (modulo the
 *                                            comments trailer it owns)   */

import { parseLatex } from '../latex/parse'
import { renderDoc, setRenderMacros } from '../latex/render'
import { DocSource } from '../latex/source'
import { refreshDerived } from '../doc/derived'
import { DOC_RUNTIME } from '../doc/runtime'
import { freshId, scopeToHost, unscopeFromHost } from './parse'

export interface Doc {
  /** shadow root hosting the theme styles and the article */
  root: ShadowRoot
  themeStyle: HTMLStyleElement
  /** the rendered dialect body — article.dia-doc, a direct root child */
  article: HTMLElement
  /** LaTeX truth + session-only block-id → span map */
  source: DocSource
  /** raw JSON text of the comments block (owned by the comment store) */
  commentsJson: string
  /** original .tex file name, kept for .tex export */
  texName: string
  headExtras: string
  title: string
  fileName: string
  docVersion: string
}

export const EMPTY_COMMENTS = '{"version":1,"threads":[]}'

/* ---------- load ---------- */

/** load a saved diastil document artifact (self-contained HTML) */
export function loadDoc(html: string, host: HTMLElement, fileName: string): Doc {
  const parsed = new DOMParser().parseFromString(html, 'text/html')

  const srcEl = parsed.querySelector('script#dia-source')
  let tex = ''
  let texName = fileName.replace(/\.html?$/i, '.tex')
  try {
    const j = JSON.parse(srcEl?.textContent ?? '{}') as { tex?: string; fileName?: string }
    tex = j.tex ?? ''
    if (j.fileName) texName = j.fileName
  } catch {
    console.error('dia-doc: #dia-source block is not valid JSON — opening with empty source')
  }

  const commentsEl = parsed.querySelector('script#dia-comments')
  const commentsJson = commentsEl?.textContent?.trim() || EMPTY_COMMENTS

  const headExtras = [...parsed.head.children]
    .filter((el) => !(el instanceof HTMLTitleElement))
    .filter((el) => !(el instanceof HTMLStyleElement))
    .filter((el) => !(el instanceof HTMLScriptElement && (el.id === 'dia-source' || el.id === 'dia-comments')))
    .filter((el) => !(el instanceof HTMLScriptElement && el.getAttribute('type') !== 'application/json'))
    .filter((el) => !el.matches('meta[charset], meta[name="viewport"]'))
    .map((el) => el.outerHTML)
    .join('\n')

  const doc = mountDoc(host, {
    tex,
    themeCss: parsed.querySelector<HTMLStyleElement>('style#dia-theme')?.textContent ?? null,
    commentsJson,
    texName,
    headExtras,
    title: parsed.title || fileName,
    fileName,
    docVersion: parsed.documentElement.getAttribute('data-dia-doc-version') ?? '1',
  })

  // the stored body is presentation-only; when it disagrees with what the
  // source renders to, someone edited the artifact out-of-band — say so
  const stored = parsed.querySelector('article.dia-doc')
  if (stored && normalizeBody(stored.outerHTML) !== normalizeBody(cleanClone(doc.article).outerHTML)) {
    console.warn('dia-doc: stored body diverged from the LaTeX source — the source wins on load')
  }
  return doc
}

/** open a bare .tex file — wraps it into a fresh document */
export function loadDocFromTex(texRaw: string, host: HTMLElement, fileName: string): Doc {
  const { tex, commentsJson } = splitCommentsTrailer(texRaw)
  const parsed = parseLatex(tex)
  const meta = parsed.blocks[0]?.kind === 'preamble' ? parsed.blocks[0].meta : {}
  return mountDoc(host, {
    tex,
    themeCss: null,
    commentsJson,
    texName: fileName,
    headExtras: '',
    title: cleanMetaText(meta.title) || fileName,
    fileName: fileName.replace(/\.tex$/i, '.html'),
    docVersion: '1',
  })
}

interface MountInput {
  tex: string
  themeCss: string | null
  commentsJson: string
  texName: string
  headExtras: string
  title: string
  fileName: string
  docVersion: string
}

function mountDoc(host: HTMLElement, input: MountInput): Doc {
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
  root.replaceChildren()

  const themeStyle = document.createElement('style')
  themeStyle.id = 'dia-theme'
  themeStyle.textContent = scopeToHost(input.themeCss ?? defaultDocThemeCss())
  root.appendChild(themeStyle)

  const editorBase = document.createElement('style')
  editorBase.id = 'dia-editor-base'
  // position: relative makes the host the containing block for editor
  // overlays (comment highlights) mounted beside the article
  // the compiled mirror (doc/blockmirror.ts) lives here too: its crops are
  // editor artifacts, so their CSS must not reach the saved file either
  editorBase.textContent = `
    :host { display: block; position: relative; }
    [data-dia-selected] { outline: 1.5px solid var(--dia-accent); outline-offset: 6px; border-radius: 1px; }
    [contenteditable] { outline: 2px solid var(--dia-accent); outline-offset: 2px; cursor: text; }
    /* A mirrored block shows its crop of the real PDF instead of its HTML
     * form. The block's own markup is NOT touched: element children go away
     * by rule, and the bare text nodes a <p> holds directly collapse with
     * font-size — nothing to strip from the saved file, nothing for the
     * byte-exact emit to trip over. */
    article.dia-doc > *:has(> .de-mirror) { font-size: 0; line-height: 0; position: relative; }
    article.dia-doc > *:has(> .de-mirror) > :not(.de-mirror) { display: none; }
    /* a table lays its children out as table boxes; while it is mirrored it
     * is a plain block holding one picture */
    article.dia-doc > table:has(> .de-mirror) { display: block; }
    /* spacing rides the TOP margin so a measured gap (blockmirror's
     * spaceMirrors) replaces the default instead of stacking on it */
    .de-mirror { display: block; margin: 0.42rem auto 0 0; cursor: text; }
    /* one part per (page, column) segment of the block's typeset output —
     * a paragraph that crossed a column break stacks its two portions */
    .de-mirror-part { display: block; }
    /* a block whose words already appear inside a neighbour's crop (run-in
     * headings, math sharing a source line) or that typesets nothing
     * (\clearpage) hides rather than doubling; a content block the compile
     * could not place keeps its HTML form with a quiet dotted edge */
    article.dia-doc > *:has(> .de-mirror-hidden) { display: none; }
    article.dia-doc > *:has(> .de-unmirrored) {
      border-left: 2px dotted color-mix(in srgb, var(--dia-ink-soft) 45%, transparent);
      padding-left: 0.6rem; }
    .de-mirror-part + .de-mirror-part { margin-top: 0.18rem; }
    /* the crop is trimmed to its own ink, so the vertical rhythm between
     * blocks is this file's job again — roughly what the theme spends */
    article.dia-doc > h1.dia-sec > .de-mirror, article.dia-doc > h2.dia-sec > .de-mirror,
    article.dia-doc > h3.dia-sec > .de-mirror,
    article.dia-doc > h4.dia-sec > .de-mirror, article.dia-doc > h5.dia-sec > .de-mirror,
    article.dia-doc > figure > .de-mirror, article.dia-doc > div.dia-math > .de-mirror,
    article.dia-doc > div.dia-tex-island > .de-mirror, article.dia-doc > table > .de-mirror
      { margin-top: 1rem; margin-bottom: 0.7rem; }
    /* theme matching by BLEND, not recolor: multiply melts the page's white
     * into light paper; on dark paper the picture inverts (hue-rotate keeps
     * chart colors) and screens, so its black page melts the same way */
    .de-mirror img { display: block; width: 100%; height: auto; mix-blend-mode: multiply; }
    .de-mirror.de-dark img { filter: invert(1) hue-rotate(180deg); mix-blend-mode: screen; }
    /* an edited block is HTML again until the recompile lands; the marker
     * says the render is catching up, quietly */
    /* an edited block waiting for its recompile must READ as waiting: the
     * whole block tints and carries a hairline, not just a whisper of a
     * label — the user could not tell which sections were pending */
    article.dia-doc > *:has(> .de-stale) { position: relative;
      background: color-mix(in srgb, var(--dia-accent) 5%, transparent);
      outline: 1px dashed color-mix(in srgb, var(--dia-accent) 45%, transparent);
      outline-offset: 5px; border-radius: 1px; }
    .de-stale { position: absolute; right: 0; top: -1.15rem; font-family: var(--dia-face-label);
      font-size: 0.62rem; line-height: 1.6; letter-spacing: .1em; text-transform: uppercase;
      color: var(--dia-accent); padding: 0 0.45em;
      border: 1px solid color-mix(in srgb, var(--dia-accent) 45%, transparent); border-radius: 3px;
      background: var(--dia-paper);
      pointer-events: none; animation: de-stale-pulse 1.7s ease-in-out infinite; }
    @keyframes de-stale-pulse { 0%, 100% { opacity: .45 } 50% { opacity: 1 } }
  `
  root.appendChild(editorBase)

  const source = new DocSource(input.tex)
  const parsedDoc = parseLatex(input.tex)
  const preamble = parsedDoc.blocks[0]
  const pmeta = preamble?.kind === 'preamble' ? preamble.meta : undefined
  setRenderMacros(pmeta?.textMacros, pmeta?.quietMacros)
  const rendered = renderDoc(parsedDoc)
  root.appendChild(rendered.article)

  // session ids everywhere; top-level blocks bind their source spans
  for (const el of [rendered.article, ...rendered.article.querySelectorAll<HTMLElement>('*')]) {
    if (!el.hasAttribute('data-dia-id')) el.setAttribute('data-dia-id', freshId('d'))
  }
  for (const b of rendered.blocks) {
    source.bind(b.el.getAttribute('data-dia-id') as string, b.span)
  }

  // resolve derived content (ref numbers) BEFORE any serialization — the
  // pass re-seals render memos, so emit stays byte-exact afterwards
  refreshDerived(rendered.article)

  return {
    root,
    themeStyle,
    article: rendered.article,
    source,
    commentsJson: input.commentsJson,
    texName: input.texName,
    headExtras: input.headExtras,
    title: input.title,
    fileName: input.fileName,
    docVersion: input.docVersion,
  }
}

/* ---------- serialize ---------- */

export function serializeDoc(doc: Doc): string {
  const styles = [...doc.root.querySelectorAll('style')]
    .filter((s) => s.id !== 'dia-editor-base')
    .filter((s) => !s.classList.contains('dia-editor-artifact'))
    .map((s) => `<style${s.id ? ` id="${s.id}"` : ''}>\n${unscopeFromHost(s.textContent ?? '').trim()}\n</style>`)
    .join('\n')

  const article = cleanClone(doc.article).outerHTML

  // the read-only comment markers ride along only when there is something to
  // mark — a comment-free document stays a script-free document
  const runtime = threadsOf(doc.commentsJson).length > 0
    ? `\n<script id="dia-doc-runtime">\n${DOC_RUNTIME}\n</script>`
    : ''

  return `<!doctype html>
<html lang="en" data-dia-doc-version="${doc.docVersion}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(doc.title)}</title>
${doc.headExtras ? doc.headExtras + '\n' : ''}<script type="application/json" id="dia-source">
${inertJson(JSON.stringify({ version: 1, fileName: doc.texName, tex: doc.source.text }))}
</script>
<script type="application/json" id="dia-comments">
${inertJson(doc.commentsJson)}
</script>
${styles}
</head>
<body>
${article}${runtime}
</body>
</html>
`
}

/** export the LaTeX truth, with comments carried as a structured trailer
 * every real TeX toolchain ignores */
export function exportTex(doc: Doc): string {
  const threads = threadsOf(doc.commentsJson)
  let out = doc.source.text
  if (threads.length > 0) {
    if (!out.endsWith('\n')) out += '\n'
    out += COMMENTS_TRAILER_HEAD + '\n'
    for (const t of threads) out += `% dia:comment ${JSON.stringify(t)}\n`
  }
  return out
}

/* ---------- comments trailer ---------- */

const COMMENTS_TRAILER_HEAD = '% === dia:comments v1 ==='

/** strip a comments trailer from .tex text; returns the bare source and the
 * reconstructed comments JSON */
export function splitCommentsTrailer(texRaw: string): { tex: string; commentsJson: string } {
  const at = texRaw.lastIndexOf(COMMENTS_TRAILER_HEAD)
  if (at < 0) return { tex: texRaw, commentsJson: EMPTY_COMMENTS }
  const threads: unknown[] = []
  for (const line of texRaw.slice(at).split('\n')) {
    const m = line.match(/^% dia:comment (.*)$/)
    if (!m) continue
    try {
      threads.push(JSON.parse(m[1]))
    } catch {
      console.warn('dia-doc: unreadable dia:comment line dropped from trailer')
    }
  }
  return {
    tex: texRaw.slice(0, at),
    commentsJson: JSON.stringify({ version: 1, threads }),
  }
}

function threadsOf(commentsJson: string): unknown[] {
  try {
    const j = JSON.parse(commentsJson) as { threads?: unknown[] }
    return Array.isArray(j.threads) ? j.threads : []
  } catch {
    return []
  }
}

/* ---------- helpers ---------- */

const EDITOR_ATTRS = ['data-dia-id', 'contenteditable', 'spellcheck', 'data-dia-selected', 'data-dia-current']

function cleanClone(el: Element): HTMLElement {
  const clone = el.cloneNode(true) as HTMLElement
  for (const node of [clone, ...clone.querySelectorAll<HTMLElement>('*')]) {
    for (const a of EDITOR_ATTRS) node.removeAttribute(a)
    if (node.classList.contains('dia-editor-artifact')) node.remove()
  }
  return clone
}

/** whitespace-insensitive body compare for the divergence warning only */
function normalizeBody(html: string): string {
  return html.replace(/\s+/g, ' ').trim()
}

/** JSON destined for an inline <script> block: escape `<` so `</script>`
 * inside string values (legal in verbatim TeX) cannot close the block */
function inertJson(json: string): string {
  return json.replace(/</g, '\\u003c')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function cleanMetaText(tex: string | undefined): string {
  if (!tex) return ''
  return tex
    .replace(/\\and\b/g, ' · ')
    .replace(/\\\\/g, ' ')
    .replace(/\\thanks\{[^}]*\}/g, '')
    .replace(/\\[a-zA-Z]+/g, ' ')
    .replace(/[{}~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/* ---------- document theme ---------- */

export function defaultDocThemeCss(): string {
  return `:host {
  --dia-paper: #fbfaf6;
  --dia-ink: #17242b;
  --dia-ink-soft: #3d4a52;
  --dia-accent: #b4552d;
  --dia-rule: #d9d4c8;
  --dia-face-display: Georgia, "Times New Roman", serif;
  --dia-face-body: Georgia, "Times New Roman", serif;
  --dia-face-label: ui-monospace, "SF Mono", Menlo, monospace;
  --dia-doc-measure: 44rem;
  --dia-doc-size: 17px;
}
article.dia-doc {
  max-width: var(--dia-doc-measure);
  margin: 0 auto;
  padding: 3rem 1.5rem 6rem;
  background: var(--dia-paper);
  color: var(--dia-ink);
  font-family: var(--dia-face-body);
  font-size: var(--dia-doc-size);
  line-height: 1.6;
}
.dia-doc-header { margin-bottom: 2.5rem; }
.dia-doc-header .dia-title { font-family: var(--dia-face-display); font-size: 1.9em;
  line-height: 1.2; font-weight: 700; margin: 0 0 0.4em; }
.dia-doc-authors { color: var(--dia-ink-soft); }
.dia-abstract { margin: 2rem 2rem 2.5rem; font-size: 0.94em; color: var(--dia-ink-soft); }
.dia-abstract::before { content: "abstract"; display: block; font-family: var(--dia-face-label);
  font-size: 0.72em; letter-spacing: .14em; text-transform: uppercase; color: var(--dia-accent);
  margin-bottom: 0.6em; }
h1.dia-sec, h2.dia-sec, h3.dia-sec, h4.dia-sec, h5.dia-sec { font-family: var(--dia-face-display);
  line-height: 1.25; margin: 1.8em 0 0.6em; }
h1.dia-sec { font-size: 1.85em; margin-top: 2.4em; }
h2.dia-sec { font-size: 1.45em; }
h3.dia-sec { font-size: 1.2em; }
h4.dia-sec, h5.dia-sec { font-size: 1.05em; }
article.dia-doc p { margin: 0 0 1em; }
article.dia-doc dl dt { font-weight: 700; margin-top: 0.6em; }
article.dia-doc dl dd { margin: 0 0 0.4em 1.4em; }
.dia-wrap-center, .dia-wrap-figure { text-align: center; }
.dia-wrap-quote, .dia-wrap-quotation { margin: 1em 2em; color: var(--dia-ink-soft); }
.dia-wrap-framed, .dia-wrap-mdframed { border: 1px solid var(--dia-rule); padding: 0.8em 1em;
  margin: 1em 0; }
figure.dia-figure { margin: 1.6em 0; text-align: center; }
figure.dia-figure img.dia-graphic { max-width: 100%; }
figure.dia-figure .dia-graphic-slot { border: 1px dashed var(--dia-rule);
  padding: 1.6em 1em; font-family: var(--dia-face-label); font-size: 0.8em;
  color: var(--dia-ink-soft); overflow-wrap: anywhere; }
figure.dia-figure .dia-graphic-slot::before { content: "graphic — resolves in the compiled PDF";
  display: block; font-size: 0.85em; letter-spacing: .1em; text-transform: uppercase;
  color: var(--dia-accent); margin-bottom: 0.5em; }
figure.dia-figure figcaption { font-size: 0.88em; color: var(--dia-ink-soft); margin-top: 0.6em;
  text-align: left; }
article.dia-doc table { border-collapse: collapse; margin: 1.2em auto; font-size: 0.92em; }
article.dia-doc td { border-top: 1px solid var(--dia-rule); border-bottom: 1px solid var(--dia-rule);
  padding: 0.35em 0.7em; }
div.dia-math { margin: 1.2em 0; text-align: center; }
div.dia-math math[display="block"] { margin: 0 auto; }
span.dia-math-inline { white-space: nowrap; }
.dia-math-src { font-family: var(--dia-face-label); font-size: 0.85em; text-align: left; }
pre.dia-verbatim { font-family: var(--dia-face-label); font-size: 0.85em; line-height: 1.45;
  background: color-mix(in srgb, var(--dia-ink) 5%, var(--dia-paper)); padding: 0.8em 1em;
  overflow-x: auto; }
code.dia-verb { font-family: var(--dia-face-label); font-size: 0.9em; }
a.dia-ref, a.dia-cite { color: var(--dia-accent); text-decoration: none; }
a.dia-url { color: var(--dia-accent); }
.dia-footnote { font-size: 0.82em; color: var(--dia-ink-soft); }
.dia-footnote::before { content: "\\2020\\00a0"; color: var(--dia-accent); }
.dia-label { display: none; }
.dia-maketitle { display: none; }
.dia-smallcaps { font-variant-caps: small-caps; }
div.dia-tex-island { margin: 1.2em 0; }
div.dia-tex-island > pre, span.dia-tex-island { font-family: var(--dia-face-label);
  font-size: 0.82em; line-height: 1.45; color: var(--dia-ink-soft);
  border-left: 3px solid var(--dia-rule); padding: 0.5em 0.9em; overflow-x: auto; }
span.dia-tex-island { display: inline; border-left: none; padding: 0 0.15em; }
span.dia-tex-island.dia-tex-quiet, div.dia-tex-island.dia-tex-quiet,
.dia-tex-quiet { display: none; }
.dia-sans { font-family: var(--dia-face-body, sans-serif); }
div.dia-wrap-tcolorbox { border: 1px solid var(--dia-rule); border-radius: 4px;
  padding: 0.7em 1em; margin: 1.2em 0;
  background: color-mix(in srgb, var(--dia-ink) 3%, var(--dia-paper)); }
div.dia-wrap-minipage, div.dia-wrap-subfigure, div.dia-wrap-subtable { margin: 0.8em 0; }
div.dia-wrap-theorem, div.dia-wrap-lemma, div.dia-wrap-proposition,
div.dia-wrap-corollary, div.dia-wrap-definition, div.dia-wrap-remark,
div.dia-wrap-example, div.dia-wrap-claim, div.dia-wrap-fact,
div.dia-wrap-observation, div.dia-wrap-conjecture, div.dia-wrap-proof {
  margin: 1.1em 0; font-style: italic; }
div.dia-wrap-proof, div.dia-wrap-remark, div.dia-wrap-example { font-style: normal; }
div.dia-wrap-theorem::before, div.dia-wrap-lemma::before,
div.dia-wrap-proposition::before, div.dia-wrap-corollary::before,
div.dia-wrap-definition::before, div.dia-wrap-remark::before,
div.dia-wrap-example::before, div.dia-wrap-claim::before,
div.dia-wrap-fact::before, div.dia-wrap-observation::before,
div.dia-wrap-conjecture::before {
  font-weight: 650; font-style: normal; text-transform: capitalize;
  content: attr(data-dia-env) ".\\00a0\\00a0"; float: left; margin-right: 0.15em; }
div.dia-wrap-proof::before { content: "Proof.\\00a0\\00a0"; font-style: italic;
  float: left; margin-right: 0.15em; }
span.dia-tex-island.dia-tex-macro { font-family: inherit; font-size: inherit;
  color: inherit; padding: 0; }
span.dia-tex-macro > .dia-tex-src { display: none; }
span.dia-tex-macro::after { content: attr(data-dia-expand); }
`
}
