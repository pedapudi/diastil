/* Deterministic SVG → scene lift.
 *
 * Import-time promotion of simple vector shapes into editable scene nodes —
 * no model, no inference, exactness or nothing. Each liftable shape element
 * becomes a `g[data-dia-node]` IN PLACE (document order, and therefore
 * z-order, preserved); everything else — text, lines with markers,
 * transformed subtrees, defs — stays verbatim, which the scene vocabulary
 * allows (free elements). Edges and labels are semantic and stay the LLM
 * lift's job; this pass only makes the geometry editable.
 *
 * Exactness contract: a lifted node re-renders (via renderNodeShape) to the
 * same pixels as the source shape, within fmt rounding (≤0.01 viewBox units,
 * plus ≤0.005 normalized units for freeform paths). Anything that cannot
 * meet that — rotated arcs, non-solid paint we can't carry, markers,
 * filters, clip paths — is left untouched. */

import { renderNodeShape } from '../scene/route'
import type { NodeGeom, NodeShape } from '../types'

/** more nodes than this and the svg is a chart, not a diagram — leave it */
const LIFT_MAX_SHAPES = 60
/** skip shapes smaller than this in either dimension (hairlines, dots) */
const MIN_SIZE = 0.5

const NON_RENDERED = new Set([
  'defs', 'marker', 'clipPath', 'mask', 'pattern', 'symbol',
  'linearGradient', 'radialGradient', 'filter', 'metadata', 'title', 'desc',
])
const SHAPE_TAGS = new Set(['rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line', 'path'])
/** attributes whose presence means regenerating the element loses paint */
const BLOCKING_ATTRS = ['marker-start', 'marker-mid', 'marker-end', 'filter', 'clip-path', 'mask', 'transform']
/** inline style props carried onto the node group verbatim (they inherit
 * into the derived shape; no theme rule overrides them) */
const CARRY_PROPS = [
  'opacity', 'fill-opacity', 'stroke-opacity', 'stroke-dasharray',
  'stroke-linecap', 'stroke-linejoin', 'fill-rule',
]

interface Lift {
  el: Element
  shape: NodeShape
  geom: NodeGeom
  path?: string
}

/** Lift every provably-exact shape in the svg into a scene node, in place.
 * Returns the number of lifted shapes; 0 leaves the svg untouched. */
export function liftSimpleSvg(svg: SVGSVGElement): number {
  if (!svg.hasAttribute('viewBox')) return 0
  if (svg.querySelector('[data-dia-node], [data-dia-edge]')) return 0 // already a scene
  const shapes: Element[] = []
  collectShapes(svg, shapes)
  if (shapes.length === 0 || shapes.length > LIFT_MAX_SHAPES) return 0
  const lifts = shapes.map(analyze).filter((l): l is Lift => l !== null)
  if (lifts.length === 0) return 0

  let seq = 1
  for (const lift of lifts) {
    const g = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'g') as SVGGElement
    g.setAttribute('data-dia-node', `s${seq++}`)
    g.setAttribute('data-shape', lift.shape)
    if (lift.path) g.setAttribute('data-path', lift.path)
    g.setAttribute('data-x', fmt(lift.geom.x))
    g.setAttribute('data-y', fmt(lift.geom.y))
    g.setAttribute('data-w', fmt(lift.geom.w))
    g.setAttribute('data-h', fmt(lift.geom.h))
    g.setAttribute('style', nodeStyle(lift.el))
    lift.el.replaceWith(g)
    renderNodeShape(g)
  }
  svg.classList.add('dia-scene')
  return lifts.length
}

/** rendered shape elements not under defs-like or transformed containers */
function collectShapes(root: Element, out: Element[]): void {
  for (const child of root.children) {
    const tag = child.tagName
    if (NON_RENDERED.has(tag)) continue
    if (child.hasAttribute('transform')) continue // geometry we won't resolve
    if (SHAPE_TAGS.has(tag)) out.push(child)
    else if (tag === 'g') collectShapes(child, out)
  }
}

function analyze(el: Element): Lift | null {
  for (const a of BLOCKING_ATTRS) if (el.getAttribute(a)) return null
  const style = (el as SVGElement).style
  if (style.clipPath || style.filter || style.markerEnd || style.markerStart || style.markerMid) return null
  const attr = (n: string, fallback = 0) => {
    const v = parseFloat(el.getAttribute(n) ?? '')
    return Number.isFinite(v) ? v : fallback
  }
  switch (el.tagName) {
    case 'rect': {
      const w = attr('width'), h = attr('height')
      if (w < MIN_SIZE || h < MIN_SIZE) return null
      const geom = { x: attr('x'), y: attr('y'), w, h }
      const rx = Math.min(attr('rx', attr('ry')), w / 2)
      const ry = Math.min(attr('ry', attr('rx')), h / 2)
      if (rx !== ry) return null // elliptical corners — renderer can't reproduce
      if (rx === 0) return { el, shape: 'rect', geom }
      if (rx === 6) return { el, shape: 'rounded', geom }
      if (rx >= h / 2 && h <= w) return { el, shape: 'pill', geom }
      return { el, shape: 'path', geom, path: roundedRectPath(rx / (w / 100), rx / (h / 100)) }
    }
    case 'circle': {
      const r = attr('r')
      if (r * 2 < MIN_SIZE) return null
      return { el, shape: 'ellipse', geom: { x: attr('cx') - r, y: attr('cy') - r, w: 2 * r, h: 2 * r } }
    }
    case 'ellipse': {
      const rx = attr('rx'), ry = attr('ry')
      if (rx * 2 < MIN_SIZE || ry * 2 < MIN_SIZE) return null
      return { el, shape: 'ellipse', geom: { x: attr('cx') - rx, y: attr('cy') - ry, w: 2 * rx, h: 2 * ry } }
    }
    case 'polygon':
    case 'polyline': {
      const pts = parsePoints(el.getAttribute('points') ?? '')
      if (!pts || pts.length < 3) return null
      return pathLift(el, polyCmds(pts, el.tagName === 'polygon'))
    }
    case 'line': {
      const cmds: Cmd[] = [
        { c: 'M', args: [attr('x1'), attr('y1')] },
        { c: 'L', args: [attr('x2'), attr('y2')] },
      ]
      return pathLift(el, cmds)
    }
    case 'path': {
      const cmds = parsePathData(el.getAttribute('d') ?? '')
      return cmds ? pathLift(el, cmds) : null
    }
  }
  return null
}

/** freeform lift: bbox from the absolute command hull, path normalized 100×100 */
function pathLift(el: Element, cmds: Cmd[]): Lift | null {
  const box = cmdsBbox(cmds)
  if (!box || box.w < MIN_SIZE || box.h < MIN_SIZE) return null
  return {
    el,
    shape: 'path',
    geom: box,
    path: normalizeCmds(cmds, box),
  }
}

/* ---------------- node styling ---------------- */

/** Scene nodes paint through scoped custom properties (theme rules consume
 * them). The source's computed paint was inlined at snapshot time; missing
 * props mean the SVG defaults (fill black, no stroke). */
function nodeStyle(el: Element): string {
  const s = (el as SVGElement).style
  const parts = [
    `--dia-node-fill: ${s.fill || '#000'}`,
    `--dia-node-stroke: ${s.stroke || 'none'}`,
    `--dia-node-stroke-w: ${s.strokeWidth || '1'}`,
  ]
  for (const p of CARRY_PROPS) {
    const v = s.getPropertyValue(p)
    if (v) parts.push(`${p}: ${v}`)
  }
  return parts.join('; ')
}

/* ---------------- path data ---------------- */

interface Cmd { c: string; args: number[] }

const ARG_COUNT: Record<string, number> = {
  M: 2, L: 2, T: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, A: 7, Z: 0,
}

/** Parse path data into ABSOLUTE commands. Returns null for anything not
 * exactly liftable (rotated arcs, malformed data). */
export function parsePathData(d: string): Cmd[] | null {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g)
  if (!tokens || !/^[Mm]$/.test(tokens[0])) return null
  const out: Cmd[] = []
  let x = 0, y = 0, startX = 0, startY = 0
  let i = 0
  let cmd = ''
  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) cmd = tokens[i++]
    else if (!cmd) return null
    const upper = cmd.toUpperCase()
    const rel = cmd !== upper
    const n = ARG_COUNT[upper]
    if (n === undefined) return null
    if (upper === 'Z') {
      out.push({ c: 'Z', args: [] })
      x = startX; y = startY
      continue
    }
    const args = tokens.slice(i, i + n).map(Number)
    if (args.length < n || args.some((v) => !Number.isFinite(v))) return null
    i += n
    switch (upper) {
      case 'H':
        args[0] += rel ? x : 0; x = args[0]
        break
      case 'V':
        args[0] += rel ? y : 0; y = args[0]
        break
      case 'A':
        if (args[2] !== 0) return null // rotated arc — not exact under per-axis scaling
        if (rel) { args[5] += x; args[6] += y }
        x = args[5]; y = args[6]
        break
      default:
        // coordinate pairs throughout
        if (rel) for (let k = 0; k < n; k += 2) { args[k] += x; args[k + 1] += y }
        x = args[n - 2]; y = args[n - 1]
    }
    if (upper === 'M') { startX = x; startY = y }
    out.push({ c: upper, args })
    // implicit repeats: M continues as L
    if (upper === 'M') cmd = rel ? 'l' : 'L'
  }
  return out
}

/** hull of every coordinate; arcs padded by their radii (over-estimate is
 * safe — the box need not be tight, only round-trip-stable) */
function cmdsBbox(cmds: Cmd[]): NodeGeom | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const take = (px: number, py: number) => {
    minX = Math.min(minX, px); maxX = Math.max(maxX, px)
    minY = Math.min(minY, py); maxY = Math.max(maxY, py)
  }
  let x = 0, y = 0
  for (const { c, args } of cmds) {
    switch (c) {
      case 'H': take(args[0], y); x = args[0]; break
      case 'V': take(x, args[0]); y = args[0]; break
      case 'A':
        take(x - args[0], y - args[1]); take(x + args[0], y + args[1])
        take(args[5] - args[0], args[6] - args[1]); take(args[5] + args[0], args[6] + args[1])
        x = args[5]; y = args[6]
        break
      case 'Z': break
      default:
        for (let k = 0; k < args.length; k += 2) take(args[k], args[k + 1])
        x = args[args.length - 2]; y = args[args.length - 1]
    }
  }
  if (!Number.isFinite(minX)) return null
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** map absolute commands into the 100×100 box space */
function normalizeCmds(cmds: Cmd[], box: NodeGeom): string {
  const sx = 100 / box.w, sy = 100 / box.h
  const nx = (v: number) => fmtN((v - box.x) * sx)
  const ny = (v: number) => fmtN((v - box.y) * sy)
  const out: string[] = []
  for (const { c, args } of cmds) {
    switch (c) {
      case 'Z': out.push('Z'); break
      case 'H': out.push(`H${nx(args[0])}`); break
      case 'V': out.push(`V${ny(args[0])}`); break
      case 'A':
        out.push(`A${fmtN(args[0] * sx)},${fmtN(args[1] * sy)} 0 ${args[3]} ${args[4]} ${nx(args[5])},${ny(args[6])}`)
        break
      default: {
        const pairs: string[] = []
        for (let k = 0; k < args.length; k += 2) pairs.push(`${nx(args[k])},${ny(args[k + 1])}`)
        out.push(`${c}${pairs.join(' ')}`)
      }
    }
  }
  return out.join(' ')
}

function polyCmds(pts: number[][], close: boolean): Cmd[] {
  const cmds: Cmd[] = [{ c: 'M', args: pts[0] }]
  for (let i = 1; i < pts.length; i++) cmds.push({ c: 'L', args: pts[i] })
  if (close) cmds.push({ c: 'Z', args: [] })
  return cmds
}

function parsePoints(points: string): number[][] | null {
  const ns = points.trim().split(/[\s,]+/).map(Number)
  if (ns.length < 4 || ns.length % 2 !== 0 || ns.some((n) => !Number.isFinite(n))) return null
  const out: number[][] = []
  for (let i = 0; i < ns.length; i += 2) out.push([ns[i], ns[i + 1]])
  return out
}

/** rounded rect in normalized space; radii already normalized per axis */
export function roundedRectPath(rx: number, ry: number): string {
  const x = fmtN(rx), y = fmtN(ry)
  return (
    `M${x},0 H${fmtN(100 - rx)} A${x},${y} 0 0 1 100,${y} V${fmtN(100 - ry)} ` +
    `A${x},${y} 0 0 1 ${fmtN(100 - rx)},100 H${x} A${x},${y} 0 0 1 0,${fmtN(100 - ry)} ` +
    `V${y} A${x},${y} 0 0 1 ${x},0 Z`
  )
}

function fmt(n: number): string { return String(Math.round(n * 100) / 100) }
function fmtN(n: number): string { return String(Math.round(n * 1000) / 1000) }
