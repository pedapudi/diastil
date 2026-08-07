/* Document surface: the article in a continuous prose scroll. A deliberate
 * FORK of table.ts's shape rather than a parameterization — the table is
 * 170 slide-shaped lines (gutter, fidelity, 16:9 assumptions) and shares
 * only the reparenting idiom. The same #deck-host canvas moves between the
 * table's deckwrap and this docwrap on activation. */

import { state } from '../state'

let container: HTMLElement | null = null
let docwrap!: HTMLElement
let canvas!: HTMLElement
let io: IntersectionObserver | null = null
const ratios = new Map<Element, number>()

export function mountDocView(mainEl: HTMLElement, canvasHost: HTMLElement): void {
  canvas = canvasHost
  container = document.createElement('div')
  container.className = 'de-docscroll'
  container.hidden = true
  docwrap = document.createElement('div')
  docwrap.className = 'de-docwrap'
  container.append(docwrap)
  mainEl.append(container)

  state.bus.on((e) => {
    if (e.type === 'doc-loaded' || e.type === 'blocks-changed'
      || e.type === 'op' || e.type === 'undo' || e.type === 'redo') {
      if (container && !container.hidden) rebuildObserver()
    }
  })
}

export function activateDoc(): void {
  if (!container) return
  container.hidden = false
  if (canvas.parentElement !== docwrap) docwrap.append(canvas)
  container.scrollTop = 0
  rebuildObserver()
}

export function deactivateDoc(): void {
  if (container) container.hidden = true
  io?.disconnect()
  io = null
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
