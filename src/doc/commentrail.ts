/* The comments surface: a rail tab of threads, highlights over the anchored
 * text, and the floating button that turns a selection into a thread.
 *
 * Everything drawn INTO the document is an editor artifact — absolutely
 * positioned boxes in an overlay layer that lives in the shadow root beside
 * the article, never inside it. The body markup is not touched at all: no
 * wrapper spans, no marker attributes, nothing for emitBlockTex to trip
 * over and nothing for the serializer to strip. The geometry comes from
 * Range.getClientRects() over the anchor, recomputed whenever the text or
 * the layout could have moved. */

import type { Doc } from '../model/doc'
import { state } from '../state'
import { hov } from '../chrome/hovercard'
import { navigateToDocumentBlock } from '../editor/docnavigate'
import { isMirrored } from './blockmirror'
import {
  anchorFromRange, authorName, blockFor, commentStore, installComments,
  rangeForAnchor, setAuthorName, type CommentThread,
} from './comments'

/* styles for the in-document overlay: they must live INSIDE the document's
 * shadow root, and carry the artifact class so serializeDoc drops them */
const OVERLAY_CSS = `
.de-cmt-layer { position: absolute; inset: 0; pointer-events: none; z-index: 6; }
.de-cmt-box {
  position: absolute; pointer-events: auto; cursor: pointer;
  background: color-mix(in srgb, var(--caution, #e0a400) 16%, transparent);
  border-bottom: 1.5px solid var(--caution, #e0a400);
}
.de-cmt-box:hover { background: color-mix(in srgb, var(--caution, #e0a400) 30%, transparent); }
.de-cmt-box.is-resolved { background: transparent; border-bottom-style: dotted; opacity: .5; }
/* a mirrored block shows a crop of the PDF: there is no HTML text under the
 * anchor to underline, so the thread gets a margin badge instead */
.de-cmt-pin {
  position: absolute; pointer-events: auto; cursor: pointer;
  width: 12px; height: 12px; border-radius: 50%;
  background: color-mix(in srgb, var(--caution, #e0a400) 70%, transparent);
  border: 1px solid var(--caution, #e0a400);
}
.de-cmt-pin.is-resolved { background: transparent; opacity: .45; }
`

let pane: HTMLElement | null = null
let listEl: HTMLElement | null = null
let activateTab: () => void = () => {}
let frame = 0

export function mountComments(host: HTMLElement, activate: () => void): void {
  installComments()
  activateTab = activate
  pane = document.createElement('div')
  pane.className = 'de-pane-pad de-comments'

  const head = document.createElement('div')
  head.className = 'de-cmt-head'
  const label = document.createElement('span')
  label.className = 'de-cmt-headk'
  label.textContent = 'commenting as'
  const who = document.createElement('input')
  who.type = 'text'
  who.className = 'de-cmt-who'
  who.value = authorName()
  who.title = 'the name new comments are signed with (kept in this browser)'
  who.addEventListener('change', () => {
    setAuthorName(who.value.trim() || 'you')
    who.value = authorName()
  })
  head.append(label, who)

  listEl = document.createElement('div')
  listEl.className = 'de-cmt-list'
  pane.append(head, listEl)
  host.append(pane)

  state.bus.on((e) => {
    switch (e.type) {
      case 'doc-loaded':
        render()
        schedulePaint()
        break
      case 'comments-changed':
        render()
        schedulePaint()
        break
      case 'op':
      case 'undo':
      case 'redo':
      case 'blocks-changed':
        schedulePaint()
        break
    }
  })
  window.addEventListener('resize', schedulePaint)
  document.addEventListener('selectionchange', onSelectionChange)
  render()
}

/* ---------- the thread list ---------- */

function render(): void {
  const store = commentStore()
  if (!listEl || !pane) return
  listEl.replaceChildren()
  if (!store || !state.doc) {
    listEl.append(hint('open a document to comment on it'))
    return
  }
  const threads = store.inDocumentOrder()
  if (threads.length === 0) {
    listEl.append(hint('select text in the document and click “comment” to start a thread'))
    return
  }
  // open first (that is what needs answering), resolved last and dimmer
  const open = threads.filter((t) => t.status !== 'resolved')
  const done = threads.filter((t) => t.status === 'resolved')
  for (const t of [...open, ...done]) listEl.append(card(t))
}

function card(t: CommentThread): HTMLElement {
  const el = document.createElement('div')
  el.className = 'de-cmt-card'
  el.dataset.thread = t.id
  if (t.status === 'resolved') el.classList.add('is-resolved')
  if (t.status === 'orphaned') el.classList.add('is-orphan')

  const quote = document.createElement('div')
  quote.className = 'de-cmt-quote'
  quote.textContent = truncate(t.anchor.quote, 90)
  quote.title = t.anchor.quote
  el.append(quote)

  if (t.status === 'orphaned') {
    const flag = document.createElement('div')
    flag.className = 'de-cmt-flag'
    flag.textContent = 'text changed — re-anchor by selecting'
    flag.title = 'the quoted text is no longer in the document; select the passage it belongs to and comment there'
    el.append(flag)
  }

  const notes = document.createElement('div')
  notes.className = 'de-cmt-notes'
  for (const n of t.notes) {
    const row = document.createElement('div')
    row.className = 'de-cmt-note'
    const by = document.createElement('div')
    by.className = 'de-cmt-by'
    by.textContent = `${n.by} · ${relativeTime(n.at)}`
    const text = document.createElement('div')
    text.className = 'de-cmt-text'
    text.textContent = n.text
    row.append(by, text)
    notes.append(row)
  }
  el.append(notes)

  const reply = document.createElement('input')
  reply.type = 'text'
  reply.className = 'de-cmt-reply'
  reply.placeholder = t.notes.length === 0 ? 'say something — Enter posts' : 'reply — Enter posts'
  reply.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    const text = reply.value.trim()
    if (!text) return
    e.preventDefault()
    const op = commentStore()?.addNote(t.id, text)
    if (op) state.apply(op)
    focusThread(t.id) // the list rebuilt around us — land back in this thread
  })
  el.append(reply)

  const actions = document.createElement('div')
  actions.className = 'de-cmt-actions'
  const toggle = button(t.status === 'resolved' ? 'reopen' : 'resolve', () => {
    const op = commentStore()?.setStatus(t.id, t.status === 'resolved' ? 'open' : 'resolved')
    if (op) state.apply(op)
  })
  toggle.title = t.status === 'resolved'
    ? 'put this thread back in the open list'
    : 'mark this thread answered — it stays in the file, dimmed'
  const del = button('delete', () => {
    const op = commentStore()?.remove(t.id)
    if (op) state.apply(op)
  })
  del.classList.add('de-cmt-del')
  del.title = 'remove the thread entirely (one undo step)'
  actions.append(toggle, del)
  el.append(actions)

  el.addEventListener('click', (e) => {
    if (e.target instanceof HTMLElement && e.target.closest('input, button')) return
    revealThread(t)
  })
  return el
}

/** scroll the document to a thread's anchor and flash the block */
function revealThread(t: CommentThread): void {
  const doc = state.doc
  if (!doc) return
  const block = blockFor(doc.article, t.anchor)
  if (block) navigateToDocumentBlock(block)
}

/** open the comments tab with one thread's reply box focused — the landing
 * spot after the floating button creates an empty thread */
export function focusThread(id: string): void {
  activateTab()
  const el = [...(listEl?.querySelectorAll<HTMLElement>('.de-cmt-card') ?? [])]
    .find((c) => c.dataset.thread === id)
  if (!el) return
  el.scrollIntoView({ block: 'nearest' })
  el.querySelector<HTMLInputElement>('.de-cmt-reply')?.focus()
}

/* ---------- in-document highlights ---------- */

function schedulePaint(): void {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    paint()
  })
}

function overlayOf(doc: Doc): HTMLElement {
  const existing = doc.root.querySelector<HTMLElement>('.de-cmt-layer')
  if (existing) return existing
  const style = document.createElement('style')
  style.className = 'dia-editor-artifact'
  style.textContent = OVERLAY_CSS
  doc.root.append(style)
  // boxes position against the host's padding box (doc.ts makes it the
  // containing block); the layer is a shadow-root sibling of the article, so
  // it is not a state.blocks() entry and never reaches the serializer
  const layer = document.createElement('div')
  layer.className = 'de-cmt-layer dia-editor-artifact'
  doc.root.append(layer)
  return layer
}

function paint(): void {
  const doc = state.doc
  const store = commentStore()
  if (!doc) return
  const layer = overlayOf(doc)
  layer.replaceChildren()
  if (!store) return
  const host = doc.root.host
  if (!(host instanceof HTMLElement)) return
  const origin = host.getBoundingClientRect()

  const pinned = new Map<HTMLElement, number>()
  for (const t of store.list()) {
    if (t.status === 'orphaned') continue // nothing to point at
    // a block showing its compiled crop has no HTML text to draw over —
    // Range rects there would point at nothing. Pin the thread to the
    // block's edge instead; opening the block brings the underline back.
    const block = blockFor(doc.article, t.anchor)
    if (block && isMirrored(block)) {
      const n = pinned.get(block) ?? 0
      pinned.set(block, n + 1)
      layer.append(pin(t, block, origin, n))
      continue
    }
    const range = rangeForAnchor(doc.article, t.anchor)
    if (!range) continue
    let rects: DOMRect[] = []
    try {
      rects = [...range.getClientRects()]
    } catch {
      continue // no layout engine (tests) — the rail still lists the thread
    }
    for (const r of rects) {
      if (r.width <= 0 || r.height <= 0) continue
      const box = document.createElement('div')
      box.className = 'de-cmt-box'
      if (t.status === 'resolved') box.classList.add('is-resolved')
      box.style.left = `${r.left - origin.left}px`
      box.style.top = `${r.top - origin.top}px`
      box.style.width = `${r.width}px`
      box.style.height = `${r.height}px`
      const first = t.notes[0]
      hov(box, first ? `${first.by}\n${first.text}` : 'an empty thread — say something in the rail')
      box.addEventListener('click', (e) => {
        e.stopPropagation()
        focusThread(t.id)
      })
      layer.append(box)
    }
  }
}

/** the badge a thread wears on a mirrored block: stacked down the block's
 * right edge so several threads on one block stay countable */
function pin(t: CommentThread, block: HTMLElement, origin: DOMRect, index: number): HTMLElement {
  const b = block.getBoundingClientRect()
  const el = document.createElement('div')
  el.className = 'de-cmt-pin'
  if (t.status === 'resolved') el.classList.add('is-resolved')
  el.style.left = `${b.right - origin.left + 6}px`
  el.style.top = `${b.top - origin.top + 2 + index * 16}px`
  const first = t.notes[0]
  hov(el, first ? `${first.by}\n${first.text}` : 'an empty thread — say something in the rail')
  el.addEventListener('click', (e) => {
    e.stopPropagation()
    focusThread(t.id)
  })
  return el
}

/* ---------- the floating "comment" button ---------- */

let floatBtn: HTMLButtonElement | null = null

function onSelectionChange(): void {
  const doc = state.doc
  if (!doc) { hideFloat(); return }
  // the selection lives in the shadow root; Chrome exposes it there, other
  // engines report it on the document
  const shadow = doc.root as ShadowRoot & { getSelection?: () => Selection | null }
  const sel = shadow.getSelection?.() ?? window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { hideFloat(); return }
  const range = sel.getRangeAt(0)
  const anchorEl = range.startContainer.nodeType === Node.ELEMENT_NODE
    ? range.startContainer as Element
    : range.startContainer.parentElement
  if (!anchorEl || !doc.article.contains(anchorEl)) { hideFloat(); return }

  let rect: DOMRect | null = null
  try {
    const rects = [...range.getClientRects()]
    rect = rects[rects.length - 1] ?? null
  } catch { rect = null }
  if (!rect || (rect.width === 0 && rect.height === 0)) { hideFloat(); return }
  showFloat(rect, range)
}

function showFloat(rect: DOMRect, range: Range): void {
  if (!floatBtn) {
    floatBtn = document.createElement('button')
    floatBtn.type = 'button'
    floatBtn.className = 'de-cmt-float'
    floatBtn.textContent = 'comment'
    floatBtn.title = 'start a thread on the selected text — the document itself is not changed'
    document.body.append(floatBtn)
  }
  const live = range.cloneRange()
  floatBtn.onclick = () => { startThread(live) }
  floatBtn.style.left = `${Math.round(rect.right)}px`
  floatBtn.style.top = `${Math.round(rect.bottom + 6)}px`
  floatBtn.hidden = false
}

function hideFloat(): void {
  if (floatBtn) floatBtn.hidden = true
}

function startThread(range: Range): void {
  const doc = state.doc
  const store = commentStore()
  if (!doc || !store) return
  const anchor = anchorFromRange(doc, range)
  if (!anchor) return
  const { op, id } = store.addThread(anchor)
  state.apply(op)
  hideFloat()
  focusThread(id)
}

/* ---------- helpers ---------- */

function hint(text: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'de-hint'
  el.textContent = text
  return el
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'de-cmt-btn'
  b.textContent = text
  b.addEventListener('click', onClick)
  return b
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`
}

export function relativeTime(iso: string): string {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return 'just now'
  const secs = Math.max(0, (Date.now() - then) / 1000)
  if (secs < 60) return 'just now'
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  if (secs < 86400 * 7) return `${Math.floor(secs / 86400)}d ago`
  return new Date(then).toLocaleDateString()
}
