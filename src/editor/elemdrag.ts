/* Direct manipulation for slide elements: drag to move (inline transform
 * translate — geometry, like a scene node's data-x). Draggable units:
 * images (plus a bottom-right corner resize: width with the aspect held;
 * ⇧ sets height too), text blocks (role classes, lists, tables, quotes,
 * code), figures, and islands (whose coarse-move contract lives in profile
 * §6). Every svg surface belongs to the scene machinery (nodes, edges, and
 * free elements drag there), so svgs are left alone here. Every gesture
 * commits as ONE op via restore-then-apply, so undo returns exactly. */

import type { Op } from '../types'
import { state } from '../state'
import { setAttr, setStyleProp, batch } from '../model/ops'
import { isEditingText } from './textedit'

const DRAG_MIN = 3
const CORNER_PX = 16

/** blocks that move as a unit; the INNERMOST match under the pointer wins,
 * except inside an island, where the island root is the unit.
 * Exported: the scene machinery yields ⇧-presses to these (see below). */
export const BLOCK_SEL = [
  '.dia-figure', '.dia-title', '.dia-kicker', '.dia-body', '.dia-caption',
  '.dia-footnote', 'blockquote', 'pre', 'ul', 'ol', 'table', 'dl', 'figure',
].join(', ')

/* what counts as a movable block is a STRUCTURAL rule, not an allow-list —
 * the same rule for every element, so dragging never works on one block
 * and dies on its neighbor */
const BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'UL', 'OL',
  'TABLE', 'DL', 'FIGURE', 'VIDEO',
])

/** the movable unit under a pointer target: the island root when inside
 * one (coarse-move contract, profile §6); else the INNERMOST element that
 * is a block — a dia-* role, math, a block tag, or any non-inline element
 * sitting directly on the slide (custom-class panels, wrappers) */
export function movableBlockFor(target: Element, slide: HTMLElement): HTMLElement | null {
  const island = target.closest<HTMLElement>('[data-dia-island]')
  if (island && island !== slide && slide.contains(island)) return island
  let el: Element | null = target
  while (el && el !== slide) {
    if (el instanceof HTMLElement && !el.classList.contains('dia-editor-artifact')) {
      const math = el.closest<HTMLElement>('.dia-math')
      if (math && slide.contains(math)) return math // formulas move whole
      const isBlockLike = getComputedStyle(el).display !== 'inline'
      // list markers are decoration riding a list item, never a unit
      const hasRole = !el.classList.contains('dia-marker') &&
        [...el.classList].some((c) => c.startsWith('dia-'))
      if (isBlockLike && (hasRole || BLOCK_TAGS.has(el.tagName))) return el
      if (isBlockLike && el.parentElement === slide) return el
    }
    el = el.parentElement
  }
  return null
}

let wired = false

export function installElementDragging(): void {
  if (wired) return
  wired = true
  state.bus.on((e) => {
    if (e.type === 'deck-loaded') wire()
    if (e.type === 'selection' || e.type === 'op' || e.type === 'undo' || e.type === 'redo') positionGrip()
  })
  if (state.deck) wire()
}

let ac: AbortController | null = null

function wire(): void {
  ac?.abort()
  const deck = state.deck
  if (!deck) return
  ac = new AbortController()
  deck.root.addEventListener('pointerdown', onPointerDown as EventListener, { signal: ac.signal })
  // suppress the browser's native image ghost-drag
  deck.root.addEventListener('dragstart', (e) => {
    const t = e.composedPath()[0]
    if (t instanceof HTMLImageElement) e.preventDefault()
  }, { signal: ac.signal })
  window.addEventListener('scroll', positionGrip, { capture: true, signal: ac.signal })
  window.addEventListener('resize', positionGrip, { signal: ac.signal })
}

/* ---------- the grab handle ----------
 * Selected svgs (and any element) are awkward to move: presses on svg
 * surfaces belong to the scene machinery, so the block itself has no
 * grabbable area. A small ✥ grip floats at the selection's top edge —
 * dragging it ALWAYS moves the selected element, whatever it is. */

let grip: HTMLButtonElement | null = null

function ensureGrip(root: ShadowRoot): HTMLButtonElement {
  if (grip?.isConnected) return grip
  grip = document.createElement('button')
  grip.type = 'button'
  grip.className = 'dia-editor-artifact dia-grab'
  grip.textContent = '✥'
  grip.title = 'drag to move the selected element'
  // theme-proof by construction, like the highlight boxes
  grip.style.cssText =
    'position: fixed; z-index: 60; width: 22px; height: 22px; display: none;' +
    'align-items: center; justify-content: center; padding: 0;' +
    'font: 13px/1 ui-monospace, monospace; cursor: grab;' +
    'color: #fff; background: #ff9500; border: 1.5px solid rgba(0,0,0,.45);' +
    'border-radius: 50%; box-shadow: 0 0 0 2px rgba(255,255,255,.85), 0 3px 10px rgba(0,0,0,.3);'
  grip.addEventListener('pointerdown', (e) => {
    const sel = state.selection
    if (sel.kind !== 'element') return
    e.preventDefault()
    e.stopPropagation()
    beginMove(sel.el, e, { immediate: true })
  })
  root.appendChild(grip)
  return grip
}

function positionGrip(): void {
  const root = state.deck?.root
  if (!root) return
  const g = ensureGrip(root)
  const sel = state.selection
  if (sel.kind !== 'element' || !sel.el.isConnected) {
    g.style.display = 'none'
    if (sizeGrip) sizeGrip.style.display = 'none'
    if (cropGrip) cropGrip.style.display = 'none'
    return
  }
  const r = sel.el.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) {
    g.style.display = 'none'
    if (sizeGrip) sizeGrip.style.display = 'none'
    if (cropGrip) cropGrip.style.display = 'none'
    return
  }
  g.style.display = 'flex'
  g.style.left = `${Math.round(r.left + r.width / 2 - 11)}px`
  g.style.top = `${Math.round(Math.max(2, r.top - 26))}px`
  const sg = ensureSizeGrip(root)
  if (resizable(sel.el)) {
    sg.style.display = 'flex'
    sg.style.left = `${Math.round(r.right - 9)}px`
    sg.style.top = `${Math.round(r.bottom - 9)}px`
  } else {
    sg.style.display = 'none'
  }
  const cg = ensureCropGrip(root)
  if (resizable(sel.el) && croppable(sel.el)) {
    cg.style.display = 'flex'
    cg.style.left = `${Math.round(r.right - 9 - 27)}px`
    cg.style.top = `${Math.round(r.bottom - 9)}px`
  } else {
    cg.style.display = 'none'
  }
}

/* ---------- the resize grip + the mode chip ----------
 * One ⤡ grip at the selection's bottom-right resizes ANY element, with
 * the semantics said OUT LOUD in a chip while dragging:
 *   text/containers — the box resizes, text reflows (⇧ also sets height)
 *   images          — scales aspect-held; ⇧ stretches; ⌥ CROPS the frame
 *   drawings (svg)  — contents scale; ⌥ crops/extends the CANVAS instead */

let sizeGrip: HTMLButtonElement | null = null
let cropGrip: HTMLButtonElement | null = null
let modeChip: HTMLDivElement | null = null

/* Alt+drag belongs to the window manager on Linux and middle buttons to
 * mice — chords are unreliable, so CROP gets its own grip. Modifiers
 * remain as accelerators only: Ctrl OR Alt (or ⌘) during a ⤡ drag. */
function gripStyle(cursor: string): string {
  return 'position: fixed; z-index: 60; width: 22px; height: 22px; display: none;' +
    'align-items: center; justify-content: center; padding: 0;' +
    `font: 13px/1 ui-monospace, monospace; cursor: ${cursor};` +
    'color: #fff; background: #ff9500; border: 1.5px solid rgba(0,0,0,.45);' +
    'border-radius: 50%; box-shadow: 0 0 0 2px rgba(255,255,255,.85), 0 3px 10px rgba(0,0,0,.3);'
}

function ensureCropGrip(root: ShadowRoot): HTMLButtonElement {
  if (cropGrip?.isConnected) return cropGrip
  cropGrip = document.createElement('button')
  cropGrip.type = 'button'
  cropGrip.className = 'dia-editor-artifact dia-grab'
  cropGrip.textContent = '⛶'
  cropGrip.title = 'drag to CROP or extend — images crop their frame, drawings crop/extend their canvas (contents keep their size)'
  cropGrip.style.cssText = gripStyle('nwse-resize')
  cropGrip.style.background = '#1f7a4d'
  cropGrip.addEventListener('pointerdown', (e) => {
    const sel = state.selection
    if (sel.kind !== 'element') return
    e.preventDefault()
    e.stopPropagation()
    beginBoxResize(sel.el, e, true)
  })
  root.appendChild(cropGrip)
  return cropGrip
}

/** crop mode applies to framed media: images, and drawings with a viewBox */
function croppable(el: HTMLElement): boolean {
  if (el instanceof HTMLImageElement) return true
  return el instanceof SVGSVGElement && el.hasAttribute('viewBox')
}

function ensureSizeGrip(root: ShadowRoot): HTMLButtonElement {
  if (sizeGrip?.isConnected) return sizeGrip
  sizeGrip = document.createElement('button')
  sizeGrip.type = 'button'
  sizeGrip.className = 'dia-editor-artifact dia-grab'
  sizeGrip.textContent = '⤡'
  sizeGrip.title = 'drag to resize — text reflows, images and drawings scale (Ctrl or Alt while dragging: crop instead)'
  sizeGrip.style.cssText = gripStyle('nwse-resize')
  sizeGrip.addEventListener('pointerdown', (e) => {
    const sel = state.selection
    if (sel.kind !== 'element') return
    e.preventDefault()
    e.stopPropagation()
    beginBoxResize(sel.el, e)
  })
  root.appendChild(sizeGrip)
  return sizeGrip
}

function showChip(text: string, ev: PointerEvent): void {
  const root = state.deck?.root
  if (!root) return
  if (!modeChip?.isConnected) {
    modeChip = document.createElement('div')
    modeChip.className = 'dia-editor-artifact dia-mode-chip'
    modeChip.style.cssText =
      'position: fixed; z-index: 62; pointer-events: none;' +
      'font: 10.5px/1.7 ui-monospace, monospace; letter-spacing: .02em;' +
      'padding: 1px 9px; border-radius: 999px; white-space: nowrap;' +
      'color: #fff; background: #1f2937; border: 1px solid rgba(255,255,255,.5);' +
      'box-shadow: 0 0 0 1.5px rgba(0,0,0,.35), 0 3px 10px rgba(0,0,0,.3);'
    root.appendChild(modeChip)
  }
  modeChip.textContent = text
  modeChip.style.left = `${ev.clientX + 16}px`
  modeChip.style.top = `${ev.clientY + 18}px`
  modeChip.style.display = 'block'
}

function hideChip(): void {
  if (modeChip) modeChip.style.display = 'none'
}

/** the slide itself and the full-slide drawing layer never box-resize */
function resizable(el: HTMLElement): boolean {
  return !el.classList.contains('dia-scene-full') && !el.matches('section.dia-slide')
}

function beginBoxResize(el: HTMLElement, e: PointerEvent, forceCrop = false): void {
  const svg = el instanceof SVGSVGElement ? el as SVGSVGElement : null
  const isImg = el instanceof HTMLImageElement
  const r0 = el.getBoundingClientRect()
  const c0 = { x: e.clientX, y: e.clientY }
  const prev = {
    width: el.style.width, height: el.style.height,
    objectFit: el.style.objectFit ?? '',
    viewBox: svg?.getAttribute('viewBox') ?? null,
  }
  // canvas mode needs the px→unit factor from the START of the gesture
  let vb: { x: number; y: number; w: number; h: number } | null = null
  if (prev.viewBox) {
    const n = prev.viewBox.trim().split(/[\s,]+/).map(Number)
    if (n.length === 4 && n.every(Number.isFinite) && n[2] > 0 && n[3] > 0)
      vb = { x: n[0], y: n[1], w: n[2], h: n[3] }
  }
  const unit = vb ? r0.width / vb.w : 1
  let moved = false

  const apply = (ev: PointerEvent): void => {
    const dx = ev.clientX - c0.x
    const dy = ev.clientY - c0.y
    const w = Math.max(40, r0.width + dx)
    const h = Math.max(24, r0.height + dy)
    const crop = forceCrop || ev.altKey || ev.ctrlKey || ev.metaKey
    if (svg) {
      if (crop && vb) {
        el.style.width = `${Math.round(w)}px`
        el.style.height = `${Math.round(h)}px`
        svg.setAttribute('viewBox',
          `${vb.x} ${vb.y} ${Math.max(20, Math.round(vb.w + dx / unit))} ${Math.max(20, Math.round(vb.h + dy / unit))}`)
        showChip(dx < 0 || dy < 0 ? 'canvas — cropping · contents keep their size' : 'canvas — extending · contents keep their size', ev)
      } else {
        if (prev.viewBox) svg.setAttribute('viewBox', prev.viewBox)
        el.style.width = `${Math.round(w)}px`
        el.style.height = prev.height || ''
        showChip('resize drawing — contents scale (⛶ grip or Ctrl/Alt: canvas crop)', ev)
      }
    } else if (isImg) {
      if (crop) {
        el.style.objectFit = 'cover'
        el.style.width = `${Math.round(w)}px`
        el.style.height = `${Math.round(h)}px`
        showChip('crop frame — the image crops, never squashes', ev)
      } else if (ev.shiftKey) {
        el.style.objectFit = prev.objectFit
        el.style.width = `${Math.round(w)}px`
        el.style.height = `${Math.round(h)}px`
        showChip('stretch — aspect unlocked', ev)
      } else {
        el.style.objectFit = prev.objectFit
        el.style.width = `${Math.round(w)}px`
        el.style.height = 'auto'
        showChip('resize image — scales, aspect held (⛶ grip or Ctrl/Alt: crop)', ev)
      }
    } else {
      el.style.width = `${Math.round(w)}px`
      if (ev.shiftKey) el.style.height = `${Math.round(h)}px`
      else el.style.height = prev.height || ''
      showChip(ev.shiftKey ? 'resize box — text reflows · height set too' : 'resize box — text reflows (⇧ sets height)', ev)
    }
    positionGrip()
  }

  const restore = (): void => {
    el.style.width = prev.width
    el.style.height = prev.height
    el.style.objectFit = prev.objectFit
    if (svg && prev.viewBox !== null) svg.setAttribute('viewBox', prev.viewBox)
  }

  session(
    (ev) => {
      if (!moved && Math.hypot(ev.clientX - c0.x, ev.clientY - c0.y) < DRAG_MIN) return
      moved = true
      document.body.style.cursor = 'nwse-resize'
      apply(ev)
      ev.preventDefault()
    },
    () => {
      document.body.style.cursor = ''
      hideChip()
      if (!moved) return
      const final = {
        width: el.style.width, height: el.style.height,
        objectFit: el.style.objectFit ?? '',
        viewBox: svg?.getAttribute('viewBox') ?? null,
      }
      restore()
      const ops: Op[] = []
      if (final.width !== prev.width) ops.push(setStyleProp(el, 'width', final.width))
      if (final.height !== prev.height) ops.push(setStyleProp(el, 'height', final.height))
      if (final.objectFit !== prev.objectFit) ops.push(setStyleProp(el, 'object-fit', final.objectFit))
      if (svg && final.viewBox !== null && final.viewBox !== prev.viewBox) ops.push(setAttr(svg, 'viewBox', final.viewBox))
      if (ops.length === 0) return
      const label = svg ? 'Resize drawing' : isImg ? 'Resize image' : 'Resize box'
      state.apply(ops.length === 1 ? ops[0] : batch(label, ops))
      positionGrip()
    },
    () => { restore(); document.body.style.cursor = ''; hideChip() },
  )
}

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0 || isEditingText()) return
  const target = e.composedPath()[0]
  if (!(target instanceof Element)) return
  // every svg surface belongs to the scene layer — EXCEPT under ⇧, which
  // escalates the grab to the containing block: a figure that is all svg
  // has no other surface to move it by (interact.ts yields the same press)
  if (target.closest('svg') && !e.shiftKey) return
  const slide = target.closest<HTMLElement>('section.dia-slide')
  if (!slide) return

  // images keep the dedicated gesture: move + bottom-right corner resize
  if (target instanceof HTMLImageElement && !target.closest('[data-dia-island]')) {
    const r = target.getBoundingClientRect()
    const corner = r.right - e.clientX < CORNER_PX && r.bottom - e.clientY < CORNER_PX
    e.preventDefault()
    state.selection = { kind: 'element', el: target, slide }
    if (corner) beginBoxResize(target, e)
    else beginMove(target, e, { immediate: true })
    return
  }

  // otherwise the draggable block, by the one structural rule
  const block = movableBlockFor(target, slide)
  if (!block || block === slide || !slide.contains(block)) return
  // no preventDefault here: a plain click must stay a click (selection),
  // and a dblclick must still reach the text editor — the drag engages
  // only once the pointer travels
  state.selection = { kind: 'element', el: block, slide }
  beginMove(block, e, { immediate: false })
}

/** parse "translate(Xpx, Ypx)" back out of a transform we wrote earlier */
function baseTranslate(el: HTMLElement): { x: number; y: number; rest: string } {
  const t = el.style.transform
  const m = /^translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)\s*(.*)$/.exec(t)
  if (m) return { x: parseFloat(m[1]), y: parseFloat(m[2]), rest: m[3] }
  return { x: 0, y: 0, rest: t }
}

function beginMove(el: HTMLElement, e: PointerEvent, opts: { immediate: boolean }): void {
  const prev = el.style.transform
  const base = baseTranslate(el)
  const c0 = { x: e.clientX, y: e.clientY }
  const prevSelect = document.body.style.userSelect
  let moved = false

  session(
    (ev) => {
      if (!moved && Math.hypot(ev.clientX - c0.x, ev.clientY - c0.y) < DRAG_MIN) return
      if (!moved && !opts.immediate) {
        // the gesture is now a drag, not a click — stop text selection
        document.body.style.userSelect = 'none'
        el.ownerDocument.defaultView?.getSelection()?.removeAllRanges()
      }
      moved = true
      document.body.style.cursor = 'grabbing'
      const x = base.x + (ev.clientX - c0.x)
      const y = base.y + (ev.clientY - c0.y)
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)${base.rest ? ' ' + base.rest : ''}`
      positionGrip() // the grab handle rides along
      ev.preventDefault()
    },
    () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = prevSelect
      if (!moved) return
      const final = el.style.transform
      el.style.transform = prev
      if (final !== prev) state.apply(setStyleProp(el, 'transform', final))
    },
    () => {
      el.style.transform = prev
      document.body.style.cursor = ''
      document.body.style.userSelect = prevSelect
    },
  )
}


function session(
  move: (e: PointerEvent) => void,
  up: () => void,
  cancel: () => void,
): void {
  const s = new AbortController()
  window.addEventListener('pointermove', move, { signal: s.signal })
  window.addEventListener('pointerup', () => { s.abort(); up() }, { signal: s.signal })
  window.addEventListener('pointercancel', () => { s.abort(); cancel() }, { signal: s.signal })
}
