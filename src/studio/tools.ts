/* Studio tools: select/transform + the drawing tools (pen, shapes,
 * freehand, text). Every finished gesture is ONE op (batched when it
 * touches several elements), so undo steps match gestures exactly.
 *
 * Editing scope is the svg's TOP-LEVEL children — the same units the
 * layers panel shows. Groups move/scale as one; the point editor
 * (scene/points.ts) drills into path geometry when asked. */

import { state } from '../state'
import { batch, insertEl, moveEl, moveSceneNode, removeEl, setAttr } from '../model/ops'
import { pxScale, showToast } from '../scene/overlay'
import { openPointEditor, closePointEditor, canPointEdit } from '../scene/points'
import { getNodeGeom, routeEdgesOf, setNodeGeom } from '../scene/route'
import { beginEdgeViaDrag, insertEdgeFlow, insertShapeNode, openEdgeLabelEdit, openLabelEdit, openSvgTextEdit } from '../scene/interact'
import type { MiscIcon } from '../scene/icons'
import type { StudioSession } from './studio'
import { isSceneArt } from './studio'
import { refreshPanels } from './panels'
import { button } from './studio'

const NS = 'http://www.w3.org/2000/svg'
const ARTIFACT = 'dia-editor-artifact'

export type ToolName = 'select' | 'pen' | 'rect' | 'ellipse' | 'line' | 'freehand' | 'text'

export const TOOLS: Array<{ name: ToolName; label: string; key: string; tip: string; icon: MiscIcon }> = [
  { name: 'select', label: 'select', key: 'v', icon: 'select', tip: 'click picks · shift adds · drag moves · marquee over empty space' },
  { name: 'pen', label: 'pen', key: 'p', icon: 'pen', tip: 'click for corners, drag for curves · enter or double-click finishes · near the start closes' },
  { name: 'rect', label: 'rectangle', key: 'r', icon: 'rect', tip: 'drag a rectangle · shift for a square' },
  { name: 'ellipse', label: 'ellipse', key: 'e', icon: 'ellipse', tip: 'drag an ellipse · shift for a circle' },
  { name: 'line', label: 'line', key: 'l', icon: 'line', tip: 'drag a line · shift snaps to 45°' },
  { name: 'freehand', label: 'freehand', key: 'f', icon: 'freehand', tip: 'draw by hand — the stroke is smoothed to a path' },
  { name: 'text', label: 'label', key: 't', icon: 'text', tip: 'place label text inside the drawing — type right away, double-click re-edits (+ text above adds a prose block instead)' },
]

/** icons for the studio's scene-insert buttons */
export const SCENE_INSERTS: Array<{ label: string; kind: 'node' | 'circle' | 'square' | 'star' | 'arrow'; icon: MiscIcon }> = [
  { label: '+ node', kind: 'node', icon: 'plus-node' },
  { label: '+ circle', kind: 'circle', icon: 'circle' },
  { label: '+ square', kind: 'square', icon: 'square' },
  { label: '+ star', kind: 'star', icon: 'star' },
  { label: '+ arrow', kind: 'arrow', icon: 'arrow' },
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
    const b = button(t.label, t.tip, t.icon)
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
    for (const ins of SCENE_INSERTS) {
      const b = button(ins.label, `insert a ${ins.kind} node — drag between nodes on the canvas to connect`, ins.icon)
      b.addEventListener('click', () => insertShapeNode(s.svg, ins.kind))
      host.append(b)
    }
  }

  host.append(hGap())
  const pts = button('edit points', 'drag the selected path’s anchors and control points (esc exits)', 'points')
  pts.addEventListener('click', () => {
    const el = [...s.picked][0]
    if (s.picked.size === 1 && el instanceof SVGPathElement && canPointEdit(el)) {
      openPointEditor({ kind: 'free', scene: s.svg, el })
    }
  })
  const grp = button('group', 'wrap the selection in a group (double-click a group to enter it, esc exits)', 'group')
  grp.addEventListener('click', groupPicked)
  const ungrp = button('ungroup', 'dissolve the selected group into its children', 'ungroup')
  ungrp.addEventListener('click', ungroupPicked)
  host.append(pts, grp, ungrp)

  const ov = document.createElementNS(NS, 'g') as SVGGElement
  ov.setAttribute('class', `${ARTIFACT} dia-st-ov`)
  s.svg.appendChild(ov)
  // the scene machinery yields THIS surface to the studio (and only this
  // one — other svgs in a focused slide keep their canvas behavior)
  s.svg.classList.add('dia-studio-surface')

  ctx = { s, buttons, tool: 'select', ov, offPointer: () => {} }
  installPointer(ctx)
}

export function disposeTools(): void {
  if (!ctx) return
  closePointEditor()
  ctx.s.svg.classList.remove('dia-studio-drawing', 'dia-studio-surface')
  ctx.s.svg.style.removeProperty('cursor')
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
  // a full-slide layer passes idle presses through to the slide's text —
  // an active drawing tool claims the whole surface instead
  ctx.s.svg.classList.toggle('dia-studio-drawing', name !== 'select')
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
    const step = parentStep(s, el, `translate(${r2(dx)} ${r2(dy)})`, () => new DOMMatrix().translate(dx, dy))
    return setAttr(el, 'transform', prefixTransform(el, step))
  })
  state.apply(ops.length === 1 ? ops[0] : batch('Nudge drawing selection', ops))
  refreshAll()
}

/** wrap the picked elements in ONE group, preserving their order */
export function groupPicked(): void {
  if (!ctx) return
  const s = ctx.s
  const els = pickables(s).filter((el) => s.picked.has(el)) // document order
  if (els.length < 2) { showToast('pick at least two elements to group'); return }
  if (els.some(isNodeEl)) { showToast('scene nodes stay ungrouped — the router owns them'); return }
  const parent = contextOf(s)
  const g = document.createElementNS(NS, 'g') as SVGGElement
  const at = [...parent.children].indexOf(els[els.length - 1]) + 1
  state.apply(batch(`Group ${els.length} elements`, [
    insertEl(parent, at, g, 'Insert group'),
    ...els.map((el, i) => moveEl(el, g, i)),
  ]))
  s.picked.clear()
  s.picked.add(g)
  refreshAll()
}

/** dissolve a selected plain group into its children, in place */
export function ungroupPicked(): void {
  if (!ctx) return
  const s = ctx.s
  const g = [...s.picked][0]
  if (s.picked.size !== 1 || !isPlainGroup(g)) { showToast('pick one plain group to ungroup'); return }
  if (g.getAttribute('transform') || g.getAttribute('style')) {
    // same contract as the scene canvas: unwrapping would move/restyle
    // the children — enter the group and edit inside instead
    showToast('group carries its own transform/style — enter it (double-click) instead')
    return
  }
  const parent = g.parentNode as Element
  const at = [...parent.children].indexOf(g)
  const kids = [...g.children].filter((el): el is SVGGraphicsElement => el instanceof SVGGraphicsElement)
  state.apply(batch('Ungroup', [
    ...kids.map((el, i) => moveEl(el, parent, at + i)),
    removeEl(g),
  ]))
  s.picked.clear()
  for (const k of kids) s.picked.add(k)
  refreshAll()
}

/** redraw selection visuals + panels (exported for panels → tools updates) */
export function refreshAll(): void {
  if (!ctx) return
  renderSelection(ctx)
  refreshPanels(ctx.s)
}

/** the top-level element (in the current context) owning a pointer target */
export function hitOf(target: EventTarget | null): SVGGraphicsElement | null {
  return ctx ? topLevelOf(ctx, target) : null
}

/** duplicate one element in place — scene nodes mint a fresh id */
export function duplicateOne(s: StudioSession, el: SVGGraphicsElement): SVGGraphicsElement {
  const copy = el.cloneNode(true) as SVGGraphicsElement
  if (isNodeEl(copy)) {
    const base = copy.getAttribute('data-dia-node') ?? 'node'
    let id = `${base}-copy`
    for (let n = 2; s.svg.querySelector(`[data-dia-node="${id}"]`); n++) id = `${base}-copy${n}`
    copy.setAttribute('data-dia-node', id)
  }
  const parent = el.parentNode as Element
  state.apply(insertEl(parent, [...parent.children].indexOf(el) + 1, copy, 'Duplicate drawing element'))
  return copy
}

export function duplicatePicked(): void {
  if (!ctx || ctx.s.picked.size === 0) return
  const s = ctx.s
  const copies = pickables(s).filter((el) => s.picked.has(el)).map((el) => duplicateOne(s, el))
  s.picked.clear()
  for (const c of copies) s.picked.add(c)
  refreshAll()
}

/** restack the picked elements to the top or bottom of their context */
export function reorderPicked(toFront: boolean): void {
  if (!ctx || ctx.s.picked.size === 0) return
  const s = ctx.s
  const parent = contextOf(s)
  const ordered = pickables(s).filter((el) => s.picked.has(el))
  const label = toFront ? 'Bring to front' : 'Send to back'
  // append-order keeps the selection's relative stacking on both moves
  const ops = (toFront ? ordered : [...ordered].reverse()).map((el) =>
    moveEl(el, parent, toFront ? parent.children.length + ordered.length : 0, label))
  state.apply(ops.length === 1 ? ops[0] : batch(label, ops))
  // the overlay artifact renders the handles — it stays topmost, outside ops
  s.svg.appendChild(ctx.ov)
  refreshAll()
}

/** THE deselection path — every picked-set clear repaints the overlay AND
 * the panels together, so the selection box can never go stale (esc, the
 * focus chrome, and outside-the-drawing presses all come through here) */
export function clearPicked(): void {
  if (!ctx || ctx.s.picked.size === 0) return
  ctx.s.picked.clear()
  refreshAll()
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

/** express a ROOT-space step in the element's PARENT space. Handles live
 * in root coordinates, but inside an entered group the parent may carry
 * its own transform — prefixing the root step verbatim would apply that
 * transform twice. Root-level elements keep the readable step string. */
function parentStep(s: StudioSession, el: SVGGraphicsElement, pretty: string, make: () => DOMMatrix): string {
  const p = el.parentElement as unknown as SVGGraphicsElement | null
  if (!p || (p as unknown as Element) === (s.svg as unknown as Element)) return pretty
  const rootCtm = s.svg.getScreenCTM?.()
  const pCtm = p.getScreenCTM?.()
  if (!rootCtm || !pCtm) return pretty
  // getScreenCTM returns legacy SVGMatrix, whose multiply() rejects
  // DOMMatrix arguments — normalize both before mixing
  const P = DOMMatrix.fromMatrix(rootCtm).inverse().multiply(DOMMatrix.fromMatrix(pCtm))
  // float noise from the CTM round-trip must not demote a plain translate
  // to an opaque matrix() in the saved document
  const nearIdentity = Math.abs(P.a - 1) + Math.abs(P.b) + Math.abs(P.c) +
    Math.abs(P.d - 1) + Math.abs(P.e) + Math.abs(P.f) < 1e-6
  if (nearIdentity) return pretty
  const M = P.inverse().multiply(make()).multiply(P)
  return `matrix(${r2(M.a)} ${r2(M.b)} ${r2(M.c)} ${r2(M.d)} ${r2(M.e)} ${r2(M.f)})`
}

/** a scene node group — picked as a UNIT and moved as GEOMETRY, never
 * transforms: data-x/y/w/h stays the single source and edges reroute */
export function isNodeEl(el: Element): el is SVGGElement {
  return el instanceof SVGGElement && el.hasAttribute('data-dia-node')
}

export function isEdgeEl(el: Element): boolean {
  return el instanceof SVGGElement && el.hasAttribute('data-dia-edge')
}

/** the current edit context: the innermost entered group, else the svg */
export function contextOf(s: StudioSession): SVGSVGElement | SVGGElement {
  return s.entered[s.entered.length - 1] ?? s.svg
}

/** a plain container group — enterable; nodes/edges are semantic units */
export function isPlainGroup(el: Element): el is SVGGElement {
  return el instanceof SVGGElement &&
    !el.hasAttribute('data-dia-node') && !el.hasAttribute('data-dia-edge') &&
    !el.classList.contains(ARTIFACT)
}

export function enterGroup(g: SVGGElement): void {
  if (!ctx || !isPlainGroup(g)) return
  ctx.s.entered.push(g)
  ctx.s.picked.clear()
  refreshAll()
}

export function exitGroup(): void {
  if (!ctx || ctx.s.entered.length === 0) return
  const g = ctx.s.entered.pop()
  ctx.s.picked.clear()
  // leaving a group selects it — you land where you came from
  if (g?.isConnected) ctx.s.picked.add(g)
  refreshAll()
}

export function pickables(s: StudioSession): SVGGraphicsElement[] {
  return [...contextOf(s).children].filter((c): c is SVGGraphicsElement =>
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

  // a single picked scene node offers ANCHOR DOTS — drag one onto another
  // node to create an edge, the same gesture as the canvas
  const solo = c.s.picked.size === 1 ? [...c.s.picked][0] : null
  if (solo && isNodeEl(solo) && isSceneArt(c.s.svg)) {
    const g = getNodeGeom(solo)
    const anchors: Array<[string, number, number]> = [
      ['N', g.x + g.w / 2, g.y], ['S', g.x + g.w / 2, g.y + g.h],
      ['E', g.x + g.w, g.y + g.h / 2], ['W', g.x, g.y + g.h / 2],
    ]
    for (const [side, x, y] of anchors) {
      const dot = document.createElementNS(NS, 'circle')
      dot.setAttribute('class', 'dia-st-anchor')
      dot.setAttribute('cx', String(x))
      dot.setAttribute('cy', String(y))
      dot.setAttribute('r', String(4.5 / k))
      dot.addEventListener('pointerdown', (e) => beginConnect(e, solo, side))
      c.ov.appendChild(dot)
    }
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

/** the four anchor points of a node's box */
function anchorPointsOf(n: SVGGElement): Array<[string, number, number]> {
  const g = getNodeGeom(n)
  return [
    ['N', g.x + g.w / 2, g.y], ['S', g.x + g.w / 2, g.y + g.h],
    ['E', g.x + g.w, g.y + g.h / 2], ['W', g.x, g.y + g.h / 2],
  ]
}

/** the node whose box (inflated by eps) contains p — nearest wins */
function hitNodeAt(s: StudioSession, p: { x: number; y: number }, skip: SVGGElement, eps: number): SVGGElement | null {
  let best: SVGGElement | null = null
  let bestD = Infinity
  for (const n of s.svg.querySelectorAll<SVGGElement>(':scope > [data-dia-node]')) {
    if (n === skip) continue
    const g = getNodeGeom(n)
    if (p.x < g.x - eps || p.x > g.x + g.w + eps || p.y < g.y - eps || p.y > g.y + g.h + eps) continue
    const d = Math.hypot(p.x - (g.x + g.w / 2), p.y - (g.y + g.h / 2))
    if (d < bestD) { bestD = d; best = n }
  }
  return best
}

/** drag an anchor dot onto another node → one InsertEdge op, canvas-style:
 * the TARGET's anchor dots light up while you hover it, and dropping ON a
 * dot pins the side the edge lands on (anywhere else on the node = auto) */
function beginConnect(e: PointerEvent, node: SVGGElement, side: string): void {
  if (!ctx) return
  e.preventDefault()
  e.stopPropagation()
  const c = ctx
  const s = c.s
  const g = getNodeGeom(node)
  const from = {
    x: side === 'E' ? g.x + g.w : side === 'W' ? g.x : g.x + g.w / 2,
    y: side === 'S' ? g.y + g.h : side === 'N' ? g.y : g.y + g.h / 2,
  }
  const k = pxScale(s.svg)
  const snap = 12 / k
  const temp = document.createElementNS(NS, 'path')
  temp.setAttribute('class', 'dia-st-draft')
  const cand = document.createElementNS(NS, 'g') as SVGGElement
  c.ov.append(temp, cand)

  const sinkSideAt = (target: SVGGElement, p: { x: number; y: number }): string | null => {
    for (const [ts, x, y] of anchorPointsOf(target)) {
      if (Math.hypot(p.x - x, p.y - y) <= snap) return ts
    }
    return null
  }
  const showCandidates = (target: SVGGElement | null, p: { x: number; y: number }): void => {
    cand.textContent = ''
    if (!target) return
    const pinned = sinkSideAt(target, p)
    for (const [ts, x, y] of anchorPointsOf(target)) {
      const dot = document.createElementNS(NS, 'circle')
      dot.setAttribute('class', `dia-st-anchor${ts === pinned ? '' : ' is-candidate'}`)
      dot.setAttribute('cx', String(x))
      dot.setAttribute('cy', String(y))
      dot.setAttribute('r', String((ts === pinned ? 5.5 : 4) / k))
      cand.appendChild(dot)
    }
  }

  drag((ev) => {
    const p = toArt(s.svg, ev.clientX, ev.clientY)
    temp.setAttribute('d', `M${r2(from.x)},${r2(from.y)} L${r2(p.x)},${r2(p.y)}`)
    showCandidates(hitNodeAt(s, p, node, snap), p)
  }, (ev) => {
    temp.remove()
    cand.remove()
    const p = toArt(s.svg, ev.clientX, ev.clientY)
    const target = hitNodeAt(s, p, node, snap)
    if (target) {
      const sink = sinkSideAt(target, p) ?? 'auto'
      insertEdgeFlow(s.svg, node.getAttribute('data-dia-node') ?? '',
        target.getAttribute('data-dia-node') ?? '', `${side},${sink}`)
    }
    refreshAll()
  })
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
  const dbl = (e: MouseEvent): void => {
    if (c.tool === 'pen') { finishPen(false); return }
    if (c.tool !== 'select') return
    // dblclick edits WORDS in place, wherever words live — a connector's
    // annotation, a node's caption, or plain label text in the artwork
    const edgeEl = (e.target as Element | null)?.closest?.('[data-dia-edge]')
    if (edgeEl instanceof SVGGElement && isSceneArt(c.s.svg)) {
      e.preventDefault()
      openEdgeLabelEdit(c.s.svg, edgeEl)
      return
    }
    const hit = topLevelOf(c, e.target)
    if (hit && isNodeEl(hit) && isSceneArt(c.s.svg)) {
      e.preventDefault()
      openLabelEdit(c.s.svg, hit)
      return
    }
    if (hit instanceof SVGTextElement) {
      e.preventDefault()
      beginTextEdit(c, hit)
      return
    }
    // dblclick a group → enter it (isolation); dblclick empty space → exit
    if (hit && isPlainGroup(hit)) enterGroup(hit)
    else if (!hit && c.s.entered.length > 0) exitGroup()
  }
  const key = (e: KeyboardEvent): void => {
    if (c.tool === 'pen' && e.key === 'Enter') { e.stopPropagation(); finishPen(false) }
  }
  // select-mode presses OUTSIDE the drawing: the surface passes empty space
  // through to the slide (so its text stays editable), which means the svg's
  // own handler never sees them — the STAGE does. Any such press releases
  // the studio selection, and truly blank space starts a marquee. Every
  // creation tool ends back in select with its element picked, so this is
  // the one deselection path they all share.
  const stageWrap = c.s.stage.parentElement
  const stageDown = (e: PointerEvent): void => {
    if (e.button !== 0 || c.tool !== 'select') return
    if (e.composedPath().includes(svg)) return // the surface's own handler owns it
    clearPicked()
    const t = e.target
    const blank = t === c.s.stage || t === stageWrap ||
      (t instanceof Element && t.matches('section.dia-slide'))
    if (blank) beginMarquee(c, e)
  }
  svg.addEventListener('pointerdown', down)
  svg.addEventListener('dblclick', dbl)
  stageWrap?.addEventListener('pointerdown', stageDown)
  document.addEventListener('keydown', key, true)
  c.offPointer = () => {
    svg.removeEventListener('pointerdown', down)
    svg.removeEventListener('dblclick', dbl)
    stageWrap?.removeEventListener('pointerdown', stageDown)
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
  const context = contextOf(c.s)
  let el: Element | null = target
  while (el && el.parentNode !== context) el = el.parentElement
  return el instanceof SVGGraphicsElement && !el.classList.contains(ARTIFACT) ? el : null
}

function selectDown(c: ToolCtx, e: PointerEvent): void {
  // grabbing a connector re-routes it — same middle-handle gesture as the
  // canvas, available anywhere along the wire
  const edgeEl = (e.target as Element | null)?.closest?.('[data-dia-edge]')
  if (edgeEl instanceof SVGGElement && isSceneArt(c.s.svg)) {
    beginEdgeViaDrag(c.s.svg, edgeEl, e)
    return
  }
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
        const step = parentStep(s, el, `translate(${r2(dx)} ${r2(dy)})`,
          () => new DOMMatrix().translate(dx, dy))
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
      const step = parentStep(s, el, `translate(${dx} ${dy})`, () => new DOMMatrix().translate(dx, dy))
      return setAttr(el, 'transform', prefixTransform(el, step))
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
  const stepOf = (el: SVGGraphicsElement, f: { sx: number; sy: number }): string =>
    parentStep(s, el,
      `translate(${r2(ax)} ${r2(ay)}) scale(${r2(f.sx)} ${r2(f.sy)}) translate(${r2(-ax)} ${r2(-ay)})`,
      () => new DOMMatrix().translate(ax, ay).scale(f.sx, f.sy).translate(-ax, -ay))
  /** a node scales as GEOMETRY around the anchor — strokes keep their weight */
  const nodeGeomAt = (g: { x: number; y: number; w: number; h: number }, f: { sx: number; sy: number }) => ({
    x: r2(ax + (g.x - ax) * f.sx), y: r2(ay + (g.y - ay) * f.sy),
    w: r2(Math.max(8, g.w * Math.abs(f.sx))), h: r2(Math.max(8, g.h * Math.abs(f.sy))),
  })
  const applyLive = (f: { sx: number; sy: number }): void => {
    els.forEach((el, i) => {
      const g = geoms[i]
      if (g && isNodeEl(el)) {
        setNodeGeom(el, nodeGeomAt(g, f))
        routeEdgesOf(s.svg, el.getAttribute('data-dia-node') ?? '')
      } else {
        const step = stepOf(el, f)
        el.setAttribute('transform', originals[i] ? `${step} ${originals[i]}` : step)
      }
    })
  }
  drag((ev) => {
    applyLive(factors(ev))
    renderSelection(c)
  }, (ev) => {
    const f = factors(ev)
    els.forEach((el, i) => {
      const g = geoms[i]
      if (g && isNodeEl(el)) setNodeGeom(el, g)
      else if (originals[i] === null) el.removeAttribute('transform')
      else el.setAttribute('transform', originals[i] as string)
    })
    const ops = els.map((el, i) => {
      const g = geoms[i]
      if (g && isNodeEl(el)) return moveSceneNode(s.svg, el, nodeGeomAt(g, f))
      return setAttr(el, 'transform', prefixTransform(el, stepOf(el, f)))
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
  const degOf = (ev: PointerEvent): number => {
    const p = toArt(s.svg, ev.clientX, ev.clientY)
    let deg = (Math.atan2(p.y - cy, p.x - cx) - a0) * 180 / Math.PI
    if (ev.shiftKey) deg = Math.round(deg / 15) * 15
    return deg
  }
  const stepOf = (el: SVGGraphicsElement, deg: number): string =>
    parentStep(s, el, `rotate(${r2(deg)} ${r2(cx)} ${r2(cy)})`,
      () => new DOMMatrix().translate(cx, cy).rotate(deg).translate(-cx, -cy))
  drag((ev) => {
    const deg = degOf(ev)
    els.forEach((el, i) => {
      const step = stepOf(el, deg)
      el.setAttribute('transform', originals[i] ? `${step} ${originals[i]}` : step)
    })
    renderSelection(c)
  }, (ev) => {
    const deg = degOf(ev)
    els.forEach((el, i) => originals[i] === null
      ? el.removeAttribute('transform')
      : el.setAttribute('transform', originals[i] as string))
    const ops = els.map((el) => setAttr(el, 'transform', prefixTransform(el, stepOf(el, deg))))
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
    state.apply(insertEl(contextOf(s), insertIndex(s), el, `Draw ${tool}`))
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
  state.apply(insertEl(contextOf(s), insertIndex(s), el, 'Draw path'))
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
    state.apply(insertEl(contextOf(s), insertIndex(s), el, 'Draw freehand'))
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
  el.textContent = 'label'
  state.apply(insertEl(contextOf(s), insertIndex(s), el, 'Place text'))
  s.picked.clear()
  s.picked.add(el)
  setTool('select')
  // placing a label IS starting to type — no second gesture required
  beginTextEdit(c, el)
}

/** the in-place words editor for plain <text> — a deleted (emptied)
 * element must also leave the picked set, or the box outlives it */
function beginTextEdit(c: ToolCtx, el: SVGTextElement): void {
  openSvgTextEdit(c.s.svg, el, () => {
    if (!el.isConnected) c.s.picked.delete(el)
    refreshAll()
  })
}

/* ---------- shared ---------- */

/** new artwork goes on top of the CONTEXT, below any overlay artifact */
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
