/* Slide focus: a WHOLE SLIDE on the studio stage, with the FULL studio
 * toolset. The slide reparents into a stage that replaces the table (the
 * inspector rail stays live), and the studio's vector machinery — select /
 * pen / shapes / freehand / text, transforms, groups, layers, properties —
 * mounts on the slide's full-slide drawing layer (created on first use).
 * The scene machinery deliberately ignores presses inside studio overlays,
 * so the studio tools OWN the layer here; in select mode the layer passes
 * empty-space presses through, keeping the slide's text and blocks
 * editable in place. One surface at a time: opening the svg studio closes
 * focus and vice versa — studios never nest. */

import { state } from '../state'
import { insertEl } from '../model/ops'
import {
  adoptSession, dropSession, h, button, closeStudio, ensureStudioStyle,
  registerSlideFocusClose, type StudioSession,
} from './studio'
import { mountTools, disposeTools, currentTool, deletePicked, exitGroup, nudgePicked, setTool, TOOLS } from './tools'
import { mountPanels, disposePanels, refreshPanels } from './panels'
import { ensureSceneStyleRules } from '../scene/interact'
import { insertTextOnSlide } from '../editor/textedit'
import { insertMathOnSlide } from '../editor/math'
import { assignFreshIds } from '../editor/slides'

const ARTIFACT = 'dia-editor-artifact'

interface FocusSession {
  slide: HTMLElement
  overlay: HTMLElement
  home: { parent: ParentNode; next: Node | null }
  studio: StudioSession | null
  offBus: () => void
  offKey: () => void
  offPlace: () => void
}

let focus: FocusSession | null = null

export function slideFocusOpen(): boolean {
  return focus !== null
}

/** the slide currently visiting the focus stage, if any */
export function focusedSlide(): HTMLElement | null {
  return focus?.slide ?? null
}

export function closeSlideFocus(): void {
  if (!focus) return
  const f = focus
  focus = null
  document.querySelector('.de-app')?.classList.remove('de-focus-on')
  if (f.studio) {
    disposeTools()
    disposePanels()
    dropSession(f.studio)
  }
  f.home.parent.insertBefore(f.slide, f.home.next)
  f.overlay.remove()
  f.offBus()
  f.offKey()
  f.offPlace()
  if (!state.deck?.root.querySelector('.dia-studio')) {
    state.deck?.root.getElementById('dia-studio-style')?.remove()
  }
}

export function toggleSlideFocus(slide: HTMLElement): void {
  if (focus && focus.slide === slide) { closeSlideFocus(); return }
  openSlideFocus(slide)
}

/** the slide's full-slide drawing layer — the studio tools' surface */
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

export function openSlideFocus(slide: HTMLElement): void {
  const deck = state.deck
  if (!deck || !slide.parentNode) return
  registerSlideFocusClose(closeSlideFocus) // call-time: safe from the cycle
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
      `slide ${idx + 1} — text and blocks edit in place; vector tools draw on the slide's layer`),
    h('span', 'dia-st-spacer'),
  )
  const done = button('done', 'return the slide to the deck (esc)')
  done.classList.add('dia-st-done')
  done.addEventListener('click', closeSlideFocus)
  head.append(done)

  const body = h('div', 'dia-st-body')
  const toolsEl = h('div', 'dia-st-tools')
  const stageWrap = h('div', 'dia-st-stagewrap')
  const stage = h('div', 'dia-st-stage')
  stageWrap.append(stage)
  body.append(toolsEl, stageWrap)

  const foot = h('footer', 'dia-st-foot')
  const zoomLabel = h('span', 'dia-st-zoom', '100%')
  foot.append(
    h('span', 'dia-st-keys', 'wheel zoom · middle-drag pan · esc backs out'),
    h('span', 'dia-st-spacer'), zoomLabel,
  )
  overlay.append(head, body, foot)
  deck.root.appendChild(overlay)

  // focus REPLACES the table, not the editor: size to the main column so
  // the topbar and the full inspector rail stay live
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

  /* ----- the rail: inserts + the FULL vector toolset ----- */
  toolsEl.append(h('div', 'dia-st-sect', 'insert'))
  const bText = button('+ text', 'add a text block and start typing')
  bText.addEventListener('click', () => insertTextOnSlide(slide))
  const bMath = button('+ math', 'add a LaTeX formula (edit by double-clicking it)')
  bMath.addEventListener('click', () => {
    const el = insertMathOnSlide(slide)
    if (el) state.selection = { kind: 'element', el, slide }
  })
  toolsEl.append(bText, bMath)

  const f: FocusSession = {
    slide, overlay, home, studio: null,
    offBus: () => {}, offKey: () => {}, offPlace: () => {},
  }
  focus = f

  /** wire the studio machinery to the slide's drawing layer */
  const mountVector = (): void => {
    if (f.studio) return
    const layer = diagramLayerOf(slide)
    const s: StudioSession = {
      svg: layer, overlay, stage,
      home: { parent: layer.parentNode as ParentNode, next: layer.nextSibling },
      picked: new Set(), entered: [],
      zoom: 1, panX: 0, panY: 0,
      offBus: () => {}, offKey: () => {},
      embedded: true,
    }
    f.studio = s
    adoptSession(s)
    const vectorHost = h('div', '')
    vectorHost.style.display = 'contents'
    toolsEl.append(vectorHost)
    mountTools(s, vectorHost)
    const panelHost = h('div', 'dia-st-rail')
    panelHost.style.cssText = 'border-left: 0; border-top: 1px solid var(--rule, #333); width: auto; padding: 10px 0 0; margin-top: 10px;'
    toolsEl.append(panelHost)
    mountPanels(s, panelHost)
  }
  // the toolset is ALWAYS visible — a slide that already draws gets the
  // live machinery; otherwise placeholder buttons stand in, and the first
  // tool you actually use creates the drawing layer and swaps them out
  const placeholders = h('div', '')
  placeholders.style.display = 'contents'
  const activate = (name: Parameters<typeof setTool>[0]): void => {
    placeholders.remove()
    mountVector()
    setTool(name)
  }
  if (slide.querySelector(':scope > svg.dia-scene-full')) {
    mountVector()
  } else {
    placeholders.append(h('div', 'dia-st-sect', 'tools'))
    for (const t of TOOLS) {
      const b = button(t.label, `${t.tip} — the first use adds the slide’s drawing layer`)
      const kbd = document.createElement('kbd')
      kbd.textContent = t.key
      b.append(kbd)
      b.addEventListener('click', () => activate(t.name))
      placeholders.append(b)
    }
    toolsEl.append(placeholders)
  }

  /* ----- zoom / pan ----- */
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

  /* ----- keys: full studio chain, then focus ----- */
  const isTyping = (e: KeyboardEvent): boolean => {
    const t = e.composedPath()[0]
    return t instanceof HTMLElement &&
      (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')
  }
  const onKey = (e: KeyboardEvent): void => {
    if (isTyping(e)) return
    if (e.key === 'Escape') {
      e.stopPropagation()
      e.preventDefault()
      // back out one layer at a time: tool → picked → group → selection → focus
      if (f.studio) {
        if (currentTool() !== 'select') { setTool('select'); return }
        if (f.studio.picked.size > 0) { f.studio.picked.clear(); refreshPanels(f.studio); return }
        if (f.studio.entered.length > 0) { exitGroup(); return }
      }
      if (state.selection.kind !== 'none') { state.selection = { kind: 'none' }; return }
      closeSlideFocus()
      return
    }
    if (!f.studio) return
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (f.studio.picked.size > 0) { e.preventDefault(); e.stopPropagation(); deletePicked() }
      return
    }
    const NUDGE: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
    }
    if (NUDGE[e.key] && f.studio.picked.size > 0) {
      e.preventDefault()
      e.stopPropagation()
      const k = e.shiftKey ? 10 : 1
      nudgePicked(NUDGE[e.key][0] * k, NUDGE[e.key][1] * k)
      return
    }
    const tool = TOOLS.find((t) => t.key === e.key.toLowerCase())
    if (tool && !e.metaKey && !e.ctrlKey) { e.stopPropagation(); setTool(tool.name) }
  }
  const onKeyPre = (e: KeyboardEvent): void => {
    // tool shortcuts work BEFORE the layer exists too — first use creates it
    if (f.studio || isTyping(e) || e.metaKey || e.ctrlKey) return
    const tool = TOOLS.find((t) => t.key === e.key.toLowerCase())
    if (tool) { e.stopPropagation(); activate(tool.name) }
  }
  document.addEventListener('keydown', onKeyPre, true)
  document.addEventListener('keydown', onKey, true)

  const offBus = state.bus.on((ev) => {
    if (ev.type === 'deck-loaded') closeSlideFocus()
  })

  f.offBus = offBus
  f.offKey = () => {
    document.removeEventListener('keydown', onKey, true)
    document.removeEventListener('keydown', onKeyPre, true)
  }
  f.offPlace = () => {
    ro?.disconnect()
    window.removeEventListener('resize', place)
  }
}
