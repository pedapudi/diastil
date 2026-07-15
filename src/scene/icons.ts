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

export type MiscIcon =
  | 'plus-node' | 'del' | 'front' | 'back' | 'anchors' | 'label' | 'ungroup' | 'make-node' | 'points'
  | 'select' | 'pen' | 'rect' | 'ellipse' | 'line' | 'freehand' | 'text'
  | 'circle' | 'square' | 'star' | 'arrow' | 'group' | 'import'
  | 'text-add' | 'drawing-add' | 'storyboard' | 'focus'

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
    case 'points': {
      // a curve with its anchor points exposed
      s.appendChild(pathEl('M2.5,10.5 C6,3 12,12 17.5,4.5', 1.2))
      for (const [cx, cy] of [[2.5, 10.5], [10, 7.6], [17.5, 4.5]]) {
        const c = document.createElementNS(NS, 'circle')
        c.setAttribute('cx', String(cx)); c.setAttribute('cy', String(cy))
        c.setAttribute('r', '1.7')
        c.setAttribute('fill', 'currentColor')
        s.appendChild(c)
      }
      break
    }
    case 'select':
      // the classic pointer
      s.appendChild(pathEl('M8,1.5 L8,11 L10.5,8.5 L12.5,12.5 L14,11.5 L12,7.8 L15.5,7.5 Z', 1.1))
      break
    case 'pen':
      // a nib on its stroke
      s.appendChild(pathEl('M2,12 L6,11 L15,2 L17,4 L8,13 L4,14 Z', 1.05))
      s.appendChild(pathEl('M13,4 L15,6', 0.9))
      break
    case 'rect':
      s.appendChild(pathEl('M3,3 h14 v8 h-14 Z', 1.2))
      break
    case 'ellipse': {
      const e = document.createElementNS(NS, 'ellipse')
      e.setAttribute('cx', '10'); e.setAttribute('cy', '7')
      e.setAttribute('rx', '7'); e.setAttribute('ry', '4.5')
      s.appendChild(stroke(e, 1.2))
      break
    }
    case 'line':
      s.appendChild(pathEl('M3,11.5 L17,2.5', 1.3))
      break
    case 'freehand':
      s.appendChild(pathEl('M2.5,9 C6,3 9,12 12.5,6 S17,7 17.5,4.5', 1.3))
      break
    case 'text':
      s.appendChild(pathEl('M5,3 H15 M10,3 V11.5 M8,11.5 H12', 1.25))
      break
    case 'circle': {
      const c = document.createElementNS(NS, 'circle')
      c.setAttribute('cx', '10'); c.setAttribute('cy', '7'); c.setAttribute('r', '5')
      s.appendChild(stroke(c, 1.2))
      break
    }
    case 'square':
      s.appendChild(pathEl('M5.5,2.5 h9 v9 h-9 Z', 1.2))
      break
    case 'star':
      s.appendChild(pathEl('M10,1.5 L11.8,5.4 L16.2,5.7 L12.8,8.4 L14,12.5 L10,10.2 L6,12.5 L7.2,8.4 L3.8,5.7 L8.2,5.4 Z', 1.05))
      break
    case 'arrow':
      s.appendChild(pathEl('M2,5.5 H10 V3 L17,7 L10,11 V8.5 H2 Z', 1.05))
      break
    case 'group':
      // a dashed container gathering its two pieces
      s.appendChild(dashed(pathEl('M2,2 h16 v10 h-16 Z', 1)))
      s.appendChild(pathEl('M6,5 h8 v4 h-8 Z', 1.3))
      break
    case 'import':
      // artwork dropping into a tray
      s.appendChild(pathEl('M10,1.5 V7.5 M7.5,5.5 L10,8 L12.5,5.5', 1.25))
      s.appendChild(pathEl('M3,9 v3 h14 v-3', 1.2))
      break
    case 'text-add':
      s.appendChild(pathEl('M4,3.5 H11 M7.5,3.5 V11.5', 1.25))
      s.appendChild(pathEl('M14.5,6 V11 M12,8.5 H17', 1.2))
      break
    case 'drawing-add':
      // a frame with a stroke being drawn into it
      s.appendChild(pathEl('M2.5,2.5 h15 v9 h-15 Z', 1.05))
      s.appendChild(pathEl('M5,9.5 C7.5,5 10,10 12.5,6 S15.5,7 15.5,5.5', 1.2))
      break
    case 'storyboard':
      // moment frames, filling left to right
      s.appendChild(pathEl('M2,3.5 h4.4 v7 h-4.4 Z', 1.1))
      s.appendChild(pathEl('M7.8,3.5 h4.4 v7 h-4.4 Z', 1.1))
      s.appendChild(dashed(pathEl('M13.6,3.5 h4.4 v7 h-4.4 Z', 1.1)))
      break
    case 'focus':
      // viewfinder corners around a slide
      s.appendChild(pathEl('M2,5 V2.5 H5 M15,2.5 H18 V5 M18,9 V11.5 H15 M5,11.5 H2 V9', 1.2))
      s.appendChild(pathEl('M7,5.5 h6 v3 h-6 Z', 1))
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
