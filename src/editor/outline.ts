/* Outline: the minimap column's document-mode counterpart — the heading
 * tree, click-to-scroll, current heading tracked from current-block, and
 * per-section counts beside the headings: the open comment threads under
 * one, and — while a search is running — the find bar's matches under it.
 * (Compile-error badges arrive with their milestone.) */

import { state } from '../state'
import { navigateToDocumentBlock } from './docnavigate'
import { blockFor, commentStore } from '../doc/comments'

interface Row {
  el: HTMLElement
  blockIndex: number
  /** open comments, amber */
  badge: HTMLElement | null
  /** find matches, accent — comes and goes with the search */
  find: HTMLElement | null
}

const HEADING = 'h1.dia-sec, h2.dia-sec, h3.dia-sec, h4.dia-sec, h5.dia-sec'

let host: HTMLElement | null = null
let rows: Row[] = []
/* The front line is the row for everything ABOVE the first heading.
 * There is real prose up there — on llama.tex "foundation" is two matches
 * before \section{Introduction}, the title's own words and the abstract's —
 * and a locator that quietly drops them is lying about where the matches
 * are. It is the derived title header when there is a \title, and a plain
 * name-of-the-file line when there is not (rebuild argues that case). */
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
  // blocks above the first heading — all of them when there is no heading
  const first = blocks.findIndex((b) => b.matches(HEADING))
  const above = first < 0 ? blocks.length : first

  const title = state.doc.article.querySelector('.dia-doc-header .dia-title')?.textContent
  /* The front line exists whenever there is anything above the first
   * heading to speak for — with a \title that is the derived header (which
   * is itself the first block, so `above` is at least 1), and without one it
   * is every block up there with no header to hang them on.
   *
   * `dia new --doc` scaffolds a \title, but a .tex someone starts by hand
   * often has none, and then the whole top of the document — an abstract, a
   * lead paragraph, all of a heading-less note — was counted by the find bar
   * and shown on no row at all. Only a document whose very first block is a
   * heading gets no front line, because there is nothing above it to point
   * at and a row that can never say anything is just noise in a 132px
   * column. The line is decided HERE, at rebuild, never from the search:
   * a row that came and went with the count would shuffle every heading
   * under it on each keystroke. */
  if (above > 0) {
    const t = document.createElement('div')
    t.className = 'de-outline-title'
    if (title) t.textContent = title
    else {
      // state.doc.title is the model's own answer to "what is this document
      // called" and it already falls back to the file name (model/doc.ts),
      // which is what the tab and the export's <title> say. Dimmed, so it
      // never reads as a \title the document does not have.
      t.classList.add('de-outline-noname')
      t.textContent = state.doc.title || 'untitled'
      t.title = 'this document has no \\title — the top of the file, above the first heading'
    }
    host.append(t)
    front = { el: t, blockIndex: 0, badge: null, find: null }
  }

  blocks.forEach((b, i) => {
    if (!b.matches(HEADING)) return
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

  const openPerBlock = openCommentsByBlock()
  for (const s of spans(blocks)) {
    let count = 0
    for (let i = s.from; i < s.until; i++) count += openPerBlock.get(i) ?? 0
    if (count === 0) continue
    const badge = document.createElement('span')
    badge.className = 'de-outline-badge'
    badge.textContent = String(count)
    const where = s.row === front ? 'before the first heading' : 'in this section'
    badge.title = `${count} open comment${count === 1 ? '' : 's'} ${where}`
    // the front line is a div with no handler of its own, so its badge
    // carries the same jump a heading row's button already gives
    if (s.row === front) badge.addEventListener('click', () => goToBlock(s.row.blockIndex))
    s.row.el.append(badge)
    s.row.badge = badge
  }
  paintFindBadges() // a rebuild mid-search must not lose the search
  trackCurrent(state.currentBlock)
}

/** Every row against the half-open block range it speaks for.
 *
 * The range is EXCLUSIVE — it stops at the next heading of ANY level, so a
 * subsection's matches are the subsection's and not also its parent's. Both
 * badges read this, so the two numbers in the column answer the same shape
 * of question; a roll-up on one and not the other would be worse than
 * either rule alone.
 *
 * Two reasons it is not a roll-up:
 *
 *  - A BADGE IS A CLICK TARGET. Clicking it scrolls to that row's block, so
 *    the number has to count what the reader finds when they land. A
 *    \section whose subsections hold the twelve matches would show 12 and
 *    then put the reader on a heading with nothing marked anywhere under it
 *    before the next row's heading. The count and the landing must agree.
 *  - EVERY MATCH IS ON EXACTLY ONE ROW, so the column's numbers add up to
 *    the find bar's own total (outline.test.ts asserts the sum). A parent
 *    counting its child's matches too would count them twice and the column
 *    would stop being an inventory of the document.
 *
 * Nothing is hidden by this: the outline never collapses, so a parent's
 * subsections are always drawn directly under it, indented, and a silent
 * parent over a child reading 12 is a file tree, not an omission. The one
 * genuine omission — matches with no row ANYWHERE, above the first heading
 * — is what the front line is for. */
function spans(blocks: HTMLElement[]): { row: Row; from: number; until: number }[] {
  const out: { row: Row; from: number; until: number }[] = []
  if (front) out.push({ row: front, from: 0, until: rows[0]?.blockIndex ?? blocks.length })
  rows.forEach((r, n) => {
    out.push({ row: r, from: r.blockIndex, until: rows[n + 1]?.blockIndex ?? blocks.length })
  })
  return out
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
  for (const s of spans(blocks)) {
    let count = 0
    if (findByBlock) for (let i = s.from; i < s.until; i++) count += findByBlock.get(blocks[i]) ?? 0
    setFindBadge(s.row, count)
  }
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
    // row lands. The front line is a div and has no handler of its own, so
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
  navigateToDocumentBlock(block)
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
