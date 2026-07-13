/* Compare-with-original overlay: re-render the imported slide's TRUE source
 * next to its current converted form, straight from the editor. The source
 * pages come from the deck itself — accepted imports embed one
 * self-contained page per slide (script#dia-originals, profile §8) — so the
 * comparison works forever, no source file or import session required.
 * ←/→ walk slides, Esc closes. Read-only: repairs still happen through the
 * copilot or a fresh import. */

import type { Deck } from '../types'
import { readEmbeddedOriginals } from '../ingest/convert'
import { unscopeFromHost } from '../model/parse'
import { state } from '../state'

const PAGE_W = 1280
const PAGE_H = 720
/** session attrs that must not leak into the compare render */
const EDITOR_ATTRS = ['data-dia-id', 'contenteditable', 'spellcheck', 'data-dia-selected', 'data-dia-current', 'data-dia-step-shown']

/** the embedded reference originals of a loaded deck, if it was imported */
export function embeddedOriginals(deck: Deck): string[] | null {
  if (!deck.headExtras.includes('dia-originals')) return null
  const doc = new DOMParser().parseFromString(
    `<html><head>${deck.headExtras}</head><body></body></html>`, 'text/html')
  return readEmbeddedOriginals(doc)
}

export function openCompare(deck: Deck, index: number): void {
  const originals = embeddedOriginals(deck)
  if (!originals || originals.length === 0) return
  let i = Math.max(0, Math.min(index, originals.length - 1))

  const overlay = h('div', 'dia-review dia-compare')
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')

  const head = h('header', 'dia-review-head')
  const title = h('span', 'dia-review-title')
  const spacer = h('div', 'dia-review-spacer')
  const prev = btn('←', 'previous slide')
  const next = btn('→', 'next slide')
  const close = btn('close', 'close (esc)')
  head.append(title, spacer, prev, next, close)

  const cmp = h('div', 'dia-cmp')
  cmp.dataset.mode = 'side'
  const origPane = pane('original')
  const currPane = pane('current')
  cmp.append(origPane.pane, currPane.pane)

  const main = h('div', 'dia-review-main')
  main.appendChild(cmp)
  const body = h('div', 'dia-review-body')
  body.appendChild(main)
  overlay.append(head, body)
  document.body.appendChild(overlay)

  const render = (): void => {
    title.replaceChildren(
      dim('original · slide '), h('span', '', String(i + 1)), dim(` of ${originals.length}`))
    origPane.frame.srcdoc = originals[i]
    currPane.frame.srcdoc = currentSlidePage(deck, i)
    prev.disabled = i === 0
    next.disabled = i === originals.length - 1
    requestAnimationFrame(fit)
  }

  const fit = (): void => {
    for (const p of [origPane, currPane]) {
      const w = p.viewport.clientWidth
      if (w > 0) p.frame.style.transform = `scale(${w / PAGE_W})`
    }
  }

  const dispose = (): void => {
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('resize', fit)
    overlay.remove()
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); dispose() }
    else if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); i--; render() }
    else if (e.key === 'ArrowRight' && i < originals.length - 1) { e.preventDefault(); i++; render() }
  }
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('resize', fit)
  prev.addEventListener('click', () => { if (i > 0) { i--; render() } })
  next.addEventListener('click', () => { if (i < originals.length - 1) { i++; render() } })
  close.addEventListener('click', dispose)

  render()
}

/** the CURRENT slide as a self-contained page — live theme, live content,
 * session artifacts stripped */
function currentSlidePage(deck: Deck, i: number): string {
  const slide = state.slides()[i]
  if (!slide) return '<!doctype html><body></body>'
  const clone = slide.cloneNode(true) as HTMLElement
  for (const node of [clone, ...clone.querySelectorAll<HTMLElement>('*')]) {
    for (const a of EDITOR_ATTRS) node.removeAttribute(a)
    if (node.classList.contains('dia-editor-artifact')) node.remove()
  }
  const theme = unscopeFromHost(deck.themeStyle.textContent ?? '')
  return `<!doctype html><html><head><meta charset="utf-8"><style>${theme}
html, body { margin: 0; }
section.dia-slide { width: ${PAGE_W}px; height: ${PAGE_H}px; }
</style></head><body>${clone.outerHTML}</body></html>`
}

function pane(label: string): { pane: HTMLElement; viewport: HTMLElement; frame: HTMLIFrameElement } {
  const p = h('div', 'dia-cmp-pane dn-panel')
  p.appendChild(h('div', 'dia-cmp-label', label))
  const viewport = h('div', 'dia-cmp-viewport')
  const frame = document.createElement('iframe')
  frame.width = String(PAGE_W)
  frame.height = String(PAGE_H)
  frame.style.transformOrigin = '0 0'
  viewport.appendChild(frame)
  p.appendChild(viewport)
  return { pane: p, viewport, frame }
}

function h(tag: string, cls = '', text = ''): HTMLElement {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  if (text) el.textContent = text
  return el
}

function dim(text: string): HTMLElement {
  const s = h('span', 'dim', text)
  return s
}

function btn(text: string, label: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'dn-btn'
  b.textContent = text
  b.title = label
  b.setAttribute('aria-label', label)
  return b
}
