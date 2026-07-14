/* Scene editor overlay: selection rings, handles, anchor dots, smart guides,
 * temp edges, edge hit-paths, and the write-target toast.
 * Every SVG artifact carries .dia-editor-artifact so serialize strips it;
 * nothing here is ever inserted inside node/edge groups. */

import type { AnchorSide } from '../types'
import { anchorPoint, autoSides, edgesOf, findNode, getNodeGeom, parseEdgeRef } from './route'

const NS = 'http://www.w3.org/2000/svg'
const ARTIFACT = 'dia-editor-artifact'

/* styles that must live inside the deck shadow root (stripped on save) */
const SHADOW_CSS = `
svg.dia-scene { touch-action: none; }
svg.dia-scene g[data-dia-node] { cursor: grab; }
.dia-edge-hit { fill: none; stroke: transparent; stroke-width: 12; pointer-events: stroke; cursor: pointer; }
.dia-overlay { pointer-events: none; }
.dia-overlay .dia-sel-shape { fill: none; stroke: var(--accent); stroke-width: 1.6; vector-effect: non-scaling-stroke; }
.dia-overlay .dia-handle { fill: var(--paper); stroke: var(--accent); stroke-width: 1; vector-effect: non-scaling-stroke; pointer-events: all; }
.dia-overlay .dia-handle[data-dia-handle="nw"], .dia-overlay .dia-handle[data-dia-handle="se"] { cursor: nwse-resize; }
.dia-overlay .dia-handle[data-dia-handle="ne"], .dia-overlay .dia-handle[data-dia-handle="sw"] { cursor: nesw-resize; }
.dia-overlay .dia-anchor { fill: var(--accent); stroke: none; pointer-events: all; cursor: crosshair; }
.dia-overlay .dia-endpoint { fill: var(--paper); stroke: var(--accent); stroke-width: 1.2; vector-effect: non-scaling-stroke; pointer-events: all; cursor: move; }
.dia-overlay .dia-guide { stroke: var(--bad); stroke-width: 1; stroke-dasharray: 4 3; fill: none; vector-effect: non-scaling-stroke; }
.dia-overlay .dia-guide-label { font-family: var(--mono); fill: var(--bad); }
.dia-overlay .dia-temp-edge { stroke: var(--accent); stroke-width: 1.4; stroke-dasharray: 5 4; fill: none; vector-effect: non-scaling-stroke; }
.dia-overlay .dia-candidate { fill: none; stroke: var(--accent); stroke-width: 1.4; stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; }
.dia-points { pointer-events: none; }
.dia-points .dia-points-trace { fill: none; stroke: var(--accent); stroke-width: 1; stroke-dasharray: 3 3; opacity: 0.7; vector-effect: non-scaling-stroke; }
.dia-points .dia-points-arm { fill: none; stroke: var(--accent); stroke-width: 0.8; opacity: 0.55; vector-effect: non-scaling-stroke; }
.dia-points .dia-point { fill: var(--paper); stroke: var(--accent); stroke-width: 1.2; vector-effect: non-scaling-stroke; pointer-events: all; cursor: move; }
.dia-points .dia-point.is-control { fill: var(--accent); stroke: var(--paper); }
`

export function ensureEditorStyles(root: ShadowRoot): void {
  if (root.querySelector('style.dia-editor-style')) return
  const st = document.createElement('style')
  st.className = `${ARTIFACT} dia-editor-style`
  st.textContent = SHADOW_CSS
  root.appendChild(st)
}

/* ---------- overlay group (always last child of the svg) ---------- */

const LAYERS = ['dia-ov-guides', 'dia-ov-sel', 'dia-ov-cand', 'dia-ov-temp'] as const
type LayerName = (typeof LAYERS)[number]

export function overlayOf(scene: SVGSVGElement): SVGGElement {
  let ov = scene.querySelector<SVGGElement>(':scope > g.dia-overlay')
  if (!ov) {
    ov = document.createElementNS(NS, 'g') as SVGGElement
    ov.setAttribute('class', `${ARTIFACT} dia-overlay`)
    for (const name of LAYERS) {
      const g = document.createElementNS(NS, 'g')
      g.setAttribute('class', name)
      ov.appendChild(g)
    }
    scene.appendChild(ov)
  }
  if (ov !== scene.lastElementChild) scene.appendChild(ov)
  return ov
}

function layerOf(scene: SVGSVGElement, name: LayerName): SVGGElement {
  return overlayOf(scene).querySelector<SVGGElement>(`:scope > g.${name}`)!
}

/** client px per viewBox unit (stage transforms fold into the CTM) */
export function pxScale(scene: SVGSVGElement): number {
  const ctm = scene.getScreenCTM()
  return ctm ? Math.hypot(ctm.a, ctm.b) || 1 : 1
}

/* ---------- selection visuals ---------- */

export function drawNodeSelection(scene: SVGSVGElement, node: SVGGElement): void {
  const g = layerOf(scene, 'dia-ov-sel')
  g.textContent = ''
  const geom = getNodeGeom(node)
  const k = pxScale(scene)

  const shape = node.querySelector<SVGGraphicsElement>('.dia-node-shape')
  if (shape) {
    const ring = shape.cloneNode(false) as SVGGraphicsElement
    ring.setAttribute('class', 'dia-sel-shape')
    ring.removeAttribute('style')
    ring.removeAttribute('id')
    g.appendChild(ring)
  } else {
    g.appendChild(rect(geom.x, geom.y, geom.w, geom.h, 'dia-sel-shape'))
  }

  for (const side of ['N', 'S', 'E', 'W'] as const) {
    const p = anchorPoint(geom, side)
    const dot = circle(p.x, p.y, 3 / k, 'dia-anchor')
    dot.setAttribute('data-dia-anchor', side)
    g.appendChild(dot)
  }

  const s = 7 / k
  const corners: [string, number, number][] = [
    ['nw', geom.x, geom.y],
    ['ne', geom.x + geom.w, geom.y],
    ['sw', geom.x, geom.y + geom.h],
    ['se', geom.x + geom.w, geom.y + geom.h],
  ]
  for (const [c, x, y] of corners) {
    const h = rect(x - s / 2, y - s / 2, s, s, 'dia-handle')
    h.setAttribute('data-dia-handle', c)
    g.appendChild(h)
  }
}

export function drawEdgeSelection(scene: SVGSVGElement, edge: SVGGElement): void {
  const g = layerOf(scene, 'dia-ov-sel')
  g.textContent = ''
  const src = edge.querySelector<SVGPathElement>('.dia-edge-path')
  if (src) g.appendChild(path(src.getAttribute('d') ?? '', 'dia-sel-shape'))
  const pts = edgeEndpoints(scene, edge)
  if (pts) {
    const r = 4 / pxScale(scene)
    for (const [end, p] of [['from', pts.p1], ['to', pts.p2]] as const) {
      const c = circle(p.x, p.y, r, 'dia-endpoint')
      c.setAttribute('data-dia-endpoint', end)
      g.appendChild(c)
    }
  }
}

/** selection ring + scale handles for a free element (bbox in scene coords) */
export function drawFreeSelection(scene: SVGSVGElement, el: SVGGraphicsElement): void {
  const g = layerOf(scene, 'dia-ov-sel')
  g.textContent = ''
  const b = freeBBox(scene, el)
  if (!b) return
  g.appendChild(rect(b.x, b.y, b.w, b.h, 'dia-sel-shape'))
  const s = 7 / pxScale(scene)
  const corners: [string, number, number][] = [
    ['nw', b.x, b.y], ['ne', b.x + b.w, b.y],
    ['sw', b.x, b.y + b.h], ['se', b.x + b.w, b.y + b.h],
  ]
  for (const [c, x, y] of corners) {
    const h = rect(x - s / 2, y - s / 2, s, s, 'dia-handle')
    h.setAttribute('data-dia-handle', c)
    g.appendChild(h)
  }
}

/** a free element's bounding box in scene coordinates (transforms applied) */
export function freeBBox(
  scene: SVGSVGElement, el: SVGGraphicsElement,
): { x: number; y: number; w: number; h: number } | null {
  try {
    const b = el.getBBox()
    const toSceneM = scene.getScreenCTM()?.inverse()
    const elM = el.getScreenCTM()
    if (!toSceneM || !elM) return { x: b.x, y: b.y, w: b.width, h: b.height }
    const m = toSceneM.multiply(elM)
    const pts = [
      [b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height],
    ].map(([x, y]) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }))
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y)
    const x = Math.min(...xs), y = Math.min(...ys)
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
  } catch {
    return null
  }
}

/** live preview of a drawing in progress (pen / line tools) */
export function drawTempPath(scene: SVGSVGElement, d: string): void {
  const g = layerOf(scene, 'dia-ov-temp')
  g.textContent = ''
  if (d) g.appendChild(path(d, 'dia-temp-edge'))
}

export function clearSelectionVisuals(scene: SVGSVGElement): void {
  layerOf(scene, 'dia-ov-sel').textContent = ''
}

/** anchor endpoints of an edge, honouring declared/auto sides (mirrors routeEdge) */
export function edgeEndpoints(
  scene: SVGSVGElement, edge: SVGGElement,
): { p1: { x: number; y: number }; p2: { x: number; y: number } } | null {
  const ref = parseEdgeRef(edge)
  if (!ref) return null
  const a = findNode(scene, ref.from), b = findNode(scene, ref.to)
  if (!a || !b) return null
  const ga = getNodeGeom(a), gb = getNodeGeom(b)
  const declared = (edge.getAttribute('data-anchors') ?? 'auto,auto').split(',') as AnchorSide[]
  const auto = autoSides(ga, gb)
  const s1 = !declared[0] || declared[0] === 'auto' ? auto[0] : (declared[0] as Exclude<AnchorSide, 'auto'>)
  const s2 = !declared[1] || declared[1] === 'auto' ? auto[1] : (declared[1] as Exclude<AnchorSide, 'auto'>)
  return { p1: anchorPoint(ga, s1), p2: anchorPoint(gb, s2) }
}

/* ---------- smart guides ---------- */

export type Guide =
  | { kind: 'v'; x: number }
  | { kind: 'h'; y: number }
  | { kind: 'label'; x: number; y: number; text: string }

export function drawGuides(scene: SVGSVGElement, guides: Guide[]): void {
  const g = layerOf(scene, 'dia-ov-guides')
  g.textContent = ''
  const vb = scene.viewBox.baseVal
  const k = pxScale(scene)
  for (const guide of guides) {
    if (guide.kind === 'v') {
      g.appendChild(line(guide.x, vb.y, guide.x, vb.y + vb.height))
    } else if (guide.kind === 'h') {
      g.appendChild(line(vb.x, guide.y, vb.x + vb.width, guide.y))
    } else {
      const t = document.createElementNS(NS, 'text')
      t.setAttribute('class', 'dia-guide-label')
      t.setAttribute('x', String(guide.x))
      t.setAttribute('y', String(guide.y))
      t.setAttribute('text-anchor', 'middle')
      t.setAttribute('font-size', String(9 / k))
      t.textContent = guide.text
      g.appendChild(t)
    }
  }
}

export function clearGuides(scene: SVGSVGElement): void {
  layerOf(scene, 'dia-ov-guides').textContent = ''
}

/* ---------- temp edge + drop candidate ---------- */

export function showTempEdge(
  scene: SVGSVGElement, from: { x: number; y: number }, to: { x: number; y: number },
): void {
  const g = layerOf(scene, 'dia-ov-temp')
  g.textContent = ''
  g.appendChild(path(`M${from.x},${from.y} L${to.x},${to.y}`, 'dia-temp-edge'))
}

export function clearTempEdge(scene: SVGSVGElement): void {
  layerOf(scene, 'dia-ov-temp').textContent = ''
}

export function highlightCandidate(
  scene: SVGSVGElement, node: SVGGElement | null, hotSide: Exclude<AnchorSide, 'auto'> | null = null,
): void {
  const g = layerOf(scene, 'dia-ov-cand')
  g.textContent = ''
  if (!node) return
  const geom = getNodeGeom(node)
  const k = pxScale(scene)
  const m = 3 / k
  const r = rect(geom.x - m, geom.y - m, geom.w + 2 * m, geom.h + 2 * m, 'dia-candidate')
  r.setAttribute('rx', String(4 / k))
  g.appendChild(r)
  // sink anchors: aim at a dot to pin the side the edge lands on; the hot
  // one (nearest the pointer) renders larger — drop pins it
  for (const side of ['N', 'S', 'E', 'W'] as const) {
    const p = anchorPoint(geom, side)
    const dot = circle(p.x, p.y, (side === hotSide ? 5 : 3) / k, 'dia-anchor')
    g.appendChild(dot)
  }
}

/** the candidate side nearest p, when within snapping distance; null = auto */
export function nearestAnchorSide(
  scene: SVGSVGElement, node: SVGGElement, p: { x: number; y: number },
): Exclude<AnchorSide, 'auto'> | null {
  const geom = getNodeGeom(node)
  const snap = 16 / Math.min(1, pxScale(scene)) // generous in small scenes
  let best: Exclude<AnchorSide, 'auto'> | null = null
  let bestD = snap
  for (const side of ['N', 'S', 'E', 'W'] as const) {
    const a = anchorPoint(geom, side)
    const d = Math.hypot(a.x - p.x, a.y - p.y)
    if (d < bestD) { bestD = d; best = side }
  }
  return best
}

/* ---------- edge hit paths (fat invisible strokes for edge picking) ---------- */

const hitToEdge = new WeakMap<Element, SVGGElement>()

/** rebuild the fat hit path per edge; call after any (re)route or structural op */
export function syncEdgeHits(scene: SVGSVGElement): void {
  let hl = scene.querySelector<SVGGElement>(':scope > g.dia-hitlayer')
  if (!hl) {
    hl = document.createElementNS(NS, 'g') as SVGGElement
    hl.setAttribute('class', `${ARTIFACT} dia-hitlayer`)
    scene.appendChild(hl)
  }
  hl.textContent = ''
  for (const edge of edgesOf(scene)) {
    const p = edge.querySelector<SVGPathElement>('.dia-edge-path')
    if (!p) continue
    const hit = path(p.getAttribute('d') ?? '', `dia-edge-hit ${ARTIFACT}`)
    hitToEdge.set(hit, edge)
    hl.appendChild(hit)
  }
  overlayOf(scene) // keep the overlay above the hit layer
}

export function edgeForHit(el: Element): SVGGElement | null {
  const hit = el.closest('.dia-edge-hit')
  return hit ? hitToEdge.get(hit) ?? null : null
}

/* ---------- write-target toast ---------- */

let toastEl: HTMLDivElement | null = null

export function showToast(text: string): void {
  if (!toastEl) {
    toastEl = document.createElement('div')
    toastEl.className = 'dia-toast'
    document.body.appendChild(toastEl)
  }
  toastEl.textContent = text
  toastEl.classList.add('dia-toast-on')
}

export function hideToast(): void {
  toastEl?.classList.remove('dia-toast-on')
}

/* ---------- svg element helpers ---------- */

function rect(x: number, y: number, w: number, h: number, cls: string): SVGRectElement {
  const r = document.createElementNS(NS, 'rect')
  r.setAttribute('class', cls)
  r.setAttribute('x', String(x)); r.setAttribute('y', String(y))
  r.setAttribute('width', String(w)); r.setAttribute('height', String(h))
  return r
}

function circle(cx: number, cy: number, r: number, cls: string): SVGCircleElement {
  const c = document.createElementNS(NS, 'circle')
  c.setAttribute('class', cls)
  c.setAttribute('cx', String(cx)); c.setAttribute('cy', String(cy))
  c.setAttribute('r', String(r))
  return c
}

function path(d: string, cls: string): SVGPathElement {
  const p = document.createElementNS(NS, 'path')
  p.setAttribute('class', cls)
  p.setAttribute('d', d)
  return p
}

function line(x1: number, y1: number, x2: number, y2: number): SVGLineElement {
  const l = document.createElementNS(NS, 'line')
  l.setAttribute('class', 'dia-guide')
  l.setAttribute('x1', String(x1)); l.setAttribute('y1', String(y1))
  l.setAttribute('x2', String(x2)); l.setAttribute('y2', String(y2))
  return l
}
