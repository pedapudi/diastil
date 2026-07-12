/* In-place text editing + click selection inside the deck.
 * Listeners sit on the canvas host (click/dblclick are composed, so they
 * cross the shadow boundary and survive deck reloads); the real target is
 * recovered from composedPath(). Clicks inside svg.dia-scene are ignored —
 * the scene module owns those. */

import { state } from '../state'
import { setText } from '../model/ops'

const ROLE_SELECTOR = '.dia-title, .dia-kicker, .dia-body, .dia-caption'

let canvas!: HTMLElement
let editing: { el: HTMLElement; original: string } | null = null

const supportsPlaintextOnly = ((): boolean => {
  const d = document.createElement('div')
  d.setAttribute('contenteditable', 'plaintext-only')
  return d.contentEditable === 'plaintext-only'
})()

export function isEditingText(): boolean {
  return editing !== null
}

export function installTextEditing(canvasHost: HTMLElement): void {
  canvas = canvasHost
  canvas.addEventListener('click', onClick)
  canvas.addEventListener('dblclick', onDblClick)
  state.bus.on((e) => {
    if (e.type === 'selection') paintSelection()
    if (e.type === 'deck-loaded') { editing = null; paintSelection() }
  })
}

/* ---------- selection ---------- */

function onClick(e: MouseEvent): void {
  const target = e.composedPath()[0]
  if (!(target instanceof Element)) return
  if (editing && editing.el.contains(target)) return // clicks inside the live edit
  // the scene module owns every svg except island content
  if (target.closest('svg') && !target.closest('[data-dia-island]')) return
  const slide = target.closest<HTMLElement>('section.dia-slide')
  if (!slide) {
    state.selection = { kind: 'none' }
    return
  }
  const idx = state.slides().indexOf(slide)
  if (idx >= 0) state.setCurrentSlide(idx)
  if (target === slide) {
    state.selection = { kind: 'slide', slide }
    return
  }
  const el = target instanceof HTMLElement ? target : target.parentElement
  if (!el || !slide.contains(el) || el === slide) {
    state.selection = { kind: 'slide', slide }
    return
  }
  state.selection = { kind: 'element', el, slide }
}

/** mirror state.selection into the [data-dia-selected] ring attribute */
function paintSelection(): void {
  const root = state.deck?.root
  if (!root) return
  for (const el of root.querySelectorAll('[data-dia-selected]')) el.removeAttribute('data-dia-selected')
  const sel = state.selection
  if (sel.kind === 'element') sel.el.setAttribute('data-dia-selected', '')
  else if (sel.kind === 'slide') sel.slide.setAttribute('data-dia-selected', '')
}

/* ---------- text editing ---------- */

function onDblClick(e: MouseEvent): void {
  if (editing) return
  const target = e.composedPath()[0]
  if (!(target instanceof Element)) return
  if (target.closest('svg') && !target.closest('[data-dia-island]')) return
  const slide = target.closest<HTMLElement>('section.dia-slide')
  if (!slide) return
  const el = target instanceof HTMLElement ? target : null
  const editable = el ? editableFor(el, slide) : null
  if (editable) {
    e.preventDefault()
    beginEdit(editable)
    return
  }
  // dblclick with no editable text: just make the slide current
  const idx = state.slides().indexOf(slide)
  if (idx >= 0) state.setCurrentSlide(idx)
}

function editableFor(target: HTMLElement, slide: HTMLElement): HTMLElement | null {
  const role = target.closest<HTMLElement>(ROLE_SELECTOR)
  if (role && slide.contains(role) && role !== slide) {
    if (role.childElementCount === 0) return role
    // structured role container (e.g. .dia-body with <p> children):
    // edit the clicked leaf, never flatten the container
    if (isTextLeaf(target) && target !== slide) return target
    return null
  }
  return target !== slide && isTextLeaf(target) ? target : null
}

function isTextLeaf(el: HTMLElement): boolean {
  if (el.childElementCount !== 0) return false
  const tag = el.tagName
  if (tag === 'IMG' || tag === 'BR' || tag === 'HR' || tag === 'INPUT') return false
  return (el.textContent ?? '').trim().length > 0
}

function beginEdit(el: HTMLElement): void {
  // capture prev BEFORE editing starts, so the op's inverse is the original
  editing = { el, original: el.textContent ?? '' }
  el.setAttribute('contenteditable', supportsPlaintextOnly ? 'plaintext-only' : 'true')
  el.spellcheck = false
  el.addEventListener('keydown', onEditKey)
  el.addEventListener('blur', onEditBlur)
  el.focus()
  const range = document.createRange()
  range.selectNodeContents(el)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

function onEditKey(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault()
    e.stopPropagation()
    commitEdit()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    cancelEdit()
  }
}

function onEditBlur(): void {
  commitEdit()
}

function commitEdit(): void {
  if (!editing) return
  const { el, original } = editing
  const text = el.textContent ?? ''
  cleanupEdit(el)
  if (text !== original) {
    // restore the original first so setText captures it as prev (undo works)
    el.textContent = original
    state.apply(setText(el, text))
  }
}

function cancelEdit(): void {
  if (!editing) return
  const { el, original } = editing
  cleanupEdit(el)
  el.textContent = original
}

function cleanupEdit(el: HTMLElement): void {
  editing = null
  el.removeEventListener('keydown', onEditKey)
  el.removeEventListener('blur', onEditBlur)
  el.removeAttribute('contenteditable')
  el.removeAttribute('spellcheck')
  el.blur()
}
