/* Stable compiled-page editor.
 *
 * The last good PDF stays mounted while a detached, source-backed editor is
 * positioned over the selected block.  Surrounding type never reflows. */

import { state } from '../state'
import { SERVICE_BASE } from '../service/client'
import { documentLayout, rectsForBlock, type DocumentLayout, type PageRect } from '../doc/pagelayout'
import { compilePageDraft, lastCompileJobId, onCompileState } from './doccompile'
import { pagesInfo, DEFAULT_PAGE_DPI, type PageDims } from '../doc/pdfpages'
import { fetchSynctex, type SynctexRecord } from '../doc/blockmirror'
import { idForLine } from './problems'
import { commitDocDraft, docDraftValue, docEditableFor } from './textedit'
import { topBlockOf } from '../doc/sync'

const DRAFT_IDLE_MS = 650

let container: HTMLElement | null = null
let column: HTMLElement
let note: HTMLElement
let a11y: HTMLElement
let shownJob: string | null = null
let records: SynctexRecord[] = []
let fallback: (block: HTMLElement) => void = () => {}
const sheets = new Map<number, { el: HTMLElement; dims: PageDims }>()
let selected: HTMLElement | null = null
let marks: HTMLElement[] = []
let edit: {
  target: HTMLElement
  host: HTMLElement
  field: HTMLElement
  label: HTMLElement
  baseLabel: string
  math: boolean
  last: string
  timer: number
  logStart: number
  committed: boolean
} | null = null

export function mountPagesView(mainEl: HTMLElement, onFallback: (block: HTMLElement) => void): void {
  fallback = onFallback
  container = document.createElement('div')
  container.className = 'de-docscroll de-pagescroll'
  container.hidden = true
  column = document.createElement('div')
  column.className = 'de-pagecol'
  note = document.createElement('div')
  note.className = 'de-pages-note'
  column.append(note)
  a11y = document.createElement('article')
  a11y.className = 'de-page-a11y'
  a11y.setAttribute('aria-label', 'Document text')
  container.append(column, a11y)
  mainEl.append(container)

  onCompileState((s) => {
    if (s.status === 'compiling' && edit) {
      edit.host.classList.add('is-compiling')
      edit.label.textContent = edit.baseLabel
    }
    if (s.status === 'failed' && edit) {
      const message = s.errors[0]?.message ?? s.detail ?? 'compile failed — open problems for details'
      edit.host.classList.remove('is-compiling')
      edit.host.classList.add('is-error')
      edit.label.textContent = message.length > 72 ? `${message.slice(0, 69)}…` : message
      edit.label.title = message
    }
    if (s.status === 'ok') {
      if (edit) {
        edit.host.classList.remove('is-compiling', 'is-error')
        edit.label.textContent = edit.baseLabel
        edit.label.title = ''
      }
      if (container && !container.hidden) void refresh()
    }
  })
  window.addEventListener('dia-document-layout', () => {
    paintSelection()
    positionEditor()
  })
  state.bus.on((event) => {
    if (event.type === 'doc-loaded') {
      closeEditor(false)
      selected = null
      shownJob = null
      records = []
      sheets.clear()
      syncAccessibleText()
    } else if (event.type === 'op') {
      syncAccessibleText()
    } else if (event.type === 'selection') {
      selected = event.sel.kind === 'block' ? event.sel.block : null
      paintSelection()
    } else if (event.type === 'undo' || event.type === 'redo' || event.type === 'blocks-changed') {
      closeEditor(false)
      syncAccessibleText()
      paintSelection()
    }
  })
}

function syncAccessibleText(): void {
  const article = state.doc?.article
  if (!article || !a11y) { if (a11y) a11y.textContent = ''; return }
  const clone = article.cloneNode(true) as HTMLElement
  for (const artifact of clone.querySelectorAll('.dia-editor-artifact')) artifact.remove()
  for (const el of clone.querySelectorAll('[data-dia-id], [data-dia-selected], [contenteditable]')) {
    el.removeAttribute('data-dia-id')
    el.removeAttribute('data-dia-selected')
    el.removeAttribute('contenteditable')
  }
  a11y.replaceChildren(...clone.childNodes)
}

export function activatePages(): void {
  if (!container) return
  container.hidden = false
  void refresh()
}

export function deactivatePages(): void {
  if (container) container.hidden = true
  closeEditor(true)
}

/** Navigation entry point for outline, find, comments, and diagnostics. */
export function scrollToPageBlock(block: HTMLElement): boolean {
  const rect = rectsForBlock(block)[0]
  const sheet = rect ? sheets.get(rect.page) : null
  if (!rect || !sheet || !container) return false
  selected = block
  state.selection = { kind: 'block', block }
  sheet.el.scrollIntoView({ block: 'center' })
  paintSelection()
  return true
}

async function refresh(): Promise<void> {
  if (!container || !state.doc) return
  const jobId = lastCompileJobId()
  if (!jobId) {
    showNote('no compiled pages yet — editing opens when the first compile succeeds')
    return
  }
  if (jobId === shownJob) { paintSelection(); return }
  const info = await pagesInfo(jobId)
  if (!info?.available || lastCompileJobId() !== jobId || !container) {
    showNote('compiled pages are unavailable — use the semantic or source view')
    return
  }
  const nextRecords = await fetchSynctex(jobId)
  if (lastCompileJobId() !== jobId) return

  // Build off-DOM, then replace once: a successful compile never flashes a
  // blank page column between the old and new render.
  const fragment = document.createDocumentFragment()
  const nextSheets = new Map<number, { el: HTMLElement; dims: PageDims }>()
  const images: HTMLImageElement[] = []
  for (const dims of info.pages) {
    const sheet = document.createElement('div')
    sheet.className = 'de-page-sheet'
    sheet.dataset.page = String(dims.n)
    sheet.style.aspectRatio = `${dims.wPt} / ${dims.hPt}`
    const img = document.createElement('img')
    img.className = 'de-page'
    img.src = `${SERVICE_BASE}/compile/${encodeURIComponent(jobId)}/page/${dims.n}.png?dpi=${DEFAULT_PAGE_DPI}`
    img.alt = `compiled page ${dims.n}`
    img.draggable = false
    sheet.append(img)
    images.push(img)
    sheet.addEventListener('click', (event) => selectFromPage(dims, sheet, event))
    sheet.addEventListener('dblclick', (event) => editFromPage(dims, sheet, event))
    fragment.append(sheet)
    nextSheets.set(dims.n, { el: sheet, dims })
  }
  // Decode before replacing the previous job.  The last good PDF therefore
  // remains visible for the whole compile and raster-fetch interval.
  await Promise.all(images.map((img) => typeof img.decode === 'function'
    ? img.decode().catch(() => undefined)
    : Promise.resolve()))
  if (lastCompileJobId() !== jobId || !container) return
  const caret = edit ? caretOffset(edit.field) : null
  column.replaceChildren(fragment)
  sheets.clear()
  for (const [page, sheet] of nextSheets) sheets.set(page, sheet)
  records = nextRecords
  shownJob = jobId
  paintSelection()
  positionEditor()
  if (edit && caret !== null) restoreCaret(edit.field, caret)
}

function showNote(message: string): void {
  if (shownJob !== null || column.childElementCount === 0) {
    shownJob = null
    sheets.clear()
    column.replaceChildren(note)
  }
  note.textContent = message
}

function blockFromPoint(dims: PageDims, sheet: HTMLElement, event: MouseEvent): HTMLElement | null {
  const doc = state.doc
  if (!doc) return null
  const r = sheet.getBoundingClientRect()
  if (!(r.width > 0) || !(r.height > 0)) return null
  const xPt = ((event.clientX - r.left) / r.width) * dims.wPt
  const yPt = ((event.clientY - r.top) / r.height) * dims.hPt
  const best = nearestRecord(records, dims.n, xPt, yPt)
  if (!best) return null
  const id = idForLine(doc, best.line)
  const block = id === null ? null : doc.article.querySelector(`[data-dia-id="${id}"]`)
  return block instanceof HTMLElement ? block : null
}

function selectFromPage(dims: PageDims, sheet: HTMLElement, event: MouseEvent): void {
  if ((event.target as Element | null)?.closest('.de-page-edit')) return
  const block = blockFromPoint(dims, sheet, event)
  if (!block) return
  selected = block
  const index = state.blocks().indexOf(block)
  if (index >= 0) state.setCurrentBlock(index)
  state.selection = { kind: 'block', block }
}

function editFromPage(dims: PageDims, sheet: HTMLElement, event: MouseEvent): void {
  if ((event.target as Element | null)?.closest('.de-page-edit')) return
  event.preventDefault()
  const block = blockFromPoint(dims, sheet, event)
  if (!block) return
  selected = block
  state.selection = { kind: 'block', block }
  beginEditor(block)
}

function editableIn(block: HTMLElement): HTMLElement | null {
  const doc = state.doc
  if (!doc) return null
  if (block.matches('.dia-tex-island')) {
    return block.querySelector<HTMLElement>('pre') ?? block
  }
  const own = docEditableFor(doc.article, block)
  if (own) return own
  for (const candidate of block.querySelectorAll<HTMLElement>(
    'p, h1.dia-sec, h2.dia-sec, h3.dia-sec, h4.dia-sec, h5.dia-sec, figcaption, li, dt, dd, td, .dia-math',
  )) {
    const leaf = docEditableFor(doc.article, candidate)
    if (leaf) return leaf
  }
  return null
}

function beginEditor(block: HTMLElement): void {
  const target = editableIn(block)
  if (!target) { fallback(block); return }
  closeEditor(true)
  const initial = docDraftValue(target)
  const host = document.createElement('div')
  host.className = 'de-page-edit'
  const label = document.createElement('div')
  label.className = 'de-page-edit-label'
  const baseLabel = initial.math ? 'math · LaTeX' : block.matches('.dia-tex-island') ? 'LaTeX island' : 'edit · recompiles on pause'
  label.textContent = baseLabel
  const field = document.createElement('div')
  field.className = 'de-page-edit-field'
  field.setAttribute('contenteditable', initial.math || block.matches('.dia-tex-island') ? 'plaintext-only' : 'true')
  field.spellcheck = !initial.math
  if (initial.math) field.textContent = initial.value
  else field.innerHTML = initial.value
  host.append(label, field)
  edit = {
    target, host, field, label, baseLabel, math: initial.math, last: initial.value, timer: 0,
    logStart: state.log.entries.length, committed: false,
  }
  field.addEventListener('input', scheduleDraft)
  field.addEventListener('keydown', onEditKey)
  field.addEventListener('blur', () => window.setTimeout(() => {
    if (edit?.field === field && !host.contains(document.activeElement)) closeEditor(true)
  }, 0))
  positionEditor()
  field.focus()
  const range = document.createRange()
  range.selectNodeContents(field)
  range.collapse(false)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

function draftValue(): string {
  if (!edit) return ''
  return edit.math || edit.target.closest('.dia-tex-island') ? (edit.field.textContent ?? '') : edit.field.innerHTML
}

function scheduleDraft(): void {
  if (!edit) return
  edit.host.classList.add('is-dirty')
  window.clearTimeout(edit.timer)
  edit.timer = window.setTimeout(() => commitDraft(false), DRAFT_IDLE_MS)
}

function commitDraft(close: boolean): void {
  if (!edit) return
  window.clearTimeout(edit.timer)
  const value = draftValue()
  if (value !== edit.last && commitDocDraft(edit.target, value, edit.math)) {
    edit.committed = true
    state.log.coalesceFrom(edit.logStart, edit.math ? 'Edit math' : 'Edit text')
    edit.last = docDraftValue(edit.target).value
    edit.host.classList.remove('is-dirty', 'is-error')
    edit.host.classList.add('is-compiling')
    if (state.doc) void compilePageDraft(state.doc)
  }
  if (close) closeEditor(false)
}

function closeEditor(commit: boolean): void {
  const held = edit
  if (!held) return
  if (commit) { commitDraft(false); if (edit !== held) return }
  window.clearTimeout(held.timer)
  held.host.remove()
  edit = null
}

function onEditKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    const shouldUndo = Boolean(edit?.committed && state.log.entries.length === (edit?.logStart ?? -1) + 1)
    closeEditor(false)
    if (shouldUndo) state.undo()
  } else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault()
    closeEditor(true)
  } else if (event.key === 'Enter' && !edit?.target.closest('.dia-tex-island')) {
    // A detached inline leaf cannot honestly manufacture a structural LaTeX
    // paragraph without choosing a source boundary. Commit instead of
    // letting contenteditable insert a <div> that emitInlines cannot mean.
    event.preventDefault()
    closeEditor(true)
  }
}

function paintSelection(): void {
  for (const mark of marks) mark.remove()
  marks = []
  const block = selected
  if (!block) return
  for (const rect of rectsForBlock(block)) {
    const sheet = sheets.get(rect.page)
    if (!sheet) continue
    const mark = document.createElement('div')
    mark.className = 'de-page-selection'
    place(mark, rect, sheet.dims)
    sheet.el.append(mark)
    marks.push(mark)
  }
}

function positionEditor(): void {
  if (!edit) return
  const block = state.doc ? topBlockOf(state.doc, edit.target) : null
  const top = block ?? selected
  const rect = top ? rectsForBlock(top)[0] : null
  const sheet = rect ? sheets.get(rect.page) : null
  if (!rect || !sheet) return
  place(edit.host, rect, sheet.dims)
  if (edit.host.parentElement !== sheet.el) sheet.el.append(edit.host)
}

function place(el: HTMLElement, rect: PageRect, dims: PageDims): void {
  el.style.left = `${(rect.xMin / dims.wPt) * 100}%`
  el.style.top = `${(rect.yMin / dims.hPt) * 100}%`
  el.style.width = `${Math.max(4, ((rect.xMax - rect.xMin) / dims.wPt) * 100)}%`
  el.style.minHeight = `${Math.max(1.6, ((rect.yMax - rect.yMin) / dims.hPt) * 100)}%`
}

function caretOffset(field: HTMLElement): number | null {
  const selection = window.getSelection()
  if (!selection?.rangeCount) return null
  const range = selection.getRangeAt(0)
  if (!field.contains(range.startContainer)) return null
  const before = document.createRange()
  before.selectNodeContents(field)
  before.setEnd(range.startContainer, range.startOffset)
  return before.toString().length
}

function restoreCaret(field: HTMLElement, offset: number): void {
  let left = offset
  const walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    const length = node.textContent?.length ?? 0
    if (left <= length) {
      const range = document.createRange()
      range.setStart(node, left)
      range.collapse(true)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      field.focus()
      return
    }
    left -= length
    node = walker.nextNode()
  }
}

/** Nearest SyncTeX line in the clicked column. */
export function nearestRecord(
  recs: SynctexRecord[], page: number, xPt: number, yPt: number,
): SynctexRecord | null {
  let best: SynctexRecord | null = null
  let bestD = Infinity
  for (const rec of recs) {
    if (rec.page !== page) continue
    const dy = Math.abs(rec.y - yPt)
    const left = rec.x ?? 0
    const right = left + (rec.w ?? 0)
    const dx = xPt < left ? left - xPt : xPt > right ? xPt - right : 0
    const d = dy + dx * 2
    if (d < bestD) { bestD = d; best = rec }
  }
  return best
}

export function layoutMatchesShown(layout: DocumentLayout | null = documentLayout()): boolean {
  return layout !== null && layout.jobId === shownJob
}
