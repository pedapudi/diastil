/* In-place text editing + click selection inside the deck.
 * Listeners sit on the canvas host (click/dblclick are composed, so they
 * cross the shadow boundary and survive deck reloads); the real target is
 * recovered from composedPath(). Clicks inside svg.dia-scene are ignored —
 * the scene module owns those. */

import { state } from '../state'
import { batch, insertEl, setAttr, setInlineHtml } from '../model/ops'
import { renderTex } from './math'
import { mathToMathml } from '../latex/render'
import { commitDocEdit, topBlockOf } from '../doc/sync'
import { showToast as showEditToast } from '../scene/overlay'

const ROLE_SELECTOR = '.dia-title, .dia-kicker, .dia-body, .dia-caption'
/** document-mode editable leaves — prose shapes, not slide roles */
const DOC_LEAF = 'p, h1.dia-sec, h2.dia-sec, h3.dia-sec, h4.dia-sec, h5.dia-sec, figcaption, li, dt, dd, td'

let canvas!: HTMLElement
let editing: { el: HTMLElement; original: string; math?: boolean } | null = null

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
    if (e.type === 'deck-loaded' || e.type === 'doc-loaded') { editing = null; paintSelection() }
  })
}

/* ---------- selection ---------- */

function onClick(e: MouseEvent): void {
  const target = e.composedPath()[0]
  if (!(target instanceof Element)) return
  if (editing && editing.el.contains(target)) return // clicks inside the live edit
  // document mode: a click selects the top-level block (visible ring) and
  // tracks the current block
  if (state.doc) {
    const block = topBlockOf(state.doc, target)
    if (block) {
      const idx = state.blocks().indexOf(block)
      if (idx >= 0) state.setCurrentBlock(idx)
      state.selection = { kind: 'block', block }
    } else {
      state.selection = { kind: 'none' }
    }
    return
  }
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
  const root = state.deck?.root ?? state.doc?.root
  if (!root) return
  for (const el of root.querySelectorAll('[data-dia-selected]')) el.removeAttribute('data-dia-selected')
  const sel = state.selection
  if (sel.kind === 'element') sel.el.setAttribute('data-dia-selected', '')
  else if (sel.kind === 'slide') sel.slide.setAttribute('data-dia-selected', '')
  else if (sel.kind === 'block') sel.block.setAttribute('data-dia-selected', '')
}

/* ---------- text editing ---------- */

function onDblClick(e: MouseEvent): void {
  if (editing) return
  const target = e.composedPath()[0]
  if (!(target instanceof Element)) return
  if (state.doc) {
    const el = target instanceof HTMLElement ? target : target.parentElement
    const editable = el ? docEditableFor(state.doc.article, el) : null
    if (editable) {
      e.preventDefault()
      beginEdit(editable)
    }
    return
  }
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

/** doc-mode editable target: math (as its TeX), else the innermost prose
 * leaf holding no block structure. Islands edit in the source view.
 * Exported because the compiled mirror opens blocks the same way a
 * double-click does, and there must be one answer to "what is editable
 * here", not two. */
export function docEditableFor(article: HTMLElement, target: HTMLElement): HTMLElement | null {
  if (!article.contains(target)) return null
  const math = target.closest<HTMLElement>('.dia-math')
  if (math) return math
  const island = target.closest<HTMLElement>('.dia-tex-island')
  if (island && state.doc) {
    // islands are raw LaTeX — dblclick jumps into the source view at their
    // line rather than pretending they are prose
    const id = topBlockOf(state.doc, island)?.getAttribute('data-dia-id')
    const span = id ? state.doc.source.spanOf(id) : null
    window.dispatchEvent(new CustomEvent('dia-open-source', {
      detail: { line: span ? state.doc.source.lineOf(span.start) : undefined },
    }))
    return null
  }
  if (target.closest('.dia-doc-header')) return null
  const leaf = target.closest<HTMLElement>(DOC_LEAF)
  if (!leaf) return null
  const hasBlockChild = [...leaf.children].some((c) =>
    c.matches('ul, ol, dl, table, figure, div, pre, p, h1, h2, h3, h4, h5'))
  return hasBlockChild ? null : leaf
}

function editableFor(target: HTMLElement, slide: HTMLElement): HTMLElement | null {
  // math edits as its SOURCE: double-click swaps the rendered MathML for
  // the data-dia-tex text, commit re-renders — math is ordinary text here
  const math = target.closest<HTMLElement>('.dia-math')
  if (math && slide.contains(math) && math !== slide) return math
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

/** begin an in-place edit programmatically (insert-then-type flows) */
export function startEdit(el: HTMLElement): void {
  if (!editing) beginEdit(el)
}

/** insert a body text block before the slide footer and start editing */
export function insertTextOnSlide(slide: HTMLElement): HTMLElement {
  const el = document.createElement('p')
  el.className = 'dia-body'
  el.textContent = 'new text'
  const foot = slide.querySelector(':scope > .dia-caption.foot')
  const index = foot ? [...slide.children].indexOf(foot) : slide.children.length
  state.apply(insertEl(slide, index, el, 'Insert text'))
  state.selection = { kind: 'element', el, slide }
  startEdit(el)
  return el
}

function beginEdit(el: HTMLElement): void {
  // capture prev BEFORE editing starts, so the op's inverse is the original.
  // innerHTML, not textContent: leaves may carry inline markup (strong/em/…)
  // which the commit must preserve, not flatten
  const math = el.classList.contains('dia-math')
  editing = { el, original: el.innerHTML, math }
  if (math) el.textContent = el.getAttribute('data-dia-tex') ?? ''
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
  const { el, original, math } = editing
  const html = el.innerHTML
  const text = (el.textContent ?? '').trim()
  cleanupEdit(el)
  // document mode has its own commit shape: every DOM change pairs with a
  // LaTeX source patch in one undo step (doc/sync.ts)
  if (state.doc) {
    commitDocLeaf(el, original, html, text, !!math)
    return
  }
  // a math element's edit surface IS its TeX — re-render or keep the old
  // rendering (an unparseable edit toasts and changes nothing)
  if (math) {
    el.innerHTML = original
    if (text && text !== (el.getAttribute('data-dia-tex') ?? '').trim()) commitAsMath(el, text, true)
    return
  }
  // typing LaTeX as the WHOLE text turns the element into math: either
  // explicitly delimited ($…$ / $$…$$), or simply starting with a TeX
  // command (\frac{a}{b}…). Explicit math reports its errors; bare text
  // that happens to start with a backslash falls back to plain text.
  const delimited = /^\$\$?([^$]+.*?)\$\$?$/s.exec(text)?.[1]?.trim()
  const bare = !delimited && /^\\[a-zA-Z]/.test(text) ? text : null
  if (delimited || bare) {
    el.innerHTML = original
    if (commitAsMath(el, delimited ?? bare!, !!delimited)) return
  }
  if (html !== original) {
    // restore the original first so the op captures it as prev (undo works)
    el.innerHTML = original
    state.apply(setInlineHtml(el, html))
  }
}

/* ---------- document-mode commit ---------- */

function commitDocLeaf(el: HTMLElement, original: string, html: string, text: string, math: boolean): void {
  const doc = state.doc
  if (!doc) return
  if (math) {
    el.innerHTML = original
    const prevTex = (el.getAttribute('data-dia-tex') ?? '').trim()
    if (!text || text === prevTex) return
    const display = el.tagName !== 'SPAN'
    const mathml = mathToMathml(text, el.getAttribute('data-dia-env') ?? undefined, display)
    if (mathml === null) {
      showEditToast('latex: formula does not parse — kept the previous one')
      return
    }
    commitDocEdit(doc, el, [setAttr(el, 'data-dia-tex', text), setInlineHtml(el, mathml)], 'Edit math')
    return
  }
  // inline math authoring in prose: $…$ runs typed into a leaf become
  // rendered inline math spans on commit
  const enriched = docifyInlineMath(html)
  if (enriched === original) return
  el.innerHTML = original // the op captures the true previous children
  commitDocEdit(doc, el, [setInlineHtml(el, enriched)], 'Edit text')
}

/** replace $…$ runs in text nodes (outside existing math) with rendered
 * inline math spans; unparseable runs stay literal text. Exported for tests. */
export function docifyInlineMath(html: string): string {
  const tmp = document.createElement('div')
  tmp.innerHTML = html
  const texts: Text[] = []
  const collect = (node: Node): void => {
    if (node instanceof HTMLElement && node.classList.contains('dia-math')) return
    if (node.nodeType === Node.TEXT_NODE) texts.push(node as Text)
    else for (const child of node.childNodes) collect(child)
  }
  collect(tmp)
  for (const t of texts) {
    const value = t.textContent ?? ''
    if (!/\$[^$\n]+\$/.test(value)) continue
    const frag = document.createDocumentFragment()
    let last = 0
    for (const m of value.matchAll(/\$([^$\n]+)\$/g)) {
      const mathml = mathToMathml(m[1], undefined, false)
      if (mathml === null) continue // stays literal — honest about not parsing
      frag.append(value.slice(last, m.index))
      const span = document.createElement('span')
      span.className = 'dia-math dia-math-inline'
      span.setAttribute('data-dia-tex', m[1])
      span.innerHTML = mathml
      frag.append(span)
      last = m.index + m[0].length
    }
    if (last === 0) continue
    frag.append(value.slice(last))
    t.replaceWith(frag)
  }
  return tmp.innerHTML
}

/** render + commit in one op: content, source attr, and the dia-math class */
function commitAsMath(el: HTMLElement, tex: string, explicit: boolean): boolean {
  const r = renderTex(tex)
  if ('error' in r) {
    if (explicit) showEditToast(`latex: ${r.error}`)
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
