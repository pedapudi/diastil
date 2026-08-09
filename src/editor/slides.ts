/* Slides & files: open / import / save / present, plus slide templates.
 * Save prefers the File System Access API handle we opened with; otherwise
 * it downloads a blob. Serialization goes through serializeClean(), which
 * temporarily strips editor artifacts serializeDeck would otherwise keep
 * (top-level artifact <style> blocks, data-dia-current). */

import type { Deck } from '../types'
import { state } from '../state'
import { loadDeck } from '../model/parse'
import { serializeDeck } from '../model/serialize'
import { loadDoc, loadDocFromTex, serializeDoc, exportTex, type Doc } from '../model/doc'
import { clearPreview } from '../copilot/preview'
import { closeStudio } from '../studio/studio'
import { closeSlideFocus } from '../studio/focus'
import { startImport } from '../ingest/pipeline'
import { looksLikePptx, pptxToHtml } from '../ingest/pptx'
import { SERVICE_BASE } from '../service/client'
import { setImportReport } from './table'

/* ---------- File System Access (minimal local typings) ---------- */

interface DEWritable { write(data: string): Promise<void>; close(): Promise<void> }
interface DEFileHandle { getFile(): Promise<File>; createWritable(): Promise<DEWritable> }
type PickerWindow = Window & {
  showOpenFilePicker?: (opts?: unknown) => Promise<DEFileHandle[]>
}

let fileHandle: DEFileHandle | null = null

interface PickedFile { text: string; bytes: ArrayBuffer | null; name: string; handle: DEFileHandle | null }

async function readPicked(f: File, handle: DEFileHandle | null): Promise<PickedFile> {
  // .pptx (or any zip) is binary — a text() read would mangle it
  if (/\.pptx$/i.test(f.name) || f.type.includes('presentation')) {
    return { text: '', bytes: await f.arrayBuffer(), name: f.name, handle }
  }
  return { text: await f.text(), bytes: null, name: f.name, handle }
}

/** Is this a LaTeX source file? Extension decides; content sniff catches a
 * .txt-renamed paper. */
export function looksLikeTex(text: string, name: string): boolean {
  if (/\.tex$/i.test(name)) return true
  return /\\documentclass\s*[[{]/.test(text.slice(0, 4000))
}

async function pickHtmlFile(): Promise<PickedFile | null> {
  const w = window as PickerWindow
  if (typeof w.showOpenFilePicker === 'function') {
    try {
      const [handle] = await w.showOpenFilePicker({
        types: [{
          description: 'Deck (HTML or PowerPoint) or document (LaTeX)',
          accept: {
            'text/html': ['.html', '.htm'],
            'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
            'text/x-tex': ['.tex'],
          },
        }],
      })
      if (!handle) return null
      return await readPicked(await handle.getFile(), handle)
    } catch {
      return null // user cancelled
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.html,.htm,.pptx,.tex,text/html'
    input.addEventListener('change', () => {
      const f = input.files?.[0]
      if (!f) { resolve(null); return }
      void readPicked(f, null).then(resolve)
    })
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
}

/* ---------- CLI file bridge (`dia <deck.html>`) ---------- */

/* When the editor is launched by the dia CLI it carries ?file= (edit) or
 * ?import= (ingest) and reads/writes through the service's allowlisted
 * /file endpoint instead of pickers. A 2s watch reloads the deck when the
 * file changes on disk and the editor holds no unsaved edits. */

let servicePath: string | null = null
let serviceMtime = 0

/** the file this session was opened from through the CLI, if any. The compile
 * path sends it so the daemon can grant read-only TEXINPUTS access to its
 * directory — that is what makes a relative \includegraphics resolve. */
export function servicePathOf(): string | null { return servicePath }
/** disk content as of the last load/save — the clean-state reference */
let lastSyncedHtml = ''
let watchTimer = 0

/** why the last readServiceFile returned null — shown to the user at boot,
 * where "silently load the demo deck instead" read as data loss */
let lastReadError = ''

async function readServiceFile(path: string): Promise<{ html: string; b64?: string; mtime: number } | null> {
  try {
    const r = await fetch(`${SERVICE_BASE}/file?path=${encodeURIComponent(path)}`)
    if (!r.ok) {
      let detail = `${r.status}`
      try {
        const body = await r.json() as { detail?: string }
        if (body.detail) detail = body.detail
      } catch { /* body was not json */ }
      lastReadError = detail
      return null
    }
    return await r.json() as { html: string; b64?: string; mtime: number }
  } catch {
    lastReadError = 'the dia service is not reachable'
    return null
  }
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Boot from CLI query params. Returns true when a file was handled. */
export async function bootFromCli(canvasHost: HTMLElement): Promise<boolean> {
  const params = new URLSearchParams(window.location.search)
  const editPath = params.get('file')
  const importPath = params.get('import')
  const path = editPath ?? importPath
  if (!path) return false
  const file = await readServiceFile(path)
  if (!file) {
    console.warn(`dia: could not read ${path} through the service — falling back to the demo deck`)
    alert(`could not open ${path}: ${lastReadError}.\n\nThe daemon only serves files it was started with — run:\n  dia edit ${path}`)
    return false
  }
  const name = path.split('/').pop() ?? 'deck.html'
  // .pptx over the bridge arrives base64 — render it to foreign HTML and
  // continue down the exact same import path
  if (file.b64 !== undefined) {
    try {
      void startImport(pptxToHtml(b64ToBytes(file.b64), name), name)
    } catch (err) {
      console.error(err)
      alert(err instanceof Error ? err.message : `could not read ${name}`)
    }
    return true
  }
  // `dia edit paper.tex` — the document editor, straight from source
  if (editPath && looksLikeTex(file.html, name)) {
    servicePath = path
    serviceMtime = file.mtime
    lastSyncedHtml = file.html
    loadDocument('tex', file.html, canvasHost, name)
    startWatch(canvasHost)
    return true
  }
  // ?import= forces conversion; ?file= auto-detects — a foreign file opened
  // with `dia edit` converts instead of loading as a broken dialect deck
  const kind = editPath ? dialectKind(file.html) : null
  if (!kind) {
    void startImport(file.html, name)
    return true
  }
  servicePath = path
  serviceMtime = file.mtime
  lastSyncedHtml = file.html
  if (kind === 'doc') {
    loadDocument('html', file.html, canvasHost, name)
  } else {
    setImportReport(null)
    const deck = loadDeck(file.html, canvasHost, name)
    state.doc = null
    state.deck = deck
    state.bus.emit({ type: 'deck-loaded' })
  }
  startWatch(canvasHost)
  return true
}

function startWatch(canvasHost: HTMLElement): void {
  window.clearInterval(watchTimer)
  watchTimer = window.setInterval(() => void pollDisk(canvasHost), 2000)
}

async function pollDisk(canvasHost: HTMLElement): Promise<void> {
  if (!servicePath || state.mode === 'none') return
  const file = await readServiceFile(servicePath)
  if (!file || file.mtime <= serviceMtime || file.html === lastSyncedHtml) return
  // external change on disk: reload only when the editor is clean —
  // byte-stable serialization makes "clean" checkable exactly
  if (serializeCurrent() !== lastSyncedHtml) {
    console.warn('dia: file changed on disk but the editor has unsaved edits — keeping them (save overwrites)')
    serviceMtime = file.mtime
    return
  }
  serviceMtime = file.mtime
  lastSyncedHtml = file.html
  if (state.doc) {
    const isTex = /\.tex$/i.test(servicePath)
    loadDocument(isTex ? 'tex' : 'html', file.html, canvasHost, isTex ? state.doc.texName : state.doc.fileName)
    return
  }
  const deck = loadDeck(file.html, canvasHost, state.deck!.fileName)
  state.deck = deck
  state.bus.emit({ type: 'deck-loaded' })
}

/** the on-disk representation of the current editor content — what a save
 * would write to servicePath (tex for .tex sessions, html otherwise) */
function serializeCurrent(): string {
  if (state.doc) {
    return servicePath && /\.tex$/i.test(servicePath) ? exportTex(state.doc) : serializeDoc(state.doc)
  }
  return state.deck ? serializeClean(state.deck) : ''
}

/* ---------- open (one door for dialect AND foreign files) ---------- */

/** Is this HTML already in the dialect? Parse-based, not substring: the
 * version stamp or actual dialect slides decide, so a foreign deck that
 * merely mentions "dia-slide" in prose still converts. */
export function isDialectHtml(html: string): boolean {
  return dialectKind(html) !== null
}

/** Which dialect kind is this HTML — a deck, a LaTeX-backed document, or
 * foreign (null)?
 *
 * The version stamp on <html> is the file DECLARING what it is, so it
 * outranks anything in the body. Structure only speaks for a file that
 * declared nothing. Checking `article.dia-doc` first cost us a real class of
 * misread: a deck teaching the document grammar with LIVE markup — which is
 * what this project's own what-is-dia.html would be the day its examples
 * stop being escaped inside <pre> — carries a stamp saying "deck" and a body
 * containing a document, and opened as a document. A nested element is
 * content; the root attribute is the claim.
 *
 * A file stamped BOTH is malformed, not ambiguous: validate.ts raises
 * doc/version-exclusive on it. Reading it as a document is the safer half of
 * that error — the LaTeX source block is the truth it would otherwise lose. */
export function dialectKind(html: string): 'deck' | 'doc' | null {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const root = doc.documentElement
  if (root.hasAttribute('data-dia-doc-version')) return 'doc'
  if (root.hasAttribute('data-dia-version')) return 'deck'
  if (doc.querySelector('article.dia-doc') !== null) return 'doc'
  if (doc.querySelector('section.dia-slide') !== null) return 'deck'
  return null
}

/** dev/e2e hook body: open document text (either form) into the editor */
export function openDocumentText(text: string, name: string): void {
  const host = document.getElementById('deck-host')
  if (!host) return
  servicePath = null
  window.clearInterval(watchTimer)
  fileHandle = null
  loadDocument(looksLikeTex(text, name) ? 'tex' : 'html', text, host, name)
}

/** load a document (from artifact html or bare .tex) into the editor */
function loadDocument(kind: 'html' | 'tex', text: string, canvasHost: HTMLElement, name: string): void {
  setImportReport(null)
  const doc = kind === 'tex'
    ? loadDocFromTex(text, canvasHost, name)
    : loadDoc(text, canvasHost, name)
  state.deck = null
  state.doc = doc
  state.bus.emit({ type: 'doc-loaded' })
}

/** Open: dialect files load directly; anything foreign hands off to the
 * import pipeline automatically — one button, no open-vs-import decision. */
export async function openDeck(canvasHost: HTMLElement): Promise<void> {
  const picked = await pickHtmlFile()
  if (!picked) return
  servicePath = null
  window.clearInterval(watchTimer)
  if (picked.bytes && looksLikePptx(picked.bytes, picked.name)) {
    fileHandle = null
    try {
      startImport(pptxToHtml(picked.bytes, picked.name), picked.name)
    } catch (err) {
      console.error(err)
      alert(err instanceof Error ? err.message : `could not read ${picked.name}`)
    }
    return
  }
  if (looksLikeTex(picked.text, picked.name)) {
    fileHandle = picked.handle
    loadDocument('tex', picked.text, canvasHost, picked.name)
    return
  }
  const kind = dialectKind(picked.text)
  if (kind === 'doc') {
    fileHandle = picked.handle
    loadDocument('html', picked.text, canvasHost, picked.name)
  } else if (kind === 'deck') {
    fileHandle = picked.handle
    setImportReport(null)
    const deck = loadDeck(picked.text, canvasHost, picked.name)
    state.doc = null
    state.deck = deck
    state.bus.emit({ type: 'deck-loaded' })
  } else {
    fileHandle = null
    startImport(picked.text, picked.name)
  }
}

/* ---------- save / present ---------- */

/** serializeDeck keeps top-level artifact styles and data-dia-current;
 * strip them for the duration of the serialization, then restore. */
function serializeClean(deck: Deck): string {
  // a staged copilot preview is NOT part of the document — a save or
  // present must never serialize one
  clearPreview('saving the deck')
  // an open studio or slide focus holds content inside its overlay —
  // return it home first, or the serialization would miss it
  closeStudio()
  closeSlideFocus()
  const root = deck.root
  const artifacts = [...root.querySelectorAll<HTMLStyleElement>('style.dia-editor-artifact')]
    .map((el) => ({ el, next: el.nextSibling, parent: el.parentNode }))
  const currents = [...root.querySelectorAll<HTMLElement>('[data-dia-current]')]
  for (const a of artifacts) a.el.remove()
  for (const c of currents) c.removeAttribute('data-dia-current')
  try {
    return serializeDeck(deck)
  } finally {
    for (const a of artifacts) a.parent?.insertBefore(a.el, a.next)
    for (const c of currents) c.setAttribute('data-dia-current', '')
  }
}

export async function saveDeck(deck: Deck): Promise<void> {
  const html = serializeClean(deck)
  if (servicePath) {
    try {
      const r = await fetch(`${SERVICE_BASE}/file`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: servicePath, html }),
      })
      if (r.ok) {
        const j = await r.json() as { mtime: number }
        serviceMtime = j.mtime
        lastSyncedHtml = html
        return
      }
    } catch {
      /* service gone — fall back to download below */
    }
  }
  if (fileHandle) {
    try {
      const w = await fileHandle.createWritable()
      await w.write(html)
      await w.close()
      return
    } catch {
      /* permission lost — fall back to download */
    }
  }
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
  const a = document.createElement('a')
  a.href = url
  a.download = deck.fileName || 'deck.html'
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

/* ---------- document save / export ---------- */

/** Save the document: back to its .tex when the session opened one through
 * the CLI (comments ride the trailer), else the self-contained artifact —
 * same three tiers as decks (service bridge → FS handle → download). */
export async function saveDoc(doc: Doc): Promise<void> {
  const isTexSession = servicePath !== null && /\.tex$/i.test(servicePath)
  const payload = isTexSession ? exportTex(doc) : serializeDoc(doc)
  if (servicePath) {
    try {
      const r = await fetch(`${SERVICE_BASE}/file`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: servicePath, html: payload }),
      })
      if (r.ok) {
        const j = await r.json() as { mtime: number }
        serviceMtime = j.mtime
        lastSyncedHtml = payload
        return
      }
    } catch {
      /* service gone — fall back to download below */
    }
  }
  if (fileHandle) {
    try {
      const w = await fileHandle.createWritable()
      await w.write(payload)
      await w.close()
      return
    } catch {
      /* permission lost — fall back to download */
    }
  }
  downloadBlob(payload, isTexSession ? doc.texName : doc.fileName, isTexSession ? 'text/x-tex' : 'text/html')
}

/** export the LaTeX source (with the comments trailer) as a download */
export function exportTexAction(): void {
  if (!state.doc) return
  downloadBlob(exportTex(state.doc), state.doc.texName || 'document.tex', 'text/x-tex')
}

/** open the readable artifact in a new tab — a document "presents" as
 * itself */
export function presentDoc(doc: Doc): void {
  const url = URL.createObjectURL(new Blob([serializeDoc(doc)], { type: 'text/html' }))
  window.open(url, '_blank')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

function downloadBlob(content: string, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

/** Present: the serialized document is self-running (runtime is embedded). */
export function presentDeck(deck: Deck): void {
  const html = serializeClean(deck)
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
  window.open(url, '_blank')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/* ---------- .pptx export (service-rendered) ---------- */

// the copilot rail probes /health and broadcasts the verdict on this bus;
// export surfaces gate on the last broadcast instead of probing again
let serviceOnline = false
window.addEventListener('dia-service-status', (ev) => {
  serviceOnline = Boolean((ev as CustomEvent<{ online?: boolean }>).detail?.online)
})

export function pptxExportAvailable(): boolean {
  return serviceOnline
}

export const PPTX_EXPORT_HINT =
  'download a .pptx — opens in PowerPoint / Keynote; imports to Google Slides as editable objects'
export const PPTX_EXPORT_OFFLINE_HINT =
  'needs the local service — start it with: dia serve'

/** the ONE export action every surface (save menu, context menu) routes
 * through: current deck, user-facing failure */
export function exportPptxAction(): void {
  if (!state.deck) return
  void exportPptx(state.deck).catch((e: unknown) =>
    alert('Export to .pptx failed.\n\n' + (e instanceof Error ? e.message : String(e))))
}

/**
 * Export to .pptx — the service renders the deck to PowerPoint (Open XML) and
 * returns it as a download. Scenes/charts/inline-SVG become native shapes and
 * connectors and text roles become text boxes, so the file opens in PowerPoint
 * / Keynote and converts to native, editable Google Slides on import.
 */
export async function exportPptx(deck: Deck): Promise<void> {
  const html = serializeClean(deck)
  let r: Response
  try {
    r = await fetch(`${SERVICE_BASE}/export/pptx`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html, title: deck.title || deck.fileName || null }),
    })
  } catch {
    throw new Error('the local service is not reachable — start it with: dia serve')
  }
  if (!r.ok) {
    const detail = await r.text().catch(() => '')
    throw new Error(`export failed (${r.status}): ${detail}`)
  }
  const blob = await r.blob()
  const base = (deck.title || deck.fileName || 'deck').replace(/\.html?$/i, '')
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${base}.pptx`
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

/* ---------- slide templates ---------- */

let idSeq = 1
const ID_SESSION = Math.random().toString(36).slice(2, 6)

/** session-stable editor ids for elements we create (distinct from parse's) */
export function assignFreshIds(rootEl: HTMLElement): void {
  for (const el of [rootEl, ...rootEl.querySelectorAll<HTMLElement>('*')])
    el.setAttribute('data-dia-id', `e${ID_SESSION}-${idSeq++}`)
}

/** minimal semantic template slide: kicker + title + body */
export function makeTemplateSlide(): HTMLElement {
  const s = document.createElement('section')
  s.className = 'dia-slide'
  const k = document.createElement('div')
  k.className = 'dia-kicker'
  k.textContent = 'Section'
  const t = document.createElement('h1')
  t.className = 'dia-title'
  t.textContent = 'New slide'
  const b = document.createElement('div')
  b.className = 'dia-body dia-stack'
  const p = document.createElement('p')
  p.textContent = 'Body copy — double-click to edit.'
  b.append(p)
  s.append(k, t, b)
  assignFreshIds(s)
  return s
}
