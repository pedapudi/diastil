/* Table altitude: slides in vertical flow, gutter overlay to the left of
 * the deck (slide number / import confidence / island flags), and
 * scroll-tracked current slide via IntersectionObserver. */

import type { ImportReport } from '../types'
import { state } from '../state'

let container: HTMLElement | null = null
let inner!: HTMLElement
let gutter!: HTMLElement
let deckwrap!: HTMLElement
let canvas!: HTMLElement

let gutterItems: HTMLElement[] = []
let report: ImportReport | null = null
let io: IntersectionObserver | null = null
const ratios = new Map<Element, number>()
let raf = 0

/* ---------- import report store (ingest module writes here) ---------- */

export function setImportReport(r: ImportReport | null): void {
  report = r
  if (container) rebuildGutter()
}

export function getImportReport(): ImportReport | null {
  return report
}

/* ---------- mount ---------- */

export function mountTable(mainEl: HTMLElement, canvasHost: HTMLElement): void {
  canvas = canvasHost
  container = document.createElement('div')
  container.className = 'de-table'
  inner = document.createElement('div')
  inner.className = 'de-table-inner'
  gutter = document.createElement('div')
  gutter.className = 'de-gutter'
  deckwrap = document.createElement('div')
  deckwrap.className = 'de-deckwrap'
  deckwrap.append(canvas)
  inner.append(gutter, deckwrap)
  container.append(inner)
  mainEl.append(container)

  container.addEventListener('scroll', schedule, { passive: true })
  new ResizeObserver(schedule).observe(container)
  window.addEventListener('resize', schedule)

  state.bus.on((e) => {
    if (e.type === 'deck-loaded' || e.type === 'slides-changed'
      || e.type === 'op' || e.type === 'undo' || e.type === 'redo') {
      rebuildGutter()
      rebuildObserver()
    }
  })
}

/* ---------- altitude switching (shell drives this) ---------- */

export function activateTable(index: number): void {
  if (!container) return
  container.hidden = false
  if (canvas.parentElement !== deckwrap) deckwrap.append(canvas)
  scrollToSlide(index, 'auto')
  schedule()
}

export function deactivateTable(): void {
  if (container) container.hidden = true
}

export function scrollToSlide(i: number, behavior: ScrollBehavior = 'smooth'): void {
  if (!container || container.hidden) return
  const slide = state.slides()[i]
  if (!slide) return
  const cr = container.getBoundingClientRect()
  const r = slide.getBoundingClientRect()
  container.scrollTo({ top: container.scrollTop + (r.top - cr.top) - 30, behavior })
}

/* ---------- gutter ---------- */

function rebuildGutter(): void {
  if (!container) return
  const slides = state.slides()
  gutterItems = []
  gutter.replaceChildren()
  slides.forEach((_slide, i) => {
    const item = document.createElement('div')
    item.className = 'de-gut'
    const num = document.createElement('span')
    num.className = 'de-num'
    num.textContent = String(i + 1)
    item.append(num)
    if (report) {
      const c = report.confidence[i]
      if (typeof c === 'number') {
        const fid = document.createElement('span')
        fid.className = c < 0.95 ? 'de-fid de-warn' : 'de-fid'
        fid.textContent = c.toFixed(2)
        item.append(fid)
      }
      const islands = report.regions.filter((r) => r.slideIndex === i && r.kind === 'island').length
      if (islands > 0) {
        const isl = document.createElement('span')
        isl.className = 'de-island'
        isl.textContent = islands > 1 ? `island ×${islands}` : 'island'
        item.append(isl)
      }
    }
    gutter.append(item)
    gutterItems.push(item)
  })
  schedule()
}

export function syncGutter(): void {
  if (!container || container.hidden) return
  const slides = state.slides()
  const innerRect = inner.getBoundingClientRect()
  const wrapRect = deckwrap.getBoundingClientRect()
  const left = Math.max(4, wrapRect.left - innerRect.left - 122)
  slides.forEach((slide, i) => {
    const item = gutterItems[i]
    if (!item) return
    const r = slide.getBoundingClientRect()
    item.style.top = `${r.top - innerRect.top}px`
    item.style.left = `${left}px`
  })
}

function schedule(): void {
  if (raf) return
  raf = requestAnimationFrame(() => { raf = 0; syncGutter() })
}

/* ---------- current-slide tracking ---------- */

function rebuildObserver(): void {
  io?.disconnect()
  ratios.clear()
  if (!container) return
  io = new IntersectionObserver(onIntersect, {
    root: container,
    threshold: [0, 0.25, 0.5, 0.6, 0.75, 1],
  })
  for (const s of state.slides()) io.observe(s)
}

function onIntersect(entries: IntersectionObserverEntry[]): void {
  for (const e of entries) ratios.set(e.target, e.intersectionRatio)
  if (state.altitude !== 'table' || !container || container.hidden) return
  const slides = state.slides()
  // topmost mostly-visible slide wins; otherwise the most-visible one
  let best = -1
  for (let i = 0; i < slides.length; i++) {
    if ((ratios.get(slides[i]) ?? 0) >= 0.55) { best = i; break }
  }
  if (best < 0) {
    let bestR = 0
    slides.forEach((s, i) => {
      const r = ratios.get(s) ?? 0
      if (r > bestR) { bestR = r; best = i }
    })
  }
  if (best >= 0) state.setCurrentSlide(best)
}
