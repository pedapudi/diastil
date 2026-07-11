/* Scene layer core: node geometry + edge routing.
 * The scene vocabulary in the dialect:
 *   <svg class="dia-scene" viewBox="…">
 *     <g data-dia-node="id" data-shape="rounded" data-x data-y data-w data-h>
 *       <rect|ellipse|path class="dia-node-shape"/><text class="dia-node-label"/>
 *     </g>
 *     <g data-dia-edge="a->b" data-anchors="E,W" data-route="ortho" data-label="…">
 *       <path class="dia-edge-path"/><text class="dia-edge-label"/>
 *     </g>
 *   </svg>
 * Moving a node = set data-x/y (+ re-render shape) + reroute its edges.
 * This module is deterministic and DOM-in/DOM-out; interactions live elsewhere. */

import type { AnchorSide, EdgeRoute, NodeGeom, NodeShape } from '../types'

const NS = 'http://www.w3.org/2000/svg'

/* ---------- node geometry ---------- */

export function getNodeGeom(node: SVGGElement): NodeGeom {
  return {
    x: num(node, 'data-x'), y: num(node, 'data-y'),
    w: num(node, 'data-w', 120), h: num(node, 'data-h', 40),
  }
}

export function setNodeGeom(node: SVGGElement, g: NodeGeom): void {
  node.setAttribute('data-x', fmt(g.x))
  node.setAttribute('data-y', fmt(g.y))
  node.setAttribute('data-w', fmt(g.w))
  node.setAttribute('data-h', fmt(g.h))
  renderNodeShape(node)
}

export function getShape(node: SVGGElement): NodeShape {
  return (node.getAttribute('data-shape') as NodeShape) || 'rounded'
}

/** (re)build the node's shape + center its label from geometry attributes */
export function renderNodeShape(node: SVGGElement): void {
  const g = getNodeGeom(node)
  const shape = getShape(node)
  let el = node.querySelector<SVGGraphicsElement>('.dia-node-shape')
  const needTag = shape === 'ellipse' ? 'ellipse' : shape === 'diamond' ? 'path' : 'rect'
  if (!el || el.tagName !== needTag) {
    const fresh = document.createElementNS(NS, needTag) as SVGGraphicsElement
    fresh.setAttribute('class', 'dia-node-shape')
    el ? el.replaceWith(fresh) : node.prepend(fresh)
    el = fresh
  }
  if (needTag === 'rect') {
    el.setAttribute('x', fmt(g.x)); el.setAttribute('y', fmt(g.y))
    el.setAttribute('width', fmt(g.w)); el.setAttribute('height', fmt(g.h))
    el.setAttribute('rx', shape === 'pill' ? fmt(g.h / 2) : shape === 'rounded' ? '6' : '0')
  } else if (needTag === 'ellipse') {
    el.setAttribute('cx', fmt(g.x + g.w / 2)); el.setAttribute('cy', fmt(g.y + g.h / 2))
    el.setAttribute('rx', fmt(g.w / 2)); el.setAttribute('ry', fmt(g.h / 2))
  } else {
    const cx = g.x + g.w / 2, cy = g.y + g.h / 2
    el.setAttribute('d', `M${fmt(cx)},${fmt(g.y)} L${fmt(g.x + g.w)},${fmt(cy)} L${fmt(cx)},${fmt(g.y + g.h)} L${fmt(g.x)},${fmt(cy)} Z`)
  }
  const label = node.querySelector<SVGTextElement>('.dia-node-label')
  if (label) {
    label.setAttribute('x', fmt(g.x + g.w / 2))
    label.setAttribute('y', fmt(g.y + g.h / 2))
    label.setAttribute('text-anchor', 'middle')
    label.setAttribute('dominant-baseline', 'central')
  }
}

/* ---------- edges ---------- */

export interface EdgeRef { from: string; to: string }

export function parseEdgeRef(edge: SVGGElement): EdgeRef | null {
  const m = /^(.+?)->(.+)$/.exec(edge.getAttribute('data-dia-edge') ?? '')
  return m ? { from: m[1], to: m[2] } : null
}

export function findNode(scene: SVGSVGElement, id: string): SVGGElement | null {
  return scene.querySelector<SVGGElement>(`g[data-dia-node="${cssEscape(id)}"]`)
}

export function nodesOf(scene: SVGSVGElement): SVGGElement[] {
  return [...scene.querySelectorAll<SVGGElement>('g[data-dia-node]')]
}

export function edgesOf(scene: SVGSVGElement): SVGGElement[] {
  return [...scene.querySelectorAll<SVGGElement>('g[data-dia-edge]')]
}

/** anchor point on a side of a node's box */
export function anchorPoint(g: NodeGeom, side: Exclude<AnchorSide, 'auto'>): { x: number; y: number } {
  switch (side) {
    case 'N': return { x: g.x + g.w / 2, y: g.y }
    case 'S': return { x: g.x + g.w / 2, y: g.y + g.h }
    case 'E': return { x: g.x + g.w, y: g.y + g.h / 2 }
    case 'W': return { x: g.x, y: g.y + g.h / 2 }
  }
}

/** choose facing sides automatically from relative centers */
export function autoSides(a: NodeGeom, b: NodeGeom): [Exclude<AnchorSide, 'auto'>, Exclude<AnchorSide, 'auto'>] {
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2
  const bx = b.x + b.w / 2, by = b.y + b.h / 2
  const dx = bx - ax, dy = by - ay
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ['E', 'W'] : ['W', 'E']
  return dy >= 0 ? ['S', 'N'] : ['N', 'S']
}

/** recompute one edge's path (+ label position) from its endpoints */
export function routeEdge(scene: SVGSVGElement, edge: SVGGElement): void {
  const ref = parseEdgeRef(edge)
  if (!ref) return
  const a = findNode(scene, ref.from), b = findNode(scene, ref.to)
  if (!a || !b) return
  const ga = getNodeGeom(a), gb = getNodeGeom(b)

  const declared = (edge.getAttribute('data-anchors') ?? 'auto,auto').split(',') as AnchorSide[]
  const auto = autoSides(ga, gb)
  const sideA = declared[0] === 'auto' || !declared[0] ? auto[0] : (declared[0] as Exclude<AnchorSide, 'auto'>)
  const sideB = declared[1] === 'auto' || !declared[1] ? auto[1] : (declared[1] as Exclude<AnchorSide, 'auto'>)
  const p1 = anchorPoint(ga, sideA), p2 = anchorPoint(gb, sideB)

  const routeKind = (edge.getAttribute('data-route') as EdgeRoute) || 'ortho'
  let d: string
  if (routeKind === 'straight') {
    d = `M${fmt(p1.x)},${fmt(p1.y)} L${fmt(p2.x)},${fmt(p2.y)}`
  } else if (routeKind === 'curve') {
    const mx = (p1.x + p2.x) / 2
    d = `M${fmt(p1.x)},${fmt(p1.y)} C${fmt(mx)},${fmt(p1.y)} ${fmt(mx)},${fmt(p2.y)} ${fmt(p2.x)},${fmt(p2.y)}`
  } else {
    d = orthoPath(p1, sideA, p2, sideB)
  }

  let path = edge.querySelector<SVGPathElement>('.dia-edge-path')
  if (!path) {
    path = document.createElementNS(NS, 'path')
    path.setAttribute('class', 'dia-edge-path')
    edge.prepend(path)
  }
  path.setAttribute('d', d)
  path.setAttribute('fill', 'none')
  path.setAttribute('marker-end', 'url(#dia-arrow)')

  const label = edge.querySelector<SVGTextElement>('.dia-edge-label')
  if (label) {
    const mid = pathMidpoint(p1, p2)
    label.setAttribute('x', fmt(mid.x)); label.setAttribute('y', fmt(mid.y - 6))
    label.setAttribute('text-anchor', 'middle')
  }
}

/** simple 1–2 bend orthogonal route between two anchor points */
function orthoPath(
  p1: { x: number; y: number }, s1: Exclude<AnchorSide, 'auto'>,
  p2: { x: number; y: number }, s2: Exclude<AnchorSide, 'auto'>,
): string {
  const h1 = s1 === 'E' || s1 === 'W'
  const h2 = s2 === 'E' || s2 === 'W'
  if (h1 && h2) {
    const mx = (p1.x + p2.x) / 2
    return `M${fmt(p1.x)},${fmt(p1.y)} H${fmt(mx)} V${fmt(p2.y)} H${fmt(p2.x)}`
  }
  if (!h1 && !h2) {
    const my = (p1.y + p2.y) / 2
    return `M${fmt(p1.x)},${fmt(p1.y)} V${fmt(my)} H${fmt(p2.x)} V${fmt(p2.y)}`
  }
  if (h1 && !h2) return `M${fmt(p1.x)},${fmt(p1.y)} H${fmt(p2.x)} V${fmt(p2.y)}`
  return `M${fmt(p1.x)},${fmt(p1.y)} V${fmt(p2.y)} H${fmt(p2.x)}`
}

function pathMidpoint(p1: { x: number; y: number }, p2: { x: number; y: number }) {
  return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
}

/** reroute every edge touching node `id` */
export function routeEdgesOf(scene: SVGSVGElement, id: string): void {
  for (const e of edgesOf(scene)) {
    const ref = parseEdgeRef(e)
    if (ref && (ref.from === id || ref.to === id)) routeEdge(scene, e)
  }
}

export function routeAll(scene: SVGSVGElement): void {
  ensureArrowMarker(scene)
  for (const n of nodesOf(scene)) renderNodeShape(n)
  for (const e of edgesOf(scene)) routeEdge(scene, e)
}

/** shared arrowhead marker, stroke-follows-ink via context-fill */
export function ensureArrowMarker(scene: SVGSVGElement): void {
  if (scene.querySelector('#dia-arrow')) return
  let defs = scene.querySelector('defs')
  if (!defs) { defs = document.createElementNS(NS, 'defs'); scene.prepend(defs) }
  const marker = document.createElementNS(NS, 'marker')
  marker.id = 'dia-arrow'
  marker.setAttribute('viewBox', '0 0 8 8')
  marker.setAttribute('refX', '7'); marker.setAttribute('refY', '4')
  marker.setAttribute('markerWidth', '7'); marker.setAttribute('markerHeight', '7')
  marker.setAttribute('orient', 'auto-start-reverse')
  const tip = document.createElementNS(NS, 'path')
  tip.setAttribute('d', 'M0,0 L8,4 L0,8 z')
  tip.setAttribute('fill', 'currentColor')
  marker.appendChild(tip)
  defs.appendChild(marker)
}

/* ---------- creation helpers ---------- */

export function createNode(scene: SVGSVGElement, id: string, geom: NodeGeom, label: string, shape: NodeShape = 'rounded'): SVGGElement {
  const g = document.createElementNS(NS, 'g') as SVGGElement
  g.setAttribute('data-dia-node', id)
  g.setAttribute('data-shape', shape)
  const text = document.createElementNS(NS, 'text')
  text.setAttribute('class', 'dia-node-label')
  text.textContent = label
  g.appendChild(text)
  scene.appendChild(g)
  setNodeGeom(g, geom)
  return g
}

export function createEdge(scene: SVGSVGElement, from: string, to: string, label?: string): SVGGElement {
  const g = document.createElementNS(NS, 'g') as SVGGElement
  g.setAttribute('data-dia-edge', `${from}->${to}`)
  g.setAttribute('data-anchors', 'auto,auto')
  g.setAttribute('data-route', 'ortho')
  if (label) {
    const t = document.createElementNS(NS, 'text')
    t.setAttribute('class', 'dia-edge-label')
    t.textContent = label
    g.appendChild(t)
  }
  scene.appendChild(g)
  routeEdge(scene, g)
  return g
}

export function freshNodeId(scene: SVGSVGElement): string {
  const used = new Set(nodesOf(scene).map((n) => n.getAttribute('data-dia-node')))
  let i = 1
  while (used.has(`n${i}`)) i++
  return `n${i}`
}

/* ---------- utils ---------- */

function num(el: Element, attr: string, fallback = 0): number {
  const v = parseFloat(el.getAttribute(attr) ?? '')
  return Number.isFinite(v) ? v : fallback
}
function fmt(n: number): string { return String(Math.round(n * 100) / 100) }
function cssEscape(s: string): string { return s.replace(/["\\]/g, '\\$&') }
