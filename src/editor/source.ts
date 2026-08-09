/* Raw LaTeX source view — first-party: a transparent-text textarea over a
 * highlight layer, with a line-number gutter and a find/replace bar. No soft
 * wrap (wrapping is where overlay alignment dies); long lines scroll sideways.
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
import { findInText, replaceAllIn, type FindOpts, type Hit } from './docfind'
import { highlightLine } from './texhl'

const HIGHLIGHT_OFF_LINES = 10000

/** the raw view searches BYTES: no whitespace collapsing, because here a
 * newline is a newline (the overlay mark is a run on one line, and a match
 * that spanned a line break could not be drawn) and because the user is
 * looking at the source, not at prose */
const SRC_FIND: FindOpts = { collapseSpace: false }

let container: HTMLElement | null = null
let ta!: HTMLTextAreaElement
let hl!: HTMLElement
let gutter!: HTMLElement
let findBar!: HTMLElement
let findInput!: HTMLInputElement
let findCount!: HTMLElement
let replaceRow!: HTMLElement
let replaceInput!: HTMLInputElement
let caseBtn!: HTMLButtonElement
let wordBtn!: HTMLButtonElement
let raf = 0
let lastLines: string[] = []
let lastHtml: string[] = []
let findMatches: Hit[] = []
let findAt = -1
let findOpts: FindOpts = { ...SRC_FIND }
let onExit: (() => void) | null = null

export function mountSourceView(mainEl: HTMLElement): void {
  container = document.createElement('div')
  container.className = 'de-src'
  container.hidden = true
  // a fresh bar's toggles are drawn off, so the options it reads start off
  // too — the two must not disagree
  findOpts = { ...SRC_FIND }

  findBar = document.createElement('div')
  findBar.className = 'de-src-find'
  findBar.hidden = true
  const findRow = document.createElement('div')
  findRow.className = 'de-src-findrow'
  findInput = document.createElement('input')
  findInput.className = 'dn-input'
  findInput.placeholder = 'find in source'
  findInput.setAttribute('spellcheck', 'false')
  findCount = document.createElement('span')
  findCount.className = 'de-src-findcount'
  caseBtn = togBtn('Aa', 'match case', () => {
    findOpts = { ...findOpts, caseSensitive: !findOpts.caseSensitive }
    syncToggles()
  })
  wordBtn = togBtn('ab', 'whole word', () => {
    findOpts = { ...findOpts, wholeWord: !findOpts.wholeWord }
    syncToggles()
  })
  const prev = navBtn('‹', -1)
  const next = navBtn('›', 1)
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'dn-btn'
  close.textContent = '✕'
  close.addEventListener('click', () => closeFind())
  findRow.append(findInput, findCount, caseBtn, wordBtn, prev, next, close)

  replaceRow = document.createElement('div')
  replaceRow.className = 'de-src-findrow'
  replaceRow.hidden = true
  replaceInput = document.createElement('input')
  replaceInput.className = 'dn-input'
  replaceInput.placeholder = 'replace with'
  replaceInput.setAttribute('spellcheck', 'false')
  const one = actBtn('replace', 'replace this match', () => replaceCurrent())
  const all = actBtn('all', 'replace every match', () => replaceAll())
  replaceRow.append(replaceInput, one, all)
  findBar.append(findRow, replaceRow)

  findInput.addEventListener('input', () => runFind())
  for (const field of [findInput, replaceInput]) {
    field.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey
      if (e.key === 'Enter') {
        e.preventDefault()
        if (field === replaceInput) replaceCurrent()
        else stepFind(e.shiftKey ? -1 : 1)
      }
      if (e.key === 'Escape') { e.preventDefault(); closeFind() }
      if (mod && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); findInput.focus(); findInput.select() }
      if (mod && (e.key === 'h' || e.key === 'H')) { e.preventDefault(); openFind(true) }
      e.stopPropagation()
    })
  }

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
    if ((e.metaKey || e.ctrlKey) && (e.key === 'h' || e.key === 'H')) {
      e.preventDefault()
      openFind(true)
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

function openFind(replace = false): void {
  findBar.hidden = false
  if (replace) replaceRow.hidden = false
  const field = replace && findInput.value ? replaceInput : findInput
  field.focus()
  field.select()
  runFind()
}

function closeFind(): void {
  findBar.hidden = true
  replaceRow.hidden = true
  findMatches = []
  findAt = -1
  findMark = null
  if (container && !container.hidden) render()
  ta.focus()
}

function syncToggles(): void {
  caseBtn.classList.toggle('is-on', !!findOpts.caseSensitive)
  wordBtn.classList.toggle('is-on', !!findOpts.wholeWord)
  runFind(findAt)
}

/** re-run the search; `keep` is the hit to land on (the step after a
 * replace, where the hit under the cursor has just disappeared) */
function runFind(keep = -1): void {
  const term = findInput.value
  findMatches = term.length > 0 ? findInText(ta.value, term, findOpts) : []
  findAt = -1
  findCount.textContent = findMatches.length ? `${findMatches.length}` : (term ? '0' : '')
  if (!findMatches.length) {
    findMark = null
    if (container && !container.hidden) render()
    return
  }
  findAt = keep >= 0 ? Math.min(keep, findMatches.length - 1) - 1 : -1
  stepFind(1)
}

function stepFind(dir: 1 | -1): void {
  if (!findMatches.length) return
  findAt = (findAt + dir + findMatches.length) % findMatches.length
  const { start, end } = findMatches[findAt]
  // mark in the overlay and scroll; focus stays in the find input so Enter
  // keeps cycling
  const before = ta.value.slice(0, start)
  const line = before.split('\n').length - 1
  const col = start - (before.lastIndexOf('\n') + 1)
  findMark = { line, col, len: end - start }
  render()
  const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 18
  ta.scrollTop = Math.max(0, line * lineHeight - ta.clientHeight / 3)
  syncScroll()
  findCount.textContent = `${findAt + 1}/${findMatches.length}`
}

/* Replacing here is a TEXTAREA edit, not an op: the source view's whole
 * session commits as one setDocSource op when it closes (or on Ctrl+S), so
 * a replace-all undoes with the rest of the session — coarse, but it is the
 * granularity this view has always had, and splitting it would mean two
 * competing writers on one buffer. */

function replaceCurrent(): void {
  if (findAt < 0 || !findMatches.length) return
  const { start, end } = findMatches[findAt]
  const landing = findAt
  ta.value = ta.value.slice(0, start) + replaceInput.value + ta.value.slice(end)
  render()
  runFind(landing)
}

function replaceAll(): void {
  if (!findMatches.length) return
  const r = replaceAllIn(ta.value, findInput.value, replaceInput.value, findOpts)
  if (r.count === 0) return
  ta.value = r.text
  render()
  runFind()
}

function navBtn(label: string, dir: 1 | -1): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'dn-btn'
  b.textContent = label
  b.addEventListener('click', () => stepFind(dir))
  return b
}

function actBtn(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'dn-btn de-src-findact'
  b.textContent = label
  b.title = title
  b.addEventListener('click', onClick)
  return b
}

function togBtn(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'dn-btn de-find-tog'
  b.textContent = label
  b.title = title
  b.addEventListener('click', onClick)
  return b
}
