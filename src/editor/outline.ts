/* Outline: the minimap column's document-mode counterpart — the heading
 * tree, click-to-scroll, current heading tracked from current-block, and
 * per-section counts beside the headings: the open comment threads under
 * one, and — while a search is running — the find bar's matches under it.
 * (Compile-error badges arrive with their milestone.) */

import { state } from '../state'
import { scrollToBlock } from './docview'
import { blockFor, commentStore } from '../doc/comments'

interface Row {
  el: HTMLElement
  blockIndex: number
  /** open comments, amber */
  badge: HTMLElement | null
  /** find matches, accent — comes and goes with the search */
  find: HTMLElement | null
}

let host: HTMLElement | null = null
let rows: Row[] = []
/* The title line doubles as the row for everything ABOVE the first heading.
 * There is real prose up there — on llama.tex "foundation" is two matches
 * before \section{Introduction}, the title's own words and the abstract's —
 * and a locator that quietly drops them is lying about where the matches
 * are. A document with no \title has no header line to hang them on; the
 * bar's own total still counts them. */
let front: Row | null = null
/** matches per block while the find bar is open, else null (see setFindCounts) */
let findByBlock: Map<HTMLElement, number> | null = null

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

/** Per-section find counts, from the block each match sits in.
 *
 * The find bar's other two answers are both LOCAL: the shading is on the one
 * match you are standing on, and a crop tab says which picture is hiding a
 * match you can see the picture of. Neither says where the other forty are
 * when they are three sections below the fold. This map is the global one,
 * and the outline is where it belongs — it is the document's own table of
 * contents, already open beside the paper in doc mode.
 *
 * `null` (and an empty map) clears every count: closing the bar, and every
 * search that finds nothing. docfind's paint() is the only caller and it
 * runs on each keystroke, so this repaints badges on the rows the last
 * rebuild made rather than rebuilding the tree. */
export function setFindCounts(counts: Map<HTMLElement, number> | null): void {
  findByBlock = counts && counts.size > 0 ? counts : null
  paintFindBadges()
}

function rebuild(): void {
  if (!host || !state.doc) return
  rows = []
  front = null
  host.replaceChildren()

  const blocks = state.blocks()
  const title = state.doc.article.querySelector('.dia-doc-header .dia-title')?.textContent
  if (title) {
    const t = document.createElement('div')
    t.className = 'de-outline-title'
    t.textContent = title
    host.append(t)
    front = { el: t, blockIndex: 0, badge: null, find: null }
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
    row.addEventListener('click', () => goToBlock(i))
    host!.append(row)
    rows.push({ el: row, blockIndex: i, badge: null, find: null })
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
  paintFindBadges() // a rebuild mid-search must not lose the search
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

/* ---------- find counts ---------- */

/** Hang the current search's counts on the existing rows.
 *
 * Cheap on purpose: this is on the per-keystroke path, so it walks the
 * blocks once and edits the text of badges that are already there. Nothing
 * here rebuilds the tree, and nothing here reads layout — the outline must
 * never be the thing that makes a big search slow. */
function paintFindBadges(): void {
  if (!host) return
  const blocks = findByBlock ? state.blocks() : []
  const under = (from: number, until: number): number => {
    if (!findByBlock) return 0
    let n = 0
    for (let i = from; i < until; i++) n += findByBlock.get(blocks[i]) ?? 0
    return n
  }
  const firstHeading = rows[0]?.blockIndex ?? blocks.length
  if (front) setFindBadge(front, under(0, firstHeading))
  rows.forEach((r, n) => setFindBadge(r, under(r.blockIndex, rows[n + 1]?.blockIndex ?? blocks.length)))
}

function setFindBadge(row: Row, count: number): void {
  if (count === 0) {
    row.find?.remove()
    row.find = null
    return
  }
  if (!row.find) {
    const badge = document.createElement('span')
    badge.className = 'de-outline-badge de-outline-find'
    // A heading row IS a button, so a click on the badge inside it runs the
    // row's own handler and the reader lands where every other click on that
    // row lands. The title line is a div and has no handler of its own, so
    // its badge carries the same call.
    if (row === front) badge.addEventListener('click', () => goToBlock(row.blockIndex))
    // ahead of the comment badge: both hug the right edge, so the amber
    // count keeps its place and opening a search shifts nothing in the column
    if (row.badge) row.el.insertBefore(badge, row.badge)
    else row.el.append(badge)
    row.find = badge
  }
  const where = row === front ? 'before the first heading' : 'in this section'
  row.find.textContent = String(count)
  row.find.title = `${count} match${count === 1 ? '' : 'es'} ${where} — click to go there`
}

/* ---------- navigation ---------- */

function goToBlock(i: number): void {
  const block = state.blocks()[i]
  if (!block) return
  state.setCurrentBlock(i)
  scrollToBlock(block)
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
