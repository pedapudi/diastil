/* Document surface: the article in a continuous prose scroll. A deliberate
 * FORK of table.ts's shape rather than a parameterization — the table is
 * 170 slide-shaped lines (gutter, fidelity, 16:9 assumptions) and shares
 * only the reparenting idiom. The same #deck-host canvas moves between the
 * table's deckwrap and this docwrap on activation. */

import type { Doc } from '../model/doc'
import { state } from '../state'
import { canMoveDocBlock, moveDocBlock, removeDocBlock, topBlockOf } from '../doc/sync'
import { insertDocBlockAfter } from './textedit'

let container: HTMLElement | null = null
let docwrap!: HTMLElement
let canvas!: HTMLElement
let rail!: HTMLElement
let io: IntersectionObserver | null = null
const ratios = new Map<Element, number>()

export function mountDocView(mainEl: HTMLElement, canvasHost: HTMLElement): void {
  canvas = canvasHost
  container = document.createElement('div')
  container.className = 'de-docscroll'
  container.hidden = true
  docwrap = document.createElement('div')
  docwrap.className = 'de-docwrap'
  rail = buildRail()
  container.append(docwrap, rail)
  mainEl.append(container)

  state.bus.on((e) => {
    if (e.type === 'doc-loaded' || e.type === 'blocks-changed'
      || e.type === 'op' || e.type === 'undo' || e.type === 'redo') {
      if (container && !container.hidden) rebuildObserver()
      syncRail()
    } else if (e.type === 'selection' || e.type === 'current-block') {
      syncRail()
    }
  })
}

export function activateDoc(): void {
  if (!container) return
  container.hidden = false
  if (canvas.parentElement !== docwrap) docwrap.append(canvas)
  container.scrollTop = 0
  rebuildObserver()
  syncRail()
}

export function deactivateDoc(): void {
  if (container) container.hidden = true
  io?.disconnect()
  io = null
  syncRail()
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
