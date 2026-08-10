/* Find & replace for the native document view (and the matcher the raw
 * source view's find bar runs on, so there is ONE answer to "does this
 * match", not two).
 *
 * Two rules shape everything here.
 *
 * 1. A SEARCH MOVES NOTHING. Highlights are decoration: they are painted
 *    with the CSS custom highlight registry from Ranges, so nothing wraps,
 *    marks or annotates the matched text itself. The house pattern for
 *    editor chrome is `dia-editor-artifact` (blockmirror.ts's opening
 *    comment), but a <mark> wrapper cannot use it here — cleanOuter and
 *    serializeDoc REMOVE artifact elements, so a wrapped match would take
 *    the matched words with it, and emit.ts would drop them from the .tex.
 *    Ranges are the only decoration that is provably invisible to the
 *    serializer. The two nodes this module does put in the document sit
 *    beside the prose and never around it: one artifact <style> in the
 *    shadow root, and — on a block whose text is hidden under a compiled
 *    crop — a count inside that crop's own artifact wrapper, which
 *    serializeDoc strips whole (blockmirror's flagCrops argues it).
 *
 * 2. A REPLACE IS AN EDIT. It goes through doc/sync's paired op so the DOM
 *    change and the source patch are one invertible step, and the
 *    replacement lands in a TEXT NODE — emit.ts's escapeTex then owns the
 *    LaTeX escaping, which is why a replacement containing % _ & # $ or \
 *    survives export and re-parse (docfind.test.ts property-tests it).
 *
 * What counts as a match is not "all the text on screen". A rendered
 * document holds four kinds of text and only one is both visible AND
 * safely rewritable:
 *
 *  - PROSE — emitted through emitInlines. Found and replaced.
 *  - RAW LATEX — `.dia-tex-island` text IS the source bytes (emit copies
 *    textContent verbatim). Visible islands are FOUND, because the glyphs
 *    on screen are the truth, but never replaced here: the replacement
 *    would land unescaped, so "50%" would comment out the rest of the line.
 *    Islands the theme hides (`.dia-tex-quiet`) are not on screen at all,
 *    so they are counted as "elsewhere" instead of highlighted.
 *  - RENDERED MATH — `.dia-math`. Its truth is `data-dia-tex`; the MathML
 *    is a RENDERING of it, and temml sets \sin as the glyphs "sin" and
 *    \alpha as "α". Matching those and writing back would mangle a formula
 *    that never contained the letters searched for, so the whole subtree is
 *    skipped and the TeX attribute is searched separately, for the count
 *    only — the bar says "2 more in math", the source view is where you
 *    change them.
 *  - DERIVED — a `\ref`'s number, a `\cite`'s key, the title header: the
 *    text is computed from an attribute or the preamble, so writing to it
 *    would be silently discarded on emit. Found, never replaced.
 *
 * A match never crosses an element boundary: "with style" does not match
 * `with <strong>style</strong>` because a replacement across that boundary
 * has to decide which side keeps the emphasis and there is no honest
 * answer. Whitespace is the other way round — the DOM text still carries
 * the source's newlines and runs of spaces that the reader sees as one
 * space, so the matcher collapses them and maps back to the raw offsets. */

import type { Op } from '../types'
import type { Doc } from '../model/doc'
import { state } from '../state'
import { batch, setInlineHtml } from '../model/ops'
import { syncedDocOp, topBlockOf } from '../doc/sync'
import { type CropFlag, cropShowing, flagCrops, peekBlock } from '../doc/blockmirror'
import { flashBlock } from './docview'
import { setFindCounts } from './outline'

/* ---------- the matcher (pure) ---------- */

export interface FindOpts {
  caseSensitive?: boolean
  wholeWord?: boolean
  /** collapse whitespace runs before matching — true for rendered text
   * (the reader sees one space), false for the raw source view (where a
   * newline is a newline and a match must stay on one line) */
  collapseSpace?: boolean
}

export interface Hit {
  start: number
  end: number
}

/** hard ceiling: a one-letter needle over a book must not hang the tab */
const MAX_HITS = 5000

/** collapsed text + a map from every collapsed index to its raw index
 * (length + 1 entries, so the end of a match maps too) */
function collapse(raw: string): { text: string; map: number[] } {
  let text = ''
  const map: number[] = []
  let i = 0
  while (i < raw.length) {
    if (/\s/.test(raw[i])) {
      map.push(i)
      text += ' '
      while (i < raw.length && /\s/.test(raw[i])) i++
    } else {
      map.push(i)
      text += raw[i]
      i++
    }
  }
  map.push(raw.length)
  return { text, map }
}

const WORD = /[\p{L}\p{N}_]/u

function isWordBoundary(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1] : ''
  const after = end < text.length ? text[end] : ''
  return !(before && WORD.test(before)) && !(after && WORD.test(after))
}

/** every non-overlapping occurrence of `needle` in `haystack`, as offsets
 * into the RAW string (whatever the collapsing did internally) */
export function findInText(haystack: string, needle: string, opts: FindOpts = {}): Hit[] {
  const collapsing = opts.collapseSpace ?? true
  const hay = collapsing ? collapse(haystack) : { text: haystack, map: null }
  const term = collapsing ? collapse(needle).text : needle
  if (term.length === 0) return []
  const a = opts.caseSensitive ? hay.text : hay.text.toLowerCase()
  const b = opts.caseSensitive ? term : term.toLowerCase()
  const hits: Hit[] = []
  let at = a.indexOf(b)
  while (at >= 0 && hits.length < MAX_HITS) {
    const end = at + b.length
    if (!opts.wholeWord || isWordBoundary(a, at, end)) {
      hits.push(hay.map ? { start: hay.map[at], end: hay.map[end] } : { start: at, end })
    }
    at = a.indexOf(b, end)
  }
  return hits
}

/** replace every occurrence in a plain string — the raw source view's
 * replace-all. The replacement is LITERAL: `$&` and `\1` are characters,
 * not patterns (String.replace would have read them as backreferences). */
export function replaceAllIn(
  text: string, needle: string, replacement: string, opts: FindOpts = {},
): { text: string; count: number } {
  const hits = findInText(text, needle, opts)
  if (hits.length === 0) return { text, count: 0 }
  let out = ''
  let last = 0
  for (const h of hits) {
    out += text.slice(last, h.start) + replacement
    last = h.end
  }
  return { text: out + text.slice(last), count: hits.length }
}

/* ---------- matching a rendered document ---------- */

export interface DocMatch {
  node: Text
  /** offsets into node.data */
  start: number
  end: number
  /** the source-backed top-level block, null when the text is not backed
   * by source at all (the derived title header) */
  block: HTMLElement | null
  replaceable: boolean
}

export interface DocMatches {
  matches: DocMatch[]
  /** occurrences that live in LaTeX the native view refuses to touch —
   * formulas' TeX and islands the theme hides. Reported, not highlighted. */
  elsewhere: number
}

/** subtrees whose DOM text is not the document's text: editor chrome, the
 * rendering of a formula, hidden islands, and the attribute-backed markers */
const SKIP = '.dia-editor-artifact, .dia-math, .dia-tex-quiet, .dia-label, .dia-maketitle'
/** text that IS raw LaTeX — findable, never rewritten from here */
const RAW = '.dia-tex-island'
/** text computed from somewhere else, so a write to it would be discarded */
const DERIVED = 'a.dia-ref, a.dia-cite, header.dia-doc-header'

export function collectDocMatches(doc: Doc, needle: string, opts: FindOpts = {}): DocMatches {
  const matches: DocMatch[] = []
  let elsewhere = 0
  if (needle.length === 0) return { matches, elsewhere }

  const walk = (node: Node, writable: boolean): void => {
    if (matches.length >= MAX_HITS) return
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node as Text
      for (const h of findInText(text.data, needle, opts)) {
        const block = topBlockOf(doc, text.parentElement ?? doc.article)
        matches.push({
          node: text, start: h.start, end: h.end, block,
          replaceable: writable && block !== null,
        })
        if (matches.length >= MAX_HITS) return
      }
      return
    }
    if (!(node instanceof Element)) return
    if (node.matches(SKIP)) {
      // the formula's truth and the hidden island's bytes are still worth
      // COUNTING — the user typed a term that is in this document, and
      // saying "0" would be a lie
      elsewhere += findInText(node.getAttribute('data-dia-tex') ?? '', needle, opts).length
      if (node.matches(RAW)) elsewhere += findInText(node.textContent ?? '', needle, opts).length
      return
    }
    const stillWritable = writable && !node.matches(RAW) && !node.matches(DERIVED)
    for (const child of node.childNodes) walk(child, stillWritable)
  }
  walk(doc.article, true)
  return { matches, elsewhere }
}

/* ---------- replace as an edit ---------- */

/** the paired op for a set of matches, or null when none is writable.
 *
 * Undo granularity: ONE op for the whole replace, however many blocks it
 * touched. Replace-all is one thing the user did — sixty ctrl-Zs to undo
 * one click is not undo, it is punishment — and the copilot already
 * establishes the shape (copilot/compile.ts batches syncedDocOp values).
 * Per block it is still exactly one syncedBlockOp, so the source patch and
 * the byte-exact inverse are unchanged; only the wrapper is new. */
export function buildReplaceOp(
  doc: Doc, matches: DocMatch[], replacement: string, label: string,
): Op | null {
  const byBlock = new Map<HTMLElement, DocMatch[]>()
  for (const m of matches) {
    if (!m.replaceable || !m.block) continue
    if (!m.node.isConnected) continue // a stale hit from before the last edit
    const list = byBlock.get(m.block)
    if (list) list.push(m)
    else byBlock.set(m.block, [m])
  }
  if (byBlock.size === 0) return null

  const ops: Op[] = []
  for (const [block, hits] of byBlock) {
    const domOps = blockReplaceOps(block, hits, replacement)
    if (domOps.length > 0) ops.push(syncedDocOp(doc, block, domOps, label))
  }
  if (ops.length === 0) return null
  return ops.length === 1 ? ops[0] : batch(label, ops)
}

/** the DOM ops for one block's hits.
 *
 * The write target is the smallest element that can carry the change: the
 * matched text node's own parent, so `\textbf{style}` stays bold and the
 * block's other children keep their identity (and therefore their render
 * memos, and therefore their exact original bytes). Hosts that NEST are
 * merged into the outer one — setting the outer host's innerHTML detaches
 * the inner one, so a second op against it would apply to a dead node.
 *
 * The value is read the way textedit.ts reads it: mutate, snapshot the
 * markup, put the original back, and let setInlineHtml capture the true
 * previous children for the inverse. */
function blockReplaceOps(block: HTMLElement, hits: DocMatch[], replacement: string): Op[] {
  const byNode = new Map<Text, DocMatch[]>()
  for (const h of hits) {
    const list = byNode.get(h.node)
    if (list) list.push(h)
    else byNode.set(h.node, [h])
  }

  const hosts: HTMLElement[] = []
  for (const node of byNode.keys()) {
    const host = node.parentElement
    if (host && !hosts.includes(host)) hosts.push(host)
  }
  const outer = hosts.filter((h) => !hosts.some((other) => other !== h && other.contains(h)))
  if (outer.length === 0) return []

  const originals = new Map<Text, string>()
  for (const [node, list] of byNode) {
    originals.set(node, node.data)
    // right to left, so earlier hits keep their offsets
    const sorted = [...list].sort((a, b) => b.start - a.start)
    let data = node.data
    for (const h of sorted) data = data.slice(0, h.start) + replacement + data.slice(h.end)
    node.data = data
  }
  const html = outer.map((h) => h.innerHTML)
  for (const [node, data] of originals) node.data = data
  return outer.map((h, i) => setInlineHtml(h, html[i]))
}

/* ---------- the find bar ---------- */

/** Chrome/Safari paint Ranges through the highlight registry with no DOM at
 * all. Where it is missing (and in the test environment, which has no
 * layout either) the bar still counts, steps and replaces — it just cannot
 * shade, so the current match is carried by the block flash instead. */
interface HighlightCtor { new (...ranges: Range[]): unknown }
const registry = (CSS as unknown as { highlights?: Map<string, unknown> } | undefined)?.highlights
const HighlightImpl = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight
const canPaint = registry !== undefined && typeof HighlightImpl === 'function'

const HIGHLIGHT_CSS = `
::highlight(dia-find) { background-color: color-mix(in srgb, var(--dia-accent) 28%, transparent); }
::highlight(dia-find-at) { background-color: var(--dia-accent); color: var(--dia-paper); }
`

let bar: HTMLElement | null = null
let input!: HTMLInputElement
let replaceRow!: HTMLElement
let replaceInput!: HTMLInputElement
let count!: HTMLElement
let note!: HTMLElement
let caseBtn!: HTMLButtonElement
let wordBtn!: HTMLButtonElement
let nativeViewOpen: () => boolean = () => true

let hits: DocMatch[] = []
let at = -1
let elsewhere = 0
let opts: FindOpts = { caseSensitive: false, wholeWord: false }

export function mountDocFind(mainEl: HTMLElement, isNativeViewOpen: () => boolean): void {
  nativeViewOpen = isNativeViewOpen
  // a fresh bar draws its toggles off, so the options it reads start off too
  opts = { caseSensitive: false, wholeWord: false }

  bar = el('div', 'de-find')
  bar.hidden = true
  const findRow = el('div', 'de-find-row')
  input = document.createElement('input')
  input.className = 'dn-input'
  input.placeholder = 'find in document'
  input.setAttribute('spellcheck', 'false')
  count = el('span', 'de-find-count')
  caseBtn = toggle('Aa', 'match case', () => { opts = { ...opts, caseSensitive: !opts.caseSensitive }; sync() })
  wordBtn = toggle('ab', 'whole word', () => { opts = { ...opts, wholeWord: !opts.wholeWord }; sync() })
  const prev = button('‹', 'previous match', () => step(-1))
  const next = button('›', 'next match', () => step(1))
  const close = button('✕', 'close (esc)', () => closeDocFind())
  findRow.append(input, count, caseBtn, wordBtn, prev, next, close)

  replaceRow = el('div', 'de-find-row de-find-replace')
  replaceRow.hidden = true
  replaceInput = document.createElement('input')
  replaceInput.className = 'dn-input'
  replaceInput.placeholder = 'replace with'
  replaceInput.setAttribute('spellcheck', 'false')
  const one = button('replace', 'replace this match', () => replaceCurrent())
  one.classList.add('de-find-wide')
  const all = button('all', 'replace every match', () => replaceAll())
  all.classList.add('de-find-wide')
  replaceRow.append(replaceInput, one, all)

  note = el('div', 'de-find-note')
  note.hidden = true
  bar.append(findRow, replaceRow, note)
  mainEl.append(bar)

  input.addEventListener('input', () => refresh(0))
  for (const field of [input, replaceInput]) {
    field.addEventListener('keydown', (e) => {
      // the bar is a typing surface: nothing leaks to the shell's globals
      e.stopPropagation()
      const mod = e.metaKey || e.ctrlKey
      if (e.key === 'Escape') { e.preventDefault(); closeDocFind(); return }
      if (mod && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); input.focus(); input.select(); return }
      if (mod && (e.key === 'h' || e.key === 'H')) { e.preventDefault(); showReplace(true); return }
      if (e.key === 'Enter') {
        e.preventDefault()
        if (field === replaceInput) replaceCurrent()
        else step(e.shiftKey ? -1 : 1)
      }
    })
  }

  // the hits hold live text nodes: any edit (ours, a neighbour's, an undo)
  // can detach them, so the search re-runs against the document as it is
  state.bus.on((e) => {
    if (bar?.hidden) return
    if (e.type === 'doc-loaded' || e.type === 'deck-loaded') { closeDocFind(); return }
    if (e.type === 'op' || e.type === 'undo' || e.type === 'redo' || e.type === 'blocks-changed') {
      refresh(at)
    }
  })
}

export function docFindOpen(): boolean {
  return bar !== null && !bar.hidden
}

/** open the bar (with the replace row when asked), seeded from the current
 * term; called by the shell's Ctrl+F / Ctrl+H */
export function openDocFind(replace = false): void {
  if (!bar || !state.doc) return
  // Ctrl+F on an open replace bar does NOT collapse the replace row — the
  // row is a mode the user chose, and the key they pressed was "find"
  const wasOpen = !bar.hidden
  bar.hidden = false
  installHighlightStyle()
  if (replace) showReplace(true)
  else if (!wasOpen) replaceRow.hidden = true
  const field = replace && input.value ? replaceInput : input
  field.focus()
  field.select()
  refresh(0)
}

export function closeDocFind(): void {
  if (!bar) return
  bar.hidden = true
  hits = []
  at = -1
  paint()
}

/** Does this Ctrl+F belong to the document surface, or to the browser?
 *
 * shell.ts already reads composedPath for its typing exemption (an INPUT,
 * TEXTAREA or contenteditable in the path swallows the global keys). Find
 * needs the same path read one notch finer: a contenteditable INSIDE the
 * article is still the document surface — you are mid-edit in the prose you
 * want to search — while a rail input or the source view is not, and with
 * no document open the browser's own find is none of our business. */
export function docFindOwnsKey(e: KeyboardEvent): boolean {
  if (!state.doc || !nativeViewOpen()) return false
  for (const t of e.composedPath()) {
    if (!(t instanceof HTMLElement)) continue
    if (bar && (t === bar || bar.contains(t))) return true
    if (t.classList.contains('de-src') || t.classList.contains('de-rail')) return false
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return false
    if (t.isContentEditable) return state.doc.article.contains(t)
  }
  return true
}

/* ---------- bar behaviour ---------- */

function showReplace(on: boolean): void {
  replaceRow.hidden = !on
  if (on) { replaceInput.focus(); replaceInput.select() }
}

function sync(): void {
  caseBtn.classList.toggle('is-on', !!opts.caseSensitive)
  wordBtn.classList.toggle('is-on', !!opts.wholeWord)
  refresh(at)
}

/** re-run the search and land on `keep` (clamped) */
function refresh(keep: number): void {
  const doc = state.doc
  if (!doc || !bar || bar.hidden) return
  const r = collectDocMatches(doc, input.value, opts)
  hits = r.matches
  elsewhere = r.elsewhere
  at = hits.length === 0 ? -1 : Math.min(Math.max(keep, 0), hits.length - 1)
  render()
  if (at >= 0) reveal(hits[at])
}

function render(): void {
  count.textContent = hits.length === 0
    ? (input.value ? '0' : '')
    : `${at + 1}/${hits.length}`
  const bits: string[] = []
  if (elsewhere > 0) {
    bits.push(`${elsewhere} more in math or raw LaTeX — the source view edits those`)
  }
  const locked = hits.filter((h) => !h.replaceable).length
  if (locked > 0 && !replaceRow.hidden) {
    bits.push(`${locked} match${locked === 1 ? '' : 'es'} sit in raw LaTeX or derived text and will not be replaced`)
  }
  note.textContent = bits.join(' · ')
  note.hidden = bits.length === 0
  paint()
}

function step(dir: 1 | -1): void {
  if (hits.length === 0) return
  land((at + dir + hits.length) % hits.length)
}

/** make hit `i` the current one */
function land(i: number): void {
  if (i < 0 || i >= hits.length) return
  at = i
  render()
  reveal(hits[at])
}

function replaceCurrent(): void {
  const doc = state.doc
  if (!doc || at < 0) return
  const target = hits[at]
  const op = buildReplaceOp(doc, [target], replaceInput.value, 'Replace')
  if (!op) {
    note.textContent = 'this match is raw LaTeX or derived text — open the source view to change it'
    note.hidden = false
    return
  }
  const landing = at // the hit disappears, so the next one takes its index
  state.apply(op)
  refresh(landing)
}

function replaceAll(): void {
  const doc = state.doc
  if (!doc || hits.length === 0) return
  const writable = hits.filter((h) => h.replaceable).length
  const op = buildReplaceOp(doc, hits, replaceInput.value, `Replace all (${writable})`)
  if (!op) return
  state.apply(op)
  refresh(0)
}

/* ---------- decoration ---------- */

function installHighlightStyle(): void {
  const doc = state.doc
  if (!doc || doc.root.querySelector('style.de-find-style')) return
  const style = document.createElement('style')
  // artifact class: serializeDoc filters styles by it, so the shading can
  // never reach the saved file
  style.className = 'de-find-style dia-editor-artifact'
  style.textContent = HIGHLIGHT_CSS
  doc.root.append(style)
}

function rangeOf(m: DocMatch): Range | null {
  if (!m.node.isConnected) return null
  try {
    const r = document.createRange()
    r.setStart(m.node, m.start)
    r.setEnd(m.node, m.end)
    return r
  } catch {
    return null // the node changed under us; the next refresh fixes it
  }
}

function paint(): void {
  // A Range shades the text it covers, and a block showing its compiled crop
  // has that text hidden underneath the picture — so on a compiled document
  // the shading landed where nobody could see it (131 of llama.tex's 152
  // blocks were mirrored: the bar said "1 / 5" over a paper with no mark on
  // it anywhere). Lend the current match's block back its HTML form for as
  // long as it holds the match; blockmirror's peekBlock argues the swap, and
  // gives the crop straight back on the next step, on close, and on the
  // recompile in between. Ahead of the canPaint bail: where the registry is
  // missing the reader still gets the block's own words under the flash,
  // which beats a picture with no mark on it.
  peekBlock(at >= 0 ? hits[at]?.block ?? null : null)
  // ...and tell the reader where the OTHER matches are without taking the
  // render away from them: every crop still standing over one gets a count
  // beside it. Ahead of the canPaint bail for the same reason as the loan —
  // a count is a number in the margin, not a shade, and it is the only
  // answer at all where the highlight registry is missing.
  flagCrops(cropCounts())
  // ...and the matches that are on no screen at all. Both answers above are
  // LOCAL — a shade on the match you stand on, a tab on a picture you can
  // see — and "3 / 41" does not say where the other forty went. The outline
  // is the document's own table of contents and it is already open in the
  // column beside the paper, so the counts go there, per section. Ahead of
  // the canPaint bail with the other two, and for the same reason: it is a
  // number in the chrome, not a shade in the prose.
  setFindCounts(matchesByBlock())
  if (!canPaint || !registry) return
  const rest: Range[] = []
  for (const [i, m] of hits.entries()) {
    if (i === at) continue
    const r = rangeOf(m)
    if (r) rest.push(r)
  }
  const cur = at >= 0 ? rangeOf(hits[at]) : null
  const set = (name: string, ranges: Range[]): void => {
    if (ranges.length === 0) registry.delete(name)
    else registry.set(name, new HighlightImpl!(...ranges))
  }
  set('dia-find', rest)
  set('dia-find-at', cur ? [cur] : [])
}

/** How many matches each crop is standing over, and where clicking its
 * count should land.
 *
 * The key is the block whose PICTURE shows the words, not the block that
 * holds them: a run-in heading, or display math sharing a source line, was
 * typeset inside its neighbour's crop, so its matches are under that
 * neighbour's picture and belong to that neighbour's count. cropShowing is
 * blockmirror's answer to which is which; the reader is looking at
 * pictures, not at block boundaries.
 *
 * The current match is never counted. Usually it cannot be — peekBlock has
 * lent its block back its HTML form, so there is no crop left to stand a
 * count on — but a block absorbed into a NEIGHBOUR's crop is un-hidden by
 * the loan while that neighbour keeps its picture, and counting the one
 * match the reader can already see shaded would be the bar's number twice
 * over. */
function cropCounts(): Map<HTMLElement, CropFlag> {
  const seen = new Map<HTMLElement, { count: number; first: number }>()
  for (const [i, m] of hits.entries()) {
    if (i === at || !m.block || !m.node.isConnected) continue
    const crop = cropShowing(m.block)
    if (!crop) continue
    const e = seen.get(crop)
    if (e) e.count++
    else seen.set(crop, { count: 1, first: i })
  }
  const out = new Map<HTMLElement, CropFlag>()
  for (const [crop, e] of seen) out.set(crop, { count: e.count, pick: () => land(e.first) })
  return out
}

/** Every match against the block holding it, for the outline's per-section
 * counts.
 *
 * The block that HOLDS the text, not the one whose picture shows it
 * (cropCounts' key): the outline's rows are headings, and which crop the
 * compile happened to set a run-in heading inside says nothing about which
 * section it reads under.
 *
 * The current match IS counted here, unlike on a crop tab. The tab sits
 * beside a picture the reader is looking at, where the bar's own number
 * would be a second copy of itself; the outline is a map of the whole
 * document, and a section reading "2" while the reader stands on the third
 * match inside it would be wrong about the document. O(hits), and hits is
 * capped at MAX_HITS, so a one-letter needle over a book costs one pass over
 * the 5000 the matcher already stopped at. */
function matchesByBlock(): Map<HTMLElement, number> {
  const doc = state.doc
  const out = new Map<HTMLElement, number>()
  if (!doc) return out
  for (const m of hits) {
    if (!m.node.isConnected) continue
    // A match with no block is the derived title header — unwritable, but
    // still somewhere the reader can scroll to. The outline asks which part
    // of the paper the words are IN, not who is allowed to rewrite them, so
    // it takes the article child holding them and the outline's title line
    // (which is that header) carries the count. Measured on llama.tex with
    // "the": 688 in the bar and 687 in the column, and the missing one was
    // in the byline.
    const block = m.block ?? articleChildOf(doc, m.node)
    if (!block) continue
    out.set(block, (out.get(block) ?? 0) + 1)
  }
  return out
}

/** the top-level article child holding this node, header included */
function articleChildOf(doc: Doc, node: Node): HTMLElement | null {
  let cur: Element | null = node.parentElement
  while (cur && cur.parentElement !== doc.article) cur = cur.parentElement
  return cur instanceof HTMLElement ? cur : null
}

/** Scroll the current match into view. Called after paint, so a mirrored
 * block has already been lent its HTML form back and the match has a box of
 * its own to measure; the block-and-flash fallback is for text with no box
 * at all — a match the theme or the layout hides for reasons the mirror
 * knows nothing about. */
function reveal(m: DocMatch): void {
  const doc = state.doc
  if (!doc) return
  const host = doc.root.host
  const scroller = host instanceof Element ? host.closest<HTMLElement>('.de-docscroll') : null
  if (!scroller) return
  const range = rangeOf(m)
  const rect = range?.getBoundingClientRect()
  const box = scroller.getBoundingClientRect()
  if (rect && rect.height > 0) {
    const top = scroller.scrollTop + (rect.top - box.top)
    if (rect.top < box.top + 40 || rect.bottom > box.bottom - 40) {
      scroller.scrollTo({ top: Math.max(0, top - scroller.clientHeight / 3) })
    }
    return
  }
  const block = m.block
  if (!block) return
  const br = block.getBoundingClientRect()
  scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + (br.top - box.top) - 60) })
  flashBlock(block)
}

/* ---------- small chrome helpers ---------- */

function el(tag: string, cls: string): HTMLElement {
  const n = document.createElement(tag)
  n.className = cls
  return n
}

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'dn-btn'
  b.textContent = label
  b.title = title
  b.addEventListener('click', onClick)
  return b
}

function toggle(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = button(label, title, onClick)
  b.classList.add('de-find-tog')
  return b
}
