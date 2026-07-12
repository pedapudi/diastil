/* Contextual scene toolbar: a floating .dn-panel above the current scene
 * selection. Node: shape segment, style rows (fill/line/w), "+ node",
 * delete. Edge: route segment, style rows (ink/w), anchors reset, delete.
 * Scene svg selected: creation row (+ node, + circle, + square).
 * Style edits write scoped custom properties (--dia-node-*, --dia-edge-*)
 * as ops — token references, in-grammar, undoable.
 * Hidden while dragging; repositions on scroll/resize. */

import type { EdgeRoute, NodeShape } from '../types'
import { state } from '../state'
import { setStyleProp } from '../model/ops'
import { getShape } from './route'
import {
  deleteSceneSelection, ensureSceneStyleRules, insertShapeNode,
  setAnchorsOp, setRouteOp, setShapeOp, spawnConnectedNode,
} from './interact'

const SHAPES: [NodeShape, string][] = [
  ['rect', 'rect'], ['rounded', 'rnd'], ['pill', 'pill'], ['ellipse', 'ell'], ['diamond', 'diam'],
]
const ROUTES: [EdgeRoute, string][] = [
  ['straight', 'line'], ['ortho', 'orth'], ['curve', 'curve'],
]

/* style options: token references only ('auto' clears back to the theme) */
const FILLS: [string, string][] = [
  ['auto', ''], ['paper', 'var(--dia-paper)'], ['rule', 'var(--dia-rule)'],
  ['accent', 'var(--dia-accent)'], ['none', 'transparent'],
]
const INKS: [string, string][] = [
  ['auto', ''], ['ink', 'var(--dia-ink)'], ['soft', 'var(--dia-ink-soft)'], ['accent', 'var(--dia-accent)'],
]
const WIDTHS: [string, string][] = [['auto', ''], ['1', '1'], ['2', '2'], ['3', '3']]

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

/** the scene svg itself, when the selection is a scene background click */
function selectedScene(): SVGSVGElement | null {
  const sel = state.selection
  if (sel.kind !== 'element') return null
  const el = sel.el as unknown as Element
  return el instanceof SVGSVGElement && el.classList.contains('dia-scene') ? el : null
}

function refresh(): void {
  const el = ensureBar()
  const sel = state.selection
  const scene = selectedScene()
  const target =
    sel.kind === 'scene-node' ? sel.node :
    sel.kind === 'scene-edge' ? sel.edge :
    scene
  if (suppressed || !target || !target.isConnected) {
    el.hidden = true
    return
  }
  el.textContent = ''
  if (sel.kind === 'scene-node') buildNodeBar(el, sel.scene, sel.node)
  else if (sel.kind === 'scene-edge') buildEdgeBar(el, sel.scene, sel.edge)
  else if (scene) buildSceneBar(el, scene)
  el.hidden = false
  position()
}

function buildSceneBar(el: HTMLDivElement, scene: SVGSVGElement): void {
  const r = row(el)
  r.appendChild(btn('+ node', () => insertShapeNode(scene, 'node')))
  r.appendChild(btn('+ circle', () => insertShapeNode(scene, 'circle')))
  r.appendChild(btn('+ square', () => insertShapeNode(scene, 'square')))
}

function buildNodeBar(el: HTMLDivElement, scene: SVGSVGElement, node: SVGGElement): void {
  const top = row(el)
  const current = getShape(node)
  top.appendChild(seg(SHAPES, current, (s) => {
    if (s !== getShape(node)) state.apply(setShapeOp(scene, node, s))
  }))
  top.appendChild(btn('+ node', () => spawnConnectedNode(scene, node)))
  top.appendChild(btn('del', () => deleteSceneSelection()))

  styleRow(el, 'fill', node, '--dia-node-fill', FILLS)
  const lineRow = styleRow(el, 'line', node, '--dia-node-stroke', INKS)
  lineRow.appendChild(document.createTextNode(' '))
  widthSeg(lineRow, node, '--dia-node-stroke-w')
}

function buildEdgeBar(el: HTMLDivElement, scene: SVGSVGElement, edge: SVGGElement): void {
  const top = row(el)
  const current = (edge.getAttribute('data-route') as EdgeRoute) || 'ortho'
  top.appendChild(seg(ROUTES, current, (r) => {
    const now = (edge.getAttribute('data-route') as EdgeRoute) || 'ortho'
    if (r !== now) state.apply(setRouteOp(scene, edge, r))
  }))
  top.appendChild(btn('anchors auto', () => {
    if ((edge.getAttribute('data-anchors') ?? 'auto,auto') !== 'auto,auto') {
      state.apply(setAnchorsOp(scene, edge, 'auto,auto'))
    }
  }))
  top.appendChild(btn('del', () => deleteSceneSelection()))

  const inkRow = styleRow(el, 'ink', edge, '--dia-edge-stroke', INKS)
  inkRow.appendChild(document.createTextNode(' '))
  widthSeg(inkRow, edge, '--dia-edge-w')
}

/* ---- style rows: scoped custom properties as undoable ops ---- */

function styleRow(
  el: HTMLDivElement, label: string, target: SVGGElement, prop: string, options: [string, string][],
): HTMLDivElement {
  const r = row(el)
  const k = document.createElement('span')
  k.className = 'dia-tb-k'
  k.textContent = label
  r.appendChild(k)
  r.appendChild(optionSeg(target, prop, options))
  return r
}

function widthSeg(r: HTMLDivElement, target: SVGGElement, prop: string): void {
  const k = document.createElement('span')
  k.className = 'dia-tb-k'
  k.textContent = 'w'
  r.appendChild(k)
  r.appendChild(optionSeg(target, prop, WIDTHS))
}

/** a segment over [name, cssValue] options — sets a custom property as an op */
function optionSeg(target: SVGGElement, prop: string, options: [string, string][]): HTMLSpanElement {
  const current = target.style.getPropertyValue(prop).trim()
  const currentName = (options.find(([, v]) => v === current) ?? options[0])[0]
  return seg(options.map(([n]) => [n, n] as [string, string]), currentName, (name) => {
    const value = options.find(([n]) => n === name)?.[1] ?? ''
    if (target.style.getPropertyValue(prop).trim() === value) return
    ensureSceneStyleRules()
    state.apply(setStyleProp(target, prop, value))
  })
}

function row(el: HTMLDivElement): HTMLDivElement {
  const r = document.createElement('div')
  r.className = 'dia-tb-row'
  el.appendChild(r)
  return r
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
    sel.kind === 'scene-edge' ? sel.edge :
    selectedScene()
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
