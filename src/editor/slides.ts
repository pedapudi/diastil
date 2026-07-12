/* Slides & files: open / import / save / present, plus slide templates.
 * Save prefers the File System Access API handle we opened with; otherwise
 * it downloads a blob. Serialization goes through serializeClean(), which
 * temporarily strips editor artifacts serializeDeck would otherwise keep
 * (top-level artifact <style> blocks, data-dia-current). */

import type { Deck } from '../types'
import { state } from '../state'
import { loadDeck } from '../model/parse'
import { serializeDeck } from '../model/serialize'
import { startImport } from '../ingest/pipeline'
import { setImportReport } from './table'

/* ---------- File System Access (minimal local typings) ---------- */

interface DEWritable { write(data: string): Promise<void>; close(): Promise<void> }
interface DEFileHandle { getFile(): Promise<File>; createWritable(): Promise<DEWritable> }
type PickerWindow = Window & {
  showOpenFilePicker?: (opts?: unknown) => Promise<DEFileHandle[]>
}

let fileHandle: DEFileHandle | null = null

async function pickHtmlFile(): Promise<{ text: string; name: string; handle: DEFileHandle | null } | null> {
  const w = window as PickerWindow
  if (typeof w.showOpenFilePicker === 'function') {
    try {
      const [handle] = await w.showOpenFilePicker({
        types: [{ description: 'HTML deck', accept: { 'text/html': ['.html', '.htm'] } }],
      })
      if (!handle) return null
      const file = await handle.getFile()
      return { text: await file.text(), name: file.name, handle }
    } catch {
      return null // user cancelled
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.html,.htm,text/html'
    input.addEventListener('change', () => {
      const f = input.files?.[0]
      if (!f) { resolve(null); return }
      f.text().then((text) => resolve({ text, name: f.name, handle: null }))
    })
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
}

/* ---------- open / import ---------- */

/** Open: dialect files load directly; anything foreign hands off to ingest. */
export async function openDeck(canvasHost: HTMLElement): Promise<void> {
  const picked = await pickHtmlFile()
  if (!picked) return
  if (picked.text.includes('dia-slide') || picked.text.includes('data-dia-version')) {
    fileHandle = picked.handle
    setImportReport(null)
    const deck = loadDeck(picked.text, canvasHost, picked.name)
    state.deck = deck
    state.bus.emit({ type: 'deck-loaded' })
  } else {
    fileHandle = null
    startImport(picked.text, picked.name)
  }
}

/** Import: always routes through the ingest pipeline's review UI. */
export async function importForeign(): Promise<void> {
  const picked = await pickHtmlFile()
  if (!picked) return
  fileHandle = null
  startImport(picked.text, picked.name)
}

/* ---------- save / present ---------- */

/** serializeDeck keeps top-level artifact styles and data-dia-current;
 * strip them for the duration of the serialization, then restore. */
function serializeClean(deck: Deck): string {
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

/** Present: the serialized document is self-running (runtime is embedded). */
export function presentDeck(deck: Deck): void {
  const html = serializeClean(deck)
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
  window.open(url, '_blank')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
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
