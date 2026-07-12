/* Compile serializable ProposedOp objects from the dia service into real Ops.
 * Every compiled op is authored 'copilot' so it reads honestly in the op log.
 * Unknown actions or missing targets are skipped with a console.warn — a bad
 * proposal must never throw and never take the editor down. */

import type { NodeGeom, Op, ProposedOp } from '../types'
import { state } from '../state'
import {
  insertEl, moveSceneNode, removeEl, setAttr, setStyleProp, setText, setToken,
} from '../model/ops'
import { findNode, routeEdge } from '../scene/route'

const BY = 'copilot' as const

export function compileOps(proposed: ProposedOp[]): Op[] {
  const ops: Op[] = []
  for (const p of proposed) {
    try {
      const op = compileOne(p)
      if (op) ops.push(op)
      else console.warn('[copilot] skipped proposal (target not found):', p)
    } catch (err) {
      console.warn('[copilot] skipped proposal (compile error):', p, err)
    }
  }
  return ops
}

function compileOne(p: ProposedOp): Op | null {
  const deck = state.deck
  if (!deck) return null

  switch (p.action) {
    case 'set-text': {
      const el = findEl(p.target)
      if (!el || p.value === undefined) return null
      return setText(el, p.value, BY)
    }

    case 'set-token': {
      if (p.value === undefined) return null
      return setToken(deck.themeStyle, p.target, p.value, BY)
    }

    case 'set-style': {
      const el = findEl(p.target)
      const prop = str(p.extra?.prop)
      if (!el || !prop || p.value === undefined) return null
      return setStyleProp(el, prop, p.value, BY)
    }

    case 'insert-html': {
      const parent = findEl(p.target)
      if (!parent || p.value === undefined) return null
      const el = parseFragment(p.value)
      if (!el) return null
      const index = clampIndex(num(p.extra?.index), parent.children.length)
      return insertEl(parent, index, el, p.label, BY)
    }

    case 'remove': {
      const el = findEl(p.target)
      if (!el) return null
      return removeEl(el, p.label, BY)
    }

    case 'move-node': {
      const scene = findScene(num(p.extra?.slide))
      if (!scene) return null
      const node = findNode(scene, p.target)
      if (!node) return null
      const geom: NodeGeom = {
        x: num(p.extra?.x, NaN), y: num(p.extra?.y, NaN),
        w: num(p.extra?.w, NaN), h: num(p.extra?.h, NaN),
      }
      const prev = nodeGeomFallback(node)
      const next: NodeGeom = {
        x: Number.isFinite(geom.x) ? geom.x : prev.x,
        y: Number.isFinite(geom.y) ? geom.y : prev.y,
        w: Number.isFinite(geom.w) ? geom.w : prev.w,
        h: Number.isFinite(geom.h) ? geom.h : prev.h,
      }
      return moveSceneNode(scene, node, next, BY)
    }

    case 'insert-edge': {
      const scene = findScene(num(p.extra?.slide))
      if (!scene) return null
      const ref = /^(.+?)->(.+)$/.exec(p.target)
      if (!ref || !findNode(scene, ref[1]) || !findNode(scene, ref[2])) return null
      const edge = buildEdge(ref[1], ref[2], str(p.extra?.label))
      const inner = insertEl(scene, scene.children.length, edge, p.label, BY)
      // wrap so the freshly inserted edge gets routed as part of apply
      return {
        label: p.label,
        author: BY,
        apply() { inner.apply(); routeEdge(scene, edge) },
        invert() { return inner.invert() },
      }
    }

    case 'retarget-edge': {
      const scene = findScene(num(p.extra?.slide))
      if (!scene || p.value === undefined) return null
      const edge = scene.querySelector<SVGGElement>(
        `g[data-dia-edge="${cssEscape(p.target)}"]`,
      )
      if (!edge) return null
      const next = /^(.+?)->(.+)$/.exec(p.value)
      if (!next || !findNode(scene, next[1]) || !findNode(scene, next[2])) return null
      return retargetEdgeOp(scene, edge, p.value, p.label)
    }

    default:
      console.warn('[copilot] unknown proposed action:', (p as ProposedOp).action)
      return null
  }
}

/** setAttr on data-dia-edge wrapped so apply/invert both reroute the edge */
function retargetEdgeOp(scene: SVGSVGElement, edge: SVGGElement, value: string, label: string): Op {
  const prev = edge.getAttribute('data-dia-edge') ?? ''
  const attr = setAttr(edge, 'data-dia-edge', value, BY)
  return {
    label,
    author: BY,
    apply() { attr.apply(); routeEdge(scene, edge) },
    invert() { return retargetEdgeOp(scene, edge, prev, `un-${label}`) },
  }
}

/* ---------- lookup helpers ---------- */

/** find an element by data-dia-id; fall back to treating target as a selector */
function findEl(target: string): HTMLElement | null {
  const root = state.deck?.root
  if (!root || !target) return null
  const byId = root.querySelector<HTMLElement>(`[data-dia-id="${cssEscape(target)}"]`)
  if (byId) return byId
  try { return root.querySelector<HTMLElement>(target) } catch { return null }
}

function findScene(slideIndex: number): SVGSVGElement | null {
  const slides = state.slides()
  const slide = slides[Number.isFinite(slideIndex) ? slideIndex : state.currentSlide]
  return slide?.querySelector<SVGSVGElement>('svg.dia-scene') ?? null
}

function nodeGeomFallback(node: SVGGElement): NodeGeom {
  const n = (a: string, f: number) => {
    const v = parseFloat(node.getAttribute(a) ?? '')
    return Number.isFinite(v) ? v : f
  }
  return { x: n('data-x', 0), y: n('data-y', 0), w: n('data-w', 120), h: n('data-h', 40) }
}

/* ---------- construction helpers ---------- */

const SVG_NS = 'http://www.w3.org/2000/svg'

/** detached scene-edge <g>; routed after insertion */
function buildEdge(from: string, to: string, label?: string): SVGGElement {
  const g = document.createElementNS(SVG_NS, 'g') as SVGGElement
  g.setAttribute('data-dia-edge', `${from}->${to}`)
  g.setAttribute('data-anchors', 'auto,auto')
  g.setAttribute('data-route', 'ortho')
  if (label) {
    const t = document.createElementNS(SVG_NS, 'text')
    t.setAttribute('class', 'dia-edge-label')
    t.textContent = label
    g.appendChild(t)
  }
  return g
}

function parseFragment(html: string): Element | null {
  const tpl = document.createElement('template')
  tpl.innerHTML = html.trim()
  return tpl.content.firstElementChild
}

/* ---------- small utils ---------- */

function str(v: string | number | undefined): string | undefined {
  return v === undefined ? undefined : String(v)
}
function num(v: string | number | undefined, fallback = NaN): number {
  const n = typeof v === 'number' ? v : parseFloat(v ?? '')
  return Number.isFinite(n) ? n : fallback
}
function clampIndex(i: number, len: number): number {
  return Number.isFinite(i) ? Math.max(0, Math.min(Math.trunc(i), len)) : len
}
function cssEscape(s: string): string { return s.replace(/["\\]/g, '\\$&') }
