/* Comments: a JSON store of anchored threads, NOT inline marks.
 *
 * A comment is an annotation, never an edit — creating, replying to, or
 * resolving one must leave doc.source.text and the rendered body byte-for-byte
 * alone (DOC-PROFILE §4). So threads live in script#dia-comments and point at
 * the text they discuss with a W3C-style quote-plus-position anchor: the
 * containing top-level block, character offsets into that block's textContent,
 * the exact quote, and ~24 characters of context on each side.
 *
 * Text moves; anchors follow it down a ladder (reanchor):
 *   1. the offsets still cut the recorded quote out of the located block
 *   2. the quote occurs elsewhere in that block — pick the occurrence whose
 *      context matches best
 *   3. the quote occurs exactly once somewhere else in the article
 *   4. nothing matched: status becomes 'orphaned' — KEPT and listed, never
 *      dropped, and restored to 'open' the moment the text comes back
 *
 * Mutations are ordinary invertible Ops (they join undo history) but they are
 * NOT source-synced: syncedBlockOp exists to keep the DOM and the LaTeX in
 * step, and a comment touches neither. Re-anchoring, by contrast, is derived
 * maintenance in the refreshDerived sense — it runs outside the op log,
 * because the ladder is a function of the current text, not a user act. */

import type { Op } from '../types'
import type { Doc } from '../model/doc'
import { state } from '../state'
import { topBlockOf } from './sync'

export type ThreadStatus = 'open' | 'resolved' | 'orphaned'

export interface CommentAnchor {
  /** css locator of the top-level block, scoped to the article */
  block: string
  /** character offsets into the block's textContent */
  start: number
  end: number
  quote: string
  prefix: string
  suffix: string
}

export interface CommentNote {
  by: string
  at: string
  text: string
}

export interface CommentThread {
  id: string
  status: ThreadStatus
  anchor: CommentAnchor
  notes: CommentNote[]
}

/** how much context each side of the quote carries */
const CONTEXT = 24

export class CommentStore {
  private threads: CommentThread[]

  constructor(private doc: Doc) {
    this.threads = parseThreads(doc.commentsJson)
  }

  list(): CommentThread[] {
    return this.threads
  }

  byId(id: string): CommentThread | null {
    return this.threads.find((t) => t.id === id) ?? null
  }

  /** threads in document order (by anchored block, then offset); unanchorable
   * ones sort last, keeping their relative order */
  inDocumentOrder(): CommentThread[] {
    const children = [...this.doc.article.children]
    const place = new Map<CommentThread, number>()
    for (const t of this.threads) {
      const block = blockFor(this.doc.article, t.anchor)
      const idx = block ? children.indexOf(block) : -1
      place.set(t, idx < 0 ? children.length : idx)
    }
    return this.threads
      .map((t, i) => ({ t, i }))
      .sort((a, b) =>
        (place.get(a.t) ?? 0) - (place.get(b.t) ?? 0)
        || a.t.anchor.start - b.t.anchor.start
        || a.i - b.i)
      .map((x) => x.t)
  }

  /* ---------- mutations (each returns an Op for state.apply) ---------- */

  addThread(anchor: CommentAnchor, note?: string, by?: string): { op: Op; id: string } {
    const id = freshThreadId(this.threads)
    const thread: CommentThread = {
      id,
      status: 'open',
      anchor: { ...anchor },
      notes: note ? [{ by: by ?? authorName(), at: new Date().toISOString(), text: note }] : [],
    }
    return { op: this.stateOp('Comment', [...this.threads, thread]), id }
  }

  addNote(id: string, text: string, by?: string): Op | null {
    const t = this.byId(id)
    if (!t) return null
    const note: CommentNote = { by: by ?? authorName(), at: new Date().toISOString(), text }
    return this.stateOp('Reply', this.replace(t, { ...t, notes: [...t.notes, note] }))
  }

  editNote(id: string, index: number, text: string): Op | null {
    const t = this.byId(id)
    if (!t || !t.notes[index]) return null
    const notes = t.notes.map((n, i) => (i === index ? { ...n, text } : n))
    return this.stateOp('Edit comment', this.replace(t, { ...t, notes }))
  }

  setStatus(id: string, status: ThreadStatus): Op | null {
    const t = this.byId(id)
    if (!t || t.status === status) return null
    return this.stateOp(status === 'resolved' ? 'Resolve comment' : 'Reopen comment',
      this.replace(t, { ...t, status }))
  }

  remove(id: string): Op | null {
    const t = this.byId(id)
    if (!t) return null
    return this.stateOp('Delete comment', this.threads.filter((x) => x !== t))
  }

  /* ---------- re-anchoring ---------- */

  /** run the ladder over every thread; returns true when anything moved.
   * Writes back directly (derived maintenance, not an op — see the header). */
  reanchor(): boolean {
    const before = serializeThreads(this.threads)
    this.threads = this.threads.map((t) => reanchorThread(this.doc.article, t))
    const after = serializeThreads(this.threads)
    if (after === before) return false
    this.doc.commentsJson = after
    return true
  }

  /* ---------- internals ---------- */

  private replace(old: CommentThread, next: CommentThread): CommentThread[] {
    return this.threads.map((t) => (t === old ? next : t))
  }

  /** whole-store snapshot swap: the only mutation shape. Undo restores the
   * previous thread list by identity, so doc.commentsJson comes back
   * byte-for-byte (key order is canonical from parseThreads onward). */
  private stateOp(label: string, next: CommentThread[], by?: 'you' | 'copilot'): Op {
    const store = this
    const make = (from: CommentThread[], to: CommentThread[], lbl: string): Op => ({
      label: lbl,
      author: by ?? 'you',
      apply() {
        store.threads = to
        store.writeBack()
      },
      invert() { return make(to, from, `un-${lbl}`) },
    })
    return make(this.threads, next, label)
  }

  private writeBack(): void {
    this.doc.commentsJson = serializeThreads(this.threads)
    state.bus.emit({ type: 'comments-changed' })
  }
}

/* ---------- module binding: one store per loaded document ---------- */

let store: CommentStore | null = null
let installed = false
let pending = 0

export function commentStore(): CommentStore | null {
  return store
}

/** bind the store to the loaded document and keep anchors current. Ops and
 * undo/redo move text under the anchors, so the ladder re-runs debounced. */
export function installComments(): void {
  if (installed) return
  installed = true
  state.bus.on((e) => {
    if (e.type === 'doc-loaded') {
      store = state.doc ? new CommentStore(state.doc) : null
      if (store?.reanchor()) state.bus.emit({ type: 'comments-changed' })
      return
    }
    if (e.type === 'deck-loaded') {
      store = null
      return
    }
    if (e.type === 'op' || e.type === 'undo' || e.type === 'redo' || e.type === 'blocks-changed') {
      scheduleReanchor()
    }
  })
}

function scheduleReanchor(): void {
  if (!store) return
  window.clearTimeout(pending)
  pending = window.setTimeout(() => {
    if (store?.reanchor()) state.bus.emit({ type: 'comments-changed' })
  }, 300)
}

/** test seam: bind a store without the bus round-trip */
export function bindCommentStore(doc: Doc | null): CommentStore | null {
  store = doc ? new CommentStore(doc) : null
  return store
}

/* ---------- the author ---------- */

export function authorName(): string {
  try { return localStorage.getItem('dia-author') || 'you' } catch { return 'you' }
}

export function setAuthorName(name: string): void {
  try { localStorage.setItem('dia-author', name) } catch { /* private mode */ }
}

/* ---------- anchors ---------- */

/** the css locator of a top-level block, scoped to the article. Tag plus
 * nth-of-type only: class names change with editing, sibling position does
 * not, and the ladder covers the rest. */
export function blockLocator(article: HTMLElement, block: Element): string {
  const tag = block.tagName.toLowerCase()
  let n = 0
  for (const child of article.children) {
    if (child.tagName === block.tagName) n++
    if (child === block) return `${tag}:nth-of-type(${n})`
  }
  return tag
}

/** resolve a locator back to its block (tolerates a leading `article > `) */
export function blockFor(article: HTMLElement, anchor: CommentAnchor): HTMLElement | null {
  const sel = anchor.block.replace(/^\s*article\s*>\s*/, '')
  if (!sel) return null
  try {
    return article.querySelector<HTMLElement>(`:scope > ${sel}`)
  } catch {
    return null
  }
}

/** build an anchor from a DOM Range. A selection spanning several blocks is
 * CLAMPED to the first one in v1 — cross-block anchors would need a second
 * locator and a merge rule in the ladder for no clear gain. */
export function anchorFromRange(doc: Doc, range: Range): CommentAnchor | null {
  const startEl = elementOf(range.startContainer)
  if (!startEl || !doc.article.contains(startEl)) return null
  const block = topBlockOf(doc, startEl)
  if (!block) return null

  const text = block.textContent ?? ''
  const start = offsetIn(block, range.startContainer, range.startOffset)
  const endRaw = block.contains(range.endContainer)
    ? offsetIn(block, range.endContainer, range.endOffset)
    : text.length
  const end = Math.min(Math.max(endRaw, start), text.length)
  if (start < 0 || end <= start) return null
  const quote = text.slice(start, end)
  if (!quote.trim()) return null

  return {
    block: blockLocator(doc.article, block),
    start,
    end,
    quote,
    prefix: text.slice(Math.max(0, start - CONTEXT), start),
    suffix: text.slice(end, end + CONTEXT),
  }
}

/** a live Range over an anchor's text, for highlight geometry */
export function rangeForAnchor(article: HTMLElement, anchor: CommentAnchor): Range | null {
  const block = blockFor(article, anchor)
  if (!block) return null
  const from = nodeAt(block, anchor.start)
  const to = nodeAt(block, anchor.end)
  if (!from || !to) return null
  const range = (block.ownerDocument ?? document).createRange()
  range.setStart(from.node, from.offset)
  range.setEnd(to.node, to.offset)
  return range
}

/* ---------- the ladder ---------- */

function reanchorThread(article: HTMLElement, t: CommentThread): CommentThread {
  const found = locate(article, t.anchor)
  if (!found) {
    return t.status === 'orphaned' ? t : { ...t, status: 'orphaned' }
  }
  const anchor = found
  const sameAnchor = anchor.block === t.anchor.block
    && anchor.start === t.anchor.start && anchor.end === t.anchor.end
    && anchor.prefix === t.anchor.prefix && anchor.suffix === t.anchor.suffix
  // a thread found again comes back from the dead; resolved stays resolved
  const status: ThreadStatus = t.status === 'orphaned' ? 'open' : t.status
  if (sameAnchor && status === t.status) return t
  return { ...t, status, anchor }
}

/** rungs 1–3; null when the text is gone */
function locate(article: HTMLElement, anchor: CommentAnchor): CommentAnchor | null {
  const block = blockFor(article, anchor)

  // 1. the recorded offsets still cut out the recorded quote
  if (block) {
    const text = block.textContent ?? ''
    if (text.slice(anchor.start, anchor.end) === anchor.quote) {
      return refreshContext(anchor, text, anchor.start)
    }
    // 2. the quote moved within its block — context picks the occurrence
    const at = bestOccurrence(text, anchor)
    if (at >= 0) return refreshContext(anchor, text, at)
  }

  // 3. a unique occurrence anywhere in the article re-homes the thread
  let hit: { block: HTMLElement; at: number } | null = null
  for (const child of article.children) {
    if (!(child instanceof HTMLElement)) continue
    const text = child.textContent ?? ''
    let from = text.indexOf(anchor.quote)
    while (from >= 0) {
      if (hit) return null // not unique — refuse to guess
      hit = { block: child, at: from }
      from = text.indexOf(anchor.quote, from + 1)
    }
  }
  if (!hit) return null
  return refreshContext(
    { ...anchor, block: blockLocator(article, hit.block) },
    hit.block.textContent ?? '',
    hit.at,
  )
}

/** the occurrence of the quote whose surrounding text best matches the
 * recorded context; -1 when the quote is not in this text at all */
function bestOccurrence(text: string, anchor: CommentAnchor): number {
  let best = -1
  let bestScore = -1
  let at = text.indexOf(anchor.quote)
  while (at >= 0) {
    const prefix = text.slice(Math.max(0, at - CONTEXT), at)
    const suffix = text.slice(at + anchor.quote.length, at + anchor.quote.length + CONTEXT)
    const score = commonSuffix(prefix, anchor.prefix) + commonPrefix(suffix, anchor.suffix)
      // ties break toward the closest offset, so a repeated word in an
      // otherwise identical block stays where the user put it
      - Math.abs(at - anchor.start) / 1e6
    if (score > bestScore) { bestScore = score; best = at }
    at = text.indexOf(anchor.quote, at + 1)
  }
  return best
}

function refreshContext(anchor: CommentAnchor, text: string, at: number): CommentAnchor {
  const end = at + anchor.quote.length
  return {
    ...anchor,
    start: at,
    end,
    prefix: text.slice(Math.max(0, at - CONTEXT), at),
    suffix: text.slice(end, end + CONTEXT),
  }
}

function commonSuffix(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++
  return n
}

function commonPrefix(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  return n
}

/* ---------- text-offset plumbing ---------- */

function elementOf(node: Node): HTMLElement | null {
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode
  return el instanceof HTMLElement ? el : null
}

/** character offset of (container, offset) within block.textContent */
function offsetIn(block: HTMLElement, container: Node, offset: number): number {
  if (container === block) {
    let n = 0
    for (let i = 0; i < offset && i < block.childNodes.length; i++) {
      n += block.childNodes[i].textContent?.length ?? 0
    }
    return n
  }
  let n = 0
  for (const node of textNodes(block)) {
    if (node === container) return n + offset
    n += node.data.length
  }
  return -1
}

/** the text node and local offset holding character `at` */
function nodeAt(block: HTMLElement, at: number): { node: Text; offset: number } | null {
  let n = 0
  let last: Text | null = null
  for (const node of textNodes(block)) {
    if (at <= n + node.data.length) return { node, offset: at - n }
    n += node.data.length
    last = node
  }
  return last ? { node: last, offset: last.data.length } : null
}

function textNodes(root: HTMLElement): Text[] {
  const out: Text[] = []
  const walk = (node: Node): void => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) out.push(child as Text)
      else walk(child)
    }
  }
  walk(root)
  return out
}

/* ---------- JSON ---------- */

/** tolerant read: anything shaped like a thread survives, the rest is
 * dropped rather than throwing the whole document's comments away */
export function parseThreads(json: string): CommentThread[] {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    console.warn('dia-doc: #dia-comments is not valid JSON — starting with no comments')
    return []
  }
  const threads = (raw as { threads?: unknown })?.threads
  if (!Array.isArray(threads)) return []
  const out: CommentThread[] = []
  for (const t of threads) {
    const thread = normalizeThread(t)
    if (thread) out.push(thread)
  }
  return out
}

function normalizeThread(raw: unknown): CommentThread | null {
  if (typeof raw !== 'object' || raw === null) return null
  const t = raw as Record<string, unknown>
  const a = (typeof t.anchor === 'object' && t.anchor !== null ? t.anchor : {}) as Record<string, unknown>
  const id = typeof t.id === 'string' && t.id ? t.id : null
  if (!id) return null
  const status = t.status === 'resolved' || t.status === 'orphaned' ? t.status : 'open'
  const notes: CommentNote[] = Array.isArray(t.notes)
    ? t.notes.filter((n): n is Record<string, unknown> => typeof n === 'object' && n !== null)
      .map((n) => ({
        by: str(n.by) || 'you',
        at: str(n.at),
        text: str(n.text),
      }))
    : []
  return {
    id,
    status,
    anchor: {
      block: str(a.block),
      start: num(a.start),
      end: num(a.end),
      quote: str(a.quote),
      prefix: str(a.prefix),
      suffix: str(a.suffix),
    },
    notes,
  }
}

/** canonical key order everywhere, so an undone mutation restores the
 * previous commentsJson byte-for-byte */
function serializeThreads(threads: CommentThread[]): string {
  return JSON.stringify({ version: 1, threads })
}

function str(v: unknown): string { return typeof v === 'string' ? v : '' }
function num(v: unknown): number { return typeof v === 'number' && Number.isFinite(v) ? v : 0 }

function freshThreadId(threads: CommentThread[]): string {
  const taken = new Set(threads.map((t) => t.id))
  let id = ''
  do {
    id = `c-${Math.random().toString(36).slice(2, 8)}`
  } while (taken.has(id))
  return id
}
