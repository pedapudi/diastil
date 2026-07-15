/* Slide focus: a WHOLE SLIDE visits the studio shell. The slide reparents
 * into a fixed overlay INSIDE the deck shadow root, and because every
 * editor gesture is delegated at the root (text editing, block dragging,
 * scene manipulation, the context menu), all of them keep working on the
 * focused slide — this is a place to work, not a different editor.
 * serializeClean() closes the focus first, exactly like the svg studio. */

import { state } from '../state'
import { insertEl } from '../model/ops'
import { h, button, closeStudio, ensureStudioStyle } from './studio'
import {
  ensureSceneStyleRules, getDrawTool, insertShapeNode, setDrawTool, type InsertKind,
} from '../scene/interact'
import { insertTextOnSlide } from '../editor/textedit'
import { insertMathOnSlide } from '../editor/math'
import { assignFreshIds } from '../editor/slides'

const ARTIFACT = 'dia-editor-artifact'

/** the slide's full-slide diagram layer — created on first use, so the
 * focus rail's drawing tools always have a surface to land on */
function diagramLayerOf(slide: HTMLElement): SVGSVGElement {
  let layer = slide.querySelector<SVGSVGElement>(':scope > svg.dia-scene-full')
  if (layer) return layer
  ensureSceneStyleRules()
  layer = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGSVGElement
  layer.setAttribute('class', 'dia-scene dia-scene-full')
  layer.setAttribute('viewBox', '0 0 1280 720')
  layer.setAttribute('aria-label', 'diagram layer')
  assignFreshIds(layer as unknown as HTMLElement)
  state.apply(insertEl(slide, slide.children.length, layer, 'InsertDiagramLayer'))
  return layer
}

interface FocusSession {
  slide: HTMLElement
  overlay: HTMLElement
  home: { parent: ParentNode; next: Node | null }
  offBus: () => void
  offKey: () => void
  offPlace: () => void
}

let focus: FocusSession | null = null

export function slideFocusOpen(): boolean {
  return focus !== null
}

export function closeSlideFocus(): void {
  if (!focus) return
  const f = focus
  focus = null
  document.querySelector('.de-app')?.classList.remove('de-focus-on')
  setDrawTool(null) // a draw mode must not outlive the focus
  f.home.parent.insertBefore(f.slide, f.home.next)
  f.overlay.remove()
  f.offBus()
  f.offKey()
  f.offPlace()
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

  // the minimap yields while a slide is focused — one slide, one stage
  document.querySelector('.de-app')?.classList.add('de-focus-on')

  const overlay = h('div', `dia-studio ${ARTIFACT}`)
  overlay.setAttribute('role', 'dialog')

  const head = h('header', 'dia-st-head')
  const idx = state.slides().indexOf(slide)
  head.append(
    h('span', 'dia-st-title', 'slide focus'),
    h('span', 'dia-st-hint',
      `slide ${idx + 1} — select anything: the inspector, storyboard, and right-click all work here`),
    h('span', 'dia-st-spacer'),
  )
  const done = button('done', 'return the slide to the deck (esc)')
  done.classList.add('dia-st-done')
  done.addEventListener('click', closeSlideFocus)
  head.append(done)

  const body = h('div', 'dia-st-body')

  /* ----- the creation rail: the studio's tools, aimed at a SLIDE ----- */
  const toolsEl = h('div', 'dia-st-tools')
  toolsEl.append(h('div', 'dia-st-sect', 'insert'))
  const bText = button('+ text', 'add a text block and start typing')
  bText.addEventListener('click', () => insertTextOnSlide(slide))
  const bMath = button('+ math', 'add a LaTeX formula (edit by double-clicking it)')
  bMath.addEventListener('click', () => {
    const el = insertMathOnSlide(slide)
    if (el) state.selection = { kind: 'element', el, slide }
  })
  toolsEl.append(bText, bMath)

  toolsEl.append(h('div', 'dia-st-sect', 'shapes'))
  for (const [labelText, kind] of [
    ['+ node', 'node'], ['+ circle', 'circle'], ['+ square', 'square'],
    ['+ star', 'star'], ['+ arrow', 'arrow'],
  ] as Array<[string, InsertKind]>) {
    const b = button(labelText, `insert a ${kind} on the slide's diagram layer (created on first use)`)
    b.addEventListener('click', () => insertShapeNode(diagramLayerOf(slide), kind))
    toolsEl.append(b)
  }

  toolsEl.append(h('div', 'dia-st-sect', 'draw'))
  const drawButtons = new Map<string, HTMLButtonElement>()
  const syncDraw = (): void => {
    const t = getDrawTool() ?? 'off'
    for (const [name, b] of drawButtons) b.classList.toggle('dia-st-on', name === t)
  }
  for (const tool of ['off', 'line', 'pen'] as const) {
    const b = button(tool, tool === 'off' ? 'stop drawing' : `draw ${tool}s anywhere on the slide — release commits, esc exits`)
    b.addEventListener('click', () => {
      if (tool !== 'off') diagramLayerOf(slide) // the strokes need a surface
      setDrawTool(tool === 'off' ? null : tool)
      syncDraw()
    })
    drawButtons.set(tool, b)
    toolsEl.append(b)
  }
  syncDraw()

  const stageWrap = h('div', 'dia-st-stagewrap')
  const stage = h('div', 'dia-st-stage')
  stageWrap.append(stage)
  body.append(toolsEl, stageWrap)

  const foot = h('footer', 'dia-st-foot')
  const zoomLabel = h('span', 'dia-st-zoom', '100%')
  foot.append(
    h('span', 'dia-st-keys', 'wheel zoom · middle-drag pan · esc closes'),
    h('span', 'dia-st-spacer'), zoomLabel,
  )
  overlay.append(head, body, foot)
  deck.root.appendChild(overlay)

  // focus REPLACES the table, not the editor: the overlay sizes itself to
  // the main column so the topbar and the full inspector rail stay live —
  // that rail IS the tool surface (typesetting, steps, storyboard, tokens)
  const place = (): void => {
    const main = document.querySelector('.de-main')
    const r = main?.getBoundingClientRect()
    if (!r || r.width === 0) return
    overlay.style.left = `${r.left}px`
    overlay.style.top = `${r.top}px`
    overlay.style.width = `${r.width}px`
    overlay.style.height = `${r.height}px`
  }
  place()
  const mainEl = document.querySelector('.de-main')
  const ro = mainEl ? new ResizeObserver(place) : null
  if (mainEl && ro) ro.observe(mainEl)
  window.addEventListener('resize', place)

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
    offPlace: () => {
      ro?.disconnect()
      window.removeEventListener('resize', place)
    },
  }
}
