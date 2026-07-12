/* Contextual scene toolbar: a floating .dn-panel above the current scene
 * selection. Node: shape segment, "+ node", delete. Edge: route segment,
 * anchors reset, delete. Hidden while dragging; repositions on scroll/resize. */

import type { EdgeRoute, NodeShape } from '../types'
import { state } from '../state'
import { getShape } from './route'
import { deleteSceneSelection, setAnchorsOp, setRouteOp, setShapeOp, spawnConnectedNode } from './interact'

const SHAPES: [NodeShape, string][] = [
  ['rect', 'rect'], ['rounded', 'rnd'], ['pill', 'pill'], ['ellipse', 'ell'], ['diamond', 'diam'],
]
const ROUTES: [EdgeRoute, string][] = [
  ['straight', 'line'], ['ortho', 'orth'], ['curve', 'curve'],
]

let bar: HTMLDivElement | null = null
let suppressed = false
let attached = false

export function attachToolbar(): void {
  if (attached) return
  attached = true
  state.bus.on((e) => {
    if (
      e.type === 'selection' || e.type === 'op' || e.type === 'undo' ||
      e.type === 'redo' || e.type === 'altitude' || e.type === 'deck-loaded'
    ) refresh()
  })
  window.addEventListener('scroll', position, true)
  window.addEventListener('resize', position)
}

/** hide the toolbar during live drags (interact drives this) */
export function setToolbarSuppressed(on: boolean): void {
  if (suppressed === on) return
  suppressed = on
  refresh()
}

/* ---------------------------------------------------------------- render */

function ensureBar(): HTMLDivElement {
  if (!bar) {
    bar = document.createElement('div')
    bar.className = 'dn-panel dia-scene-toolbar'
    bar.hidden = true
    document.body.appendChild(bar)
  }
  return bar
}

function refresh(): void {
  const el = ensureBar()
  const sel = state.selection
  const target =
    sel.kind === 'scene-node' ? sel.node :
    sel.kind === 'scene-edge' ? sel.edge : null
  if (suppressed || !target || !target.isConnected) {
    el.hidden = true
    return
  }
  el.textContent = ''
  if (sel.kind === 'scene-node') buildNodeBar(el, sel.scene, sel.node)
  else if (sel.kind === 'scene-edge') buildEdgeBar(el, sel.scene, sel.edge)
  el.hidden = false
  position()
}

function buildNodeBar(el: HTMLDivElement, scene: SVGSVGElement, node: SVGGElement): void {
  const current = getShape(node)
  el.appendChild(seg(SHAPES, current, (s) => {
    if (s !== getShape(node)) state.apply(setShapeOp(scene, node, s))
  }))
  el.appendChild(btn('+ node', () => spawnConnectedNode(scene, node)))
  el.appendChild(btn('del', () => deleteSceneSelection()))
}

function buildEdgeBar(el: HTMLDivElement, scene: SVGSVGElement, edge: SVGGElement): void {
  const current = (edge.getAttribute('data-route') as EdgeRoute) || 'ortho'
  el.appendChild(seg(ROUTES, current, (r) => {
    const now = (edge.getAttribute('data-route') as EdgeRoute) || 'ortho'
    if (r !== now) state.apply(setRouteOp(scene, edge, r))
  }))
  el.appendChild(btn('anchors auto', () => {
    if ((edge.getAttribute('data-anchors') ?? 'auto,auto') !== 'auto,auto') {
      state.apply(setAnchorsOp(scene, edge, 'auto,auto'))
    }
  }))
  el.appendChild(btn('del', () => deleteSceneSelection()))
}

function seg<T extends string>(items: [T, string][], current: T, pick: (v: T) => void): HTMLSpanElement {
  const s = document.createElement('span')
  s.className = 'dn-seg'
  for (const [value, text] of items) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = text
    if (value === current) b.classList.add('dn-on')
    b.addEventListener('click', () => pick(value))
    s.appendChild(b)
  }
  return s
}

function btn(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'dn-btn'
  b.textContent = text
  b.addEventListener('click', onClick)
  return b
}

/* -------------------------------------------------------------- position */

function position(): void {
  if (!bar || bar.hidden) return
  const sel = state.selection
  const target =
    sel.kind === 'scene-node' ? sel.node :
    sel.kind === 'scene-edge' ? sel.edge : null
  if (!target || !target.isConnected) {
    bar.hidden = true
    return
  }
  const rect = target.getBoundingClientRect()
  if (rect.width < 1 && rect.height < 1) {
    // target exists but has no rendered box (its slide is hidden) — no anchor
    bar.hidden = true
    return
  }
  const bw = bar.offsetWidth
  const bh = bar.offsetHeight
  let left = rect.left + rect.width / 2 - bw / 2
  left = Math.max(4, Math.min(left, window.innerWidth - bw - 4))
  let top = rect.top - bh - 8
  if (top < 4) top = Math.min(rect.bottom + 8, window.innerHeight - bh - 4)
  bar.style.left = `${left}px`
  bar.style.top = `${top}px`
}
