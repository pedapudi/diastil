/* Slide focus: a WHOLE SLIDE on the studio stage, with the FULL studio
 * toolset — and ISOLATION for deep-diving one drawing without leaving.
 *
 * The slide reparents into a stage that replaces the table (topbar and
 * the inspector rail stay live, so the copilot works here too). The
 * studio's vector machinery mounts on ONE svg at a time — the slide's
 * full-slide drawing layer by default, or an ISOLATED drawing: everything
 * else dims and ignores presses until esc steps back out. 'Open in
 * studio' anywhere routes here; studios never nest and never go
 * fullscreen-modal. serializeClean() closes focus before any save. */

import { state } from '../state'
import { insertEl } from '../model/ops'
import {
  adoptSession, dropSession, h, button, closeStudio, ensureStudioStyle,
  registerSlideFocusClose, type StudioSession,
} from './studio'
import { mountTools, disposeTools, clearPicked, currentTool, deletePicked, exitGroup, nudgePicked, setTool, SCENE_INSERTS, TOOLS } from './tools'
import { mountPanels, disposePanels } from './panels'
import { openImportDialog } from './svgimport'
import { ensureSceneStyleRules, insertShapeNode } from '../scene/interact'
import { setToolbarSuppressed } from '../scene/toolbar'
import { insertTextOnSlide } from '../editor/textedit'
import { assignFreshIds } from '../editor/slides'

const ARTIFACT = 'dia-editor-artifact'

interface Isolation {
  svg: SVGSVGElement
  dims: Array<{ el: HTMLElement | SVGElement; opacity: string; pe: string }>
}

interface FocusSession {
  slide: HTMLElement
  overlay: HTMLElement
  home: { parent: ParentNode; next: Node | null }
  studio: StudioSession | null
  isolated: Isolation | null
  bindSession: (svg: SVGSVGElement) => void
  isolate: (svg: SVGSVGElement) => void
  exitIsolation: () => void
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

/** THE studio entry: focus the drawing's slide and isolate the drawing.
 * openStudio() routes here from every 'open in studio' surface. */
export function focusIsolate(svg: SVGSVGElement): void {
  const slide = svg.closest<HTMLElement>('section.dia-slide')
  if (!slide) return
  if (!focus || focus.slide !== slide) openSlideFocus(slide)
  focus?.isolate(svg)
}

export function closeSlideFocus(): void {
  if (!focus) return
  const f = focus
  focus = null
  f.exitIsolation()
  document.querySelector('.de-app')?.classList.remove('de-focus-on')
  if (f.studio) {
    disposeTools()
    disposePanels()
    dropSession(f.studio)
  }
  // a cross-session history restore can replace the document UNDER the
  // focus — the recorded home then belongs to the old tree
  const nextOk = f.home.next && f.home.next.parentNode === f.home.parent
  try { f.home.parent.insertBefore(f.slide, nextOk ? f.home.next : null) } catch { /* document replaced */ }
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

/** the slide's full-slide drawing layer — the default tool surface */
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
  const hint = h('span', 'dia-st-hint',
    `slide ${idx + 1} — text and blocks edit in place; vector tools draw on the slide's layer`)
  head.append(h('span', 'dia-st-title', 'slide focus'), hint, h('span', 'dia-st-spacer'))
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

  /* ----- the rail: inserts + the vector toolset for ONE svg at a time ----- */
  toolsEl.append(h('div', 'dia-st-sect', 'insert'))
  const bText = button('+ text', 'add a text block and start typing — type $latex$ (or a \\command) and it becomes math', 'text-add')
  bText.addEventListener('click', () => insertTextOnSlide(slide))
  toolsEl.append(bText)
  const vectorWrap = h('div', '')
  vectorWrap.style.display = 'contents'
  toolsEl.append(vectorWrap)

  const f: FocusSession = {
    slide, overlay, home, studio: null, isolated: null,
    bindSession: () => {}, isolate: () => {}, exitIsolation: () => {},
    offBus: () => {}, offKey: () => {}, offPlace: () => {},
  }
  focus = f

  const clearSession = (): void => {
    if (f.studio) {
      disposeTools()
      disposePanels()
      dropSession(f.studio)
      f.studio = null
    }
    vectorWrap.replaceChildren()
  }

  /** the vector machinery, bound to one svg (the layer, or an isolate) */
  const bindSession = (svg: SVGSVGElement): void => {
    clearSession()
    const s: StudioSession = {
      svg, overlay, stage,
      home: { parent: svg.parentNode as ParentNode, next: svg.nextSibling },
      picked: new Set(), entered: [],
      zoom: 1, panX: 0, panY: 0,
      offBus: () => {}, offKey: () => {},
      embedded: true,
    }
    f.studio = s
    adoptSession(s)
    mountTools(s, vectorWrap)
    const imp = button('import svg…', 'add artwork from pasted markup or a file (lands in this drawing)', 'import')
    imp.addEventListener('click', () => { if (f.studio) openImportDialog(f.studio) })
    vectorWrap.append(imp)
    const panelHost = h('div', 'dia-st-rail')
    panelHost.style.cssText = 'border-left: 0; border-top: 1px solid var(--rule, #333); width: auto; padding: 10px 0 0; margin-top: 10px;'
    vectorWrap.append(panelHost)
    mountPanels(s, panelHost)
  }
  f.bindSession = bindSession

  /** the FULL rail, before the drawing layer exists: every section shows
   * from the start (no hidden UI); the first real use creates the layer
   * and swaps in the live machinery in the same shape */
  const showPlaceholders = (): void => {
    clearSession()
    const ph = h('div', '')
    ph.style.display = 'contents'
    ph.append(h('div', 'dia-st-sect', 'tools'))
    for (const t of TOOLS) {
      const b = button(t.label, `${t.tip} — the first use adds the slide’s drawing layer`, t.icon)
      const kbd = document.createElement('kbd')
      kbd.textContent = t.key
      b.append(kbd)
      b.addEventListener('click', () => activate(t.name))
      ph.append(b)
    }
    ph.append(h('div', 'dia-st-sect', 'scene'))
    for (const ins of SCENE_INSERTS) {
      const b = button(ins.label, `insert a ${ins.kind} — the first use adds the slide’s drawing layer`, ins.icon)
      b.addEventListener('click', () => {
        activate('select')
        if (f.studio) insertShapeNode(f.studio.svg, ins.kind)
      })
      ph.append(b)
    }
    for (const [labelText, tip, icon] of [
      ['edit points', 'drag a path’s anchors and control points — pick a path first', 'points'],
      ['group', 'wrap a selection in a group — pick elements first', 'group'],
      ['ungroup', 'dissolve a selected group', 'ungroup'],
      ['import svg…', 'add artwork from pasted markup or a file', 'import'],
    ] as const) {
      const b = button(labelText, tip, icon)
      b.addEventListener('click', () => {
        activate('select')
        if (labelText === 'import svg…' && f.studio) openImportDialog(f.studio)
      })
      ph.append(b)
    }
    ph.append(h('div', 'dia-st-sect', 'properties'))
    ph.append(h('div', 'dia-st-hint', 'pick something on the drawing — fill, line, and width live here'))
    ph.append(h('div', 'dia-st-sect', 'layers'))
    ph.append(h('div', 'dia-st-hint', 'nothing drawn yet'))
    vectorWrap.append(ph)
  }
  const activate = (name: Parameters<typeof setTool>[0]): void => {
    bindSession(diagramLayerOf(slide))
    setTool(name)
  }

  /* ----- isolation: one drawing, everything else dims ----- */
  const isolate = (svg: SVGSVGElement): void => {
    f.exitIsolation()
    const iso: Isolation = { svg, dims: [] }
    for (const c of [...slide.children]) {
      if (!(c instanceof HTMLElement) && !(c instanceof SVGElement)) continue
      if (c === svg || c.contains(svg) || c.classList.contains(ARTIFACT)) continue
      iso.dims.push({ el: c, opacity: c.style.opacity, pe: c.style.pointerEvents })
      c.style.opacity = '0.15'
      c.style.pointerEvents = 'none'
    }
    f.isolated = iso
    if (svg.classList.contains('dia-scene')) setToolbarSuppressed(true)
    state.selection = { kind: 'none' }
    bindSession(svg)
    hint.textContent = `isolated drawing — everything else is dimmed; esc steps back to the slide`
  }
  const exitIsolation = (): void => {
    const iso = f.isolated
    if (!iso) return
    f.isolated = null
    for (const d of iso.dims) {
      d.opacity ? d.el.style.opacity = d.opacity : d.el.style.removeProperty('opacity')
      d.pe ? d.el.style.pointerEvents = d.pe : d.el.style.removeProperty('pointer-events')
    }
    setToolbarSuppressed(false)
    hint.textContent = `slide ${idx + 1} — text and blocks edit in place; vector tools draw on the slide's layer`
    const layer = slide.querySelector<SVGSVGElement>(':scope > svg.dia-scene-full')
    layer ? bindSession(layer) : showPlaceholders()
  }
  f.isolate = isolate
  f.exitIsolation = exitIsolation

  const layer = slide.querySelector<SVGSVGElement>(':scope > svg.dia-scene-full')
  layer ? bindSession(layer) : showPlaceholders()

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

  /* ----- keys: full studio chain, then isolation, then focus ----- */
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
      // back out one layer at a time:
      // tool → picked → group → ISOLATION → selection → focus
      if (f.studio) {
        if (currentTool() !== 'select') { setTool('select'); return }
        if (f.studio.picked.size > 0) { clearPicked(); return }
        if (f.studio.entered.length > 0) { exitGroup(); return }
      }
      if (f.isolated) { exitIsolation(); return }
      if (state.selection.kind !== 'none') { state.selection = { kind: 'none' }; return }
      closeSlideFocus()
      return
    }
    if (!f.studio) {
      const tool = TOOLS.find((t) => t.key === e.key.toLowerCase())
      if (tool && !e.metaKey && !e.ctrlKey) { e.stopPropagation(); activate(tool.name) }
      return
    }
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
  document.addEventListener('keydown', onKey, true)

  const offBus = state.bus.on((ev) => {
    if (ev.type === 'deck-loaded') closeSlideFocus()
  })

  f.offBus = offBus
  f.offKey = () => document.removeEventListener('keydown', onKey, true)
  f.offPlace = () => {
    ro?.disconnect()
    window.removeEventListener('resize', place)
  }
}
