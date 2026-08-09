/* The problems drawer: what the engine said, one row per finding, each row a
 * jump into the document.
 *
 * The jump is the whole point. A TeX error is a line number in a file the
 * user never looks at; this maps it back through the source spans to the
 * block that produced it — line -> byte offset -> innermost bound block id ->
 * element -> scroll + flash. When the finding names a file that is not this
 * document's source (a .sty, an \input'd chapter), the row says so and stays
 * put rather than jumping somewhere plausible and wrong. */

import type { Doc } from '../model/doc'
import { state } from '../state'
import { grantFolderAndRecompile, onCompileState, type CompileState, type TexError } from './doccompile'
import { flashBlock, scrollToBlock } from './docview'
import { folderGrantAvailable } from './folderGrant'

let drawer: HTMLElement | null = null
let list: HTMLElement | null = null
let titleEl: HTMLElement | null = null
/* the drawer auto-opens on the TRANSITION into failure, never on every
 * broadcast — a health poll two seconds after the user closed it must not
 * shove it back open */
let lastStatus = ''

export function mountProblems(mainEl: HTMLElement): void {
  drawer = document.createElement('div')
  drawer.className = 'de-problems'
  drawer.hidden = true

  const head = document.createElement('div')
  head.className = 'de-prob-head'
  titleEl = document.createElement('span')
  titleEl.className = 'de-prob-title'
  const spacer = document.createElement('span')
  spacer.className = 'de-spacer'
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'de-prob-close'
  close.textContent = '✕'
  close.title = 'close (Esc)'
  close.addEventListener('click', () => toggleProblems(false))
  head.append(titleEl, spacer, close)

  list = document.createElement('div')
  list.className = 'de-prob-list'
  drawer.append(head, list)
  mainEl.append(drawer)

  onCompileState(render)

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !problemsOpen()) return
    // the shell's typing exemption: a field owns its own Escape
    const inField = e.composedPath().some((t) =>
      t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable))
    if (inField) return
    e.preventDefault()
    toggleProblems(false)
  })
}

export function problemsOpen(): boolean {
  return drawer !== null && !drawer.hidden
}

export function toggleProblems(force?: boolean): void {
  if (!drawer) return
  const open = force ?? drawer.hidden
  drawer.hidden = !open
}

/** does the drawer have anything worth opening for? */
export function problemsCount(s: CompileState): number {
  return s.errors.length + s.warnings.length
}

function render(s: CompileState): void {
  if (!drawer || !list || !titleEl) return
  const findings = [...s.errors, ...s.warnings]
  titleEl.textContent = s.errors.length > 0
    ? `${s.errors.length} error${s.errors.length === 1 ? '' : 's'}${s.warnings.length ? `, ${s.warnings.length} warning${s.warnings.length === 1 ? '' : 's'}` : ''}`
    : s.warnings.length > 0
      ? `${s.warnings.length} warning${s.warnings.length === 1 ? '' : 's'}`
      : s.status === 'ok' ? 'no problems' : 'problems'

  list.replaceChildren()
  if (findings.length === 0 && s.detail) {
    // an engine that produced no PDF and no parseable error still owes the
    // user a sentence — the daemon's detail is that sentence
    const note = document.createElement('div')
    note.className = 'de-prob-note'
    note.textContent = s.detail
    list.append(note)
  }
  // the one-click recovery: only offered when the failure is EXACTLY the
  // shape a folder grant fixes, and only where the API exists to fix it
  if (s.blindMissing && folderGrantAvailable()) list.append(grantRow())
  for (const f of findings) list.append(rowFor(f))

  // a failed compile opens the drawer itself; a clean one never closes it
  // behind the user's back (they may be reading the last run's warnings)
  const became = s.status !== lastStatus
  lastStatus = s.status
  if (became && s.status === 'failed' && findings.length > 0) toggleProblems(true)
}

let granting = false

/** the drawer's offer for a blind compile: read the document's folder in
 * the browser and resubmit with its styles/figures attached */
function grantRow(): HTMLElement {
  const row = document.createElement('div')
  row.className = 'de-prob-grant'
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.textContent = 'grant folder access…'
  btn.title = 'read this document’s folder in the browser and send its styles, classes and figures along with the compile'
  const original = btn.textContent
  btn.addEventListener('click', () => {
    if (granting || !state.doc) return
    granting = true
    btn.disabled = true
    btn.textContent = 'choose a folder…'
    void grantFolderAndRecompile(state.doc).then((result) => {
      // null: the user cancelled the picker — leave the offer exactly as it was
      if (result === null) { btn.textContent = original; btn.disabled = false }
    }).finally(() => { granting = false })
  })
  row.append(btn)
  return row
}

function rowFor(f: TexError): HTMLElement {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = f.level === 'warning' ? 'de-prob-row is-warn' : 'de-prob-row'

  const dot = document.createElement('span')
  dot.className = 'de-prob-dot'
  const where = document.createElement('span')
  where.className = 'de-prob-where'
  // a finding with no file is not claimed for main.tex — the engine did not
  // say so, and a filename we invented is a filename the user cannot check
  where.textContent = f.line === null ? (f.file ?? '—')
    : f.file === null ? `line ${f.line}`
      : `${shortFile(f.file)}:${f.line}`
  const msg = document.createElement('span')
  msg.className = 'de-prob-msg'
  msg.textContent = f.message

  row.append(dot, where, msg)

  const target = jumpableLine(f)
  if (target === null) {
    row.classList.add('is-flat')
    row.title = f.file && !isMainSource(f.file)
      ? `reported in ${f.file} — not this document's source`
      : 'no line to jump to'
  } else {
    row.title = 'jump to the block this line is in'
    row.addEventListener('click', () => jumpToLine(target))
  }
  return row
}

/** the daemon compiles the source as `main.tex`; anything else is a package,
 * a class, or an \input'd file whose own line numbering we cannot map a
 * main-file offset into */
function isMainSource(file: string): boolean {
  return /(^|[\\/])main\.tex$/.test(file)
}

function shortFile(file: string): string {
  const tail = file.split(/[\\/]/).pop() ?? file
  return tail || file
}

function jumpableLine(f: TexError): number | null {
  if (f.line === null) return null
  if (f.file !== null && !isMainSource(f.file)) return null
  // A file-less line in a MULTI-FILE project cannot be placed. TeX numbers
  // lines per file, and an \input'd chapter's line 26 is not main.tex's
  // line 26 — measured: an undefined control sequence inside
  // chapters/method.tex comes back as `line: 26, file: null`, which mapped
  // against main.tex lands on an unrelated paragraph. Refusing to jump is
  // the honest answer until the daemon's log parse tracks the open-file
  // stack (`(./chapters/method.tex … )`) and attributes the line itself.
  if (f.file === null && state.doc?.project.multiFile) return null
  return f.line
}

function jumpToLine(line: number): void {
  const doc = state.doc
  if (!doc) return
  const el = blockForLine(doc, line)
  if (!el) return
  scrollToBlock(el)
  flashBlock(el)
}

/** The mapping the whole drawer rests on: a 1-based source line to the block
 * element that owns it.
 *
 * Blocks tile the source with GAPS between them (blank lines, stray
 * whitespace), so an error line can legitimately land in no block at all —
 * a `\usepackage` typo reported one line past the preamble's end, say. The
 * search therefore walks forward from the line start: first through that
 * line, then into the following few lines, taking the first offset that is
 * inside a bound span. Forward and bounded, because the block a stray line
 * belongs to is the one that follows it, and an unbounded scan on a click
 * handler is a hang waiting for a large document. */
export function blockForLine(doc: Doc, line: number, host?: ParentNode): HTMLElement | null {
  const id = idForLine(doc, line)
  if (id === null) return null
  const root = host ?? doc.article
  return root.querySelector<HTMLElement>(`[data-dia-id="${cssEscape(id)}"]`)
}

/** the block id owning a 1-based source line, or null */
export function idForLine(doc: Doc, line: number): string | null {
  const text = doc.source.text
  const start = doc.source.offsetOfLine(line)
  const LOOKAHEAD_LINES = 6
  let seenNewlines = 0
  for (let i = start; i < text.length; i++) {
    const id = doc.source.idAt(i)
    if (id !== null) return id
    if (text[i] === '\n' && ++seenNewlines > LOOKAHEAD_LINES) break
  }
  return null
}

/** CSS.escape is absent in happy-dom; ids are `d<session>-<n>`, so escaping
 * the one character that could appear and break a selector is enough */
function cssEscape(id: string): string {
  const g = globalThis as { CSS?: { escape?: (s: string) => string } }
  return g.CSS?.escape ? g.CSS.escape(id) : id.replace(/"/g, '\\"')
}
