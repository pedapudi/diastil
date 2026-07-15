/* Storyboard: the video-editor idiom adapted to a CLICK-DRIVEN medium.
 * Present mode has no time axis — it has MOMENTS (step 0, step 1, …), so
 * the drawer shows element LANES against step COLUMNS instead of tracks
 * against seconds. Click a cell to reassign an element's step (one op);
 * click a column header to preview that moment ON THE LIVE SLIDE (outside
 * the op log, like copilot previews); ▶ walks through the moments.
 *
 * Timing and easing stay the runtime's business; imported animated svgs
 * keep their own clocks. The storyboard manages ORDER. */

import { state } from '../state'
import { setAttr } from '../model/ops'

let drawer: HTMLElement | null = null
let boardSlide: HTMLElement | null = null
let offBus: (() => void) | null = null
let playTimer: number | null = null

/* ---------- moment preview (never an op) ---------- */

let previewed: Array<{ el: HTMLElement | SVGElement; opacity: string }> = []
let previewStep = -1

function clearMoment(): void {
  for (const p of previewed) {
    if (p.opacity) p.el.style.opacity = p.opacity
    else p.el.style.removeProperty('opacity')
  }
  previewed = []
  previewStep = -1
}

/** show the slide as the audience sees it AT step k: later steps ghost */
function showMoment(slide: HTMLElement, k: number): void {
  clearMoment()
  previewStep = k
  for (const el of steppedEls(slide)) {
    const step = Number(el.getAttribute('data-dia-step'))
    if (step > k) {
      previewed.push({ el, opacity: el.style.opacity })
      el.style.opacity = '0.12'
    }
  }
}

/* ---------- data ---------- */

function steppedEls(slide: HTMLElement): Array<HTMLElement | SVGElement> {
  return [...slide.querySelectorAll<HTMLElement | SVGElement>('[data-dia-step]')]
    .filter((el) => !el.closest('.dia-editor-artifact'))
}

/** transparent layout wrappers — their CHILDREN are the steppable units */
const LAYOUT = new Set(['dia-columns', 'dia-stack', 'dia-split', 'grid2', 'grid4'])

/** every element on the slide worth a lane, stepped or not: role blocks,
 * list items, figures, drawings, scene nodes and edges — so choreographing
 * a slide never requires visiting each element in the inspector first */
function candidates(slide: HTMLElement): Array<HTMLElement | SVGElement> {
  const out: Array<HTMLElement | SVGElement> = []
  const walk = (el: Element): void => {
    for (const c of el.children) {
      if (!(c instanceof HTMLElement) && !(c instanceof SVGElement)) continue
      const tag = c.tagName.toLowerCase()
      if (tag === 'style' || tag === 'script') continue
      if (c.classList.contains('dia-editor-artifact')) continue
      if (c.classList.contains('foot')) continue // the page footer never steps
      if (c instanceof SVGSVGElement) {
        out.push(c)
        for (const g of c.querySelectorAll<SVGElement>(':scope > [data-dia-node], :scope > [data-dia-edge]')) {
          out.push(g)
        }
        continue
      }
      if ([...c.classList].some((cl) => LAYOUT.has(cl))) { walk(c); continue }
      out.push(c as HTMLElement)
      if (tag === 'ul' || tag === 'ol') {
        for (const li of c.querySelectorAll<HTMLElement>(':scope > li')) out.push(li)
      }
    }
  }
  walk(slide)
  // anything already stepped that the heuristic missed still gets a lane
  for (const el of steppedEls(slide)) if (!out.includes(el)) out.push(el)
  return out
}

function maxStep(slide: HTMLElement): number {
  return Math.max(0, ...steppedEls(slide).map((el) => Number(el.getAttribute('data-dia-step')) || 0))
}

function labelOf(el: Element): string {
  const node = el.closest('[data-dia-node]')
  if (node) return `node ${node.getAttribute('data-dia-node')}`
  const edge = el.closest('[data-dia-edge]')
  if (edge) return `edge ${(edge.getAttribute('data-dia-edge') ?? '').replace('->', ' → ')}`
  const role = [...el.classList].find((c) => c.startsWith('dia-') || c === 'panel')
  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 26)
  return role ? `${role}${text ? ` “${text}”` : ''}` : `${el.tagName.toLowerCase()}${text ? ` “${text}”` : ''}`
}

/* ---------- the drawer ---------- */

export function storyboardOpen(): boolean {
  return drawer !== null
}

export function closeStoryboard(): void {
  stopPlay()
  clearMoment()
  drawer?.remove()
  drawer = null
  boardSlide = null
  offBus?.()
  offBus = null
}

export function toggleStoryboard(slide: HTMLElement): void {
  if (drawer && boardSlide === slide) { closeStoryboard(); return }
  openStoryboard(slide)
}

export function openStoryboard(slide: HTMLElement): void {
  closeStoryboard()
  boardSlide = slide
  drawer = h('div', 'de-sb dn-panel')
  document.body.appendChild(drawer)
  rebuild()
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.stopPropagation(); closeStoryboard() }
  }
  document.addEventListener('keydown', onKey, true)
  const offBusInner = state.bus.on((e) => {
    if (e.type === 'deck-loaded') { closeStoryboard(); return }
    if (e.type === 'op' || e.type === 'undo' || e.type === 'redo') {
      // geometry may have changed under a preview — drop it, redraw truth
      clearMoment()
      if (boardSlide?.isConnected) rebuild()
      else closeStoryboard()
    }
  })
  offBus = () => {
    document.removeEventListener('keydown', onKey, true)
    offBusInner()
  }
}

function rebuild(): void {
  if (!drawer || !boardSlide) return
  const slide = boardSlide
  drawer.replaceChildren()

  const head = h('div', 'de-sb-head')
  const idx = state.slides().indexOf(slide)
  head.append(h('b', '', 'storyboard'), h('span', 'de-sb-dim', ` — slide ${idx + 1}, moments of the build`))
  const spacer = h('span', 'de-sb-spacer')
  const play = btn('▶ play', 'walk through the moments on the live slide')
  play.addEventListener('click', () => (playTimer === null ? startPlay(slide) : stopPlay()))
  const close = btn('✕', 'close (esc)')
  close.addEventListener('click', closeStoryboard)
  head.append(spacer, play, close)
  drawer.append(head)

  const all = candidates(slide)
  const overflow = Math.max(0, all.length - 36)
  const els = overflow > 0
    ? all.filter((el, i) => el.hasAttribute('data-dia-step') || i < 36)
    : all
  if (els.length === 0) {
    drawer.append(h('div', 'de-sb-hint', 'nothing steppable on this slide yet'))
    return
  }

  const cols = Math.max(1, maxStep(slide) + 1) // one spare column to push things later
  const grid = h('div', 'de-sb-grid')
  grid.style.gridTemplateColumns = `minmax(180px, 240px) 44px repeat(${cols}, 40px)`

  // header row: the moments. 0 = slide enters; k = after k advances
  grid.append(h('span', 'de-sb-lane de-sb-dim', 'element'))
  const noneHead = h('button', 'de-sb-col', '—')
  noneHead.title = 'always visible'
  grid.append(noneHead)
  for (let k = 1; k <= cols; k++) {
    const c = btn(String(k), `preview the slide after ${k} advance${k > 1 ? 's' : ''}`)
    c.className = `de-sb-col${previewStep === k ? ' dn-on' : ''}`
    c.addEventListener('click', () => {
      if (previewStep === k) clearMoment()
      else showMoment(slide, k)
      rebuild()
    })
    grid.append(c)
  }

  // stepped lanes first (in reveal order), then the unstepped in document
  // order — the whole slide is on the board, ready to choreograph
  const stepOf = (el: Element): number => Number(el.getAttribute('data-dia-step')) || 0
  const sorted = [...els].sort((a, b) => {
    const sa = stepOf(a)
    const sb = stepOf(b)
    if ((sa === 0) !== (sb === 0)) return sa === 0 ? 1 : -1
    if (sa !== sb) return sa - sb
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  })
  for (const el of sorted) {
    const step = stepOf(el)
    const lane = h('span', 'de-sb-lane', labelOf(el))
    lane.title = 'click to select the element'
    lane.addEventListener('click', () => {
      const sl = el.closest<HTMLElement>('section.dia-slide')
      if (sl && el instanceof HTMLElement) state.selection = { kind: 'element', el, slide: sl }
    })
    grid.append(lane)
    const none = btn(step === 0 ? '●' : '·', 'always visible (no step)')
    none.className = `de-sb-cell${step === 0 ? ' is-on' : ''}`
    if (step !== 0) none.addEventListener('click', () => state.apply(setAttr(el, 'data-dia-step', null)))
    grid.append(none)
    for (let k = 1; k <= cols; k++) {
      const cell = btn(step === k ? '●' : '·', `reveal at moment ${k}`)
      cell.className = `de-sb-cell${step === k ? ' is-on' : ''}`
      if (step !== k) cell.addEventListener('click', () => state.apply(setAttr(el, 'data-dia-step', String(k))))
      grid.append(cell)
    }
  }
  drawer.append(grid)
  if (overflow > 0) {
    drawer.append(h('div', 'de-sb-hint', `${overflow} more elements not shown — step them from the inspector and they join the board`))
  }

  if (previewStep >= 0) {
    drawer.append(h('div', 'de-sb-hint',
      `previewing moment ${previewStep} on the slide — later reveals are ghosted; click the column again to exit`))
  }
}

/* ---------- play-through ---------- */

function startPlay(slide: HTMLElement): void {
  stopPlay()
  let k = 0
  const last = maxStep(slide)
  showMoment(slide, 0)
  rebuild()
  playTimer = window.setInterval(() => {
    k++
    if (k > last) { stopPlay(); clearMoment(); rebuild(); return }
    showMoment(slide, k)
    rebuild()
  }, 900)
}

function stopPlay(): void {
  if (playTimer !== null) { clearInterval(playTimer); playTimer = null }
}

/* ---------- tiny DOM helpers ---------- */

function h(tag: string, cls = '', text = ''): HTMLElement {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  if (text) el.textContent = text
  return el
}

function btn(text: string, tip: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = text
  b.title = tip
  return b
}
