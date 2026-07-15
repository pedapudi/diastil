/* Studio core: the session registry, the shared chrome styles, and the
 * 'open in studio' ROUTER. The studio is no longer a fullscreen modal —
 * opening a drawing focuses its slide and ISOLATES the drawing there
 * (see focus.ts), so the inspector rail and the copilot stay available
 * and studios can never nest. Tools/panels operate on whatever session
 * is adopted; serializeClean() closes the focus before any save. */

import { state } from '../state'
import { miscIcon, type MiscIcon } from '../scene/icons'

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
  /** a session mounted INSIDE slide focus — its lifecycle belongs there */
  embedded?: boolean
}

let session: StudioSession | null = null

/** focus registers its close here AT CALL TIME — the studio↔focus module
 * cycle makes eval-time registration hit the let's temporal dead zone */
let closeSlideFocusHook: (() => void) | null = null
export function registerSlideFocusClose(fn: () => void): void {
  closeSlideFocusHook = fn
}

/** focus binds the tool machinery to a slide's drawing (the layer or an
 * isolated figure) — it must BE the session so every tool, panel, and
 * menu helper operates on it */
export function adoptSession(s: StudioSession): void {
  session = s
  // the inspector's structure tree doubles as the layers panel of the
  // BOUND drawing — it must re-render when the binding changes
  state.bus.emit({ type: 'studio-selection' })
}

export function dropSession(s: StudioSession): void {
  if (session === s) session = null
  state.bus.emit({ type: 'studio-selection' })
}

export function studioOpen(): boolean {
  return session !== null
}

export function studioSession(): StudioSession | null {
  return session
}

/** what 'open in studio' accepts: any svg except the full-slide layer,
 * which is the slide itself (focus binds it as the DEFAULT surface) */
export function canStudio(el: Element): el is SVGSVGElement {
  return el instanceof SVGSVGElement && !el.classList.contains('dia-scene-full')
}

export function isSceneArt(svg: SVGSVGElement): boolean {
  return svg.classList.contains('dia-scene')
}

/** every live session is focus-embedded — closing the studio closes focus */
export function closeStudio(): void {
  if (!session) return
  closeSlideFocusHook?.()
}

/** 'open in studio', from anywhere: focus the drawing's slide and isolate
 * the drawing there. Dynamic import breaks the module cycle. */
export function openStudio(svg: SVGSVGElement): void {
  if (!canStudio(svg)) return
  void import('./focus').then((m) => m.focusIsolate(svg))
}

/* ---------- shared chrome (style + tiny DOM helpers) ---------- */

export function ensureStudioStyle(): void {
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

export function button(text: string, tip = '', icon?: MiscIcon): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'dia-st-btn'
  if (icon) b.appendChild(miscIcon(icon))
  b.appendChild(h('span', 'dia-st-btn-label', text))
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
.dia-st-crumbs { display: flex; align-items: center; gap: 8px; flex: none; letter-spacing: .02em; }
.dia-st-crumb {
  background: transparent; border: 0; padding: 0; font: inherit; font-weight: 600;
  color: var(--ink-faint, #999); cursor: pointer;
}
.dia-st-crumb:hover { color: var(--accent); }
.dia-st-here { font-weight: 600; color: var(--ink, #eee); }
.dia-st-csep { color: var(--ink-faint, #888); }
.dia-st-hint, .dia-st-keys { color: var(--ink-faint, #999); font-size: 12px; }
.dia-st-zoom { font: 11.5px/1 var(--mono, ui-monospace, monospace); color: var(--ink-soft, #bbb); }
.dia-st-spacer { flex: 1; }
.dia-st-btn {
  font: inherit; font-size: 12.5px; color: var(--ink, #eee);
  background: transparent; border: 1px solid var(--rule, #444);
  border-radius: 5px; padding: 3px 11px; cursor: pointer;
  display: inline-flex; align-items: center; gap: 7px;
}
.dia-st-btn:hover { border-color: var(--accent); }
.dia-st-btn svg { width: 17px; height: 12px; flex: none; }
.dia-st-btn .dia-st-btn-label { flex: 1; text-align: left; min-width: 0; }
.dia-st-btn.dia-st-on { border-color: var(--accent); color: var(--accent); }
.dia-st-done { border-color: var(--accent); color: var(--accent); }
.dia-st-body { flex: 1; display: flex; min-height: 0; }
.dia-st-tools {
  flex: none; width: 148px; padding: 10px;
  display: flex; flex-direction: column; gap: 4px;
  border-right: 1px solid var(--rule, #333); background: var(--panel, #222);
  overflow-y: auto; overscroll-behavior: contain;
}
.dia-st-tools .dia-st-btn { text-align: left; display: flex; }
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
/* inside a focus stage, the drawing layer's press ownership follows the
 * tool: select passes empty space through to the slide's text; an active
 * drawing tool takes the whole surface */
.dia-studio section.dia-slide svg.dia-scene-full.dia-studio-drawing { pointer-events: bounding-box !important; }
.dia-st-stage > section.dia-slide {
  margin: 0 !important; width: 1280px;
  box-shadow: 0 0 0 1px var(--rule, #444), 0 18px 60px rgba(0,0,0,.35);
}
.dia-st-rail {
  flex: none; width: 252px; overflow-y: auto; overscroll-behavior: contain;
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
/* overlay artifacts inside the edited svg — deck-proof (!important) */
.dia-studio .dia-st-ov { pointer-events: none; }
.dia-studio .dia-st-ov * { vector-effect: non-scaling-stroke; }
.dia-studio .dia-st-selbox { fill: none !important; stroke: var(--accent, #59c2ff) !important; stroke-width: 1 !important; stroke-dasharray: 4 3; }
.dia-studio .dia-st-handle { fill: var(--paper, #fff) !important; stroke: var(--accent, #59c2ff) !important; stroke-width: 1.2 !important; pointer-events: auto; }
.dia-studio .dia-st-rot { cursor: grab; }
.dia-studio .dia-st-anchor { fill: var(--accent) !important; stroke: var(--paper) !important; stroke-width: 1 !important; pointer-events: all; cursor: crosshair; }
.dia-studio .dia-st-anchor.is-candidate { fill: var(--paper) !important; stroke: var(--accent) !important; stroke-width: 1.4 !important; pointer-events: none; }
.dia-studio .dia-st-marquee { fill: color-mix(in srgb, var(--accent) 14%, transparent) !important; stroke: var(--accent) !important; stroke-width: 1 !important; stroke-dasharray: 3 3; }
.dia-studio .dia-st-draft { fill: none !important; stroke: var(--accent) !important; stroke-width: 1.2 !important; stroke-dasharray: 5 3; }
`
