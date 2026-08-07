/* Outline: the minimap column's document-mode counterpart — the heading
 * tree, click-to-scroll, current heading tracked from current-block, and a
 * per-section count of the open comment threads under it.
 * (Compile-error badges arrive with their milestone.) */

import { state } from '../state'
import { scrollToBlock } from './docview'
import { blockFor, commentStore } from '../doc/comments'

let host: HTMLElement | null = null
let rows: Array<{ el: HTMLElement; blockIndex: number; badge: HTMLElement | null }> = []

export function mountOutline(container: HTMLElement): void {
  host = document.createElement('div')
  host.className = 'de-outline'
  host.hidden = true
  container.append(host)

  state.bus.on((e) => {
    if (e.type === 'doc-loaded' || e.type === 'blocks-changed' || e.type === 'comments-changed') rebuild()
    else if (e.type === 'current-block') trackCurrent(e.index)
  })
}

export function showOutline(on: boolean): void {
  if (host) host.hidden = !on
  if (on) rebuild()
}

function rebuild(): void {
  if (!host || !state.doc) return
  rows = []
  host.replaceChildren()

  const blocks = state.blocks()
  const title = state.doc.article.querySelector('.dia-doc-header .dia-title')?.textContent
  if (title) {
    const t = document.createElement('div')
    t.className = 'de-outline-title'
    t.textContent = title
    host.append(t)
  }
  const openPerBlock = openCommentsByBlock()
  blocks.forEach((b, i) => {
    if (!b.matches('h1.dia-sec, h2.dia-sec, h3.dia-sec, h4.dia-sec, h5.dia-sec')) return
    const level = Number(b.tagName[1]) - 1 // h2 → 1
    const row = document.createElement('button')
    row.type = 'button'
    row.className = `de-outline-row de-outline-l${level}`
    const text = document.createElement('span')
    text.className = 'de-outline-text'
    text.textContent = b.textContent ?? ''
    row.append(text)
    row.addEventListener('click', () => {
      state.setCurrentBlock(i)
      scrollToBlock(b)
    })
    host!.append(row)
    rows.push({ el: row, blockIndex: i, badge: null })
  })

  // a section's count is every open thread from its heading up to the next
  // heading at the same level or higher — what a reader would call "in here"
  rows.forEach((r, n) => {
    const until = rows[n + 1]?.blockIndex ?? blocks.length
    let count = 0
    for (let i = r.blockIndex; i < until; i++) count += openPerBlock.get(i) ?? 0
    if (count === 0) return
    const badge = document.createElement('span')
    badge.className = 'de-outline-badge'
    badge.textContent = String(count)
    badge.title = `${count} open comment${count === 1 ? '' : 's'} in this section`
    r.el.append(badge)
    r.badge = badge
  })
  trackCurrent(state.currentBlock)
}

/** open threads counted against the index of the block they anchor to */
function openCommentsByBlock(): Map<number, number> {
  const out = new Map<number, number>()
  const store = commentStore()
  const doc = state.doc
  if (!store || !doc) return out
  const children = [...doc.article.children]
  for (const t of store.list()) {
    if (t.status === 'resolved') continue
    const block = blockFor(doc.article, t.anchor)
    // an orphaned thread has no block — it is the rail's problem, not a
    // section's, so it is not counted anywhere in the outline
    const idx = block ? children.indexOf(block) : -1
    if (idx < 0) continue
    out.set(idx, (out.get(idx) ?? 0) + 1)
  }
  return out
}

/** highlight the heading governing the current block */
function trackCurrent(blockIndex: number): void {
  let active = -1
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].blockIndex <= blockIndex) active = i
    else break
  }
  rows.forEach((r, i) => r.el.classList.toggle('de-on', i === active))
}
