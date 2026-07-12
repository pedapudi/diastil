/* Direct manipulation for images (and figures) in slides: drag to move
 * (inline transform translate — geometry, like a scene node's data-x),
 * drag the bottom-right corner to resize width (height stays auto so the
 * aspect holds; ⇧ ignores the aspect and sets height too). Every gesture
 * commits as ONE op via restore-then-apply, so undo returns exactly. */

import { state } from '../state'
import { setStyleProp, batch } from '../model/ops'
import { isEditingText } from './textedit'

const DRAG_MIN = 3
const CORNER_PX = 16

let wired = false

export function installImageEditing(): void {
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
  if (!(target instanceof HTMLImageElement)) return
  if (target.closest('[data-dia-island]') || target.closest('svg')) return
  const slide = target.closest<HTMLElement>('section.dia-slide')
  if (!slide) return

  const r = target.getBoundingClientRect()
  const corner = r.right - e.clientX < CORNER_PX && r.bottom - e.clientY < CORNER_PX
  e.preventDefault()
  state.selection = { kind: 'element', el: target, slide }
  if (corner) beginResize(target, e, r)
  else beginMove(target, e)
}

/** parse "translate(Xpx, Ypx)" back out of a transform we wrote earlier */
function baseTranslate(el: HTMLElement): { x: number; y: number; rest: string } {
  const t = el.style.transform
  const m = /^translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)\s*(.*)$/.exec(t)
  if (m) return { x: parseFloat(m[1]), y: parseFloat(m[2]), rest: m[3] }
  return { x: 0, y: 0, rest: t }
}

function beginMove(img: HTMLImageElement, e: PointerEvent): void {
  const prev = img.style.transform
  const base = baseTranslate(img)
  const c0 = { x: e.clientX, y: e.clientY }
  let moved = false

  session(
    (ev) => {
      if (!moved && Math.hypot(ev.clientX - c0.x, ev.clientY - c0.y) < DRAG_MIN) return
      moved = true
      document.body.style.cursor = 'grabbing'
      const x = base.x + (ev.clientX - c0.x)
      const y = base.y + (ev.clientY - c0.y)
      img.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)${base.rest ? ' ' + base.rest : ''}`
    },
    () => {
      document.body.style.cursor = ''
      if (!moved) return
      const final = img.style.transform
      img.style.transform = prev
      if (final !== prev) state.apply(setStyleProp(img, 'transform', final))
    },
    () => { img.style.transform = prev; document.body.style.cursor = '' },
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
