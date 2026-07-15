/* Studio tools: select/transform + the drawing tools (pen, shapes,
 * freehand, text). Every finished gesture is ONE op (batched when it
 * touches several elements), so undo steps match gestures exactly.
 *
 * Editing scope is the svg's TOP-LEVEL children — the same units the
 * layers panel shows. Groups move/scale as one; the point editor
 * (scene/points.ts) drills into path geometry when asked. */

import { state } from '../state'
import { batch, insertEl, moveSceneNode, removeEl, setAttr } from '../model/ops'
import { pxScale } from '../scene/overlay'
import { openPointEditor, closePointEditor, canPointEdit } from '../scene/points'
import { getNodeGeom, routeEdgesOf, setNodeGeom } from '../scene/route'
import { insertShapeNode } from '../scene/interact'
import type { StudioSession } from './studio'
import { isSceneArt } from './studio'
import { refreshPanels } from './panels'
import { button } from './studio'

const NS = 'http://www.w3.org/2000/svg'
const ARTIFACT = 'dia-editor-artifact'

export type ToolName = 'select' | 'pen' | 'rect' | 'ellipse' | 'line' | 'freehand' | 'text'

export const TOOLS: Array<{ name: ToolName; label: string; key: string; tip: string }> = [
  { name: 'select', label: 'select', key: 'v', tip: 'click picks · shift adds · drag moves · marquee over empty space' },
  { name: 'pen', label: 'pen', key: 'p', tip: 'click for corners, drag for curves · enter or double-click finishes · near the start closes' },
  { name: 'rect', label: 'rectangle', key: 'r', tip: 'drag a rectangle · shift for a square' },
  { name: 'ellipse', label: 'ellipse', key: 'e', tip: 'drag an ellipse · shift for a circle' },
  { name: 'line', label: 'line', key: 'l', tip: 'drag a line · shift snaps to 45°' },
  { name: 'freehand', label: 'freehand', key: 'f', tip: 'draw by hand — the stroke is smoothed to a path' },
  { name: 'text', label: 'text', key: 't', tip: 'click to place text — edit the words in the rail' },
]

interface ToolCtx {
  s: StudioSession
  buttons: Map<ToolName, HTMLButtonElement>
  tool: ToolName
  ov: SVGGElement
  offPointer: () => void
}

let ctx: ToolCtx | null = null

/* pen state lives across clicks */
interface PenState { cmds: string[]; start: { x: number; y: number } | null }
let pen: PenState = { cmds: [], start: null }

export function currentTool(): ToolName {
  return ctx?.tool ?? 'select'
}

export function mountTools(s: StudioSession, host: HTMLElement): void {
  const buttons = new Map<ToolName, HTMLButtonElement>()
  host.append(hSect('tools'))
  for (const t of TOOLS) {
    const b = button(t.label, t.tip)
    const kbd = document.createElement('kbd')
    kbd.textContent = t.key
    b.append(kbd)
    b.addEventListener('click', () => setTool(t.name))
    buttons.set(t.name, b)
    host.append(b)
  }
  // a scene brings its semantic vocabulary: nodes inserted here carry
  // data-x/y/w/h and participate in routing like any canvas-born node
  if (isSceneArt(s.svg)) {
    host.append(hGap(), hSect('scene'))
    for (const [labelText, kind] of [
      ['+ node', 'node'], ['+ circle', 'circle'], ['+ square', 'square'],
      ['+ star', 'star'], ['+ arrow', 'arrow'],
    ] as const) {
      const b = button(labelText, `insert a ${kind} node — drag between nodes on the canvas to connect`)
      b.addEventListener('click', () => insertShapeNode(s.svg, kind))
      host.append(b)
    }
  }

  host.append(hGap())
  const pts = button('edit points', 'drag the selected path’s anchors and control points (esc exits)')
  pts.addEventListener('click', () => {
    const el = [...s.picked][0]
    if (s.picked.size === 1 && el instanceof SVGPathElement && canPointEdit(el)) {
      openPointEditor({ kind: 'free', scene: s.svg, el })
    }
  })
  host.append(pts)

  const ov = document.createElementNS(NS, 'g') as SVGGElement
  ov.setAttribute('class', `${ARTIFACT} dia-st-ov`)
  s.svg.appendChild(ov)

  ctx = { s, buttons, tool: 'select', ov, offPointer: () => {} }
  installPointer(ctx)
}

export function disposeTools(): void {
  if (!ctx) return
  closePointEditor()
  ctx.ov.remove()
  ctx.offPointer()
  pen = { cmds: [], start: null }
  ctx = null
}

export function setTool(name: ToolName): void {
  if (!ctx) return
  if (ctx.tool === 'pen' && name !== 'pen') finishPen(false)
  ctx.tool = name
  for (const [n, b] of ctx.buttons) b.classList.toggle('dia-st-on', n === name)
  ctx.s.svg.style.cursor = name === 'select' ? '' : name === 'text' ? 'text' : 'crosshair'
  if (name !== 'select') { ctx.s.picked.clear(); refreshAll() }
  else refreshAll()
}

export function deletePicked(): void {
  if (!ctx || ctx.s.picked.size === 0) return
  const s = ctx.s
  const doomed = new Set<Element>(s.picked)
  // a deleted node takes its touching edges along (the scene contract)
  for (const el of s.picked) {
    if (!isNodeEl(el)) continue
    const id = el.getAttribute('data-dia-node') ?? ''
    for (const edge of s.svg.querySelectorAll('[data-dia-edge]')) {
      const [from, to] = (edge.getAttribute('data-dia-edge') ?? '').split('->')
      if (from === id || to === id) doomed.add(edge)
    }
  }
  // descending DOM order so the batch invert re-inserts exactly
  const ordered = [...doomed].sort((a, b) =>
    [...s.svg.children].indexOf(b) - [...s.svg.children].indexOf(a))
  const ops = ordered.map((el) => removeEl(el))
  state.apply(ops.length === 1 ? ops[0] : batch(`Delete ${ops.length} drawing elements`, ops))
  s.picked.clear()
  refreshAll()
}

export function nudgePicked(dx: number, dy: number): void {
  if (!ctx || ctx.s.picked.size === 0) return
  const s = ctx.s
  const ops = [...s.picked].map((el) => {
    if (isNodeEl(el)) {
      const g = getNodeGeom(el)
      return moveSceneNode(s.svg, el, { ...g, x: r2(g.x + dx), y: r2(g.y + dy) })
    }
    return setAttr(el, 'transform', prefixTransform(el, `translate(${r2(dx)} ${r2(dy)})`))
  })
  state.apply(ops.length === 1 ? ops[0] : batch('Nudge drawing selection', ops))
  refreshAll()
}

/** redraw selection visuals + panels (exported for panels → tools updates) */
export function refreshAll(): void {
  if (!ctx) return
  renderSelection(ctx)
  refreshPanels(ctx.s)
}

/** studio-side pick (used by the layers panel) */
export function pick(el: SVGGraphicsElement, add: boolean): void {
  if (!ctx) return
  const p = ctx.s.picked
  if (!add) p.clear()
  p.has(el) && add ? p.delete(el) : p.add(el)
  refreshAll()
}

/* ---------- geometry ---------- */

function toArt(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
  const ctm = svg.getScreenCTM()
  if (!ctm) return { x: 0, y: 0 }
  const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse())
  return { x: p.x, y: p.y }
}

/** an element's bbox in the svg's ROOT user space (its own transform applied) */
export function bboxInRoot(svg: SVGSVGElement, el: SVGGraphicsElement): { x: number; y: number; w: number; h: number } | null {
  let b: DOMRect
  try { b = el.getBBox() } catch { return null }
  const rootCtm = svg.getScreenCTM()
  const elCtm = el.getScreenCTM()
  if (!rootCtm || !elCtm) return { x: b.x, y: b.y, w: b.width, h: b.height }
  const m = rootCtm.inverse().multiply(elCtm)
  const pts = [
    new DOMPoint(b.x, b.y), new DOMPoint(b.x + b.width, b.y),
    new DOMPoint(b.x, b.y + b.height), new DOMPoint(b.x + b.width, b.y + b.height),
  ].map((p) => p.matrixTransform(m))
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

function pickedBBox(s: StudioSession): { x: number; y: number; w: number; h: number } | null {
  let out: { x: number; y: number; w: number; h: number } | null = null
  for (const el of s.picked) {
    const b = bboxInRoot(s.svg, el)
    if (!b) continue
    if (!out) out = { ...b }
    else {
      const x2 = Math.max(out.x + out.w, b.x + b.w)
      const y2 = Math.max(out.y + out.h, b.y + b.h)
      out.x = Math.min(out.x, b.x)
      out.y = Math.min(out.y, b.y)
      out.w = x2 - out.x
      out.h = y2 - out.y
    }
  }
  return out
}

/** compose a new transform step BEFORE the element's existing transform —
 * the step is expressed in root user space, where our handles live */
function prefixTransform(el: SVGGraphicsElement, step: string): string {
  const prev = el.getAttribute('transform')
  return prev ? `${step} ${prev}` : step
}

/** a scene node group — picked as a UNIT and moved as GEOMETRY, never
 * transforms: data-x/y/w/h stays the single source and edges reroute */
export function isNodeEl(el: Element): el is SVGGElement {
  return el instanceof SVGGElement && el.hasAttribute('data-dia-node')
}

export function isEdgeEl(el: Element): boolean {
  return el instanceof SVGGElement && el.hasAttribute('data-dia-edge')
}

export function pickables(s: StudioSession): SVGGraphicsElement[] {
  return [...s.svg.children].filter((c): c is SVGGraphicsElement =>
    c instanceof SVGGraphicsElement && !c.classList.contains(ARTIFACT) &&
    !(c instanceof SVGDefsElement) && c.tagName !== 'style' &&
    !isEdgeEl(c)) // edges are DERIVED — they follow their nodes
}

/* ---------- selection visuals ---------- */

const HANDLES = [
  ['nw', 0, 0], ['n', 0.5, 0], ['ne', 1, 0], ['e', 1, 0.5],
  ['se', 1, 1], ['s', 0.5, 1], ['sw', 0, 1], ['w', 0, 0.5],
] as const

function renderSelection(c: ToolCtx): void {
  c.ov.textContent = ''
  const box = pickedBBox(c.s)
  if (!box || c.tool !== 'select') return
  const k = pxScale(c.s.svg)

  const rect = document.createElementNS(NS, 'rect')
  rect.setAttribute('class', 'dia-st-selbox')
  rect.setAttribute('x', String(box.x))
  rect.setAttribute('y', String(box.y))
  rect.setAttribute('width', String(box.w))
  rect.setAttribute('height', String(box.h))
  c.ov.appendChild(rect)

  for (const [name, fx, fy] of HANDLES) {
    const r = 3.6 / k
    const hd = document.createElementNS(NS, 'rect')
    hd.setAttribute('class', 'dia-st-handle')
    hd.setAttribute('x', String(box.x + fx * box.w - r))
    hd.setAttribute('y', String(box.y + fy * box.h - r))
    hd.setAttribute('width', String(2 * r))
    hd.setAttribute('height', String(2 * r))
    hd.style.cursor = `${name}-resize`
    hd.addEventListener('pointerdown', (e) => beginScale(e, name, box))
    c.ov.appendChild(hd)
  }

  // rotate: a round handle floated above the top-center. Scene nodes are
  // axis-aligned geometry (data-x/y/w/h) — no rotation while one is picked
  if (![...c.s.picked].some(isNodeEl)) {
    const rot = document.createElementNS(NS, 'circle')
    rot.setAttribute('class', 'dia-st-handle dia-st-rot')
    rot.setAttribute('cx', String(box.x + box.w / 2))
    rot.setAttribute('cy', String(box.y - 18 / k))
    rot.setAttribute('r', String(4 / k))
    rot.addEventListener('pointerdown', (e) => beginRotate(e, box))
    c.ov.appendChild(rot)
  }
}

/* ---------- pointer machine ---------- */

function installPointer(c: ToolCtx): void {
  const svg = c.s.svg
  const down = (e: PointerEvent): void => {
    if (e.button !== 0) return
    switch (c.tool) {
      case 'select': return selectDown(c, e)
      case 'pen': return penDown(c, e)
      case 'text': return textDown(c, e)
      case 'freehand': e.preventDefault(); return installFreehand(c, e)
      default: return shapeDown(c, e)
    }
  }
  const dbl = (): void => { if (c.tool === 'pen') finishPen(false) }
  const key = (e: KeyboardEvent): void => {
    if (c.tool === 'pen' && e.key === 'Enter') { e.stopPropagation(); finishPen(false) }
  }
  svg.addEventListener('pointerdown', down)
  svg.addEventListener('dblclick', dbl)
  document.addEventListener('keydown', key, true)
  c.offPointer = () => {
    svg.removeEventListener('pointerdown', down)
    svg.removeEventListener('dblclick', dbl)
    document.removeEventListener('keydown', key, true)
  }
}

function drag(onMove: (e: PointerEvent) => void, onUp: (e: PointerEvent) => void): void {
  const move = (e: PointerEvent): void => onMove(e)
  const up = (e: PointerEvent): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    onUp(e)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

/* ---------- select: pick, marquee, move ---------- */

function topLevelOf(c: ToolCtx, target: EventTarget | null): SVGGraphicsElement | null {
  if (!(target instanceof Element)) return null
  let el: Element | null = target
  while (el && el.parentNode !== c.s.svg) el = el.parentElement
  return el instanceof SVGGraphicsElement && !el.classList.contains(ARTIFACT) ? el : null
}

function selectDown(c: ToolCtx, e: PointerEvent): void {
  const hit = topLevelOf(c, e.target)
  if (!hit) return beginMarquee(c, e)
  e.preventDefault()
  if (e.shiftKey) {
    c.s.picked.has(hit) ? c.s.picked.delete(hit) : c.s.picked.add(hit)
    refreshAll()
    return
  }
  if (!c.s.picked.has(hit)) { c.s.picked.clear(); c.s.picked.add(hit); refreshAll() }
  beginMove(c, e)
}

function beginMove(c: ToolCtx, e: PointerEvent): void {
  const s = c.s
  const from = toArt(s.svg, e.clientX, e.clientY)
  const els = [...s.picked]
  const originals = els.map((el) => el.getAttribute('transform'))
  // scene nodes move as GEOMETRY — capture their boxes, reroute live
  const geoms = els.map((el) => isNodeEl(el) ? getNodeGeom(el) : null)
  let moved = false
  const applyLive = (dx: number, dy: number): void => {
    els.forEach((el, i) => {
      const g = geoms[i]
      if (g && isNodeEl(el)) {
        setNodeGeom(el, { ...g, x: g.x + dx, y: g.y + dy })
        routeEdgesOf(s.svg, el.getAttribute('data-dia-node') ?? '')
      } else {
        const step = `translate(${r2(dx)} ${r2(dy)})`
        el.setAttribute('transform', originals[i] ? `${step} ${originals[i]}` : step)
      }
    })
  }
  drag((ev) => {
    const p = toArt(s.svg, ev.clientX, ev.clientY)
    const dx = p.x - from.x
    const dy = p.y - from.y
    if (!moved && Math.hypot(dx, dy) * pxScale(s.svg) < 2.5) return
    moved = true
    applyLive(dx, dy)
    renderSelection(c)
  }, (ev) => {
    if (!moved) return
    const p = toArt(s.svg, ev.clientX, ev.clientY)
    const dx = r2(p.x - from.x)
    const dy = r2(p.y - from.y)
    // restore, then commit the gesture as ONE op so undo captures the truth
    els.forEach((el, i) => {
      const g = geoms[i]
      if (g && isNodeEl(el)) setNodeGeom(el, g)
      else if (originals[i] === null) el.removeAttribute('transform')
      else el.setAttribute('transform', originals[i] as string)
    })
    const ops = els.map((el, i) => {
      const g = geoms[i]
      if (g && isNodeEl(el)) return moveSceneNode(s.svg, el, { ...g, x: r2(g.x + dx), y: r2(g.y + dy) })
      return setAttr(el, 'transform', prefixTransform(el, `translate(${dx} ${dy})`))
    })
    state.apply(ops.length === 1 ? ops[0] : batch('Move drawing selection', ops))
    refreshAll()
  })
}

function beginMarquee(c: ToolCtx, e: PointerEvent): void {
  e.preventDefault()
  const s = c.s
  const from = toArt(s.svg, e.clientX, e.clientY)
  const box = document.createElementNS(NS, 'rect')
  box.setAttribute('class', 'dia-st-marquee')
  c.ov.appendChild(box)
  drag((ev) => {
    const p = toArt(s.svg, ev.clientX, ev.clientY)
    box.setAttribute('x', String(Math.min(from.x, p.x)))
    box.setAttribute('y', String(Math.min(from.y, p.y)))
    box.setAttribute('width', String(Math.abs(p.x - from.x)))
    box.setAttribute('height', String(Math.abs(p.y - from.y)))
  }, (ev) => {
    box.remove()
    const p = toArt(s.svg, ev.clientX, ev.clientY)
    const mx = Math.min(from.x, p.x)
    const my = Math.min(from.y, p.y)
    const mw = Math.abs(p.x - from.x)
    const mh = Math.abs(p.y - from.y)
    if (!ev.shiftKey) s.picked.clear()
    if (mw * pxScale(s.svg) > 3 || mh * pxScale(s.svg) > 3) {
      for (const el of pickables(s)) {
        const b = bboxInRoot(s.svg, el)
        if (b && b.x < mx + mw && b.x + b.w > mx && b.y < my + mh && b.y + b.h > my) s.picked.add(el)
      }
    }
    refreshAll()
  })
}

function beginScale(e: PointerEvent, handle: string, box: { x: number; y: number; w: number; h: number }): void {
  if (!ctx) return
  e.preventDefault()
  e.stopPropagation()
  const c = ctx
  const s = c.s
  // the anchor is the point that must NOT move: the opposite corner/edge
  const ax = handle.includes('w') ? box.x + box.w : handle.includes('e') ? box.x : box.x + box.w / 2
  const ay = handle.includes('n') ? box.y + box.h : handle.includes('s') ? box.y : box.y + box.h / 2
  const from = toArt(s.svg, e.clientX, e.clientY)
  const els = [...s.picked]
  const originals = els.map((el) => el.getAttribute('transform'))
  const geoms = els.map((el) => isNodeEl(el) ? getNodeGeom(el) : null)
  const factors = (ev: PointerEvent): { sx: number; sy: number } => {
    const p = toArt(s.svg, ev.clientX, ev.clientY)
    let sx = (handle.includes('e') || handle.includes('w')) && from.x !== ax ? (p.x - ax) / (from.x - ax) : 1
    let sy = (handle.includes('n') || handle.includes('s')) && from.y !== ay ? (p.y - ay) / (from.y - ay) : 1
    if (ev.shiftKey) { const u = Math.max(Math.abs(sx), Math.abs(sy)); sx = Math.sign(sx || 1) * u; sy = Math.sign(sy || 1) * u }
    return { sx, sy }
  }
  const stepOf = (f: { sx: number; sy: number }): string =>
    `translate(${r2(ax)} ${r2(ay)}) scale(${r2(f.sx)} ${r2(f.sy)}) translate(${r2(-ax)} ${r2(-ay)})`
  /** a node scales as GEOMETRY around the anchor — strokes keep their weight */
  const nodeGeomAt = (g: { x: number; y: number; w: number; h: number }, f: { sx: number; sy: number }) => ({
    x: r2(ax + (g.x - ax) * f.sx), y: r2(ay + (g.y - ay) * f.sy),
    w: r2(Math.max(8, g.w * Math.abs(f.sx))), h: r2(Math.max(8, g.h * Math.abs(f.sy))),
  })
  const applyLive = (f: { sx: number; sy: number }): void => {
    const step = stepOf(f)
    els.forEach((el, i) => {
      const g = geoms[i]
      if (g && isNodeEl(el)) {
        setNodeGeom(el, nodeGeomAt(g, f))
        routeEdgesOf(s.svg, el.getAttribute('data-dia-node') ?? '')
      } else {
        el.setAttribute('transform', originals[i] ? `${step} ${originals[i]}` : step)
      }
    })
  }
  drag((ev) => {
    applyLive(factors(ev))
    renderSelection(c)
  }, (ev) => {
    const f = factors(ev)
    const step = stepOf(f)
    els.forEach((el, i) => {
      const g = geoms[i]
      if (g && isNodeEl(el)) setNodeGeom(el, g)
      else if (originals[i] === null) el.removeAttribute('transform')
      else el.setAttribute('transform', originals[i] as string)
    })
    const ops = els.map((el, i) => {
      const g = geoms[i]
      if (g && isNodeEl(el)) return moveSceneNode(s.svg, el, nodeGeomAt(g, f))
      return setAttr(el, 'transform', prefixTransform(el, step))
    })
    state.apply(ops.length === 1 ? ops[0] : batch('Scale drawing selection', ops))
    refreshAll()
  })
}

function beginRotate(e: PointerEvent, box: { x: number; y: number; w: number; h: number }): void {
  if (!ctx) return
  e.preventDefault()
  e.stopPropagation()
  const c = ctx
  const s = c.s
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const from = toArt(s.svg, e.clientX, e.clientY)
  const a0 = Math.atan2(from.y - cy, from.x - cx)
  const els = [...s.picked]
  const originals = els.map((el) => el.getAttribute('transform'))
  const stepOf = (ev: PointerEvent): string => {
    const p = toArt(s.svg, ev.clientX, ev.clientY)
    let deg = (Math.atan2(p.y - cy, p.x - cx) - a0) * 180 / Math.PI
    if (ev.shiftKey) deg = Math.round(deg / 15) * 15
    return `rotate(${r2(deg)} ${r2(cx)} ${r2(cy)})`
  }
  drag((ev) => {
    const step = stepOf(ev)
    els.forEach((el, i) => el.setAttribute('transform', originals[i] ? `${step} ${originals[i]}` : step))
    renderSelection(c)
  }, (ev) => {
    const step = stepOf(ev)
    els.forEach((el, i) => originals[i] === null
      ? el.removeAttribute('transform')
      : el.setAttribute('transform', originals[i] as string))
    const ops = els.map((el) => setAttr(el, 'transform', prefixTransform(el, step)))
    state.apply(ops.length === 1 ? ops[0] : batch('Rotate drawing selection', ops))
    refreshAll()
  })
}

/* ---------- shape tools: rect · ellipse · line ---------- */

const DRAW_STYLE = 'fill: none; stroke: var(--dia-ink, currentColor); stroke-width: 1.5;'

function shapeDown(c: ToolCtx, e: PointerEvent): void {
  e.preventDefault()
  const s = c.s
  const tool = c.tool
  const from = toArt(s.svg, e.clientX, e.clientY)
  const draft = document.createElementNS(NS, tool === 'ellipse' ? 'ellipse' : tool === 'line' ? 'line' : 'rect') as SVGGraphicsElement
  draft.setAttribute('class', 'dia-st-draft')
  c.ov.appendChild(draft)
  const geom = (ev: PointerEvent): Record<string, number> => {
    const p = toArt(s.svg, ev.clientX, ev.clientY)
    let dx = p.x - from.x
    let dy = p.y - from.y
    if (ev.shiftKey && tool !== 'line') {
      const u = Math.max(Math.abs(dx), Math.abs(dy))
      dx = Math.sign(dx || 1) * u
      dy = Math.sign(dy || 1) * u
    }
    if (ev.shiftKey && tool === 'line') {
      const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
      const len = Math.hypot(dx, dy)
      dx = Math.cos(a) * len
      dy = Math.sin(a) * len
    }
    if (tool === 'line') return { x1: from.x, y1: from.y, x2: from.x + dx, y2: from.y + dy }
    const x = Math.min(from.x, from.x + dx)
    const y = Math.min(from.y, from.y + dy)
    const w = Math.abs(dx)
    const h2 = Math.abs(dy)
    return tool === 'ellipse'
      ? { cx: x + w / 2, cy: y + h2 / 2, rx: w / 2, ry: h2 / 2 }
      : { x, y, width: w, height: h2 }
  }
  const write = (el: SVGGraphicsElement, g: Record<string, number>): void => {
    for (const [k2, v] of Object.entries(g)) el.setAttribute(k2, String(r2(v)))
  }
  drag((ev) => write(draft, geom(ev)), (ev) => {
    const g = geom(ev)
    draft.remove()
    const size = tool === 'line'
      ? Math.hypot(g.x2 - g.x1, g.y2 - g.y1)
      : Math.max(g.width ?? (g.rx ?? 0) * 2, g.height ?? (g.ry ?? 0) * 2)
    if (size * pxScale(s.svg) < 4) return
    const el = document.createElementNS(NS, draft.tagName) as SVGGraphicsElement
    write(el, g)
    el.setAttribute('style', DRAW_STYLE)
    state.apply(insertEl(s.svg, insertIndex(s), el, `Draw ${tool}`))
    s.picked.clear()
    s.picked.add(el)
    setTool('select')
  })
}

/* ---------- pen ---------- */

function penDown(c: ToolCtx, e: PointerEvent): void {
  e.preventDefault()
  const s = c.s
  const p = toArt(s.svg, e.clientX, e.clientY)
  const k = pxScale(s.svg)
  if (pen.start && pen.cmds.length > 1 && Math.hypot(p.x - pen.start.x, p.y - pen.start.y) * k < 8) {
    finishPen(true)
    return
  }
  if (!pen.start) {
    pen.start = { x: p.x, y: p.y }
    pen.cmds.push(`M${r2(p.x)},${r2(p.y)}`)
  } else {
    pen.cmds.push(`L${r2(p.x)},${r2(p.y)}`)
  }
  const at = pen.cmds.length - 1
  // dragging after the click turns this segment into a smooth curve
  drag((ev) => {
    const q = toArt(s.svg, ev.clientX, ev.clientY)
    if (Math.hypot(q.x - p.x, q.y - p.y) * pxScale(s.svg) > 4 && at > 0) {
      // control point mirrors the drag direction — the classic pen gesture
      pen.cmds[at] = `Q${r2(2 * p.x - q.x)},${r2(2 * p.y - q.y)} ${r2(p.x)},${r2(p.y)}`
    }
    renderPenDraft(c)
  }, () => renderPenDraft(c))
  renderPenDraft(c)
}

function renderPenDraft(c: ToolCtx): void {
  let draft = c.ov.querySelector<SVGPathElement>('.dia-st-pen')
  if (pen.cmds.length === 0) { draft?.remove(); return }
  if (!draft) {
    draft = document.createElementNS(NS, 'path')
    draft.setAttribute('class', 'dia-st-draft dia-st-pen')
    c.ov.appendChild(draft)
  }
  draft.setAttribute('d', pen.cmds.join(' '))
}

export function finishPen(close: boolean): void {
  if (!ctx) return
  const s = ctx.s
  const cmds = pen.cmds
  pen = { cmds: [], start: null }
  ctx.ov.querySelector('.dia-st-pen')?.remove()
  if (cmds.length < 2) return
  const el = document.createElementNS(NS, 'path')
  el.setAttribute('d', cmds.join(' ') + (close ? ' Z' : ''))
  el.setAttribute('style', DRAW_STYLE)
  state.apply(insertEl(s.svg, insertIndex(s), el, 'Draw path'))
  s.picked.clear()
  s.picked.add(el)
  setTool('select')
}

/* ---------- freehand ---------- */

function installFreehand(c: ToolCtx, e: PointerEvent): void {
  const s = c.s
  const pts: Array<{ x: number; y: number }> = [toArt(s.svg, e.clientX, e.clientY)]
  const draft = document.createElementNS(NS, 'path')
  draft.setAttribute('class', 'dia-st-draft')
  c.ov.appendChild(draft)
  drag((ev) => {
    pts.push(toArt(s.svg, ev.clientX, ev.clientY))
    draft.setAttribute('d', 'M' + pts.map((p) => `${r2(p.x)},${r2(p.y)}`).join(' L'))
  }, () => {
    draft.remove()
    const kept = simplify(pts, 1.2 / pxScale(s.svg))
    if (kept.length < 2) return
    const el = document.createElementNS(NS, 'path')
    el.setAttribute('d', smoothPath(kept))
    el.setAttribute('style', DRAW_STYLE)
    state.apply(insertEl(s.svg, insertIndex(s), el, 'Draw freehand'))
    s.picked.clear()
    s.picked.add(el)
    setTool('select')
  })
}

/** Ramer–Douglas–Peucker */
function simplify(pts: Array<{ x: number; y: number }>, eps: number): Array<{ x: number; y: number }> {
  if (pts.length < 3) return pts
  const a = pts[0]
  const b = pts[pts.length - 1]
  let iMax = 0
  let dMax = 0
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1e-9
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((b.x - a.x) * (a.y - pts[i].y) - (a.x - pts[i].x) * (b.y - a.y)) / len
    if (d > dMax) { dMax = d; iMax = i }
  }
  if (dMax <= eps) return [a, b]
  return [
    ...simplify(pts.slice(0, iMax + 1), eps).slice(0, -1),
    ...simplify(pts.slice(iMax), eps),
  ]
}

/** midpoint-smoothed quadratic through the kept points */
function smoothPath(pts: Array<{ x: number; y: number }>): string {
  if (pts.length === 2) return `M${r2(pts[0].x)},${r2(pts[0].y)} L${r2(pts[1].x)},${r2(pts[1].y)}`
  let d = `M${r2(pts[0].x)},${r2(pts[0].y)}`
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2
    const my = (pts[i].y + pts[i + 1].y) / 2
    d += ` Q${r2(pts[i].x)},${r2(pts[i].y)} ${r2(mx)},${r2(my)}`
  }
  const last = pts[pts.length - 1]
  d += ` L${r2(last.x)},${r2(last.y)}`
  return d
}

/* ---------- text ---------- */

function textDown(c: ToolCtx, e: PointerEvent): void {
  e.preventDefault()
  const s = c.s
  const p = toArt(s.svg, e.clientX, e.clientY)
  const el = document.createElementNS(NS, 'text')
  el.setAttribute('x', String(r2(p.x)))
  el.setAttribute('y', String(r2(p.y)))
  el.setAttribute('style', 'fill: var(--dia-ink, currentColor); font-size: 16px; font-family: var(--dia-face-label, inherit);')
  el.textContent = 'text'
  state.apply(insertEl(s.svg, insertIndex(s), el, 'Place text'))
  s.picked.clear()
  s.picked.add(el)
  setTool('select')
}

/* ---------- shared ---------- */

/** new artwork goes on top, but always below the overlay artifact */
function insertIndex(s: StudioSession): number {
  return pickables(s).length
}

function r2(n: number): number {
  return Math.round(n * 100) / 100
}

function hSect(text: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'dia-st-sect'
  el.textContent = text
  return el
}

function hGap(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'dia-st-toolgap'
  return el
}
