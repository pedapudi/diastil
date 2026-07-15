/* In-place text editing + click selection inside the deck.
 * Listeners sit on the canvas host (click/dblclick are composed, so they
 * cross the shadow boundary and survive deck reloads); the real target is
 * recovered from composedPath(). Clicks inside svg.dia-scene are ignored —
 * the scene module owns those. */

import { state } from '../state'
import { batch, setAttr, setInlineHtml } from '../model/ops'
import { renderTex } from './math'
import { showToast as showEditToast } from '../scene/overlay'

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

/** inline formatting that may live INSIDE an editable text leaf — imported
 * decks are full of strong/em/span runs; rejecting them made most imported
 * text silently uneditable */
const INLINE_TAGS = new Set([
  'STRONG', 'EM', 'B', 'I', 'U', 'S', 'CODE', 'A', 'SPAN', 'MARK',
  'SMALL', 'SUB', 'SUP', 'BR', 'ABBR', 'KBD', 'WBR',
])

function isTextLeaf(el: HTMLElement): boolean {
  const tag = el.tagName
  if (tag === 'IMG' || tag === 'BR' || tag === 'HR' || tag === 'INPUT') return false
  if ((el.textContent ?? '').trim().length === 0) return false
  // a leaf may contain inline formatting, but no block structure
  return [...el.querySelectorAll('*')].every((c) => INLINE_TAGS.has(c.tagName))
}

function beginEdit(el: HTMLElement): void {
  // capture prev BEFORE editing starts, so the op's inverse is the original.
  // innerHTML, not textContent: leaves may carry inline markup (strong/em/…)
  // which the commit must preserve, not flatten
  editing = { el, original: el.innerHTML }
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
  const html = el.innerHTML
  const text = (el.textContent ?? '').trim()
  cleanupEdit(el)
  // typing $…$ (or $$…$$) as the WHOLE text turns the element into math:
  // LaTeX renders to MathML and the source persists on the element
  const tex = /^\$\$?([^$]+.*?)\$\$?$/s.exec(text)?.[1]?.trim()
  if (tex) {
    el.innerHTML = original
    if (commitAsMath(el, tex)) return
  }
  if (html !== original) {
    // restore the original first so the op captures it as prev (undo works)
    el.innerHTML = original
    state.apply(setInlineHtml(el, html))
  }
}

/** render + commit in one op: content, source attr, and the dia-math class */
function commitAsMath(el: HTMLElement, tex: string): boolean {
  const r = renderTex(tex)
  if ('error' in r) {
    showEditToast(`latex: ${r.error}`)
    return false
  }
  const cls = el.classList.contains('dia-math') ? null
    : `${el.getAttribute('class') ?? ''} dia-math`.trim()
  const ops = [
    setAttr(el, 'data-dia-tex', tex),
    setInlineHtml(el, r.mathml),
    ...(cls ? [setAttr(el, 'class', cls)] : []),
  ]
  state.apply(batch('Edit math', ops))
  return true
}

function cancelEdit(): void {
  if (!editing) return
  const { el, original } = editing
  cleanupEdit(el)
  el.innerHTML = original
}

function cleanupEdit(el: HTMLElement): void {
  editing = null
  el.removeEventListener('keydown', onEditKey)
  el.removeEventListener('blur', onEditBlur)
  el.removeAttribute('contenteditable')
  el.removeAttribute('spellcheck')
  el.blur()
}
