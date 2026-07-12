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
})
