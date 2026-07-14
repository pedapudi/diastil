/* Point editor — drag the anchor and control points of an EXISTING path:
 * pen strokes, imported art paths, and freeform data-path node outlines.
 * This is deliberately the whole "illustrator" surface diastil takes on:
 * editing points of what is already semantic (a free <path>, a path-shaped
 * node) — never boolean ops, masks, or anonymous-geometry authoring.
 *
 * Every drag is ONE op (SetAttr d / data-path), so undo steps match
 * gestures. Handles are .dia-editor-artifact — serialize strips them. */

import { state } from '../state'
import { setAttr } from '../model/ops'
import { parsePathData, type Cmd } from '../ingest/svglift'
import { pxScale } from './overlay'
import { getNodeGeom, renderNodeShape } from './route'

const NS = 'http://www.w3.org/2000/svg'
const ARTIFACT = 'dia-editor-artifact'

export type PointTarget =
  | { kind: 'free'; scene: SVGSVGElement; el: SVGPathElement }
  | { kind: 'node'; scene: SVGSVGElement; node: SVGGElement }

/** one draggable point: cmd index + arg offset of its x (y = x+1) */
interface Handle { cmd: number; arg: number; control: boolean }

interface Session {
  target: PointTarget
  cmds: Cmd[]
  group: SVGGElement
  offBus: () => void
  offKey: () => void
}

let session: Session | null = null

export function pointEditActive(target?: PointTarget): boolean {
  if (!session) return false
  if (!target) return true
  return elOf(session.target) === elOf(target)
}

function elOf(t: PointTarget): Element {
  return t.kind === 'free' ? t.el : t.node
}

/** a free element is point-editable when it is a path whose data parses */
export function canPointEdit(el: SVGGraphicsElement): boolean {
  return el instanceof SVGPathElement && parsePathData(el.getAttribute('d') ?? '') !== null
}

export function closePointEditor(): void {
  if (!session) return
  session.group.remove()
  session.offBus()
  session.offKey()
  session = null
}

export function togglePointEditor(target: PointTarget): void {
  if (pointEditActive(target)) closePointEditor()
  else openPointEditor(target)
}

export function openPointEditor(target: PointTarget): boolean {
  closePointEditor()
  const cmds = readCmds(target)
  if (!cmds) return false
  const group = document.createElementNS(NS, 'g') as SVGGElement
  group.setAttribute('class', `${ARTIFACT} dia-points`)
  target.scene.appendChild(group)
  const offBus = state.bus.on((e) => {
    // undo/redo (or a copilot op) may rewrite the path under the editor —
    // re-read from the DOM so handles never show stale geometry
    if (e.type === 'op' || e.type === 'undo' || e.type === 'redo') {
      const fresh = session && readCmds(session.target)
      if (session && fresh) { session.cmds = fresh; renderHandles(session) }
      else closePointEditor()
    }
    if (e.type === 'selection') closePointEditor()
  })
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.stopPropagation(); closePointEditor() }
  }
  document.addEventListener('keydown', onKey, true)
  session = { target, cmds, group, offBus, offKey: () => document.removeEventListener('keydown', onKey, true) }
  renderHandles(session)
  return true
}

/* ---------- geometry: path data <-> scene coordinates ---------- */

/** parse the target's outline as ABSOLUTE commands in SCENE coordinates.
 * H/V collapse to L (same pixels, uniform two-coordinate handles). */
function readCmds(target: PointTarget): Cmd[] | null {
  const raw = target.kind === 'free'
    ? target.el.getAttribute('d')
    : target.node.getAttribute('data-path')
  const parsed = raw ? parsePathData(raw) : null
  if (!parsed) return null
  const out: Cmd[] = []
  let x = 0
  let y = 0
  for (const cmd of parsed) {
    if (cmd.c === 'H') out.push({ c: 'L', args: [cmd.args[0], y] })
    else if (cmd.c === 'V') out.push({ c: 'L', args: [x, cmd.args[0]] })
    else out.push({ c: cmd.c, args: [...cmd.args] })
    const cur = out[out.length - 1]
    if (cur.c !== 'Z' && cur.args.length >= 2) {
      x = cur.args[cur.args.length - 2]
      y = cur.args[cur.args.length - 1]
    }
  }
  if (target.kind === 'node') {
    // data-path lives in a 100×100-normalized space — map into the node box
    const g = getNodeGeom(target.node)
    for (const cmd of out) mapArgs(cmd, (px, py) => [g.x + (px / 100) * g.w, g.y + (py / 100) * g.h])
  }
  return out
}

function writeCmds(target: PointTarget, cmds: Cmd[]): void {
  if (target.kind === 'free') {
    state.apply(setAttr(target.el, 'd', serialize(cmds)))
    return
  }
  const g = getNodeGeom(target.node)
  const normalized = cmds.map((cmd) => ({ c: cmd.c, args: [...cmd.args] }))
  for (const cmd of normalized) {
    mapArgs(cmd, (px, py) => [
      g.w === 0 ? 0 : ((px - g.x) / g.w) * 100,
      g.h === 0 ? 0 : ((py - g.y) / g.h) * 100,
    ])
  }
  state.apply(setAttr(target.node, 'data-path', serialize(normalized)))
  renderNodeShape(target.node)
}

/** apply (x,y) → (x',y') to every COORDINATE pair; arcs keep rx/ry/flags */
function mapArgs(cmd: Cmd, fn: (x: number, y: number) => [number, number]): void {
  if (cmd.c === 'A') {
    const [nx, ny] = fn(cmd.args[5], cmd.args[6])
    cmd.args[5] = nx
    cmd.args[6] = ny
    return
  }
  for (let i = 0; i + 1 < cmd.args.length; i += 2) {
    const [nx, ny] = fn(cmd.args[i], cmd.args[i + 1])
    cmd.args[i] = nx
    cmd.args[i + 1] = ny
  }
}

function serialize(cmds: Cmd[]): string {
  return cmds.map((cmd) => cmd.c === 'Z' ? 'Z' : `${cmd.c}${cmd.args.map(r2).join(',')}`).join(' ')
}

function r2(n: number): number {
  return Math.round(n * 100) / 100
}

/* ---------- handles ---------- */

/** the draggable points of a command: control points first, endpoint last */
function handlesOf(cmds: Cmd[]): Handle[] {
  const out: Handle[] = []
  for (const [i, cmd] of cmds.entries()) {
    switch (cmd.c) {
      case 'M': case 'L': case 'T':
        out.push({ cmd: i, arg: 0, control: false })
        break
      case 'Q': case 'S':
        out.push({ cmd: i, arg: 0, control: true }, { cmd: i, arg: 2, control: false })
        break
      case 'C':
        out.push({ cmd: i, arg: 0, control: true }, { cmd: i, arg: 2, control: true }, { cmd: i, arg: 4, control: false })
        break
      case 'A':
        out.push({ cmd: i, arg: 5, control: false })
        break
    }
  }
  return out
}

function renderHandles(s: Session): void {
  s.group.textContent = ''
  const k = pxScale(s.target.scene)
  const cmds = s.cmds

  // dim outline of the edited path + control-arm ticks, so the structure
  // reads even when the path itself is thick or filled
  const trace = document.createElementNS(NS, 'path')
  trace.setAttribute('class', 'dia-points-trace')
  trace.setAttribute('d', serialize(cmds))
  s.group.appendChild(trace)
  for (const [i, cmd] of cmds.entries()) {
    if (cmd.c === 'C' || cmd.c === 'Q' || cmd.c === 'S') {
      const prev = endpointBefore(cmds, i)
      const arms = document.createElementNS(NS, 'path')
      arms.setAttribute('class', 'dia-points-arm')
      arms.setAttribute('d', armPath(cmd, prev))
      s.group.appendChild(arms)
    }
  }

  for (const handle of handlesOf(cmds)) {
    const cmd = cmds[handle.cmd]
    const x = cmd.args[handle.arg]
    const y = cmd.args[handle.arg + 1]
    const dot = document.createElementNS(NS, handle.control ? 'rect' : 'circle') as SVGGraphicsElement
    dot.setAttribute('class', `dia-point${handle.control ? ' is-control' : ''}`)
    if (dot instanceof SVGRectElement) {
      const r = 3.4 / k
      dot.setAttribute('x', String(x - r))
      dot.setAttribute('y', String(y - r))
      dot.setAttribute('width', String(2 * r))
      dot.setAttribute('height', String(2 * r))
    } else {
      dot.setAttribute('cx', String(x))
      dot.setAttribute('cy', String(y))
      dot.setAttribute('r', String(4.2 / k))
    }
    dot.addEventListener('pointerdown', (e) => beginDrag(e, handle))
    s.group.appendChild(dot)
  }
}

function endpointBefore(cmds: Cmd[], i: number): { x: number; y: number } {
  for (let j = i - 1; j >= 0; j--) {
    const c = cmds[j]
    if (c.c !== 'Z' && c.args.length >= 2) {
      return { x: c.args[c.args.length - 2], y: c.args[c.args.length - 1] }
    }
  }
  return { x: 0, y: 0 }
}

function armPath(cmd: Cmd, prev: { x: number; y: number }): string {
  if (cmd.c === 'C') {
    const [c1x, c1y, c2x, c2y, ex, ey] = cmd.args
    return `M${r2(prev.x)},${r2(prev.y)} L${r2(c1x)},${r2(c1y)} M${r2(ex)},${r2(ey)} L${r2(c2x)},${r2(c2y)}`
  }
  const [cx, cy, ex, ey] = cmd.args
  return `M${r2(prev.x)},${r2(prev.y)} L${r2(cx)},${r2(cy)} M${r2(ex)},${r2(ey)} L${r2(cx)},${r2(cy)}`
}

/* ---------- dragging ---------- */

function beginDrag(e: PointerEvent, handle: Handle): void {
  if (!session) return
  e.preventDefault()
  e.stopPropagation()
  const s = session
  const el = elOf(s.target) as SVGGraphicsElement
  const liveTarget = s.target.kind === 'node'
    ? s.target.node.querySelector<SVGGraphicsElement>('.dia-node-shape')
    : (s.target as { el: SVGPathElement }).el
  const originalAttr = s.target.kind === 'free'
    ? el.getAttribute('d')
    : liveTarget?.getAttribute('d')

  const move = (ev: PointerEvent): void => {
    const p = toScene(s.target.scene, ev.clientX, ev.clientY)
    const cmd = s.cmds[handle.cmd]
    cmd.args[handle.arg] = p.x
    cmd.args[handle.arg + 1] = p.y
    // live preview on the rendered element; the op lands on release
    liveTarget?.setAttribute('d', serialize(s.cmds))
    renderHandles(s)
  }
  const up = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    // restore the pre-drag rendering so the op captures the true previous
    // value, then commit the whole gesture as ONE op
    if (originalAttr != null) liveTarget?.setAttribute('d', originalAttr)
    writeCmds(s.target, s.cmds)
    if (session === s) {
      const fresh = readCmds(s.target)
      if (fresh) { s.cmds = fresh; renderHandles(s) }
    }
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

function toScene(scene: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
  const ctm = scene.getScreenCTM()
  if (!ctm) return { x: 0, y: 0 }
  const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse())
  return { x: p.x, y: p.y }
}
