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

const RECT_SHAPES = new Set<NodeShape>(['rect', 'rounded', 'pill'])

/** (re)build the node's shape + center its label from geometry attributes */
export function renderNodeShape(node: SVGGElement): void {
  const g = getNodeGeom(node)
  const shape = getShape(node)
  let el = node.querySelector<SVGGraphicsElement>('.dia-node-shape')
  const needTag = shape === 'ellipse' ? 'ellipse' : RECT_SHAPES.has(shape) ? 'rect' : 'path'
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
  } else if (shape === 'path') {
    // freeform outline in a 100×100-normalized space, scaled into the box.
    // vector-effect keeps stroke width constant under the scale transform.
    el.setAttribute('d', node.getAttribute('data-path') ?? 'M0,0 L100,100')
    // scale needs more precision than fmt: a 2dp scale error is ×100 in
    // normalized units — enough to visibly shift an imported outline
    const prec = (n: number) => String(Math.round(n * 100000) / 100000)
    el.setAttribute('transform',
      `translate(${fmt(g.x)},${fmt(g.y)}) scale(${prec(g.w / 100)},${prec(g.h / 100)})`)
    el.setAttribute('vector-effect', 'non-scaling-stroke')
  } else {
    el.removeAttribute('transform')
    el.setAttribute('d', shapePathD(shape, g))
  }
  const label = node.querySelector<SVGTextElement>('.dia-node-label')
  if (label) {
    label.setAttribute('x', fmt(g.x + g.w / 2))
    label.setAttribute('y', fmt(g.y + g.h / 2))
    label.setAttribute('text-anchor', 'middle')
    label.setAttribute('dominant-baseline', 'central')
  }
}

/** outline path for the parametric (non-rect, non-ellipse) shapes */
export function shapePathD(shape: NodeShape, g: NodeGeom): string {
  const { x, y, w, h } = g
  const cx = x + w / 2, cy = y + h / 2
  switch (shape) {
    case 'diamond':
      return `M${fmt(cx)},${fmt(y)} L${fmt(x + w)},${fmt(cy)} L${fmt(cx)},${fmt(y + h)} L${fmt(x)},${fmt(cy)} Z`
    case 'cylinder': {
      const ry = Math.min(h * 0.15, 14), rx = w / 2
      return (
        `M${fmt(x)},${fmt(y + ry)} A${fmt(rx)},${fmt(ry)} 0 0 1 ${fmt(x + w)},${fmt(y + ry)} ` +
        `V${fmt(y + h - ry)} A${fmt(rx)},${fmt(ry)} 0 0 1 ${fmt(x)},${fmt(y + h - ry)} Z ` +
        `M${fmt(x)},${fmt(y + ry)} A${fmt(rx)},${fmt(ry)} 0 0 0 ${fmt(x + w)},${fmt(y + ry)}`
      )
    }
    case 'hex': {
      const d = Math.min(w * 0.25, h / 2)
      return (
        `M${fmt(x + d)},${fmt(y)} L${fmt(x + w - d)},${fmt(y)} L${fmt(x + w)},${fmt(cy)} ` +
        `L${fmt(x + w - d)},${fmt(y + h)} L${fmt(x + d)},${fmt(y + h)} L${fmt(x)},${fmt(cy)} Z`
      )
    }
    case 'parallelogram': {
      const s = Math.min(w * 0.2, 24)
      return `M${fmt(x + s)},${fmt(y)} L${fmt(x + w)},${fmt(y)} L${fmt(x + w - s)},${fmt(y + h)} L${fmt(x)},${fmt(y + h)} Z`
    }
    case 'triangle':
      return `M${fmt(cx)},${fmt(y)} L${fmt(x + w)},${fmt(y + h)} L${fmt(x)},${fmt(y + h)} Z`
    case 'cloud': {
      const px = (f: number) => fmt(x + w * f), py = (f: number) => fmt(y + h * f)
      return (
        `M${px(0.22)},${py(0.85)} ` +
        `C${px(0.05)},${py(0.85)} ${px(0)},${py(0.62)} ${px(0.08)},${py(0.5)} ` +
        `C${px(0)},${py(0.3)} ${px(0.16)},${py(0.2)} ${px(0.3)},${py(0.24)} ` +
        `C${px(0.36)},${py(0.08)} ${px(0.62)},${py(0.08)} ${px(0.7)},${py(0.22)} ` +
        `C${px(0.87)},${py(0.16)} ${px(1)},${py(0.32)} ${px(0.94)},${py(0.5)} ` +
        `C${px(1)},${py(0.65)} ${px(0.93)},${py(0.85)} ${px(0.78)},${py(0.85)} Z`
      )
    }
    case 'note': {
      const f = Math.min(14, w * 0.2, h * 0.3)
      return (
        `M${fmt(x)},${fmt(y)} L${fmt(x + w - f)},${fmt(y)} L${fmt(x + w)},${fmt(y + f)} ` +
        `L${fmt(x + w)},${fmt(y + h)} L${fmt(x)},${fmt(y + h)} Z ` +
        `M${fmt(x + w - f)},${fmt(y)} L${fmt(x + w - f)},${fmt(y + f)} L${fmt(x + w)},${fmt(y + f)}`
      )
    }
    default:
      return `M${fmt(x)},${fmt(y)} H${fmt(x + w)} V${fmt(y + h)} H${fmt(x)} Z`
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
  let labelAt: Pt
  if (routeKind === 'straight') {
    d = `M${fmt(p1.x)},${fmt(p1.y)} L${fmt(p2.x)},${fmt(p2.y)}`
    labelAt = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
  } else if (routeKind === 'curve') {
    const mx = (p1.x + p2.x) / 2
    d = `M${fmt(p1.x)},${fmt(p1.y)} C${fmt(mx)},${fmt(p1.y)} ${fmt(mx)},${fmt(p2.y)} ${fmt(p2.x)},${fmt(p2.y)}`
    labelAt = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
  } else {
    const obstacles = nodesOf(scene)
      .filter((n) => n !== a && n !== b)
      .map((n) => getNodeGeom(n))
    const pts = routeOrtho(p1, sideA, p2, sideB, obstacles)
    d = polylineD(pts)
    labelAt = polylineMidpoint(pts)
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

  let label = edge.querySelector<SVGTextElement>('.dia-edge-label')
  if (!label && edge.getAttribute('data-label')) {
    // declarative label (data-label) materializes on first route
    label = document.createElementNS(NS, 'text')
    label.setAttribute('class', 'dia-edge-label')
    label.textContent = edge.getAttribute('data-label')
    edge.appendChild(label)
  }
  if (label) {
    label.setAttribute('x', fmt(labelAt.x)); label.setAttribute('y', fmt(labelAt.y - 6))
    label.setAttribute('text-anchor', 'middle')
  }
}

/* ---------- orthogonal routing with obstacle avoidance ----------
 * A* over the coordinate grid induced by obstacle rects inflated by
 * AVOID_MARGIN (plus the two anchor stubs). Small scenes → tiny grids;
 * bends are penalized so routes stay calm. Falls back to the classic
 * 1–2 bend route when no clear path exists (e.g. overlapping nodes).
 * The attribute format stays routing-algorithm-neutral: only the emitted
 * path changes. */

export interface Pt { x: number; y: number }

const AVOID_MARGIN = 12
const BEND_PENALTY = 40

/** orthogonal polyline from p1 (leaving via s1) to p2 (arriving via s2) */
export function routeOrtho(
  p1: Pt, s1: Exclude<AnchorSide, 'auto'>,
  p2: Pt, s2: Exclude<AnchorSide, 'auto'>,
  obstacles: NodeGeom[] = [],
): Pt[] {
  const insideOf = (p: Pt, r: Rect) => p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h
  const cores: Rect[] = obstacles.map((g) => ({ x: g.x, y: g.y, w: g.w, h: g.h }))

  // Packed layouts: the endpoint stub shortens until it clears every node
  // core (a neighbor may sit closer than the full margin) …
  const stubFor = (p: Pt, side: Exclude<AnchorSide, 'auto'>): Pt => {
    for (const d of [AVOID_MARGIN, 6, 3, 1]) {
      const s = pushOut(p, side, d)
      if (!cores.some((r) => insideOf(s, r))) return s
    }
    return pushOut(p, side, 0.5) // genuinely overlapping nodes
  }
  const start = stubFor(p1, s1)
  const goal = stubFor(p2, s2)

  // … and avoidance degrades per-obstacle, not wholesale: an obstacle whose
  // margin zone contains a stub shrinks to its core; one whose core contains
  // a stub (overlap) is excluded — every other node keeps the full margin.
  const rects: Rect[] = []
  for (let i = 0; i < obstacles.length; i++) {
    const g = obstacles[i]
    const core = cores[i]
    const inflated: Rect = {
      x: g.x - AVOID_MARGIN, y: g.y - AVOID_MARGIN,
      w: g.w + 2 * AVOID_MARGIN, h: g.h + 2 * AVOID_MARGIN,
    }
    if (!insideOf(start, inflated) && !insideOf(goal, inflated)) rects.push(inflated)
    else if (!insideOf(start, core) && !insideOf(goal, core)) rects.push(core)
  }

  if (rects.length === 0) {
    return simplify([p1, ...fallbackOrtho(start, s1, goal, s2), p2])
  }

  const xs = uniqSorted([start.x, goal.x, ...rects.flatMap((r) => [r.x, r.x + r.w])])
  const ys = uniqSorted([start.y, goal.y, ...rects.flatMap((r) => [r.y, r.y + r.h])])
  const pts = astar(xs, ys, start, goal, rects)
  if (!pts) return simplify([p1, ...fallbackOrtho(start, s1, goal, s2), p2])
  return simplify([p1, ...pts, p2])
}

function pushOut(p: Pt, side: Exclude<AnchorSide, 'auto'>, by: number): Pt {
  switch (side) {
    case 'N': return { x: p.x, y: p.y - by }
    case 'S': return { x: p.x, y: p.y + by }
    case 'E': return { x: p.x + by, y: p.y }
    case 'W': return { x: p.x - by, y: p.y }
  }
}

/** the pre-avoidance 1–2 bend route, kept as the honest fallback */
function fallbackOrtho(
  p1: Pt, s1: Exclude<AnchorSide, 'auto'>,
  p2: Pt, s2: Exclude<AnchorSide, 'auto'>,
): Pt[] {
  const h1 = s1 === 'E' || s1 === 'W'
  const h2 = s2 === 'E' || s2 === 'W'
  if (h1 && h2) {
    const mx = (p1.x + p2.x) / 2
    return [p1, { x: mx, y: p1.y }, { x: mx, y: p2.y }, p2]
  }
  if (!h1 && !h2) {
    const my = (p1.y + p2.y) / 2
    return [p1, { x: p1.x, y: my }, { x: p2.x, y: my }, p2]
  }
  if (h1) return [p1, { x: p2.x, y: p1.y }, p2]
  return [p1, { x: p1.x, y: p2.y }, p2]
}

type Rect = { x: number; y: number; w: number; h: number }

function astar(xs: number[], ys: number[], start: Pt, goal: Pt, rects: Rect[]): Pt[] | null {
  const si = xs.indexOf(start.x), sj = ys.indexOf(start.y)
  const gi = xs.indexOf(goal.x), gj = ys.indexOf(goal.y)
  // state: grid point + incoming axis (0 none, 1 horizontal, 2 vertical)
  const key = (i: number, j: number, dir: number) => (i * ys.length + j) * 3 + dir
  const dist = new Map<number, number>()
  const prev = new Map<number, number>()
  const open: Array<{ k: number; i: number; j: number; dir: number; f: number; g: number }> = []
  const h = (i: number, j: number) => Math.abs(xs[i] - xs[gi]) + Math.abs(ys[j] - ys[gj])
  const push = (k: number, i: number, j: number, dir: number, g: number, from: number) => {
    const known = dist.get(k)
    if (known !== undefined && known <= g) return
    dist.set(k, g)
    prev.set(k, from)
    open.push({ k, i, j, dir, f: g + h(i, j), g })
  }
  push(key(si, sj, 0), si, sj, 0, 0, -1)

  while (open.length > 0) {
    // small grids: linear extract-min is fine
    let bi = 0
    for (let n = 1; n < open.length; n++) if (open[n].f < open[bi].f) bi = n
    const cur = open.splice(bi, 1)[0]
    if (dist.get(cur.k)! < cur.g) continue
    if (cur.i === gi && cur.j === gj) {
      const out: Pt[] = []
      let k: number | undefined = cur.k
      while (k !== undefined && k !== -1) {
        const cell = Math.floor(k / 3)
        out.unshift({ x: xs[Math.floor(cell / ys.length)], y: ys[cell % ys.length] })
        k = prev.get(k)
      }
      return out
    }
    const steps: Array<{ i: number; j: number; dir: number }> = [
      { i: cur.i + 1, j: cur.j, dir: 1 }, { i: cur.i - 1, j: cur.j, dir: 1 },
      { i: cur.i, j: cur.j + 1, dir: 2 }, { i: cur.i, j: cur.j - 1, dir: 2 },
    ]
    for (const s of steps) {
      if (s.i < 0 || s.j < 0 || s.i >= xs.length || s.j >= ys.length) continue
      if (!segmentClear(xs[cur.i], ys[cur.j], xs[s.i], ys[s.j], rects)) continue
      const len = Math.abs(xs[s.i] - xs[cur.i]) + Math.abs(ys[s.j] - ys[cur.j])
      const turn = cur.dir !== 0 && cur.dir !== s.dir ? BEND_PENALTY : 0
      push(key(s.i, s.j, s.dir), s.i, s.j, s.dir, cur.g + len + turn, cur.k)
    }
  }
  return null
}

/** axis-aligned segment (between adjacent grid coords) vs rect interiors */
function segmentClear(x1: number, y1: number, x2: number, y2: number, rects: Rect[]): boolean {
  const lox = Math.min(x1, x2), hix = Math.max(x1, x2)
  const loy = Math.min(y1, y2), hiy = Math.max(y1, y2)
  for (const r of rects) {
    if (lox < r.x + r.w && hix > r.x && loy < r.y + r.h && hiy > r.y) return false
  }
  return true
}

/** drop collinear and duplicate intermediate points */
function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = []
  for (const p of pts) {
    const a = out[out.length - 2], b = out[out.length - 1]
    if (b && b.x === p.x && b.y === p.y) continue
    if (a && b && ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y))) out.pop()
    out.push(p)
  }
  return out
}

function polylineD(pts: Pt[]): string {
  let d = `M${fmt(pts[0].x)},${fmt(pts[0].y)}`
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i], q = pts[i - 1]
    d += p.y === q.y ? ` H${fmt(p.x)}` : p.x === q.x ? ` V${fmt(p.y)}` : ` L${fmt(p.x)},${fmt(p.y)}`
  }
  return d
}

/** point at half the polyline's length — where the label sits */
function polylineMidpoint(pts: Pt[]): Pt {
  let total = 0
  for (let i = 1; i < pts.length; i++) total += Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y)
  let walk = total / 2
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y)
    if (walk <= seg && seg > 0) {
      const t = walk / seg
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t }
    }
    walk -= seg
  }
  return pts[Math.floor(pts.length / 2)] ?? pts[0]
}

function uniqSorted(ns: number[]): number[] {
  return [...new Set(ns.map((n) => Math.round(n * 100) / 100))].sort((a, b) => a - b)
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
