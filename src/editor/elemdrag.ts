/* Direct manipulation for slide elements: drag to move (inline transform
 * translate — geometry, like a scene node's data-x). Draggable units:
 * images (plus a bottom-right corner resize: width with the aspect held;
 * ⇧ sets height too), text blocks (role classes, lists, tables, quotes,
 * code), figures, and islands (whose coarse-move contract lives in profile
 * §6). Every svg surface belongs to the scene machinery (nodes, edges, and
 * free elements drag there), so svgs are left alone here. Every gesture
 * commits as ONE op via restore-then-apply, so undo returns exactly. */

import { state } from '../state'
import { setStyleProp, batch } from '../model/ops'
import { isEditingText } from './textedit'

const DRAG_MIN = 3
const CORNER_PX = 16

/** blocks that move as a unit; the INNERMOST match under the pointer wins,
 * except inside an island, where the island root is the unit */
const BLOCK_SEL = [
  '.dia-figure', '.dia-title', '.dia-kicker', '.dia-body', '.dia-caption',
  '.dia-footnote', 'blockquote', 'pre', 'ul', 'ol', 'table', 'dl',
].join(', ')

let wired = false

export function installElementDragging(): void {
  if (wired) return
  wired = true
  state.bus.on((e) => { if (e.type === 'deck-loaded') wire() })
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
}

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0 || isEditingText()) return
  const target = e.composedPath()[0]
  if (!(target instanceof Element)) return
  if (target.closest('svg')) return // every svg surface is the scene layer's
  const slide = target.closest<HTMLElement>('section.dia-slide')
  if (!slide) return

  // images keep the dedicated gesture: move + bottom-right corner resize
  if (target instanceof HTMLImageElement && !target.closest('[data-dia-island]')) {
    const r = target.getBoundingClientRect()
    const corner = r.right - e.clientX < CORNER_PX && r.bottom - e.clientY < CORNER_PX
    e.preventDefault()
    state.selection = { kind: 'element', el: target, slide }
    if (corner) beginResize(target, e, r)
    else beginMove(target, e, { immediate: true })
    return
  }

  // otherwise the draggable block: the island root when inside one (islands
  // move coarsely as a whole), else the innermost role/structure block
  const island = target.closest<HTMLElement>('[data-dia-island]')
  const block = island ?? target.closest<HTMLElement>(BLOCK_SEL)
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

function beginResize(img: HTMLImageElement, e: PointerEvent, r0: DOMRect): void {
  const prevW = img.style.width
  const prevH = img.style.height
  const c0 = { x: e.clientX, y: e.clientY }
  let moved = false

  session(
    (ev) => {
      if (!moved && Math.hypot(ev.clientX - c0.x, ev.clientY - c0.y) < DRAG_MIN) return
      moved = true
      document.body.style.cursor = 'nwse-resize'
      const w = Math.max(40, r0.width + (ev.clientX - c0.x))
      img.style.width = `${Math.round(w)}px`
      if (ev.shiftKey) img.style.height = `${Math.round(r0.height + (ev.clientY - c0.y))}px`
      else img.style.height = 'auto' // keep the aspect
    },
    () => {
      document.body.style.cursor = ''
      if (!moved) return
      const w = img.style.width
      const h = img.style.height
      img.style.width = prevW
      img.style.height = prevH
      state.apply(batch('Resize image', [
        setStyleProp(img, 'width', w),
        setStyleProp(img, 'height', h),
      ]))
    },
    () => { img.style.width = prevW; img.style.height = prevH; document.body.style.cursor = '' },
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
