/* Orthogonal routing — pure geometry, exercised directly. Every produced
 * segment must be axis-aligned; routes detour around obstacle rects
 * (inflated by the routing margin) instead of crossing them. */

import { describe, expect, it } from 'vitest'
import { routeOrtho, type Pt } from './route'
import type { NodeGeom } from '../types'

const MARGIN = 12 // must match AVOID_MARGIN in route.ts

function crossesInflated(pts: Pt[], g: NodeGeom): boolean {
  const r = { x: g.x - MARGIN, y: g.y - MARGIN, w: g.w + 2 * MARGIN, h: g.h + 2 * MARGIN }
  for (let i = 1; i < pts.length; i++) {
    const lox = Math.min(pts[i - 1].x, pts[i].x), hix = Math.max(pts[i - 1].x, pts[i].x)
    const loy = Math.min(pts[i - 1].y, pts[i].y), hiy = Math.max(pts[i - 1].y, pts[i].y)
    if (lox < r.x + r.w && hix > r.x && loy < r.y + r.h && hiy > r.y) return true
  }
  return false
}

function assertOrthogonal(pts: Pt[]): void {
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x
    const dy = pts[i].y - pts[i - 1].y
    expect(dx === 0 || dy === 0, `segment ${i} is diagonal`).toBe(true)
  }
}

describe('routeOrtho', () => {
  const p1: Pt = { x: 100, y: 50 } // leaving E
  const p2: Pt = { x: 300, y: 50 } // arriving W

  it('open corridor: calm 1–2 bend route, endpoints exact', () => {
    const pts = routeOrtho(p1, 'E', p2, 'W', [])
    expect(pts[0]).toEqual(p1)
    expect(pts[pts.length - 1]).toEqual(p2)
    assertOrthogonal(pts)
    expect(pts.length).toBeLessThanOrEqual(4)
  })

  it('detours around an obstacle sitting on the direct line', () => {
    const wall: NodeGeom = { x: 180, y: 20, w: 40, h: 60 } // spans the corridor
    const pts = routeOrtho(p1, 'E', p2, 'W', [wall])
    expect(pts[0]).toEqual(p1)
    expect(pts[pts.length - 1]).toEqual(p2)
    assertOrthogonal(pts)
    expect(crossesInflated(pts, wall)).toBe(false)
  })

  it('threads between two obstacles when a gap exists', () => {
    const top: NodeGeom = { x: 180, y: -100, w: 40, h: 100 }
    const bottom: NodeGeom = { x: 180, y: 100, w: 40, h: 100 }
    const pts = routeOrtho(p1, 'E', p2, 'W', [top, bottom])
    assertOrthogonal(pts)
    expect(crossesInflated(pts, top)).toBe(false)
    expect(crossesInflated(pts, bottom)).toBe(false)
  })

  it('vertical anchors route around a horizontal wall', () => {
    const a: Pt = { x: 100, y: 100 } // leaving S
    const b: Pt = { x: 100, y: 400 } // arriving N
    const wall: NodeGeom = { x: 0, y: 220, w: 180, h: 40 }
    const pts = routeOrtho(a, 'S', b, 'N', [wall])
    expect(pts[0]).toEqual(a)
    expect(pts[pts.length - 1]).toEqual(b)
    assertOrthogonal(pts)
    expect(crossesInflated(pts, wall)).toBe(false)
  })

  it('falls back gracefully when an obstacle swallows an anchor stub', () => {
    // obstacle overlapping p1's push-out point: no clean grid start exists
    const hugger: NodeGeom = { x: 95, y: 40, w: 30, h: 20 }
    const pts = routeOrtho(p1, 'E', p2, 'W', [hugger])
    expect(pts[0]).toEqual(p1)
    expect(pts[pts.length - 1]).toEqual(p2)
    assertOrthogonal(pts)
  })

  it('packed layout: a stub inside a NEIGHBOR margin degrades to core avoidance, not cut-through', () => {
    // wall sits 8px right of p1's node edge — inside the 12px margin, so the
    // start stub lands in the wall's inflated rect. The route must still
    // avoid the wall's CORE instead of slicing through it.
    const wall: NodeGeom = { x: 108, y: -50, w: 40, h: 200 }
    const pts = routeOrtho(p1, 'E', p2, 'W', [wall])
    expect(pts[0]).toEqual(p1)
    expect(pts[pts.length - 1]).toEqual(p2)
    assertOrthogonal(pts)
    // no segment may cross the core interior
    for (let i = 1; i < pts.length; i++) {
      const lox = Math.min(pts[i - 1].x, pts[i].x), hix = Math.max(pts[i - 1].x, pts[i].x)
      const loy = Math.min(pts[i - 1].y, pts[i].y), hiy = Math.max(pts[i - 1].y, pts[i].y)
      const crossesCore = lox < wall.x + wall.w && hix > wall.x && loy < wall.y + wall.h && hiy > wall.y
      expect(crossesCore, `segment ${i} slices the packed neighbor`).toBe(false)
    }
  })
})

/* ---------- node shape rendering (happy-dom) ---------- */

import { createNode, renderNodeShape, shapePathD } from './route'
import type { NodeShape } from '../types'

function sceneEl(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGSVGElement
  svg.setAttribute('class', 'dia-scene')
  svg.setAttribute('viewBox', '0 0 400 300')
  document.body.appendChild(svg)
  return svg
}

describe('renderNodeShape', () => {
  const g: NodeGeom = { x: 10, y: 20, w: 120, h: 60 }

  it.each([
    ['rect', 'rect'], ['rounded', 'rect'], ['pill', 'rect'], ['ellipse', 'ellipse'],
    ['diamond', 'path'], ['cylinder', 'path'], ['hex', 'path'], ['parallelogram', 'path'],
    ['triangle', 'path'], ['cloud', 'path'], ['note', 'path'],
  ] as [NodeShape, string][])('%s renders as <%s>', (shape, tag) => {
    const scene = sceneEl()
    const node = createNode(scene, 'n', g, 'label', shape)
    const el = node.querySelector('.dia-node-shape')!
    expect(el.tagName).toBe(tag)
    if (tag === 'path') {
      const d = el.getAttribute('d') ?? ''
      expect(d.startsWith('M')).toBe(true)
      // every coordinate stays within the node box (small epsilon for fmt
      // rounding) — skipped for arc shapes, where A rx,ry pairs are radii
      for (const m of d.includes('A') ? [] : d.matchAll(/(-?\d+\.?\d*),(-?\d+\.?\d*)/g)) {
        expect(Number(m[1])).toBeGreaterThanOrEqual(g.x - 0.01)
        expect(Number(m[1])).toBeLessThanOrEqual(g.x + g.w + 0.01)
        expect(Number(m[2])).toBeGreaterThanOrEqual(g.y - 0.01)
        expect(Number(m[2])).toBeLessThanOrEqual(g.y + g.h + 0.01)
      }
    }
    scene.remove()
  })

  it('path shape scales data-path into the box and keeps stroke width constant', () => {
    const scene = sceneEl()
    const node = createNode(scene, 'ring', g, '', 'path')
    node.setAttribute('data-path', 'M10,50 A40,40 0 1 1 90,50 A40,40 0 1 1 10,50 Z')
    renderNodeShape(node)
    const el = node.querySelector('.dia-node-shape')!
    expect(el.getAttribute('d')).toContain('A40,40')
    expect(el.getAttribute('transform')).toBe('translate(10,20) scale(1.2,0.6)')
    expect(el.getAttribute('vector-effect')).toBe('non-scaling-stroke')
    scene.remove()
  })

  it('re-rendering after a shape change swaps the element tag', () => {
    const scene = sceneEl()
    const node = createNode(scene, 'n2', g, 'db', 'rect')
    expect(node.querySelector('.dia-node-shape')!.tagName).toBe('rect')
    node.setAttribute('data-shape', 'cylinder')
    renderNodeShape(node)
    expect(node.querySelector('.dia-node-shape')!.tagName).toBe('path')
    scene.remove()
  })

  it('shapePathD outlines close (Z) for fillable shapes', () => {
    for (const shape of ['diamond', 'hex', 'parallelogram', 'triangle', 'cloud', 'note', 'cylinder'] as NodeShape[]) {
      expect(shapePathD(shape, g)).toContain('Z')
    }
  })
})
