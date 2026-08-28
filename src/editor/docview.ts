/* Document surface: the article in a continuous prose scroll. A deliberate
 * FORK of table.ts's shape rather than a parameterization — the table is
 * 170 slide-shaped lines (gutter, fidelity, 16:9 assumptions) and shares
 * only the reparenting idiom. The same #deck-host canvas moves between the
 * table's deckwrap and this docwrap on activation. */

import type { Doc } from '../model/doc'
import { state } from '../state'
import { canMoveDocBlock, moveCrossesInto, moveDocBlock, removeDocBlock, topBlockOf } from '../doc/sync'
import { documentLayout } from '../doc/pagelayout'
import { breaksAreCurrent, pageBreakCss, pageGroups, type PageGroup } from '../doc/pagination'
import { insertDocBlockAfter } from './textedit'

let container: HTMLElement | null = null
let docwrap!: HTMLElement
let canvas!: HTMLElement
let rail!: HTMLElement
let sheets!: HTMLElement
let io: IntersectionObserver | null = null
const ratios = new Map<Element, number>()

export function mountDocView(mainEl: HTMLElement, canvasHost: HTMLElement): void {
  canvas = canvasHost
  container = document.createElement('div')
  container.className = 'de-docscroll'
  container.hidden = true
  docwrap = document.createElement('div')
  docwrap.className = 'de-docwrap'
  // the paper the article floats over; behind it in the same scrolled
  // coordinate space, so it rides the scroll rather than being re-placed
  sheets = document.createElement('div')
  sheets.className = 'de-sheets'
  sheets.setAttribute('aria-hidden', 'true')
  rail = buildRail()
  container.append(sheets, docwrap, rail)
  mainEl.append(container)

  state.bus.on((e) => {
    if (e.type === 'doc-loaded' || e.type === 'blocks-changed'
      || e.type === 'op' || e.type === 'undo' || e.type === 'redo') {
      if (container && !container.hidden) rebuildObserver()
      syncRail()
      repaginate()
    } else if (e.type === 'selection' || e.type === 'current-block') {
      syncRail()
    }
  })
  // a compile lands new page breaks; nothing else in the document changed
  window.addEventListener('dia-document-layout', () => repaginate())
  // the measure moves with the zoom segment and the window
  resizeObserver = new ResizeObserver(() => drawSheets())
}

export function activateDoc(): void {
  if (!container) return
  container.hidden = false
  if (canvas.parentElement !== docwrap) docwrap.append(canvas)
  container.scrollTop = 0
  rebuildObserver()
  syncRail()
  repaginate()
}

export function deactivateDoc(): void {
  if (container) container.hidden = true
  io?.disconnect()
  io = null
  resizeObserver?.disconnect()
  syncRail()
}

/* ---------- pages, where the engine broke them ----------
 * The semantic surface is one continuous flow of HTML; these sheets are
 * drawn behind it at the boundaries synctex reported, so this view and the
 * compiled one agree on where a page ends while differing on how faithfully
 * they set the type. Nothing here touches the article: the gaps come from a
 * :nth-child stylesheet that is an editor artifact, and the paper is a layer
 * underneath. See doc/pagination.ts for why the breaks cannot be the
 * browser's own. */

/** Paper kept above and below a page's blocks, in px. Not the real margin of
 * the paper — the sheets bound the prose they hold, because HTML sets the
 * same words to a different length than TeX did and a sheet forced to the
 * paper's proportions would either clip or gape. The compiled view is where
 * a page is the size of a page. */
const SHEET_PAD = 30

/** Bare background left between two sheets. The gap the article opens at a
 * break has to cover both sheets' padding as well, or the paper of one page
 * overlaps the next — measured at 14px of overlap before the two numbers
 * were tied together here. */
const SHEET_GUTTER = 36

let resizeObserver: ResizeObserver | null = null
let groups: PageGroup[] = []
let breakStyle: HTMLStyleElement | null = null

function repaginate(): void {
  const doc = state.doc
  if (!container) return
  // no document (a deck took the editor over) is the same as no breaks
  const layout = doc ? documentLayout() : null
  const current = breaksAreCurrent(layout, doc?.source.text)
  groups = doc ? pageGroups(state.blocks(), layout) : []
  if (groups.length === 0 || !doc) {
    container.classList.remove('is-paginated', 'is-provisional')
    breakStyle?.remove()
    breakStyle = null
    sheets.replaceChildren()
    resizeObserver?.disconnect()
    return
  }
  if (breakStyle === null || breakStyle.getRootNode() !== doc.root) {
    breakStyle = document.createElement('style')
    // never serialized: model/doc.ts drops editor-artifact styles on save
    breakStyle.className = 'dia-editor-artifact'
    doc.root.appendChild(breakStyle)
  }
  breakStyle.textContent = pageBreakCss(doc.article, groups)
  container.style.setProperty('--de-page-gap', `${SHEET_PAD * 2 + SHEET_GUTTER}px`)
  container.classList.add('is-paginated')
  container.classList.toggle('is-provisional', !current)
  resizeObserver?.disconnect()
  resizeObserver?.observe(doc.article)
  drawSheets()
}

/** Place one sheet per page group.
 *
 * Synchronous on purpose. The gap rules above were only just written, but
 * `getBoundingClientRect` flushes layout before it answers, so the measure
 * is of the article as it now stands. Deferring to a frame would read the
 * same numbers and cost a class of bug instead: a rAF does not run in a
 * background tab, so the draw would sit queued and the paper never appear.
 * Drawing writes only to the sheet layer, which nothing here observes, so
 * calling this from the ResizeObserver cannot loop. */
function drawSheets(): void {
  const doc = state.doc
  if (!container || container.hidden || !doc || groups.length === 0) return
  const cr = container.getBoundingClientRect()
  const ar = doc.article.getBoundingClientRect()
  const left = ar.left - cr.left + container.scrollLeft
  const top0 = container.scrollTop
  const made: HTMLElement[] = []
  for (const group of groups) {
    const box = groupBox(group)
    if (box === null) continue
    const el = document.createElement('div')
    el.className = 'de-sheet'
    el.style.left = `${left}px`
    el.style.width = `${ar.width}px`
    el.style.top = `${box.top - cr.top + top0 - SHEET_PAD}px`
    el.style.height = `${box.bottom - box.top + SHEET_PAD * 2}px`
    const label = document.createElement('span')
    label.className = 'de-sheet-page'
    label.textContent = String(group.page)
    const when = container.classList.contains('is-provisional')
      ? 'as the last compile set it — the document has changed since'
      : 'of the last compile'
    label.title = group.straddled
      ? `page ${group.page} ${when}. The engine broke inside the block at the top, `
        + `so page ${group.page - 1} carries some of it too`
      : `page ${group.page} ${when}`
    if (group.straddled) el.classList.add('is-straddled')
    el.append(label)
    made.push(el)
  }
  sheets.replaceChildren(...made)
}

/** the vertical extent of a group's blocks, skipping the ones with no box
 * (a block the compile absorbed into a neighbour renders at zero height) */
function groupBox(group: PageGroup): { top: number; bottom: number } | null {
  let top = Infinity
  let bottom = -Infinity
  for (const block of group.blocks) {
    const r = block.getBoundingClientRect()
    if (r.height === 0) continue
    if (r.top < top) top = r.top
    if (r.bottom > bottom) bottom = r.bottom
  }
  return bottom > top ? { top, bottom } : null
}

/* ---------- block rail ----------
 * The table's gutter idiom at document scale: an absolutely positioned
 * overlay beside the text, tracking a block. ONE cluster, following the
 * block you selected (else the one you are reading), because a rail against
 * every paragraph would out-shout the prose it is there to edit. The verbs
 * are the context menu's, in the same order — a faster path to the same
 * paired ops, never a second implementation. */

interface RailVerb { glyph: string; title: string; run: (doc: Doc, block: HTMLElement) => void }

const RAIL_VERBS: RailVerb[] = [
  { glyph: '¶', title: 'new paragraph after this block', run: (d, b) => { insertDocBlockAfter(d, b, 'paragraph') } },
  { glyph: '§', title: 'new section after this block', run: (d, b) => { insertDocBlockAfter(d, b, 'section') } },
  { glyph: '↑', title: 'move this block up', run: (d, b) => { moveDocBlock(d, b, -1) } },
  { glyph: '↓', title: 'move this block down', run: (d, b) => { moveDocBlock(d, b, 1) } },
  { glyph: '⌫', title: 'delete this block', run: (d, b) => { removeDocBlock(d, b) } },
]

function buildRail(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'de-docrail'
  el.hidden = true
  for (const verb of RAIL_VERBS) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = verb.glyph
    b.title = verb.title
    b.dataset.verb = verb.title
    b.addEventListener('click', () => {
      const doc = state.doc
      const block = railBlock()
      if (doc && block) verb.run(doc, block)
    })
    el.append(b)
  }
  return el
}

/** the block the rail acts on: what you selected, else what you are reading */
function railBlock(): HTMLElement | null {
  const doc = state.doc
  if (!doc) return null
  const sel = state.selection
  const block = sel.kind === 'block' ? sel.block : state.blocks()[state.currentBlock]
  // the derived header is not a block — it has no source bytes to move
  return block && block.isConnected && topBlockOf(doc, block) === block ? block : null
}

function syncRail(): void {
  if (!rail || !container) return
  const doc = state.doc
  const block = railBlock()
  if (!doc || !block || container.hidden) {
    rail.hidden = true
    return
  }
  rail.hidden = false
  const buttons = [...rail.querySelectorAll('button')]
  buttons[2].disabled = !canMoveDocBlock(doc, block, -1)
  buttons[3].disabled = !canMoveDocBlock(doc, block, 1)
  buttons[4].disabled = !canMoveDocBlock(doc, block, -1) && !canMoveDocBlock(doc, block, 1)
  // at a chapter seam the arrow moves the block into ANOTHER FILE, which
  // the continuous prose gives no sign of — the tooltip is the only place
  // that can say so before the click (doc/sync moveCrossesInto)
  for (const i of [2, 3] as const) {
    const into = moveCrossesInto(doc, block, i === 2 ? -1 : 1)
    buttons[i].title = into ? `${RAIL_VERBS[i].title}, into ${into}` : RAIL_VERBS[i].title
  }
  // content coordinates: the rail is a child of the scroller, so it rides
  // the scroll instead of being re-placed on every frame
  const cr = container.getBoundingClientRect()
  const r = block.getBoundingClientRect()
  rail.style.top = `${r.top - cr.top + container.scrollTop}px`
  rail.style.left = `${Math.max(4, r.left - cr.left + container.scrollLeft - rail.offsetWidth - 12)}px`
}

/** instant by default: Chrome silently drops smooth programmatic scrolls in
 * this container (observed against shadow-DOM content); the flash carries
 * the orientation instead */
export function scrollToBlock(el: HTMLElement, behavior: ScrollBehavior = 'auto'): void {
  if (!container || container.hidden) return
  // a hidden block (absorbed into a neighbour's crop) has no box — land on
  // the first visible sibling instead of the page top
  let target = el
  while (target.getBoundingClientRect().height === 0 && target.nextElementSibling instanceof HTMLElement) {
    target = target.nextElementSibling
  }
  el = target
  const cr = container.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  container.scrollTo({ top: container.scrollTop + (r.top - cr.top) - 60, behavior })
  flashBlock(el)
}

/** flash a block after a jump so the eye lands where the click meant */
export function flashBlock(el: HTMLElement): void {
  el.classList.add('de-doc-flash')
  window.setTimeout(() => el.classList.remove('de-doc-flash'), 1200)
}

/* ---------- current-block tracking ---------- */

function rebuildObserver(): void {
  io?.disconnect()
  ratios.clear()
  if (!container) return
  io = new IntersectionObserver(onIntersect, {
    root: container,
    threshold: [0, 0.25, 0.5, 0.75, 1],
  })
  for (const b of state.blocks()) io.observe(b)
}

function onIntersect(entries: IntersectionObserverEntry[]): void {
  for (const e of entries) ratios.set(e.target, e.intersectionRatio)
  if (!container || container.hidden) return
  const blocks = state.blocks()
  // the topmost block that is meaningfully visible wins — prose blocks are
  // short, so "mostly visible" (the table's rule) would jitter
  let best = -1
  for (let i = 0; i < blocks.length; i++) {
    if ((ratios.get(blocks[i]) ?? 0) >= 0.5) { best = i; break }
  }
  if (best < 0) {
    let bestR = 0
    blocks.forEach((b, i) => {
      const r = ratios.get(b) ?? 0
      if (r > bestR) { bestR = r; best = i }
    })
  }
  if (best >= 0) state.setCurrentBlock(best)
}
