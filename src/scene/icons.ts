/* Inline SVG iconography for the floating scene toolbars — stroke-only,
 * currentColor, so icons follow the button's own ink (including the
 * accent-filled .dn-on state). Shape icons are TRUE previews: their
 * outlines come from the same shapePathD geometry the renderer uses. */

import type { EdgeRoute, NodeGeom, NodeShape } from '../types'
import { shapePathD } from './route'

const NS = 'http://www.w3.org/2000/svg'
/** icon-box geometry the shape outlines are generated into */
const G: NodeGeom = { x: 2.5, y: 2, w: 15, h: 10 }

function svg(): SVGSVGElement {
  const s = document.createElementNS(NS, 'svg') as SVGSVGElement
  s.setAttribute('viewBox', '0 0 20 14')
  s.setAttribute('class', 'dia-tb-icon')
  s.setAttribute('aria-hidden', 'true')
  return s
}

function stroke<T extends SVGElement>(el: T, w = 1.3): T {
  el.setAttribute('fill', 'none')
  el.setAttribute('stroke', 'currentColor')
  el.setAttribute('stroke-width', String(w))
  el.setAttribute('stroke-linejoin', 'round')
  el.setAttribute('stroke-linecap', 'round')
  return el
}

function pathEl(d: string, w = 1.3): SVGPathElement {
  const p = document.createElementNS(NS, 'path')
  p.setAttribute('d', d)
  return stroke(p, w)
}

function dashed<T extends SVGElement>(el: T): T {
  el.setAttribute('stroke-dasharray', '2 1.6')
  return el
}

export function shapeIcon(shape: NodeShape): SVGSVGElement {
  const s = svg()
  if (shape === 'rect' || shape === 'rounded' || shape === 'pill') {
    const r = document.createElementNS(NS, 'rect')
    r.setAttribute('x', String(G.x)); r.setAttribute('y', String(G.y))
    r.setAttribute('width', String(G.w)); r.setAttribute('height', String(G.h))
    r.setAttribute('rx', shape === 'pill' ? String(G.h / 2) : shape === 'rounded' ? '2.5' : '0')
    s.appendChild(stroke(r))
  } else if (shape === 'ellipse') {
    const e = document.createElementNS(NS, 'ellipse')
    e.setAttribute('cx', String(G.x + G.w / 2)); e.setAttribute('cy', String(G.y + G.h / 2))
    e.setAttribute('rx', String(G.w / 2)); e.setAttribute('ry', String(G.h / 2))
    s.appendChild(stroke(e))
  } else {
    s.appendChild(pathEl(shapePathD(shape, G)))
  }
  return s
}

export function routeIcon(route: EdgeRoute): SVGSVGElement {
  const s = svg()
  const d =
    route === 'straight' ? 'M2.5,11.5 L17.5,2.5' :
    route === 'curve' ? 'M2.5,11.5 C8,11.5 12,2.5 17.5,2.5' :
    'M2.5,11.5 H10 V2.5 H17.5'
  s.appendChild(pathEl(d))
  return s
}

export function widthIcon(name: string): SVGSVGElement {
  const s = svg()
  const p = pathEl('M3,7 H17', name === '1' ? 1 : name === '2' ? 2 : name === '3' ? 3 : 1.3)
  if (name === 'auto' || name === 'keep') p.setAttribute('stroke-dasharray', '2.5 2')
  s.appendChild(p)
  return s
}

export type MiscIcon = 'plus-node' | 'del' | 'front' | 'back' | 'anchors' | 'label' | 'ungroup' | 'make-node'

export function miscIcon(name: MiscIcon): SVGSVGElement {
  const s = svg()
  switch (name) {
    case 'plus-node':
      // stub into a node carrying a plus — "spawn a connected node"
      s.appendChild(pathEl('M1.5,7 H6.5'))
      s.appendChild(pathEl('M6.5,3.5 h9 a1.5,1.5 0 0 1 1.5,1.5 v4 a1.5,1.5 0 0 1 -1.5,1.5 h-9 a1.5,1.5 0 0 1 -1.5,-1.5 v-4 a1.5,1.5 0 0 1 1.5,-1.5 Z'))
      s.appendChild(pathEl('M11,5 V9 M9,7 H13', 1.2))
      break
    case 'del':
      s.appendChild(pathEl('M6,3 L14,11 M14,3 L6,11'))
      break
    case 'front':
      s.appendChild(pathEl('M8,5.5 h8 v6 h-8 Z', 0.9))
      s.appendChild(pathEl('M4,2.5 h8 v6 h-8 Z', 1.7))
      break
    case 'back':
      s.appendChild(pathEl('M4,2.5 h8 v6 h-8 Z', 0.9))
      s.appendChild(pathEl('M8,5.5 h8 v6 h-8 Z', 1.7))
      break
    case 'label':
      // a connector with its annotation tag above the midpoint
      s.appendChild(pathEl('M1.5,11 H18.5'))
      s.appendChild(pathEl('M6,3 h8 v4.5 h-8 Z', 1.1))
      break
    case 'ungroup':
      // a dashed container releasing its two pieces
      s.appendChild(dashed(pathEl('M2,2 h16 v10 h-16 Z', 1)))
      s.appendChild(pathEl('M5,5 h4 v4 h-4 Z', 1.3))
      s.appendChild(pathEl('M11,5 h4 v4 h-4 Z', 1.3))
      break
    case 'make-node':
      // freeform mark gaining a node box around it
      s.appendChild(pathEl('M3,2.5 h14 a1.5,1.5 0 0 1 1.5,1.5 v6 a1.5,1.5 0 0 1 -1.5,1.5 h-14 a1.5,1.5 0 0 1 -1.5,-1.5 v-6 a1.5,1.5 0 0 1 1.5,-1.5 Z', 1.1))
      s.appendChild(pathEl('M5,9 C7,4 9,10 11,5 S15,8 15.5,5.5', 1.3))
      break
    case 'anchors': {
      s.appendChild(pathEl('M5.5,4 h9 v6 h-9 Z', 1))
      for (const [cx, cy] of [[10, 4], [10, 10], [5.5, 7], [14.5, 7]]) {
        const c = document.createElementNS(NS, 'circle')
        c.setAttribute('cx', String(cx)); c.setAttribute('cy', String(cy))
        c.setAttribute('r', '1.4')
        c.setAttribute('fill', 'currentColor')
        s.appendChild(c)
      }
      break
    }
  }
  return s
}

/** color chip for fill/ink options; token refs resolve against `context`
 * (deck tokens live inside the deck shadow root, not on the chrome root).
 * '' = auto/keep (dashed, theme decides) · none/transparent = slashed. */
export function swatch(cssValue: string, context: Element): HTMLSpanElement {
  const chip = document.createElement('span')
  chip.className = 'dia-tb-swatch'
  if (cssValue === '') {
    chip.classList.add('is-auto')
  } else if (cssValue === 'none' || cssValue === 'transparent') {
    chip.classList.add('is-none')
  } else {
    const m = /^var\((--[a-z0-9-]+)\)$/i.exec(cssValue)
    const resolved = m
      ? getComputedStyle(context).getPropertyValue(m[1]).trim() || cssValue
      : cssValue
    chip.style.background = resolved
  }
  return chip
}
