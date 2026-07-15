/* SVG studio — a large modal drawing surface for one svg element.
 *
 * The selected <svg> is REPARENTED into the studio stage and back on close,
 * so element identity is preserved: every op created during the session
 * references the same nodes the op log already knows, and undo works after
 * the studio closes. The overlay itself is a .dia-editor-artifact inside the
 * deck shadow root — deck theme tokens (var(--dia-*)) keep resolving on the
 * artwork, and serialization never sees studio chrome. serializeClean()
 * closes the studio first, so a save can never catch the svg mid-visit.
 *
 * Scope: import, creation, and update of ordinary svg artwork — the
 * "illustrator" surface. Scenes (svg.dia-scene) keep their own semantic
 * editor; the studio refuses them. */

import { state } from '../state'
import {
  mountTools, disposeTools, currentTool, deletePicked, duplicatePicked, enterGroup,
  exitGroup, groupPicked, hitOf, isPlainGroup, nudgePicked, pick, reorderPicked,
  setTool, TOOLS, ungroupPicked,
} from './tools'
import { mountPanels, disposePanels, refreshPanels } from './panels'
import { openImportDialog } from './svgimport'
import { setToolbarSuppressed } from '../scene/toolbar'
import { insertShapeNode } from '../scene/interact'
import { canPointEdit, openPointEditor } from '../scene/points'
import { closeMenu, openMenu, SEP, type Entry } from '../editor/menu'

const ARTIFACT = 'dia-editor-artifact'

export interface StudioSession {
  svg: SVGSVGElement
  overlay: HTMLElement
  stage: HTMLElement
  /** where the svg goes back to on close */
  home: { parent: ParentNode; next: Node | null }
  /** studio-local selection — top-level children of the edit context */
  picked: Set<SVGGraphicsElement>
  /** entered groups, outermost first — the edit context is the last one
   * (Illustrator isolation): dblclick enters, esc exits one level */
  entered: SVGGElement[]
  zoom: number
  panX: number
  panY: number
  offBus: () => void
  offKey: () => void
}

let session: StudioSession | null = null

export function studioOpen(): boolean {
  return session !== null
}

export function studioSession(): StudioSession | null {
  return session
}

/** true when the studio can take this svg. Scenes are welcome — the studio
 * is the WORKBENCH (big canvas, zoom, layers) while the scene machinery
 * stays the MODEL: node picks map to geometry ops and edges stay derived.
 * Full-slide layers are the slide itself and keep their in-place editing. */
export function canStudio(el: Element): el is SVGSVGElement {
  return el instanceof SVGSVGElement && !el.classList.contains('dia-scene-full')
}

export function isSceneArt(svg: SVGSVGElement): boolean {
  return svg.classList.contains('dia-scene')
}

export function closeStudio(): void {
  if (!session) return
  const s = session
  session = null
  closeMenu()
  disposeTools()
  disposePanels()
  s.svg.classList.remove('dia-studio-art')
  s.svg.style.removeProperty('transform')
  s.home.parent.insertBefore(s.svg, s.home.next)
  s.overlay.remove()
  s.offBus()
  s.offKey()
  if (isSceneArt(s.svg)) setToolbarSuppressed(false)
  state.deck?.root.getElementById('dia-studio-style')?.remove()
}

export function openStudio(svg: SVGSVGElement): void {
  const deck = state.deck
  if (!deck || !canStudio(svg) || !svg.parentNode) return
  closeStudio()
  ensureStudioStyle()

  const overlay = h('div', `dia-studio ${ARTIFACT}`)
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')

  /* ----- header: wordmark register, sans controls, mono data ----- */
  const head = h('header', 'dia-st-head')
  const title = h('span', 'dia-st-title', 'svg studio')
  const hint = h('span', 'dia-st-hint', 'edits land as ops — undo works after you close')
  const imp = button('import svg…', 'replace or add artwork from pasted markup or a file')
  imp.addEventListener('click', () => { if (session) openImportDialog(session) })
  const done = button('done', 'return the drawing to its slide (esc)')
  done.classList.add('dia-st-done')
  done.addEventListener('click', closeStudio)
  head.append(title, hint, h('span', 'dia-st-spacer'), imp, done)

  /* ----- three columns: tools | stage | panels ----- */
  const body = h('div', 'dia-st-body')
  const toolsEl = h('div', 'dia-st-tools')
  const stageWrap = h('div', 'dia-st-stagewrap')
  const stage = h('div', 'dia-st-stage')
  stageWrap.append(stage)
  const railEl = h('div', 'dia-st-rail')
  body.append(toolsEl, stageWrap, railEl)

  const foot = h('footer', 'dia-st-foot')
  const zoomLabel = h('span', 'dia-st-zoom', '100%')
  foot.append(
    h('span', 'dia-st-keys', 'wheel zoom · space-drag pan · del removes · esc closes'),
    h('span', 'dia-st-spacer'), zoomLabel,
  )

  overlay.append(head, body, foot)
  deck.root.appendChild(overlay)

  const home = { parent: svg.parentNode, next: svg.nextSibling }
  // a visiting scene leaves its floating bars behind
  if (isSceneArt(svg)) {
    state.selection = { kind: 'none' }
    setToolbarSuppressed(true)
  }
  svg.classList.add('dia-studio-art')
  stage.appendChild(svg)

  const s: StudioSession = {
    svg, overlay, stage, home,
    picked: new Set(),
    entered: [],
    zoom: 1, panX: 0, panY: 0,
    offBus: () => {},
    offKey: () => {},
  }
  session = s

  /* ----- zoom / pan ----- */
  const applyView = (): void => {
    stage.style.transform = `translate(${s.panX}px, ${s.panY}px) scale(${s.zoom})`
    zoomLabel.textContent = `${Math.round(s.zoom * 100)}%`
  }
  fitToStage(s, stageWrap)
  applyView()

  stageWrap.addEventListener('wheel', (e) => {
    e.preventDefault()
    const factor = Math.exp(-e.deltaY * 0.0015)
    const next = Math.min(16, Math.max(0.1, s.zoom * factor))
    // zoom about the cursor: keep the point under it fixed
    const r = stageWrap.getBoundingClientRect()
    const cx = e.clientX - r.left
    const cy = e.clientY - r.top
    s.panX = cx - (cx - s.panX) * (next / s.zoom)
    s.panY = cy - (cy - s.panY) * (next / s.zoom)
    s.zoom = next
    applyView()
  }, { passive: false })

  /* ----- right-click: the studio's verbs for what's under the pointer ----- */
  stageWrap.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    openMenu(e.clientX, e.clientY, studioEntries(s, e.composedPath()[0] ?? null))
  })

  let spaceDown = false
  let panFrom: { x: number; y: number; px: number; py: number } | null = null
  stageWrap.addEventListener('pointerdown', (e) => {
    if (!spaceDown && e.button !== 1) return
    e.preventDefault()
    e.stopPropagation()
    panFrom = { x: e.clientX, y: e.clientY, px: s.panX, py: s.panY }
    const move = (ev: PointerEvent): void => {
      if (!panFrom) return
      s.panX = panFrom.px + (ev.clientX - panFrom.x)
      s.panY = panFrom.py + (ev.clientY - panFrom.y)
      applyView()
    }
    const up = (): void => {
      panFrom = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, true)

  /* ----- keyboard: studio owns the keys while open ----- */
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === ' ' && e.type === 'keydown' && !isTyping(e)) {
      spaceDown = true
      stageWrap.classList.add('is-panning')
      e.preventDefault()
      return
    }
    if (e.type !== 'keydown') return
    if (e.key === 'Escape') {
      e.stopPropagation()
      e.preventDefault()
      // esc backs out one level: active drawing → selection → studio
      if (!toolsHandleEscape()) closeStudio()
      return
    }
    if (isTyping(e)) return
    e.stopPropagation()
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deletePicked(); return }
    const NUDGE: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
    }
    if (NUDGE[e.key]) {
      e.preventDefault()
      const k = e.shiftKey ? 10 : 1
      nudgePicked(NUDGE[e.key][0] * k, NUDGE[e.key][1] * k)
      return
    }
    const tool = TOOLS.find((t) => t.key === e.key.toLowerCase())
    if (tool && !e.metaKey && !e.ctrlKey) { setTool(tool.name); return }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      e.shiftKey ? state.redo() : state.undo()
    }
  }
  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === ' ') { spaceDown = false; stageWrap.classList.remove('is-panning') }
  }
  document.addEventListener('keydown', onKey, true)
  document.addEventListener('keyup', onKeyUp, true)
  s.offKey = () => {
    document.removeEventListener('keydown', onKey, true)
    document.removeEventListener('keyup', onKeyUp, true)
  }

  /* ----- bus: stay honest under ops/undo/redo; die with the document ----- */
  s.offBus = state.bus.on((e) => {
    if (e.type === 'deck-loaded') { closeStudio(); return }
    if (e.type === 'op' || e.type === 'undo' || e.type === 'redo') {
      for (const el of [...s.picked]) if (el.parentNode !== s.svg) s.picked.delete(el)
      refreshPanels(s)
    }
  })

  mountTools(s, toolsEl)
  mountPanels(s, railEl)
  setTool('select')
}

/** center the artwork in the stage at a comfortable initial zoom */
function fitToStage(s: StudioSession, wrap: HTMLElement): void {
  const wr = wrap.getBoundingClientRect()
  const box = s.svg.getBoundingClientRect()
  const w = box.width || 480
  const h2 = box.height || 300
  if (wr.width === 0) return
  s.zoom = Math.min(2.5, Math.max(0.1, Math.min((wr.width * 0.72) / w, (wr.height * 0.72) / h2)))
  s.panX = (wr.width - w * s.zoom) / 2
  s.panY = (wr.height - h2 * s.zoom) / 2
}

/** the studio's context verbs — every item is an existing tool action */
function studioEntries(s: StudioSession, target: EventTarget | null): Entry[] {
  const items: Entry[] = []
  const hit = hitOf(target)
  if (hit) {
    if (!s.picked.has(hit)) pick(hit, false)
    if (hit instanceof SVGPathElement && canPointEdit(hit)) {
      items.push({ label: 'edit points', run: () => openPointEditor({ kind: 'free', scene: s.svg, el: hit }) })
    }
    if (isPlainGroup(hit)) {
      items.push(
        { label: 'enter group', run: () => enterGroup(hit) },
        { label: 'ungroup', run: ungroupPicked },
      )
    }
    if (s.picked.size > 1) items.push({ label: `group ${s.picked.size} elements`, run: groupPicked })
    items.push(
      { label: 'duplicate', run: duplicatePicked },
      { label: 'bring to front', run: () => reorderPicked(true) },
      { label: 'send to back', run: () => reorderPicked(false) },
      SEP,
      { label: s.picked.size > 1 ? `delete ${s.picked.size} elements` : 'delete', run: deletePicked, danger: true },
      SEP,
    )
  } else if (s.entered.length > 0) {
    items.push({ label: 'exit group', run: exitGroup }, SEP)
  }
  if (isSceneArt(s.svg)) items.push({ label: 'insert node', run: () => insertShapeNode(s.svg, 'node') })
  items.push(
    { label: 'import svg…', run: () => openImportDialog(s) },
    SEP,
    { label: 'done — close studio', run: closeStudio },
  )
  return items
}

/** esc backs out one layer: drawing → selection → entered group → studio */
function toolsHandleEscape(): boolean {
  if (!session) return false
  if (currentTool() !== 'select') { setTool('select'); return true }
  if (session.picked.size > 0) {
    session.picked.clear()
    refreshPanels(session)
    return true
  }
  if (session.entered.length > 0) { exitGroup(); return true }
  return false
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.composedPath()[0]
  return t instanceof HTMLElement &&
    (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
}

/* ---------- studio chrome css (artifact style inside the shadow root) ---------- */

function ensureStudioStyle(): void {
  const root = state.deck?.root
  if (!root || root.getElementById('dia-studio-style')) return
  const style = document.createElement('style')
  style.id = 'dia-studio-style'
  style.className = ARTIFACT
  style.textContent = STUDIO_CSS
  root.appendChild(style)
}

export function h(tag: string, cls = '', text = ''): HTMLElement {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  if (text) el.textContent = text
  return el
}

export function button(text: string, tip = ''): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'dia-st-btn'
  b.textContent = text
  if (tip) b.title = tip
  return b
}

const STUDIO_CSS = `
.dia-studio {
  position: fixed; inset: 0; z-index: 420;
  display: flex; flex-direction: column;
  background: var(--paper, #17181a);
  color: var(--ink, #eee);
  font: 13px/1.5 var(--sans, system-ui, sans-serif);
}
.dia-st-head, .dia-st-foot {
  display: flex; align-items: center; gap: 12px;
  padding: 8px 14px; flex: none;
  border-bottom: 1px solid var(--rule, #333);
  background: var(--panel, #222);
}
.dia-st-foot { border-bottom: 0; border-top: 1px solid var(--rule, #333); padding-block: 5px; }
.dia-st-title { font-weight: 600; letter-spacing: .02em; }
.dia-st-hint, .dia-st-keys { color: var(--ink-faint, #999); font-size: 12px; }
.dia-st-zoom { font: 11.5px/1 var(--mono, ui-monospace, monospace); color: var(--ink-soft, #bbb); }
.dia-st-spacer { flex: 1; }
.dia-st-btn {
  font: inherit; font-size: 12.5px; color: var(--ink, #eee);
  background: transparent; border: 1px solid var(--rule, #444);
  border-radius: 5px; padding: 3px 11px; cursor: pointer;
}
.dia-st-btn:hover { border-color: var(--accent); }
.dia-st-btn.dia-st-on { border-color: var(--accent); color: var(--accent); }
.dia-st-done { border-color: var(--accent); color: var(--accent); }
.dia-st-body { flex: 1; display: flex; min-height: 0; }
.dia-st-tools {
  flex: none; width: 148px; padding: 10px;
  display: flex; flex-direction: column; gap: 4px;
  border-right: 1px solid var(--rule, #333); background: var(--panel, #222);
  overflow-y: auto;
}
.dia-st-tools .dia-st-btn { text-align: left; display: flex; justify-content: space-between; }
.dia-st-tools .dia-st-btn kbd {
  font: 10.5px/1.6 var(--mono, ui-monospace, monospace);
  color: var(--ink-faint, #888); border: 1px solid var(--rule, #444);
  border-radius: 3px; padding: 0 4px;
}
.dia-st-toolgap { height: 10px; flex: none; }
.dia-st-stagewrap {
  flex: 1; position: relative; overflow: hidden;
  background:
    linear-gradient(var(--rule-soft, #26272a) 1px, transparent 1px) 0 0 / 24px 24px,
    linear-gradient(90deg, var(--rule-soft, #26272a) 1px, transparent 1px) 0 0 / 24px 24px,
    var(--cell-empty, #1b1c1e);
}
.dia-st-stagewrap.is-panning { cursor: grab; }
.dia-st-stage { position: absolute; transform-origin: 0 0; }
.dia-st-stage > svg.dia-studio-art {
  display: block;
  background: var(--dia-paper, transparent);
  box-shadow: 0 0 0 1px var(--rule, #444), 0 18px 60px rgba(0,0,0,.35);
}
.dia-st-rail {
  flex: none; width: 252px; overflow-y: auto;
  border-left: 1px solid var(--rule, #333); background: var(--panel, #222);
  padding: 10px; display: flex; flex-direction: column; gap: 14px;
}
.dia-st-sect { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-faint, #888); }
.dia-st-row { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.dia-st-k { font-size: 11.5px; color: var(--ink-soft, #bbb); width: 46px; flex: none; }
.dia-st-swatch {
  width: 17px; height: 17px; border-radius: 4px; flex: none;
  border: 1px solid var(--rule, #555); cursor: pointer; padding: 0;
}
.dia-st-swatch.dia-st-on { outline: 2px solid var(--accent); outline-offset: 1px; }
.dia-st-swatch.is-none { background:
  linear-gradient(to top left, transparent 46%, #d33 47%, #d33 53%, transparent 54%), var(--panel, #222); }
.dia-st-num {
  width: 52px; font: 11.5px/1.4 var(--mono, ui-monospace, monospace);
  color: var(--ink, #eee); background: transparent;
  border: 1px solid var(--rule, #444); border-radius: 4px; padding: 2px 5px;
}
.dia-st-text { flex: 1; min-width: 0; font: inherit; font-size: 12.5px; color: var(--ink, #eee);
  background: transparent; border: 1px solid var(--rule, #444); border-radius: 4px; padding: 2px 6px; }
input[type='range'].dia-st-range { flex: 1; accent-color: var(--accent); }
.dia-st-layers { display: flex; flex-direction: column; gap: 2px; }
.dia-st-layer {
  display: flex; align-items: center; gap: 7px;
  border: 1px solid transparent; border-radius: 5px; padding: 3px 6px;
  cursor: pointer; user-select: none;
}
.dia-st-layer:hover { border-color: var(--rule, #444); }
.dia-st-layer.dia-st-on { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
.dia-st-layer.is-dragging { opacity: .4; }
.dia-st-layer .dia-st-lname { flex: 1; font: 11.5px/1.5 var(--mono, ui-monospace, monospace); color: var(--ink-soft, #ccc);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dia-st-layer .dia-st-lbtn {
  flex: none; font-size: 11px; line-height: 1; padding: 2px 4px;
  background: transparent; border: 0; color: var(--ink-faint, #888); cursor: pointer; border-radius: 3px;
}
.dia-st-layer .dia-st-lbtn:hover { color: var(--ink, #eee); background: var(--rule-soft, #333); }
.dia-st-layer.is-hidden .dia-st-lname { opacity: .45; text-decoration: line-through; }
/* import dialog */
.dia-st-import {
  position: absolute; inset: 0; z-index: 10; display: grid; place-items: center;
  background: color-mix(in srgb, var(--paper, #111) 55%, transparent);
}
.dia-st-import .dia-st-card {
  width: min(640px, 84vw); display: flex; flex-direction: column; gap: 10px;
  background: var(--panel, #222); border: 1px solid var(--rule, #444);
  border-radius: 8px; padding: 16px;
}
.dia-st-import textarea {
  width: 100%; height: 180px; resize: vertical;
  font: 11.5px/1.5 var(--mono, ui-monospace, monospace);
  color: var(--ink, #eee); background: var(--paper, #17181a);
  border: 1px solid var(--rule, #444); border-radius: 5px; padding: 8px;
}
.dia-st-import .dia-st-err { color: var(--bad, #e05); font-size: 12px; }
/* overlay artifacts inside the artwork svg */
svg.dia-studio-art .dia-st-ov { pointer-events: none; }
svg.dia-studio-art .dia-st-ov * { vector-effect: non-scaling-stroke; }
svg.dia-studio-art .dia-st-selbox { fill: none; stroke: var(--accent, #59c2ff); stroke-width: 1; stroke-dasharray: 4 3; }
svg.dia-studio-art .dia-st-handle { fill: var(--paper, #fff); stroke: var(--accent, #59c2ff); stroke-width: 1.2; pointer-events: auto; }
svg.dia-studio-art .dia-st-rot { cursor: grab; }
svg.dia-studio-art .dia-st-marquee { fill: color-mix(in srgb, var(--accent) 14%, transparent); stroke: var(--accent); stroke-width: 1; stroke-dasharray: 3 3; }
svg.dia-studio-art .dia-st-draft { fill: none; stroke: var(--accent); stroke-width: 1.2; stroke-dasharray: 5 3; }
`
