/* Raw LaTeX source view — first-party: a transparent-text textarea over a
 * highlight layer, with a line-number gutter and a find bar. No soft wrap
 * (wrapping is where overlay alignment dies); long lines scroll sideways.
 * While this view is open the native surface is inert — exactly one
 * writer. Leaving the view (or Ctrl+S) commits ONE setDocSource op; the
 * reconcile keeps unchanged blocks' identity, so comment anchors and
 * selection survive a source session.
 *
 * Above HIGHLIGHT_OFF_LINES the overlay drops to plain text (the gutter
 * and editing stay) — honesty about the technique's limits beats a
 * stuttering editor. */

import { state } from '../state'
import { commitSourceEdit, topBlockOf } from '../doc/sync'
import { highlightLine } from './texhl'

const HIGHLIGHT_OFF_LINES = 10000

let container: HTMLElement | null = null
let ta!: HTMLTextAreaElement
let hl!: HTMLElement
let gutter!: HTMLElement
let findBar!: HTMLElement
let findInput!: HTMLInputElement
let findCount!: HTMLElement
let raf = 0
let lastLines: string[] = []
let lastHtml: string[] = []
let findMatches: number[] = []
let findAt = -1
let onExit: (() => void) | null = null

export function mountSourceView(mainEl: HTMLElement): void {
  container = document.createElement('div')
  container.className = 'de-src'
  container.hidden = true

  findBar = document.createElement('div')
  findBar.className = 'de-src-find'
  findBar.hidden = true
  findInput = document.createElement('input')
  findInput.className = 'dn-input'
  findInput.placeholder = 'find in source'
  findInput.setAttribute('spellcheck', 'false')
  findCount = document.createElement('span')
  findCount.className = 'de-src-findcount'
  const prev = navBtn('‹', -1)
  const next = navBtn('›', 1)
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'dn-btn'
  close.textContent = '✕'
  close.addEventListener('click', () => closeFind())
  findBar.append(findInput, findCount, prev, next, close)
  findInput.addEventListener('input', () => runFind())
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1) }
    if (e.key === 'Escape') { e.preventDefault(); closeFind() }
    e.stopPropagation()
  })

  const body = document.createElement('div')
  body.className = 'de-src-body'
  gutter = document.createElement('div')
  gutter.className = 'de-src-gutter'
  const scroll = document.createElement('div')
  scroll.className = 'de-src-scroll'
  hl = document.createElement('pre')
  hl.className = 'de-src-hl'
  hl.setAttribute('aria-hidden', 'true')
  ta = document.createElement('textarea')
  ta.className = 'de-src-ta'
  ta.setAttribute('spellcheck', 'false')
  ta.setAttribute('autocapitalize', 'off')
  ta.setAttribute('autocomplete', 'off')
  ta.wrap = 'off'
  scroll.append(hl, ta)
  body.append(gutter, scroll)
  container.append(findBar, body)
  mainEl.append(container)

  ta.addEventListener('input', schedule)
  ta.addEventListener('scroll', syncScroll, { passive: true })
  ta.addEventListener('keydown', (e) => {
    // the editor is a typing surface — no global shortcuts leak out, but
    // save and find are handled HERE
    if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault()
      commitNow()
      // fall through to the shell's save via a synthetic event is fragile;
      // the commit is the important half — the user can save after
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault()
      openFind()
    }
    if (e.key === 'Tab') {
      // Tab types two spaces instead of leaving the field
      e.preventDefault()
      const { selectionStart, selectionEnd, value } = ta
      ta.value = value.slice(0, selectionStart) + '  ' + value.slice(selectionEnd)
      ta.selectionStart = ta.selectionEnd = selectionStart + 2
      schedule()
    }
    e.stopPropagation()
  })
}

/* ---------- activation ---------- */

export function sourceViewOpen(): boolean {
  return container !== null && !container.hidden
}

/** show the source view; exitCb runs after every commit-and-close */
export function activateSource(exitCb?: () => void): void {
  if (!container || !state.doc) return
  onExit = exitCb ?? null
  ta.value = state.doc.source.text
  lastLines = []
  lastHtml = []
  container.hidden = false
  render()
  ta.focus()
}

/** commit (if dirty) and hide; returns whether a source op was applied */
export function deactivateSource(): boolean {
  if (!container || container.hidden) return false
  const changed = commitNow()
  container.hidden = true
  closeFind()
  onExit?.()
  return changed
}

/** jump the source view to a block's first line (island dblclick, error
 * rows); opens the view when needed via the exit callback chain */
export function sourceJumpToOffset(offset: number): void {
  if (!container || container.hidden || !state.doc) return
  const line = state.doc.source.lineOf(offset)
  jumpToLine(line)
}

export function jumpToLine(line: number): void {
  if (!container || container.hidden || !state.doc) return
  const start = state.doc.source.offsetOfLine(line)
  const end = state.doc.source.offsetOfLine(line + 1)
  ta.focus()
  ta.setSelectionRange(start, Math.max(start, end - 1))
  // place the target line roughly a third down the viewport
  const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 18
  ta.scrollTop = Math.max(0, (line - 1) * lineHeight - ta.clientHeight / 3)
  syncScroll()
}

/** the offset of a block element's source span start, for jump entries */
export function blockOffsetOf(el: Element): number | null {
  const doc = state.doc
  if (!doc) return null
  const block = topBlockOf(doc, el)
  const id = block?.getAttribute('data-dia-id')
  const span = id ? doc.source.spanOf(id) : null
  return span ? span.start : null
}

function commitNow(): boolean {
  if (!state.doc) return false
  return commitSourceEdit(state.doc, ta.value)
}

/* ---------- rendering ---------- */

function schedule(): void {
  if (raf) return
  raf = requestAnimationFrame(() => { raf = 0; render() })
}

/** current find hit, marked in the OVERLAY — a selection in an unfocused
 * textarea is invisible, the overlay mark is not */
let findMark: { line: number; col: number; len: number } | null = null

function render(): void {
  const lines = ta.value.split('\n')
  const off = lines.length > HIGHLIGHT_OFF_LINES
  const html: string[] = new Array(lines.length)
  for (let i = 0; i < lines.length; i++) {
    if (!off && lines[i] === lastLines[i] && lastHtml[i] !== undefined) {
      html[i] = lastHtml[i]
    } else {
      html[i] = off ? escapePlain(lines[i]) : highlightLine(lines[i])
    }
  }
  lastLines = lines
  lastHtml = [...html]
  if (findMark && findMark.line < lines.length) {
    const { line, col, len } = findMark
    const text = lines[line]
    html[line] =
      (off ? escapePlain(text.slice(0, col)) : highlightLine(text.slice(0, col))) +
      `<mark class="hl-find">${escapePlain(text.slice(col, col + len))}</mark>` +
      (off ? escapePlain(text.slice(col + len)) : highlightLine(text.slice(col + len)))
  }
  // a trailing newline needs a phantom line so heights match the textarea
  hl.innerHTML = html.join('\n') + '\n'
  renderGutter(lines.length)
  syncScroll()
}

function escapePlain(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function renderGutter(count: number): void {
  if (gutter.childElementCount === count) return
  const frag = document.createDocumentFragment()
  for (let i = 1; i <= count; i++) {
    const n = document.createElement('div')
    n.textContent = String(i)
    frag.append(n)
  }
  gutter.replaceChildren(frag)
}

function syncScroll(): void {
  hl.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`
  gutter.style.transform = `translateY(${-ta.scrollTop}px)`
}

/* ---------- find ---------- */

function openFind(): void {
  findBar.hidden = false
  findInput.focus()
  findInput.select()
  runFind()
}

function closeFind(): void {
  findBar.hidden = true
  findMatches = []
  findAt = -1
  findMark = null
  if (container && !container.hidden) render()
}

function runFind(): void {
  const term = findInput.value
  findMatches = []
  findAt = -1
  if (term.length > 0) {
    const text = ta.value
    let at = text.indexOf(term)
    while (at >= 0 && findMatches.length < 5000) {
      findMatches.push(at)
      at = text.indexOf(term, at + term.length)
    }
  }
  findCount.textContent = findMatches.length ? `${findMatches.length}` : (term ? '0' : '')
  if (findMatches.length) stepFind(1)
}

function stepFind(dir: 1 | -1): void {
  if (!findMatches.length) return
  findAt = (findAt + dir + findMatches.length) % findMatches.length
  const at = findMatches[findAt]
  const term = findInput.value
  // mark in the overlay and scroll; focus stays in the find input so Enter
  // keeps cycling
  const before = ta.value.slice(0, at)
  const line = before.split('\n').length - 1
  const col = at - (before.lastIndexOf('\n') + 1)
  findMark = { line, col, len: term.length }
  render()
  const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 18
  ta.scrollTop = Math.max(0, line * lineHeight - ta.clientHeight / 3)
  syncScroll()
  findCount.textContent = `${findAt + 1}/${findMatches.length}`
}

function navBtn(label: string, dir: 1 | -1): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'dn-btn'
  b.textContent = label
  b.addEventListener('click', () => stepFind(dir))
  return b
}
