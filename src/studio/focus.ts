/* Slide focus: a WHOLE SLIDE visits the studio shell. The slide reparents
 * into a fixed overlay INSIDE the deck shadow root, and because every
 * editor gesture is delegated at the root (text editing, block dragging,
 * scene manipulation, the context menu), all of them keep working on the
 * focused slide — this is a place to work, not a different editor.
 * serializeClean() closes the focus first, exactly like the svg studio. */

import { state } from '../state'
import { h, button, closeStudio, ensureStudioStyle } from './studio'

const ARTIFACT = 'dia-editor-artifact'

interface FocusSession {
  slide: HTMLElement
  overlay: HTMLElement
  home: { parent: ParentNode; next: Node | null }
  offBus: () => void
  offKey: () => void
}

let focus: FocusSession | null = null

export function slideFocusOpen(): boolean {
  return focus !== null
}

export function closeSlideFocus(): void {
  if (!focus) return
  const f = focus
  focus = null
  f.home.parent.insertBefore(f.slide, f.home.next)
  f.overlay.remove()
  f.offBus()
  f.offKey()
  if (!document.querySelector('.dia-studio')) {
    state.deck?.root.getElementById('dia-studio-style')?.remove()
  }
}

export function toggleSlideFocus(slide: HTMLElement): void {
  if (focus && focus.slide === slide) { closeSlideFocus(); return }
  openSlideFocus(slide)
}

export function openSlideFocus(slide: HTMLElement): void {
  const deck = state.deck
  if (!deck || !slide.parentNode) return
  closeStudio()
  closeSlideFocus()
  ensureStudioStyle()

  const overlay = h('div', `dia-studio ${ARTIFACT}`)
  overlay.setAttribute('role', 'dialog')

  const head = h('header', 'dia-st-head')
  const idx = state.slides().indexOf(slide)
  head.append(
    h('span', 'dia-st-title', 'slide focus'),
    h('span', 'dia-st-hint',
      `slide ${idx + 1} — every editor gesture works here: text, drag, scenes, right-click`),
    h('span', 'dia-st-spacer'),
  )
  const done = button('done', 'return the slide to the deck (esc)')
  done.classList.add('dia-st-done')
  done.addEventListener('click', closeSlideFocus)
  head.append(done)

  const body = h('div', 'dia-st-body')
  const stageWrap = h('div', 'dia-st-stagewrap')
  const stage = h('div', 'dia-st-stage')
  stageWrap.append(stage)
  body.append(stageWrap)

  const foot = h('footer', 'dia-st-foot')
  const zoomLabel = h('span', 'dia-st-zoom', '100%')
  foot.append(
    h('span', 'dia-st-keys', 'wheel zoom · middle-drag pan · esc closes'),
    h('span', 'dia-st-spacer'), zoomLabel,
  )
  overlay.append(head, body, foot)
  deck.root.appendChild(overlay)

  const home = { parent: slide.parentNode, next: slide.nextSibling }
  stage.appendChild(slide)

  const view = { zoom: 1, x: 0, y: 0 }
  const applyView = (): void => {
    stage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`
    zoomLabel.textContent = `${Math.round(view.zoom * 100)}%`
  }
  const wr = stageWrap.getBoundingClientRect()
  const box = slide.getBoundingClientRect()
  if (wr.width > 0 && box.width > 0) {
    view.zoom = Math.min(2, (wr.width * 0.86) / box.width, (wr.height * 0.86) / box.height)
    view.x = (wr.width - box.width * view.zoom) / 2
    view.y = (wr.height - box.height * view.zoom) / 2
  }
  applyView()

  stageWrap.addEventListener('wheel', (e) => {
    e.preventDefault()
    const next = Math.min(6, Math.max(0.15, view.zoom * Math.exp(-e.deltaY * 0.0015)))
    const r = stageWrap.getBoundingClientRect()
    const cx = e.clientX - r.left
    const cy = e.clientY - r.top
    view.x = cx - (cx - view.x) * (next / view.zoom)
    view.y = cy - (cy - view.y) * (next / view.zoom)
    view.zoom = next
    applyView()
  }, { passive: false })

  // middle-drag pans; plain drags stay with the slide's own editing
  stageWrap.addEventListener('pointerdown', (e) => {
    if (e.button !== 1) return
    e.preventDefault()
    const from = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
    const move = (ev: PointerEvent): void => {
      view.x = from.vx + (ev.clientX - from.x)
      view.y = from.vy + (ev.clientY - from.y)
      applyView()
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, true)

  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    // an in-place text edit owns its own Esc; only a free Esc closes
    const t = e.composedPath()[0]
    if (t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
    if (state.selection.kind !== 'none') { state.selection = { kind: 'none' }; return }
    e.stopPropagation()
    closeSlideFocus()
  }
  document.addEventListener('keydown', onKey, true)

  const offBus = state.bus.on((e) => {
    if (e.type === 'deck-loaded') closeSlideFocus()
  })

  focus = {
    slide, overlay, home,
    offBus,
    offKey: () => document.removeEventListener('keydown', onKey, true),
  }
}
