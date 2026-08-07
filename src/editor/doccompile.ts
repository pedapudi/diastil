/* Compile controller: the browser half of the daemon's LaTeX pipeline.
 *
 * A compile is a JOB, not a request — POST /compile hands back an id and the
 * result arrives over SSE seconds later. This module owns the one piece of
 * state that whole flow produces (a CompileState) and hands it to whoever
 * renders it: the topbar chip, the problems drawer, the PDF actions.
 *
 * The state transitions live in reduceCompile(), a pure function, because
 * the interesting bugs here are ordering bugs — a stale job's `done` landing
 * after a newer one started, a health poll saying "no engine" mid-compile —
 * and those are worth testing without a DOM.
 *
 * Superseding is server-side (one active job per docId), but a superseded
 * job still streams its own frames to its own reader; `generation` is what
 * keeps the older reader from writing to the chip the newer one now owns. */

import type { Doc } from '../model/doc'
import { state } from '../state'
import { SERVICE_BASE, sseData, type TexCapability } from '../service/client'
import { servicePathOf } from './slides'
import { grantFolderAccess, summarizeSkips, type FolderGrantResult } from './folderGrant'

/** one finding from the engine's log, as the daemon's parse_log emits it */
export interface TexError {
  level: 'error' | 'warning'
  file: string | null
  line: number | null
  message: string
}

export type CompileStatus =
  | 'idle' | 'compiling' | 'ok' | 'failed' | 'offline' | 'no-engine'

export interface CompileState {
  status: CompileStatus
  errors: TexError[]
  warnings: TexError[]
  pages: number | null
  ms: number
  engine: string | null
  /** no engine installed, but the daemon ships a tectonic for this platform */
  downloadable: boolean
  /** why we cannot compile, or why the last one failed — engine's words */
  detail: string | null
  /** managed-tectonic install in flight: 0..1, or null when not installing */
  installing: number | null
  installNote: string
  /** the last failure was a blind compile tripping on a file it could not
   * see — the one shape a folder grant can actually fix, so this is what
   * the problems drawer and tex chip gate the "grant folder access" offer
   * on rather than re-deriving it from the detail string each render */
  blindMissing: boolean
}

/** Until /health says otherwise the daemon is assumed absent — the copilot
 * rail probes on boot, so this is a first-frame state, not a guess we keep. */
export const INITIAL_COMPILE_STATE: CompileState = {
  status: 'offline',
  errors: [],
  warnings: [],
  pages: null,
  ms: 0,
  engine: null,
  downloadable: false,
  detail: null,
  installing: null,
  installNote: '',
  blindMissing: false,
}

export type CompileEvent =
  | { kind: 'service'; online: boolean; tex: TexCapability | null }
  | { kind: 'start' }
  /** blind: the daemon could not see the document's folder (not CLI-opened),
   * so sibling styles/figures/.bbl were invisible to this compile */
  | { kind: 'frame'; frame: Record<string, unknown>; blind?: boolean }
  | { kind: 'fail'; status: 'offline' | 'no-engine' | 'failed'; detail: string }
  | { kind: 'install'; pct: number | null; note: string }

export const TEX_OFFLINE_HINT =
  'needs the local service — start it with: dia serve'
export const TEX_NO_ENGINE_HINT =
  'no TeX engine found — install tectonic, TeX Live or MacTeX, then reload'
/* the hint a DISABLED surface shows, so it names the affordance that unlocks
 * it — the chip, which is the one place that offers the install */
export const TEX_INSTALL_HINT =
  'no TeX engine found — the tex chip downloads a managed tectonic (~30MB, one time)'
export const TEX_INSTALL_ACTION =
  'download a managed tectonic (~30MB, one time)'
export const PDF_EXPORT_HINT =
  'compile with a real TeX engine and download the PDF'
export const PDF_PREVIEW_HINT =
  'compile and open the PDF in a new tab — your browser renders it'
/* the failure a picker-opened document hits: the browser never learns the
 * file's path, so the daemon cannot read the styles/figures beside it */
export const TEX_BLIND_HINT =
  'this document was opened without a path, so files beside it (styles, figures, .bbl) are invisible to the compile — open it with: dia edit <file.tex>'

/* ---------- the reducer ---------- */

export function reduceCompile(prev: CompileState, ev: CompileEvent): CompileState {
  switch (ev.kind) {
    case 'service': {
      if (!ev.online) {
        return { ...prev, status: 'offline', engine: null, detail: null, installing: null }
      }
      const engine = ev.tex?.engine ?? null
      const downloadable = Boolean(ev.tex?.downloadable)
      if (engine === null) {
        // a poll must never interrupt a compile that is still streaming
        const status = prev.status === 'compiling' ? 'compiling' : 'no-engine'
        return { ...prev, status, engine: null, downloadable, detail: ev.tex?.detail ?? null }
      }
      // coming back from offline/no-engine lands on idle, not on a stale verdict
      const status = prev.status === 'offline' || prev.status === 'no-engine' ? 'idle' : prev.status
      return { ...prev, status, engine, downloadable, detail: null }
    }
    case 'start':
      return { ...prev, status: 'compiling', errors: [], warnings: [], pages: null, ms: 0, detail: null, blindMissing: false }
    case 'frame':
      return reduceFrame(prev, ev.frame, ev.blind === true)
    case 'fail':
      return { ...prev, status: ev.status, detail: ev.detail, installing: null, blindMissing: false }
    case 'install':
      return { ...prev, installing: ev.pct, installNote: ev.note }
  }
}

function reduceFrame(prev: CompileState, frame: Record<string, unknown>, blind: boolean): CompileState {
  const engine = typeof frame.engine === 'string' ? frame.engine : prev.engine
  if (frame.type !== 'done') return { ...prev, engine }

  const findings = Array.isArray(frame.errors)
    ? frame.errors.map(normalizeTexError).filter((e): e is TexError => e !== null)
    : []
  // a cancelled job is not a failure — it is a compile the user replaced
  const status: CompileStatus = frame.status === 'ok' ? 'ok'
    : frame.status === 'cancelled' ? 'idle'
      : 'failed'
  const errors = findings.filter((e) => e.level === 'error')
  const warnings = findings.filter((e) => e.level !== 'error')
  let detail = typeof frame.detail === 'string' && frame.detail ? frame.detail : null
  // a blind compile failing on a missing file is almost never a document
  // problem — it is the daemon unable to SEE the file; say that, or the
  // user stares at "neurips_2022.sty not found" beside a folder that has it
  const blindMissing = status === 'failed' && blind && missingFileFailure(errors, detail)
  if (blindMissing) {
    detail = detail ? `${detail} — ${TEX_BLIND_HINT}` : TEX_BLIND_HINT
    warnings.unshift({ level: 'warning', file: null, line: null, message: TEX_BLIND_HINT })
  }
  return {
    ...prev,
    status,
    engine,
    errors,
    warnings,
    pages: typeof frame.pages === 'number' ? frame.pages : null,
    ms: typeof frame.durationMs === 'number' ? frame.durationMs : prev.ms,
    detail,
    blindMissing,
  }
}

/** does this failure smell like a file the engine could not find? */
export function missingFileFailure(errors: TexError[], detail: string | null): boolean {
  const texts = [...errors.map((e) => e.message), detail ?? '']
  return texts.some((t) => /(?:file |package )?[`'"]?[\w.\-/]+[`'"]? not found|unable to (?:find|load)|no such file/i.test(t))
}

/** Everything off the wire is shaped by a log parser, so nothing is trusted:
 * a finding with no message is dropped rather than rendered as a blank row. */
function normalizeTexError(raw: unknown): TexError | null {
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as Record<string, unknown>
  const message = typeof e.message === 'string' ? e.message.trim() : ''
  if (!message) return null
  return {
    level: e.level === 'warning' ? 'warning' : 'error',
    file: typeof e.file === 'string' && e.file ? e.file : null,
    line: typeof e.line === 'number' && Number.isFinite(e.line) && e.line > 0 ? Math.trunc(e.line) : null,
    message,
  }
}

/* ---------- the store ---------- */

let current: CompileState = INITIAL_COMPILE_STATE
const subscribers = new Set<(s: CompileState) => void>()
let generation = 0
let lastOkJob: string | null = null

export function compileState(): CompileState { return current }

/** the job whose artifacts (pdf, pages, synctex) are the current ones —
 * set BEFORE the `ok` state is published so a subscriber reacting to that
 * state can name the job it is about to read */
export function lastCompileJobId(): string | null { return lastOkJob }

/** subscribe; the callback fires immediately with the state as it stands, so
 * a surface mounted after the first health poll is not blank until the next */
export function onCompileState(fn: (s: CompileState) => void): () => void {
  subscribers.add(fn)
  fn(current)
  return () => { subscribers.delete(fn) }
}

function dispatch(ev: CompileEvent): void {
  current = reduceCompile(current, ev)
  for (const fn of [...subscribers]) fn(current)
}

/** tests reach for this; nothing in the app resets a live session */
export function resetCompileState(): void {
  current = INITIAL_COMPILE_STATE
  generation++
  lastOkJob = null
  grant = null
}

// the copilot rail owns the /health poll and broadcasts the verdict; every
// tex surface gates on the last broadcast rather than probing again
if (typeof window !== 'undefined') {
  window.addEventListener('dia-service-status', (ev) => {
    const detail = (ev as CustomEvent<{ online?: boolean; tex?: TexCapability | null }>).detail
    dispatch({ kind: 'service', online: Boolean(detail?.online), tex: detail?.tex ?? null })
  })
}

export function texAvailable(): boolean {
  return current.status !== 'offline' && current.engine !== null
}

export function texDownloadable(): boolean {
  return current.status !== 'offline' && current.engine === null && current.downloadable
}

/** the one sentence a disabled compile surface should say */
export function texHint(): string {
  if (current.status === 'offline') return TEX_OFFLINE_HINT
  if (current.engine === null) return current.downloadable ? TEX_INSTALL_HINT : TEX_NO_ENGINE_HINT
  return PDF_EXPORT_HINT
}

/* ---------- the folder grant ---------- */

/** what a granted folder gave us, kept for the rest of the browser session
 * (this module's lifetime, like `autoOn` below) so every auto-compile after
 * the grant keeps sending the same assets without asking again */
export interface CompileGrant {
  folderName: string
  assets: Record<string, string>
  skippedCount: number
}

let grant: CompileGrant | null = null

/** tests reach for this to exercise compileNow's asset attachment without a
 * real showDirectoryPicker(); grantFolderAndRecompile is the production path */
export function setCompileGrant(folderName: string, assets: Record<string, string>, skippedCount = 0): void {
  grant = { folderName, assets, skippedCount }
}

export function clearCompileGrant(): void { grant = null }

export function compileGrant(): CompileGrant | null { return grant }

/** the one-click recovery from a blind compile: ask the browser for the
 * document's folder, remember what it gave us, and immediately retry the
 * compile that just failed for lack of it. Resolves null if the user
 * cancelled the picker or the API is unavailable — callers should leave
 * their affordance exactly as it was rather than reporting a failure. */
export async function grantFolderAndRecompile(doc: Doc): Promise<FolderGrantResult | null> {
  const result = await grantFolderAccess()
  if (result === null) return null
  grant = { folderName: result.folderName, assets: result.assets, skippedCount: result.skipped.length }
  if (result.skipped.length > 0) {
    const n = Object.keys(result.assets).length
    alert(`Sent ${n} file${n === 1 ? '' : 's'} from “${result.folderName}”.\n\n${summarizeSkips(result.skipped)}`)
  }
  await compileNow(doc)
  return result
}

/* ---------- compiling ---------- */

export interface CompileResult {
  jobId: string
  ok: boolean
  errors: TexError[]
  warnings: TexError[]
  pages: number | null
  ms: number
}

/** the docId the daemon keys "one active job per document" on */
function docIdOf(doc: Doc): string {
  return doc.fileName || doc.texName || 'doc'
}

/** Compile the document's LaTeX truth. Resolves null when the compile could
 * not run or was superseded — the state carries why, and every caller shows
 * that rather than inventing its own message. */
export async function compileNow(doc: Doc): Promise<CompileResult | null> {
  const mine = ++generation
  dispatch({ kind: 'start' })

  let res: Response
  try {
    res = await fetch(`${SERVICE_BASE}/compile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        texSource: doc.source.text,
        docId: docIdOf(doc),
        docPath: servicePathOf() ?? undefined,
        // a granted folder's files ride along on every compile for the rest
        // of the session, not just the one that prompted the grant
        ...(grant ? { assets: grant.assets } : {}),
      }),
    })
  } catch {
    if (mine === generation) dispatch({ kind: 'fail', status: 'offline', detail: TEX_OFFLINE_HINT })
    return null
  }
  if (!res.ok) {
    const detail = await detailOf(res)
    // 503 is the daemon saying it has no engine, not a document problem
    if (mine === generation) {
      dispatch({ kind: 'fail', status: res.status === 503 ? 'no-engine' : 'failed', detail })
    }
    return null
  }
  const { jobId, texinputs } = await res.json() as { jobId?: string; texinputs?: boolean }
  const blind = texinputs === false
  if (!jobId) {
    if (mine === generation) dispatch({ kind: 'fail', status: 'failed', detail: 'the service accepted the compile but named no job' })
    return null
  }

  let stream: Response
  try {
    stream = await fetch(`${SERVICE_BASE}/compile/${encodeURIComponent(jobId)}/events`)
  } catch {
    if (mine === generation) dispatch({ kind: 'fail', status: 'offline', detail: TEX_OFFLINE_HINT })
    return null
  }
  if (!stream.ok || !stream.body) {
    if (mine === generation) dispatch({ kind: 'fail', status: 'failed', detail: `the compile stream failed (${stream.status})` })
    return null
  }

  let done: Record<string, unknown> | null = null
  for await (const payload of sseData(stream.body)) {
    let frame: unknown
    try { frame = JSON.parse(payload) } catch { continue } // malformed frame — skip
    if (typeof frame !== 'object' || frame === null) continue
    // a newer compile owns the chip now; this reader goes quiet
    if (mine !== generation) return null
    const f = frame as Record<string, unknown>
    if (f.type === 'done' && f.status === 'ok') lastOkJob = jobId
    dispatch({ kind: 'frame', frame: f, blind })
    if (f.type === 'done') { done = f; break }
  }
  if (mine !== generation) return null
  if (done === null) {
    dispatch({ kind: 'fail', status: 'failed', detail: 'the compile stream ended without a result' })
    return null
  }
  return {
    jobId,
    ok: done.status === 'ok',
    errors: current.errors,
    warnings: current.warnings,
    pages: current.pages,
    ms: current.ms,
  }
}

/** the service's `detail` says WHY (no engine, bad asset path) — surface it */
async function detailOf(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  try {
    const j = JSON.parse(text) as { detail?: unknown }
    if (typeof j.detail === 'string' && j.detail) return j.detail
  } catch { /* not json — use the body as-is */ }
  return text ? `${res.status}: ${text.slice(0, 200)}` : `the service refused the compile (${res.status})`
}

/** compile, then fetch the PDF bytes; throws with a user-facing sentence */
export async function compilePdf(doc: Doc): Promise<Blob> {
  const result = await compileNow(doc)
  if (result === null) throw new Error(current.detail ?? texHint())
  if (!result.ok) {
    const n = result.errors.length
    throw new Error(n > 0
      ? `${n} LaTeX error${n === 1 ? '' : 's'} — see the problems drawer`
      : current.detail ?? 'the engine produced no PDF')
  }
  const res = await fetch(`${SERVICE_BASE}/compile/${encodeURIComponent(result.jobId)}/pdf`)
  if (!res.ok) throw new Error(`the compiled PDF was not available (${res.status})`)
  return res.blob()
}

/* ---------- auto-compile ---------- */

/* The native view rests as the compiled render, so a compile is no longer
 * something the user asks for — it is what keeps the picture true. Edits
 * arrive in bursts (a keystroke commit, an undo, a copilot batch), so the
 * trigger is debounced; the engine takes seconds, so a second run never
 * overlaps the first. */

/** long enough that a sentence's worth of edits is one compile, short
 * enough that a pause of thought gets the render back */
export const AUTO_COMPILE_MS = 1500

export interface AutoCompiler {
  /** something changed — (re)arm the debounce */
  note(): void
  /** drop a pending run and any trailing one (a new document, the switch off) */
  cancel(): void
  /** is a compile armed or running? */
  busy(): boolean
}

/** Debounce + at-most-one-in-flight, with a single trailing run.
 *
 * Kept as a factory over an injected runner because this is the piece with
 * the ordering rules worth testing (a burst is one compile; edits during a
 * compile earn exactly one more, not one each) and none of them need a
 * daemon to be true. */
export function createAutoCompiler(run: () => Promise<unknown>, delayMs = AUTO_COMPILE_MS): AutoCompiler {
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight = false
  let trailing = false

  const fire = async (): Promise<void> => {
    if (inFlight) { trailing = true; return }
    inFlight = true
    try {
      await run()
    } catch {
      // the runner reports through the compile state; a rejection here is
      // not a reason to stop reacting to the next edit
    } finally {
      inFlight = false
    }
    if (trailing) { trailing = false; void fire() }
  }

  return {
    note(): void {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; void fire() }, delayMs)
    },
    cancel(): void {
      if (timer !== null) clearTimeout(timer)
      timer = null
      trailing = false
    },
    busy(): boolean { return timer !== null || inFlight },
  }
}

let autoOn = true

export function autoCompileOn(): boolean { return autoOn }

export function setAutoCompile(on: boolean): void {
  autoOn = on
  if (!on) auto.cancel()
}

const auto = createAutoCompiler(async () => {
  const doc = state.doc
  // the gate is read when the run FIRES, not when it was armed: the engine
  // may have arrived (or the switch flipped) during the debounce
  if (!doc || !autoOn || !texAvailable()) return
  await compileNow(doc)
})

/* the first compile of a document is not an edit — it is what makes the
 * native view a compiled render at all. It waits for an engine, because at
 * doc-loaded time the health poll has usually not answered yet. */
let wantFirst = false
let autoInstalled = false

/** Wire auto-compile to the op stream. Idempotent — the shell calls it once. */
export function installAutoCompile(): void {
  if (autoInstalled) return
  autoInstalled = true

  state.bus.on((e) => {
    switch (e.type) {
      case 'doc-loaded':
        auto.cancel()
        wantFirst = true
        firstCompile()
        break
      case 'deck-loaded':
        auto.cancel()
        wantFirst = false
        break
      case 'op':
      case 'undo':
      case 'redo':
      case 'blocks-changed':
        if (state.doc && autoOn) auto.note()
        break
    }
  })

  onCompileState(() => { firstCompile() })
}

function firstCompile(): void {
  if (!wantFirst || !autoOn || !state.doc || !texAvailable()) return
  if (current.status === 'compiling') return
  wantFirst = false
  auto.note()
}

/* ---------- PDF actions ---------- */

export function exportPdfAction(): void {
  const doc = state.doc
  if (!doc) return
  void compilePdf(doc).then((blob) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = (doc.texName || doc.fileName || 'document').replace(/\.(tex|html?)$/i, '') + '.pdf'
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
  }).catch((e: unknown) => {
    alert('Compile to PDF failed.\n\n' + (e instanceof Error ? e.message : String(e)))
  })
}

/** Preview: the tab is opened SYNCHRONOUSLY, before the compile, because a
 * window.open() seconds after the click has lost its user gesture and every
 * popup blocker eats it. The blank tab is closed again if nothing compiles. */
export function previewPdfAction(): void {
  const doc = state.doc
  if (!doc) return
  const tab = window.open('', '_blank')
  void compilePdf(doc).then((blob) => {
    const url = URL.createObjectURL(blob)
    if (tab) tab.location.href = url
    else window.open(url, '_blank')
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }).catch((e: unknown) => {
    tab?.close()
    alert('Compile to PDF failed.\n\n' + (e instanceof Error ? e.message : String(e)))
  })
}

/* ---------- managed tectonic install ---------- */

/** Drive POST /tex/install, reporting progress as it streams. Resolves to
 * the capability the daemon re-discovered afterwards (engine non-null on
 * success); throws with the installer's own message on failure. */
export async function installTectonic(
  onProgress?: (pct: number | null, note: string) => void,
): Promise<TexCapability | null> {
  const report = (pct: number | null, note: string): void => {
    dispatch({ kind: 'install', pct, note })
    onProgress?.(pct, note)
  }
  report(null, 'starting…')

  let res: Response
  try {
    res = await fetch(`${SERVICE_BASE}/tex/install`, { method: 'POST' })
  } catch {
    report(null, '')
    throw new Error(TEX_OFFLINE_HINT)
  }
  if (!res.ok || !res.body) {
    report(null, '')
    throw new Error(`the install could not start (${res.status})`)
  }

  let tex: TexCapability | null = null
  let failure = ''
  for await (const payload of sseData(res.body)) {
    let frame: unknown
    try { frame = JSON.parse(payload) } catch { continue }
    if (typeof frame !== 'object' || frame === null) continue
    const f = frame as Record<string, unknown>
    if (f.type === 'install') {
      if (f.phase === 'error') failure = typeof f.message === 'string' ? f.message : 'install failed'
      else report(installPct(f), installNote(f))
    } else if (f.type === 'done') {
      tex = (f.tex as TexCapability | undefined) ?? null
    }
  }
  report(null, '')
  if (failure) throw new Error(failure)
  // the daemon re-probes after unpacking; that verdict replaces the poll's
  dispatch({ kind: 'service', online: true, tex })
  return tex
}

function installPct(f: Record<string, unknown>): number | null {
  const got = typeof f.bytes === 'number' ? f.bytes : null
  const total = typeof f.total === 'number' ? f.total : null
  if (got === null || total === null || total <= 0) return null
  return Math.max(0, Math.min(1, got / total))
}

function installNote(f: Record<string, unknown>): string {
  switch (f.phase) {
    case 'start': return 'downloading…'
    case 'download': return 'downloading…'
    case 'verify': return 'verifying…'
    case 'unpack': return 'unpacking…'
    case 'done': return 'done'
    default: return typeof f.phase === 'string' ? f.phase : ''
  }
}
