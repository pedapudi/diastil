/* Scene interactions: selection, drag/resize with snapping + smart guides,
 * anchor-drag edge creation, edge retargeting, label editing, keyboard.
 * Live drags write geometry directly (no ops); on release the start state is
 * silently restored and ONE op is applied, so undo returns to the true start. */

import type { AnchorSide, EdgeRoute, NodeGeom, NodeShape, Op, SlideEl } from '../types'
import { state } from '../state'
import { batch, insertEl, moveSceneNode, removeEl } from '../model/ops'
import {
  anchorPoint, createEdge, createNode, edgesOf, freshNodeId, getNodeGeom, getShape,
  nodesOf, parseEdgeRef, renderNodeShape, routeEdge, routeEdgesOf, setNodeGeom,
} from './route'
import type { Guide } from './overlay'
import {
  clearGuides, clearSelectionVisuals, clearTempEdge, drawEdgeSelection, drawGuides,
  drawNodeSelection, edgeEndpoints, edgeForHit, ensureEditorStyles, hideToast,
  highlightCandidate, pxScale, showTempEdge, showToast, syncEdgeHits,
} from './overlay'
import { attachToolbar, setToolbarSuppressed } from './toolbar'
import './scene.css'

const NS = 'http://www.w3.org/2000/svg'
const GRID = 8          // grid snap, viewBox units
const SNAP = 6          // alignment/spacing snap threshold, viewBox units
const DRAG_MIN = 3      // client px before a press becomes a drag
const MIN_W = 40
const MIN_H = 28

type Pt = { x: number; y: number }
type Corner = 'nw' | 'ne' | 'sw' | 'se'

/* ================================================================ wiring */

let wireAC: AbortController | null = null

/** call once from main; wires (and re-wires on deck-loaded) scene editing */
export function attachSceneEditing(): void {
  attachToolbar()
  document.addEventListener('keydown', onKeydown)
  state.bus.on((e) => {
    switch (e.type) {
      case 'deck-loaded': wire(); break
      case 'selection': onSelectionChanged(); break
      case 'op':
      case 'undo':
      case 'redo':
      case 'slides-changed': onDocMutated(); break
      case 'altitude': refreshOverlaySelection(); break
    }
  })
  if (state.deck) wire()
}

function wire(): void {
  wireAC?.abort()
  wireAC = null
  const deck = state.deck
  if (!deck) return
  wireAC = new AbortController()
  ensureEditorStyles(deck.root)
  deck.root.addEventListener('pointerdown', onPointerDown as EventListener, { signal: wireAC.signal })
  deck.root.addEventListener('dblclick', onDblClick as EventListener, { signal: wireAC.signal })
  for (const scene of scenesOf(deck.root)) syncEdgeHits(scene)
}

function scenesOf(root: ShadowRoot): SVGSVGElement[] {
  return [...root.querySelectorAll<SVGSVGElement>('svg.dia-scene')]
}

/* ============================================================= bus sync */

function onSelectionChanged(): void {
  const sel = state.selection
  if (pendingNudge && !(sel.kind === 'scene-node' && sel.node === pendingNudge.node)) flushNudge()
  refreshOverlaySelection()
}

function onDocMutated(): void {
  const root = state.deck?.root
  if (!root) return
  for (const scene of scenesOf(root)) syncEdgeHits(scene)
  const sel = state.selection
  if (
    (sel.kind === 'scene-node' && !sel.node.isConnected) ||
    (sel.kind === 'scene-edge' && !sel.edge.isConnected)
  ) {
    state.selection = sel.scene.isConnected
      ? { kind: 'element', el: sel.scene as unknown as HTMLElement, slide: sel.slide }
      : { kind: 'none' }
    return // the selection event redraws
  }
  refreshOverlaySelection()
}

function refreshOverlaySelection(): void {
  const root = state.deck?.root
  if (!root) return
  for (const scene of scenesOf(root)) clearSelectionVisuals(scene)
  const sel = state.selection
  if (sel.kind === 'scene-node' && sel.node.isConnected) drawNodeSelection(sel.scene, sel.node)
  else if (sel.kind === 'scene-edge' && sel.edge.isConnected) drawEdgeSelection(sel.scene, sel.edge)
}

/* ============================================================== pointer */

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return
  const target = e.target as Element | null
  if (!(target instanceof Element)) return
  const scene = target.closest('svg.dia-scene') as SVGSVGElement | null
  if (!scene) return
  flushNudge()
  const sel = state.selection

  const handle = target.closest('[data-dia-handle]')
  if (handle && sel.kind === 'scene-node') {
    e.preventDefault()
    beginResize(scene, sel.node, (handle.getAttribute('data-dia-handle') ?? 'se') as Corner, e)
    return
  }
  const anchor = target.closest('[data-dia-anchor]')
  if (anchor && sel.kind === 'scene-node') {
    e.preventDefault()
    beginCreateEdge(scene, sel.node, (anchor.getAttribute('data-dia-anchor') ?? 'E') as Exclude<AnchorSide, 'auto'>, e)
    return
  }
  const endpoint = target.closest('[data-dia-endpoint]')
  if (endpoint && sel.kind === 'scene-edge') {
    e.preventDefault()
    beginRetarget(scene, sel.edge, endpoint.getAttribute('data-dia-endpoint') === 'from' ? 'from' : 'to', e)
    return
  }

  const p = toScene(scene, e.clientX, e.clientY)
  const node = hitNode(scene, p)
  if (node) {
    e.preventDefault()
    beginNodeDrag(scene, node, e)
    return
  }
  const edge = edgeForHit(target) ?? (target.closest('g[data-dia-edge]') as SVGGElement | null)
  if (edge) {
    state.selection = { kind: 'scene-edge', edge, scene, slide: slideOf(scene) }
    return
  }
  // empty scene space
  state.selection = { kind: 'element', el: scene as unknown as HTMLElement, slide: slideOf(scene) }
}

function onDblClick(e: MouseEvent): void {
  const target = e.target as Element | null
  if (!(target instanceof Element)) return
  const scene = target.closest('svg.dia-scene') as SVGSVGElement | null
  if (!scene) return
  if (target.closest('[data-dia-handle],[data-dia-anchor],[data-dia-endpoint]')) return
  const p = toScene(scene, e.clientX, e.clientY)
  const node = hitNode(scene, p)
  if (node) {
    e.preventDefault()
    openLabelEdit(scene, node)
    return
  }
  if (edgeForHit(target) || target.closest('g[data-dia-edge]')) return
  // double-click empty scene space → bare new node, label edit open
  e.preventDefault()
  const nid = freshNodeId(scene)
  const nodeEl = createNode(scene, nid, dropGeom(p), 'node')
  nodeEl.remove()
  state.apply(insertEl(scene, scene.children.length, nodeEl, `InsertNode ${nid}`))
  state.selection = { kind: 'scene-node', node: nodeEl, scene, slide: slideOf(scene) }
  openLabelEdit(scene, nodeEl)
}

/* ------------------------------------------------------- drag sessions */

let sessionAC: AbortController | null = null

function startSession(
  move: (e: PointerEvent) => void,
  up: (e: PointerEvent) => void,
  cancel: () => void,
): void {
  sessionAC?.abort()
  const ac = (sessionAC = new AbortController())
  window.addEventListener('pointermove', move, { signal: ac.signal })
  window.addEventListener('pointerup', (e) => {
    ac.abort()
    if (sessionAC === ac) sessionAC = null
    up(e)
  }, { signal: ac.signal })
  window.addEventListener('pointercancel', () => {
    ac.abort()
    if (sessionAC === ac) sessionAC = null
    cancel()
  }, { signal: ac.signal })
}

/** A completed drag's pointerup spawns a synthetic click wherever the pointer
 * ended — often outside the scene svg — which would reach the text-selection
 * handler and stomp the scene selection (the toolbar vanishes). Swallow
 * exactly that one click. */
function suppressNextClick(): void {
  window.addEventListener(
    'click',
    (e) => { e.stopPropagation(); e.preventDefault() },
    { capture: true, once: true },
  )
}

/** keep at least CLAMP_KEEP scene units of a node inside the viewBox so a
 * drag or nudge can never strand it where it cannot be re-grabbed */
const CLAMP_KEEP = 24
function clampToViewBox(scene: SVGSVGElement, g: NodeGeom): NodeGeom {
  const vb = scene.viewBox.baseVal
  if (!vb || vb.width <= 0 || vb.height <= 0) return g
  return {
    ...g,
    x: Math.min(Math.max(g.x, vb.x - g.w + CLAMP_KEEP), vb.x + vb.width - CLAMP_KEEP),
    y: Math.min(Math.max(g.y, vb.y - g.h + CLAMP_KEEP), vb.y + vb.height - CLAMP_KEEP),
  }
}

function cleanupDragUi(scene: SVGSVGElement): void {
  clearGuides(scene)
  clearTempEdge(scene)
  highlightCandidate(scene, null)
  hideToast()
  setToolbarSuppressed(false)
  document.body.style.cursor = ''
}

function geomToast(nid: string, edges: number): string {
  return `drag writes to node/${nid} · geometry · ${edges} edge${edges === 1 ? '' : 's'} reroute`
}

/* ---------------------------------------------------------- move node */

function beginNodeDrag(scene: SVGSVGElement, node: SVGGElement, e: PointerEvent): void {
  state.selection = { kind: 'scene-node', node, scene, slide: slideOf(scene) }
  const start = getNodeGeom(node)
  const p0 = toScene(scene, e.clientX, e.clientY)
  const c0 = { x: e.clientX, y: e.clientY }
  const nid = idOf(node)
  const touching = countEdges(scene, nid)
  let moved = false

  startSession(
    (ev) => {
      if (!moved && Math.hypot(ev.clientX - c0.x, ev.clientY - c0.y) < DRAG_MIN) return
      if (!moved) {
        moved = true
        setToolbarSuppressed(true)
        showToast(geomToast(nid, touching))
        document.body.style.cursor = 'grabbing'
      }
      const p = toScene(scene, ev.clientX, ev.clientY)
      const raw = { x: start.x + (p.x - p0.x), y: start.y + (p.y - p0.y) }
      const snap = snapNodePos(scene, node, raw, start.w, start.h)
      setNodeGeom(node, clampToViewBox(scene, { x: snap.x, y: snap.y, w: start.w, h: start.h }))
      routeEdgesOf(scene, nid)
      drawGuides(scene, snap.guides)
      drawNodeSelection(scene, node)
    },
    () => endGeomDrag(scene, node, start, moved),
    () => {
      if (moved) {
        setNodeGeom(node, start)
        routeEdgesOf(scene, nid)
        drawNodeSelection(scene, node)
      }
      cleanupDragUi(scene)
    },
  )
}

/** commit a live geometry drag as ONE op: silently restore start, then apply */
function endGeomDrag(scene: SVGSVGElement, node: SVGGElement, start: NodeGeom, moved: boolean): void {
  cleanupDragUi(scene)
  if (!moved) return
  suppressNextClick()
  const final = getNodeGeom(node)
  if (geomEq(final, start)) return
  setNodeGeom(node, start)          // restore so the op captures the true prev
  routeEdgesOf(scene, idOf(node))
  state.apply(moveSceneNode(scene, node, final)) // lands final; undo → start
}

/* --------------------------------------------------------- resize node */

function beginResize(scene: SVGSVGElement, node: SVGGElement, corner: Corner, e: PointerEvent): void {
  const start = getNodeGeom(node)
  const right = start.x + start.w
  const bottom = start.y + start.h
  const nid = idOf(node)
  const c0 = { x: e.clientX, y: e.clientY }
  const touching = countEdges(scene, nid)
  const west = corner === 'nw' || corner === 'sw'
  const north = corner === 'nw' || corner === 'ne'
  let moved = false

  startSession(
    (ev) => {
      if (!moved && Math.hypot(ev.clientX - c0.x, ev.clientY - c0.y) < DRAG_MIN) return
      if (!moved) {
        moved = true
        setToolbarSuppressed(true)
        showToast(geomToast(nid, touching))
      }
      const p = toScene(scene, ev.clientX, ev.clientY)
      const px = snapGrid(p.x), py = snapGrid(p.y)
      let x = west ? Math.min(px, right - MIN_W) : start.x
      let w = west ? right - x : Math.max(MIN_W, px - start.x)
      let y = north ? Math.min(py, bottom - MIN_H) : start.y
      let h = north ? bottom - y : Math.max(MIN_H, py - start.y)
      if (ev.shiftKey) {
        // aspect lock: true circles and squares
        const s = Math.max(w, h)
        if (west) x = right - s
        if (north) y = bottom - s
        w = s; h = s
      }
      setNodeGeom(node, { x, y, w, h })
      routeEdgesOf(scene, nid)
      drawNodeSelection(scene, node)
    },
    () => endGeomDrag(scene, node, start, moved),
    () => {
      if (moved) {
        setNodeGeom(node, start)
        routeEdgesOf(scene, nid)
        drawNodeSelection(scene, node)
      }
      cleanupDragUi(scene)
    },
  )
}

/* -------------------------------------- create edge / node (anchor drag) */

function beginCreateEdge(
  scene: SVGSVGElement, node: SVGGElement, side: Exclude<AnchorSide, 'auto'>, e: PointerEvent,
): void {
  const from = idOf(node)
  const a = anchorPoint(getNodeGeom(node), side)
  const c0 = { x: e.clientX, y: e.clientY }
  let moved = false

  startSession(
    (ev) => {
      if (!moved && Math.hypot(ev.clientX - c0.x, ev.clientY - c0.y) < DRAG_MIN) return
      if (!moved) {
        moved = true
        setToolbarSuppressed(true)
        showToast(`drag writes to scene · new edge from ${from}`)
      }
      const p = toScene(scene, ev.clientX, ev.clientY)
      showTempEdge(scene, a, p)
      highlightCandidate(scene, hitNode(scene, p, node))
    },
    (ev) => {
      cleanupDragUi(scene)
      if (!moved) return
      suppressNextClick()
      const p = toScene(scene, ev.clientX, ev.clientY)
      const cand = hitNode(scene, p, node)
      if (cand) insertEdgeFlow(scene, from, idOf(cand))
      else insertNodeWithEdge(scene, from, p)
    },
    () => cleanupDragUi(scene),
  )
}

/** drop on a node → ONE InsertEdge op */
function insertEdgeFlow(scene: SVGSVGElement, from: string, to: string): void {
  const edgeEl = createEdge(scene, from, to) // builds + routes, appended
  edgeEl.remove()                            // detach; the op does the insert
  state.apply(insertEl(scene, scene.children.length, edgeEl, `InsertEdge ${from}->${to}`))
  routeEdge(scene, edgeEl)
  syncEdgeHits(scene)
  state.selection = { kind: 'scene-edge', edge: edgeEl, scene, slide: slideOf(scene) }
}

/* ------------------------------------- standalone shapes / new diagrams */

/** Theme rules that make per-node/per-edge styling work: shapes read scoped
 * custom properties with token fallbacks. Appended to the deck theme once,
 * when a deck predating them meets the styling controls or gets a new
 * diagram. Additive CSS — never overrides an existing rule of the same name
 * because later rules of equal specificity win only for the props they set. */
export const SCENE_STYLE_RULES = `
.dia-scene .dia-node-shape { fill: var(--dia-node-fill, var(--dia-paper)); stroke: var(--dia-node-stroke, var(--dia-ink)); stroke-width: var(--dia-node-stroke-w, 1.3); }
.dia-scene .dia-node-label { font: 12px var(--dia-face-body); fill: var(--dia-node-ink, var(--dia-ink)); }
.dia-scene .dia-edge-path { stroke: var(--dia-edge-stroke, var(--dia-ink)); stroke-width: var(--dia-edge-w, 1.2); fill: none; color: var(--dia-edge-stroke, var(--dia-ink)); }
.dia-scene .dia-edge-label { font: 10px var(--dia-face-label); fill: var(--dia-edge-ink, var(--dia-ink-soft)); }
.dia-scene [data-dia-emphasis] .dia-node-shape { stroke: var(--dia-accent); stroke-width: 2; }`

/** make sure the deck theme can express scene styling (idempotent) */
export function ensureSceneStyleRules(): void {
  const theme = state.deck?.themeStyle
  if (!theme || (theme.textContent ?? '').includes('--dia-node-fill')) return
  theme.textContent = `${theme.textContent ?? ''}\n${SCENE_STYLE_RULES}\n`
}

/** insert a standalone shape (circle/square = a label-less node) or a plain
 * labeled node near the scene center — ONE op, selected afterwards */
export function insertShapeNode(scene: SVGSVGElement, kind: 'node' | 'circle' | 'square'): void {
  ensureSceneStyleRules()
  const vb = scene.viewBox.baseVal
  const cx = vb && vb.width > 0 ? vb.x + vb.width / 2 : 170
  const cy = vb && vb.height > 0 ? vb.y + vb.height / 2 : 120
  const n = nodesOf(scene).length
  const size = kind === 'node' ? { w: 120, h: 40 } : { w: 72, h: 72 }
  const geom: NodeGeom = {
    x: snapGrid(cx - size.w / 2 + (n % 5) * 12 - 24),
    y: snapGrid(cy - size.h / 2 + (n % 5) * 10 - 20),
    w: size.w, h: size.h,
  }
  const shape: NodeShape = kind === 'circle' ? 'ellipse' : kind === 'square' ? 'rect' : 'rounded'
  const nid = freshNodeId(scene)
  const nodeEl = createNode(scene, nid, geom, kind === 'node' ? 'node' : '', shape)
  nodeEl.remove()
  state.apply(insertEl(scene, scene.children.length, nodeEl, `Insert ${kind} ${nid}`))
  state.selection = { kind: 'scene-node', node: nodeEl, scene, slide: slideOf(scene) }
  if (kind === 'node') openLabelEdit(scene, nodeEl)
}

/** drop on empty canvas → new node + connecting edge as ONE batch op */
function insertNodeWithEdge(scene: SVGSVGElement, from: string, p: Pt): void {
  const nid = freshNodeId(scene)
  const nodeEl = createNode(scene, nid, dropGeom(p), 'node')
  const edgeEl = createEdge(scene, from, nid)
  nodeEl.remove()
  edgeEl.remove()
  const base = scene.children.length
  state.apply(batch(`InsertNode ${nid} + InsertEdge ${from}->${nid}`, [
    insertEl(scene, base, nodeEl),
    insertEl(scene, base + 1, edgeEl),
  ]))
  routeEdge(scene, edgeEl)
  syncEdgeHits(scene)
  state.selection = { kind: 'scene-node', node: nodeEl, scene, slide: slideOf(scene) }
  openLabelEdit(scene, nodeEl)
}

function dropGeom(p: Pt): NodeGeom {
  return { x: snapGrid(p.x - 60), y: snapGrid(p.y - 20), w: 120, h: 40 }
}

/* -------------------------------------------------------- retarget edge */

function beginRetarget(scene: SVGSVGElement, edge: SVGGElement, end: 'from' | 'to', e: PointerEvent): void {
  const pts = edgeEndpoints(scene, edge)
  const ref = parseEdgeRef(edge)
  if (!pts || !ref) return
  const fixed = end === 'from' ? pts.p2 : pts.p1
  const stays = end === 'from' ? ref.to : ref.from
  const c0 = { x: e.clientX, y: e.clientY }
  let moved = false
  let cand: SVGGElement | null = null

  startSession(
    (ev) => {
      if (!moved && Math.hypot(ev.clientX - c0.x, ev.clientY - c0.y) < DRAG_MIN) return
      if (!moved) {
        moved = true
        setToolbarSuppressed(true)
        showToast(`drag writes to edge/${ref.from}->${ref.to} · endpoints`)
        clearSelectionVisuals(scene)
      }
      const p = toScene(scene, ev.clientX, ev.clientY)
      showTempEdge(scene, end === 'from' ? p : fixed, end === 'from' ? fixed : p)
      cand = hitNode(scene, p, null, 8)
      if (cand && idOf(cand) === stays) cand = null // no self-loops
      highlightCandidate(scene, cand)
    },
    () => {
      cleanupDragUi(scene)
      if (moved) suppressNextClick()
      if (moved && cand) {
        const newRef = end === 'from' ? `${idOf(cand)}->${ref.to}` : `${ref.from}->${idOf(cand)}`
        if (newRef !== edge.getAttribute('data-dia-edge')) {
          state.apply(retargetEdgeOp(scene, edge, newRef))
        }
      }
      refreshOverlaySelection()
    },
    () => {
      cleanupDragUi(scene)
      refreshOverlaySelection()
    },
  )
}

/* ============================================================= keyboard */

function onKeydown(e: KeyboardEvent): void {
  const t = e.composedPath()[0]
  if (
    t instanceof HTMLElement &&
    (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
  ) return
  const sel = state.selection
  if (sel.kind !== 'scene-node' && sel.kind !== 'scene-edge') return

  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault()
    e.stopPropagation() // scene owns this key — the shell must not also act
    deleteSceneSelection()
    return
  }
  if (sel.kind === 'scene-node') {
    const d = e.shiftKey ? 10 : 1
    const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0
    const dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0
    if (dx || dy) {
      e.preventDefault()
      e.stopPropagation() // arrows nudge the node; they must not change slides
      nudgeNode(sel.scene, sel.node, dx, dy)
    }
  }
}

/* --------------------------------------------- nudge (coalesced to 1 op) */

let pendingNudge: { scene: SVGSVGElement; node: SVGGElement; start: NodeGeom; timer: number } | null = null

function nudgeNode(scene: SVGSVGElement, node: SVGGElement, dx: number, dy: number): void {
  if (pendingNudge && pendingNudge.node !== node) flushNudge()
  if (!pendingNudge) pendingNudge = { scene, node, start: getNodeGeom(node), timer: 0 }
  clearTimeout(pendingNudge.timer)
  const g = getNodeGeom(node)
  setNodeGeom(node, clampToViewBox(scene, { ...g, x: g.x + dx, y: g.y + dy }))
  routeEdgesOf(scene, idOf(node))
  drawNodeSelection(scene, node)
  pendingNudge.timer = window.setTimeout(flushNudge, 400)
}

function flushNudge(): void {
  if (!pendingNudge) return
  const { scene, node, start, timer } = pendingNudge
  clearTimeout(timer)
  pendingNudge = null
  const final = getNodeGeom(node)
  if (geomEq(final, start) || !node.isConnected) return
  setNodeGeom(node, start)
  routeEdgesOf(scene, idOf(node))
  state.apply(moveSceneNode(scene, node, final))
}

/* =============================================================== delete */

/** delete the current scene selection (node takes its touching edges along) */
export function deleteSceneSelection(): void {
  flushNudge()
  const sel = state.selection
  if (sel.kind === 'scene-node') {
    const nid = idOf(sel.node)
    const touching = edgesOf(sel.scene).filter((ed) => {
      const r = parseEdgeRef(ed)
      return !!r && (r.from === nid || r.to === nid)
    })
    // remove in descending DOM order so the batch invert re-inserts exactly
    const doomed = [...touching, sel.node].sort(
      (a, b) => domIndex(b) - domIndex(a),
    )
    state.apply(batch(`DeleteNode ${nid}`, doomed.map((el) => removeEl(el))))
    state.selection = { kind: 'element', el: sel.scene as unknown as HTMLElement, slide: sel.slide }
  } else if (sel.kind === 'scene-edge') {
    state.apply(removeEl(sel.edge, `DeleteEdge ${sel.edge.getAttribute('data-dia-edge') ?? ''}`))
    state.selection = { kind: 'element', el: sel.scene as unknown as HTMLElement, slide: sel.slide }
  }
}

/** toolbar "+ node": spawn a connected node to the east as ONE batch op */
export function spawnConnectedNode(scene: SVGSVGElement, node: SVGGElement): void {
  const g = getNodeGeom(node)
  const nid = freshNodeId(scene)
  const nodeEl = createNode(scene, nid, { x: g.x + g.w + 48, y: g.y, w: 120, h: 40 }, 'node')
  const edgeEl = createEdge(scene, idOf(node), nid)
  nodeEl.remove()
  edgeEl.remove()
  const base = scene.children.length
  state.apply(batch(`InsertNode ${nid} + InsertEdge ${idOf(node)}->${nid}`, [
    insertEl(scene, base, nodeEl),
    insertEl(scene, base + 1, edgeEl),
  ]))
  routeEdge(scene, edgeEl)
  syncEdgeHits(scene)
  state.selection = { kind: 'scene-node', node: nodeEl, scene, slide: slideOf(scene) }
}

/* ============================================================ label edit */

let closeLabelEdit: (() => void) | null = null

function openLabelEdit(scene: SVGSVGElement, node: SVGGElement): void {
  closeLabelEdit?.()
  flushNudge()
  let label = node.querySelector<SVGTextElement>('.dia-node-label')
  const attached = !!label
  if (!label) {
    label = document.createElementNS(NS, 'text') as SVGTextElement
    label.setAttribute('class', 'dia-node-label')
  }
  const prev = label.textContent ?? ''

  const input = document.createElement('input')
  input.className = 'dia-label-input'
  input.value = prev
  if (attached) input.style.color = getComputedStyle(label).fill

  const place = (): void => {
    const ctm = scene.getScreenCTM()
    if (!ctm) return
    const g = getNodeGeom(node)
    const tl = new DOMPoint(g.x, g.y).matrixTransform(ctm)
    const br = new DOMPoint(g.x + g.w, g.y + g.h).matrixTransform(ctm)
    input.style.left = `${Math.min(tl.x, br.x)}px`
    input.style.top = `${Math.min(tl.y, br.y)}px`
    input.style.width = `${Math.abs(br.x - tl.x)}px`
    input.style.height = `${Math.abs(br.y - tl.y)}px`
    const fs = attached ? parseFloat(getComputedStyle(label!).fontSize) || 12 : 12
    input.style.fontSize = `${fs * pxScale(scene)}px`
  }
  place()
  if (attached) label.style.visibility = 'hidden'
  document.body.appendChild(input)
  input.focus()
  input.select()

  const ac = new AbortController()
  window.addEventListener('scroll', place, { capture: true, signal: ac.signal })
  window.addEventListener('resize', place, { signal: ac.signal })

  let done = false
  const close = (): void => {
    if (done) return
    done = true
    ac.abort()
    input.remove()
    label!.style.visibility = ''
    if (!label!.getAttribute('style')) label!.removeAttribute('style')
    closeLabelEdit = null
  }
  closeLabelEdit = close

  const commit = (): void => {
    if (done) return
    const value = input.value
    close()
    if (!attached) {
      if (!value) return
      state.apply(batch('SetText dia-node-label', [
        insertEl(node, node.children.length, label!),
        setSvgTextOp(label!, value),
      ]))
      renderNodeShape(node) // position the fresh label
    } else if (value !== prev) {
      state.apply(setSvgTextOp(label!, value))
    }
  }

  input.addEventListener('keydown', (ke) => {
    ke.stopPropagation()
    if (ke.key === 'Enter') commit()
    else if (ke.key === 'Escape') close()
  })
  input.addEventListener('blur', commit)
}

/* ======================================================= scene-local ops */

/** SetText for SVG <text> — mirrors ops.setText semantics with proper invert */
function setSvgTextOp(el: SVGTextElement, text: string): Op {
  const prev = el.textContent ?? ''
  return {
    label: 'SetText dia-node-label',
    author: 'you',
    apply() { el.textContent = text },
    invert() { return setSvgTextOp(el, prev) },
  }
}

/** set a node's shape and re-render (+ reroute) with a proper invert */
export function setShapeOp(scene: SVGSVGElement, node: SVGGElement, shape: NodeShape): Op {
  const prev = getShape(node)
  const nid = idOf(node)
  return {
    label: `SetShape ${nid} ${shape}`,
    author: 'you',
    apply() {
      node.setAttribute('data-shape', shape)
      renderNodeShape(node)
      routeEdgesOf(scene, nid)
    },
    invert() { return setShapeOp(scene, node, prev) },
  }
}

/** set an edge's route kind and reroute */
export function setRouteOp(scene: SVGSVGElement, edge: SVGGElement, route: EdgeRoute): Op {
  const prev = (edge.getAttribute('data-route') as EdgeRoute) || 'ortho'
  return {
    label: `SetRoute ${route}`,
    author: 'you',
    apply() {
      edge.setAttribute('data-route', route)
      routeEdge(scene, edge)
    },
    invert() { return setRouteOp(scene, edge, prev) },
  }
}

/** set an edge's declared anchors ('auto,auto' resets) and reroute */
export function setAnchorsOp(scene: SVGSVGElement, edge: SVGGElement, anchors: string): Op {
  const prev = edge.getAttribute('data-anchors') ?? 'auto,auto'
  return {
    label: `SetAnchors ${anchors}`,
    author: 'you',
    apply() {
      edge.setAttribute('data-anchors', anchors)
      routeEdge(scene, edge)
    },
    invert() { return setAnchorsOp(scene, edge, prev) },
  }
}

/** RetargetEdge: new ref + anchors reset to auto + reroute, one undo step */
function retargetEdgeOp(scene: SVGSVGElement, edge: SVGGElement, ref: string, anchors = 'auto,auto'): Op {
  const prevRef = edge.getAttribute('data-dia-edge') ?? ''
  const prevAnchors = edge.getAttribute('data-anchors') ?? 'auto,auto'
  return {
    label: `RetargetEdge ${prevRef} → ${ref}`,
    author: 'you',
    apply() {
      edge.setAttribute('data-dia-edge', ref)
      edge.setAttribute('data-anchors', anchors)
      routeEdge(scene, edge)
    },
    invert() { return retargetEdgeOp(scene, edge, prevRef, prevAnchors) },
  }
}

/* ============================================================== snapping */

interface AxisCand { pos: number; dist: number; guides: Guide[] }

function snapNodePos(
  scene: SVGSVGElement, node: SVGGElement, raw: Pt, w: number, h: number,
): { x: number; y: number; guides: Guide[] } {
  const others = nodesOf(scene).filter((n) => n !== node).map(getNodeGeom)
  const xc: AxisCand[] = []
  const yc: AxisCand[] = []

  // alignment: my left/center/right vs their left/center/right (same for y)
  for (const o of others) {
    for (const ox of [o.x, o.x + o.w / 2, o.x + o.w]) {
      for (const off of [0, w / 2, w]) {
        const pos = ox - off
        const dist = Math.abs(pos - raw.x)
        if (dist <= SNAP) xc.push({ pos, dist, guides: [{ kind: 'v', x: ox }] })
      }
    }
    for (const oy of [o.y, o.y + o.h / 2, o.y + o.h]) {
      for (const off of [0, h / 2, h]) {
        const pos = oy - off
        const dist = Math.abs(pos - raw.y)
        if (dist <= SNAP) yc.push({ pos, dist, guides: [{ kind: 'h', y: oy }] })
      }
    }
  }

  // equal spacing along x among row-mates (nodes overlapping my vertical span)
  const row = others.filter((o) => o.y < raw.y + h && o.y + o.h > raw.y).sort((a, b) => a.x - b.x)
  for (let i = 0; i < row.length - 1; i++) {
    const a = row[i], b = row[i + 1]
    const span = b.x - (a.x + a.w)
    if (span <= 0) continue
    if (span > w) { // centered between a and b, equal gaps
      const gap = (span - w) / 2
      const pos = a.x + a.w + gap
      const dist = Math.abs(pos - raw.x)
      if (dist <= SNAP) {
        xc.push({ pos, dist, guides: spacingX(a.x + a.w, pos, pos + w, b.x, raw.y - 5, gap, gap) })
      }
    }
    const posR = b.x + b.w + span // continue the run rightward with the same gap
    const dR = Math.abs(posR - raw.x)
    if (dR <= SNAP) xc.push({ pos: posR, dist: dR, guides: spacingX(a.x + a.w, b.x, b.x + b.w, posR, raw.y - 5, span, span) })
    const posL = a.x - span - w   // …or leftward
    const dL = Math.abs(posL - raw.x)
    if (dL <= SNAP) xc.push({ pos: posL, dist: dL, guides: spacingX(posL + w, a.x, a.x + a.w, b.x, raw.y - 5, span, span) })
  }

  // equal spacing along y among column-mates
  const col = others.filter((o) => o.x < raw.x + w && o.x + o.w > raw.x).sort((a, b) => a.y - b.y)
  for (let i = 0; i < col.length - 1; i++) {
    const a = col[i], b = col[i + 1]
    const span = b.y - (a.y + a.h)
    if (span <= 0) continue
    if (span > h) {
      const gap = (span - h) / 2
      const pos = a.y + a.h + gap
      const dist = Math.abs(pos - raw.y)
      if (dist <= SNAP) {
        yc.push({ pos, dist, guides: spacingY(a.y + a.h, pos, pos + h, b.y, raw.x - 8, gap, gap) })
      }
    }
    const posB = b.y + b.h + span
    const dB = Math.abs(posB - raw.y)
    if (dB <= SNAP) yc.push({ pos: posB, dist: dB, guides: spacingY(a.y + a.h, b.y, b.y + b.h, posB, raw.x - 8, span, span) })
    const posT = a.y - span - h
    const dT = Math.abs(posT - raw.y)
    if (dT <= SNAP) yc.push({ pos: posT, dist: dT, guides: spacingY(posT + h, a.y, a.y + a.h, b.y, raw.x - 8, span, span) })
  }

  const bx = best(xc), by = best(yc)
  return {
    x: bx ? bx.pos : snapGrid(raw.x),
    y: by ? by.pos : snapGrid(raw.y),
    guides: [...(bx?.guides ?? []), ...(by?.guides ?? [])],
  }
}

function spacingX(g1a: number, g1b: number, g2a: number, g2b: number, y: number, gap1: number, gap2: number): Guide[] {
  return [
    { kind: 'v', x: g1a }, { kind: 'v', x: g1b }, { kind: 'v', x: g2a }, { kind: 'v', x: g2b },
    { kind: 'label', x: (g1a + g1b) / 2, y, text: String(Math.round(gap1)) },
    { kind: 'label', x: (g2a + g2b) / 2, y, text: String(Math.round(gap2)) },
  ]
}

function spacingY(g1a: number, g1b: number, g2a: number, g2b: number, x: number, gap1: number, gap2: number): Guide[] {
  return [
    { kind: 'h', y: g1a }, { kind: 'h', y: g1b }, { kind: 'h', y: g2a }, { kind: 'h', y: g2b },
    { kind: 'label', x, y: (g1a + g1b) / 2, text: String(Math.round(gap1)) },
    { kind: 'label', x, y: (g2a + g2b) / 2, text: String(Math.round(gap2)) },
  ]
}

function best(cands: AxisCand[]): AxisCand | null {
  let b: AxisCand | null = null
  for (const c of cands) if (!b || c.dist < b.dist) b = c
  return b
}

/* ================================================================= utils */

function toScene(scene: SVGSVGElement, clientX: number, clientY: number): Pt {
  const ctm = scene.getScreenCTM()
  if (!ctm) return { x: 0, y: 0 }
  const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse())
  return { x: p.x, y: p.y }
}

function hitNode(scene: SVGSVGElement, p: Pt, exclude: SVGGElement | null = null, margin = 0): SVGGElement | null {
  const ns = nodesOf(scene)
  for (let i = ns.length - 1; i >= 0; i--) {
    const n = ns[i]
    if (n === exclude) continue
    const g = getNodeGeom(n)
    if (p.x >= g.x - margin && p.x <= g.x + g.w + margin && p.y >= g.y - margin && p.y <= g.y + g.h + margin) {
      return n
    }
  }
  return null
}

function countEdges(scene: SVGSVGElement, nid: string): number {
  return edgesOf(scene).filter((ed) => {
    const r = parseEdgeRef(ed)
    return !!r && (r.from === nid || r.to === nid)
  }).length
}

function idOf(node: SVGGElement): string {
  return node.getAttribute('data-dia-node') ?? '?'
}

function slideOf(scene: SVGSVGElement): SlideEl {
  return (scene.closest('section.dia-slide') ?? scene.parentElement) as SlideEl
}

function snapGrid(v: number): number {
  return Math.round(v / GRID) * GRID
}

function domIndex(el: Element): number {
  return el.parentElement ? [...el.parentElement.children].indexOf(el) : -1
}

function geomEq(a: NodeGeom, b: NodeGeom): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}
