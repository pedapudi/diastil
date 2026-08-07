/* Pages view: the compiled PDF, page by page, at reading width — the third
 * document surface beside native and source. The pages are the daemon's own
 * rasters of the last good compile, so what this view shows IS the ground
 * truth every mirror crop is cut from; nothing here is inferred. Read-only,
 * but not inert: every spot on a page knows its source line through
 * synctex, and a double-click jumps the native view to that block. */

import { state } from '../state'
import { SERVICE_BASE } from '../service/client'
import { lastCompileJobId, onCompileState } from './doccompile'
import { pagesInfo, DEFAULT_PAGE_DPI, type PageDims } from '../doc/pdfpages'
import { fetchSynctex, type SynctexRecord } from '../doc/blockmirror'
import { idForLine } from './problems'

let container: HTMLElement | null = null
let column: HTMLElement
let shownJob: string | null = null
let records: SynctexRecord[] = []
let jump: (block: HTMLElement) => void = () => {}

export function mountPagesView(mainEl: HTMLElement, onJump: (block: HTMLElement) => void): void {
  jump = onJump
  container = document.createElement('div')
  container.className = 'de-docscroll de-pagescroll'
  container.hidden = true
  column = document.createElement('div')
  column.className = 'de-pagecol'
  container.append(column)
  mainEl.append(container)
  // a compile finishing while the view is open refreshes it in place
  onCompileState((s) => {
    if (!container || container.hidden) return
    if (s.status === 'ok') void refresh()
  })
}

export function activatePages(): void {
  if (!container) return
  container.hidden = false
  void refresh()
}

export function deactivatePages(): void {
  if (container) container.hidden = true
}

async function refresh(): Promise<void> {
  if (!container || !state.doc) return
  const jobId = lastCompileJobId()
  if (!jobId) {
    if (shownJob !== null || column.childElementCount === 0) {
      shownJob = null
      column.textContent = ''
      const note = document.createElement('div')
      note.className = 'de-pages-note'
      note.textContent = 'no compiled pages yet — the first compile fills this view'
      column.append(note)
    }
    return
  }
  if (jobId === shownJob) return
  const info = await pagesInfo(jobId)
  if (!info || !info.available || lastCompileJobId() !== jobId || !container) return
  records = await fetchSynctex(jobId)
  shownJob = jobId
  column.textContent = ''
  for (const p of info.pages) {
    const img = document.createElement('img')
    img.className = 'de-page'
    img.src = `${SERVICE_BASE}/compile/${encodeURIComponent(jobId)}/page/${p.n}.png?dpi=${DEFAULT_PAGE_DPI}`
    img.title = 'double-click a spot to edit it in the native view'
    img.draggable = false
    img.addEventListener('dblclick', (e) => jumpFrom(p, img, e))
    column.append(img)
  }
}

function jumpFrom(dims: PageDims, img: HTMLImageElement, e: MouseEvent): void {
  if (!state.doc) return
  const r = img.getBoundingClientRect()
  if (!(r.width > 0) || !(r.height > 0)) return
  const xPt = ((e.clientX - r.left) / r.width) * dims.wPt
  const yPt = ((e.clientY - r.top) / r.height) * dims.hPt
  const best = nearestRecord(records, dims.n, xPt, yPt)
  if (!best) return
  const id = idForLine(state.doc, best.line)
  const el = id === null ? null : state.doc.article.querySelector(`[data-dia-id="${id}"]`)
  if (el instanceof HTMLElement) jump(el)
}

/** The record nearest a click, in the click's own column: horizontal
 * distance outweighs vertical so a spot in column one never resolves to
 * the line beside it in column two, while within a column the nearest
 * LINE wins even when the record's box sits elsewhere on it. */
export function nearestRecord(
  recs: SynctexRecord[],
  page: number,
  xPt: number,
  yPt: number,
): SynctexRecord | null {
  let best: SynctexRecord | null = null
  let bestD = Infinity
  for (const rec of recs) {
    if (rec.page !== page) continue
    const dy = Math.abs(rec.y - yPt)
    const left = rec.x ?? 0
    const right = (rec.x ?? 0) + (rec.w ?? 0)
    const dx = xPt < left ? left - xPt : xPt > right ? xPt - right : 0
    const d = dy + dx * 2
    if (d < bestD) { bestD = d; best = rec }
  }
  return best
}
