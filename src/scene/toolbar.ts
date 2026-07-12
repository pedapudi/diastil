/* Contextual scene toolbar: a floating .dn-panel above the current scene
 * selection. Node: shape segment, style rows (fill/line/w), "+ node",
 * delete. Edge: route segment, style rows (ink/w), anchors reset, delete.
 * Scene svg selected: creation row (+ node, + circle, + square).
 * Style edits write scoped custom properties (--dia-node-*, --dia-edge-*)
 * as ops — token references, in-grammar, undoable.
 * Hidden while dragging; repositions on scroll/resize. */

import type { EdgeRoute, NodeShape } from '../types'
import { state } from '../state'
import { moveEl, setStyleProp } from '../model/ops'
import { getShape } from './route'
import {
  contentEndIndex, deleteSceneSelection, ensureSceneStyleRules,
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
  // click-away: a pointerdown anywhere outside the toolbar and outside the
  // deck canvas DISMISSES the scene selection (not just the bar — otherwise
  // the next op event would resurrect it). Deck-internal clicks re-resolve
  // through the normal selection handlers.
  window.addEventListener('pointerdown', (e) => {
    if (!bar || bar.hidden) return
    const path = e.composedPath()
    if (path.includes(bar)) return
    const host = document.querySelector('#deck-host')
    if (host && path.includes(host)) return
    const sel = state.selection
    if (sel.kind === 'scene-node' || sel.kind === 'scene-edge' || sel.kind === 'scene-free' ||
        (sel.kind === 'element' && selectedScene())) {
      state.selection = { kind: 'none' } // refresh() hides the bar via the selection event
    } else {
      bar.hidden = true
    }
  }, { capture: true })
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
    // adopt a bar left by an interrupted hot reload rather than stacking a
    // zombie copy that nothing will ever hide again
    bar = document.querySelector<HTMLDivElement>('.dia-scene-toolbar')
    if (!bar) {
      bar = document.createElement('div')
      bar.className = 'dn-panel dia-scene-toolbar'
      document.body.appendChild(bar)
    }
    bar.hidden = true
  }
  return bar
}

/** any editable svg when the selection is a background click (dia-scene or
 * a plain imported svg — both are editing surfaces now) */
function selectedScene(): SVGSVGElement | null {
  const sel = state.selection
  if (sel.kind !== 'element') return null
  const el = sel.el as unknown as Element
  return el instanceof SVGSVGElement ? el : null
}

/* Floating bars appear ONLY for concrete selections (node · edge · free
 * element) — they die with the selection. Creation tools (+ node/+ circle/
 * + square, draw toggles, make-diagram) live in the INSPECTOR, which is
 * stable chrome, not a popup. */
function refresh(): void {
  const el = ensureBar()
  const sel = state.selection
  const target =
    sel.kind === 'scene-node' ? sel.node :
    sel.kind === 'scene-edge' ? sel.edge :
    sel.kind === 'scene-free' ? sel.el :
    null
  if (suppressed || !target || !target.isConnected) {
    el.hidden = true
    return
  }
  el.textContent = ''
  if (sel.kind === 'scene-node') buildNodeBar(el, sel.scene, sel.node)
  else if (sel.kind === 'scene-edge') buildEdgeBar(el, sel.scene, sel.edge)
  else if (sel.kind === 'scene-free') buildFreeBar(el, sel.scene, sel.el)
  el.hidden = false
  position()
}

/* free elements: arbitrary svg content — style, z-order, delete */

const FREE_FILLS: [string, string][] = [
  ['keep', ''], ['paper', 'var(--dia-paper)'], ['rule', 'var(--dia-rule)'],
  ['accent', 'var(--dia-accent)'], ['ink', 'var(--dia-ink)'], ['none', 'none'],
]
const FREE_STROKES: [string, string][] = [
  ['keep', ''], ['ink', 'var(--dia-ink)'], ['soft', 'var(--dia-ink-soft)'],
  ['accent', 'var(--dia-accent)'], ['none', 'none'],
]

function buildFreeBar(el: HTMLDivElement, scene: SVGSVGElement, target: SVGGraphicsElement): void {
  const top = row(el)
  const tag = document.createElement('span')
  tag.className = 'dia-tb-k'
  tag.textContent = `<${target.tagName.toLowerCase()}>`
  top.appendChild(tag)
  top.appendChild(btn('front', () => {
    state.apply(moveEl(target, scene, contentEndIndex(scene) - 1, 'ToFront'))
  }))
  top.appendChild(btn('back', () => {
    state.apply(moveEl(target, scene, firstContentIndex(scene), 'ToBack'))
  }))
  top.appendChild(btn('del', () => deleteSceneSelection()))

  styleRow(el, 'fill', target, 'fill', FREE_FILLS)
  const lineRow = styleRow(el, 'line', target, 'stroke', FREE_STROKES)
  lineRow.appendChild(document.createTextNode(' '))
  widthSeg(lineRow, target, 'stroke-width')
}

/** first index past defs/style/title — where "send to back" lands */
function firstContentIndex(scene: SVGSVGElement): number {
  const kids = [...scene.children]
  const i = kids.findIndex((c) => !/^(defs|style|title|desc|metadata)$/.test(c.tagName))
  return i === -1 ? 0 : i
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
  el: HTMLDivElement, label: string, target: SVGGraphicsElement, prop: string, options: [string, string][],
): HTMLDivElement {
  const r = row(el)
  const k = document.createElement('span')
  k.className = 'dia-tb-k'
  k.textContent = label
  r.appendChild(k)
  r.appendChild(optionSeg(target, prop, options))
  return r
}

function widthSeg(r: HTMLDivElement, target: SVGGraphicsElement, prop: string): void {
  const k = document.createElement('span')
  k.className = 'dia-tb-k'
  k.textContent = 'w'
  r.appendChild(k)
  r.appendChild(optionSeg(target, prop, WIDTHS))
}

/** a segment over [name, cssValue] options — sets a style property as an op */
function optionSeg(target: SVGGraphicsElement, prop: string, options: [string, string][]): HTMLSpanElement {
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
    sel.kind === 'scene-free' ? sel.el :
    null
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
