/* Stage altitude: one slide fills the viewport minus chrome, scaled to fit.
 * Visibility is driven by :host(.dia-stage) + [data-dia-current] rules in
 * the editor artifact style (shell installs it); this module sets the class
 * on the canvas host and keeps data-dia-current on the current slide. */

import { state } from '../state'
import { getImportReport } from './table'

const BASE_W = 980

let view!: HTMLElement
let outer!: HTMLElement
let fitBox!: HTMLElement
let canvas!: HTMLElement
let chipSlide!: HTMLElement
let chipConf!: HTMLElement
let prevBtn!: HTMLButtonElement
let nextBtn!: HTMLButtonElement

export function mountStage(mainEl: HTMLElement, canvasHost: HTMLElement): void {
  canvas = canvasHost

  view = document.createElement('div')
  view.className = 'de-stage'
  view.hidden = true

  const meta = document.createElement('div')
  meta.className = 'de-stage-meta'
  chipSlide = document.createElement('div')
  chipSlide.className = 'de-chip'
  chipConf = document.createElement('div')
  chipConf.className = 'de-chip'
  chipConf.hidden = true
  meta.append(chipSlide, chipConf)

  outer = document.createElement('div')
  outer.className = 'de-stage-outer'
  fitBox = document.createElement('div')
  fitBox.className = 'de-stage-fit'
  outer.append(fitBox)

  prevBtn = navButton('de-nav de-nav-prev', '←', 'previous slide', () =>
    state.setCurrentSlide(state.currentSlide - 1))
  nextBtn = navButton('de-nav de-nav-next', '→', 'next slide', () =>
    state.setCurrentSlide(state.currentSlide + 1))

  const hint = document.createElement('div')
  hint.className = 'de-esc-hint'
  const k = document.createElement('span')
  k.className = 'de-k'
  k.textContent = 'esc'
  hint.append(k, document.createTextNode(' back to table'))

  view.append(meta, outer, prevBtn, nextBtn, hint)
  mainEl.append(view)

  new ResizeObserver(() => { if (!view.hidden) fit() }).observe(view)

  state.bus.on((e) => {
    if (view.hidden) return
    if (e.type === 'current-slide' || e.type === 'op' || e.type === 'undo'
      || e.type === 'redo' || e.type === 'slides-changed' || e.type === 'deck-loaded') {
      applyCurrent()
      fit()
    }
  })
}

function navButton(cls: string, glyph: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = cls
  b.type = 'button'
  b.textContent = glyph
  b.setAttribute('aria-label', label)
  b.addEventListener('click', onClick)
  return b
}

/* ---------- altitude switching (shell drives this) ---------- */

export function enterStage(): void {
  view.hidden = false
  canvas.classList.add('dia-stage')
  if (canvas.parentElement !== fitBox) fitBox.append(canvas)
  applyCurrent()
  fit()
}

export function exitStage(): void {
  canvas.classList.remove('dia-stage')
  for (const s of state.slides()) s.removeAttribute('data-dia-current')
  view.hidden = true
}

/** the element the shell animates for the FLIP lift (bounds ≈ visible slide) */
export function stageFlipTarget(): HTMLElement {
  return outer
}

/* ---------- internals ---------- */

function applyCurrent(): void {
  const slides = state.slides()
  const cur = state.currentSlide
  slides.forEach((s, i) => {
    if (i === cur) s.setAttribute('data-dia-current', '')
    else s.removeAttribute('data-dia-current')
  })
  chipSlide.textContent = `slide ${Math.min(cur + 1, slides.length)} / ${slides.length}`
  const rep = getImportReport()
  const c = rep?.confidence[cur]
  if (typeof c === 'number') {
    chipConf.hidden = false
    const val = document.createElement('span')
    val.className = c < 0.95 ? 'de-conf-warn' : 'de-conf-good'
    val.textContent = c.toFixed(2)
    chipConf.replaceChildren(document.createTextNode('confidence '), val)
  } else {
    chipConf.hidden = true
  }
  prevBtn.disabled = cur <= 0
  nextBtn.disabled = cur >= slides.length - 1
}

function fit(): void {
  const availW = Math.max(120, view.clientWidth - 128)
  const availH = Math.max(90, view.clientHeight - 100)
  fitBox.style.width = `${BASE_W}px`
  const h = canvas.offsetHeight || (BASE_W * 9) / 16
  const k = Math.min(availW / BASE_W, availH / h)
  fitBox.style.transform = `scale(${k})`
  outer.style.width = `${BASE_W * k}px`
  outer.style.height = `${h * k}px`
}
