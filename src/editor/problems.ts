/* The problems drawer: what the engine said, one row per finding, each row a
 * jump into the document.
 *
 * The jump is the whole point. A TeX error is a line number in a file the
 * user never looks at; this maps it back through the source spans to the
 * block that produced it — line -> byte offset -> innermost bound block id ->
 * element -> scroll + flash.
 *
 * WHICH file's lines those are is the part that has to be right. The daemon
 * reports a project-relative path (`chapters/method.tex`) for a finding it
 * could place and null for one it could not, and every line number here is
 * counted in THAT file. A finding this document cannot claim — a .sty, a
 * class, a chapter the engine named but the project does not have — makes
 * the row say so and stay put rather than jump somewhere plausible and
 * wrong: an author sent to a paragraph that is fine is worse off than an
 * author sent nowhere. */

import type { DocSource } from '../latex/source'
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
  for (const f of findings) list.append(rowFor(f, state.doc ?? null))

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

function rowFor(f: TexError, doc: Doc | null): HTMLElement {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = f.level === 'warning' ? 'de-prob-row is-warn' : 'de-prob-row'

  const dot = document.createElement('span')
  dot.className = 'de-prob-dot'
  const where = document.createElement('span')
  where.className = 'de-prob-where'
  // a finding with no file is not labelled with one — the engine did not say
  // so, and a filename we invented is a filename the user cannot check
  where.textContent = f.line === null ? (f.file === null ? '—' : displayFile(doc, f.file))
    : f.file === null ? `line ${f.line}`
      : `${displayFile(doc, f.file)}:${f.line}`
  const msg = document.createElement('span')
  msg.className = 'de-prob-msg'
  msg.textContent = f.message

  row.append(dot, where, msg)

  const target = doc === null ? null : jumpTarget(doc, f)
  if (target === null) {
    row.classList.add('is-flat')
    row.title = declineReason(doc, f)
  } else {
    row.title = 'jump to the block this line is in'
    row.addEventListener('click', () => {
      const el = blockForLine(doc as Doc, target.line, undefined, target.source)
      if (!el) return
      scrollToBlock(el)
      flashBlock(el)
    })
  }
  return row
}

/** The source a finding's line number is counted in, or null when nothing
 * in this document can honestly claim it. The project owns the map from a
 * compile path to a file (`main.tex` is the job's name for the root, and
 * only the job's — the user's file is `thesis.tex`); the drawer only asks. */
export function sourceForFile(doc: Doc, file: string | null): DocSource | null {
  if (file === null) {
    // The engine said a line but not a file. In a one-file document that is
    // not ambiguous — there is one file. In a multi-file one it is: measured
    // on a real tectonic run, an undefined control sequence inside
    // chapters/method.tex reported line 29 with no file, and the main file
    // it would have been mapped against is sixteen lines long.
    return doc.project.multiFile ? null : doc.source
  }
  return doc.project.sourceOfCompilePath(file)
}

/** a path this document owns stays whole — `chapters/method.tex:29` is the
 * only form an author can check against their own tree — while a path into
 * a TeX installation is worth naming but not worth eighty columns */
function displayFile(doc: Doc | null, file: string): string {
  if (doc !== null && sourceForFile(doc, file) !== null) return file
  const tail = file.split(/[\\/]/).pop() ?? file
  return tail || file
}

/** The source and line a row would jump to, or null when there is nothing
 * to jump to. The block is probed HERE as well as looked up again on click:
 * naming a file correctly is not the same as having it on screen, and a row
 * that looks clickable and then does nothing reads as a broken drawer. The
 * element is not held across the render — an edit re-renders the article,
 * and a stale node would flash nothing. */
function jumpTarget(doc: Doc, f: TexError): { source: DocSource; line: number } | null {
  if (f.line === null) return null
  const source = sourceForFile(doc, f.file)
  if (source === null) return null
  return blockForLine(doc, f.line, undefined, source) === null
    ? null
    : { source, line: f.line }
}

/** why this row does not jump. A dead row with no explanation reads as a
 * broken drawer; the reason is the difference between "we will not guess"
 * and "this is broken". */
function declineReason(doc: Doc | null, f: TexError): string {
  if (f.line === null) return 'no line to jump to'
  const source = doc === null ? null : sourceForFile(doc, f.file)
  if (source === null) {
    if (f.file !== null) return `reported in ${f.file} — not one of this document's files`
    return doc !== null && doc.project.multiFile
      ? 'the engine gave a line but not which file it is in, and this document is more than one file — jumping would be a guess'
      : 'no line to jump to'
  }
  // The file is genuinely this document's and the line is genuinely in it,
  // and still nothing on screen is bound to it. An \input that is not a
  // top-level block — nested in an environment, or in the preamble — is
  // read, compiled and exported, but its content is NOT spliced into the
  // view: binding a chapter's blocks under a span that belongs to the
  // enclosing environment is the corruption the project layer exists to
  // prevent. So the compile is right, the resolver is right, and there is
  // simply no block here. Verified against a real nested \input: the
  // resolved DocSource carries the chapter's exact text and zero bindings.
  //
  // The identity check against doc.source is what keeps this off the ROOT,
  // which has zero bindings too whenever the body is empty — a brand-new
  // document, which is now a first-class flow. "It is \input from
  // somewhere" is nonsense about the file the user is looking at, and the
  // root reaches the same decline through the truthful sentence below.
  // sourceOfCompilePath returns the very same DocSource for the root under
  // every spelling of it (`main.tex`, `./main.tex`, the user's own name),
  // so identity is the whole test.
  if (f.file !== null && source !== doc?.source && source.snapshotBindings().size === 0) {
    return `${f.file} is part of this document, but it is \\input from somewhere the editor does not splice (inside an environment, or the preamble) — open that file itself to edit it`
  }
  return `nothing in the view covers line ${f.line}${f.file === null ? '' : ` of ${f.file}`}`
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
 * handler is a hang waiting for a large document.
 *
 * `source` names WHICH file the line is counted in; it defaults to the
 * document's root source, which is the only one a single-file document has.
 * The element is looked up in the one article either way — every file's
 * blocks render into it, and a block id is unique across the project. */
export function blockForLine(doc: Doc, line: number, host?: ParentNode,
                             source?: DocSource): HTMLElement | null {
  const id = idForLine(doc, line, source)
  if (id === null) return null
  const root = host ?? doc.article
  return root.querySelector<HTMLElement>(`[data-dia-id="${cssEscape(id)}"]`)
}

/** the block id owning a 1-based line of `source`, or null */
export function idForLine(doc: Doc, line: number, source?: DocSource): string | null {
  const src = source ?? doc.source
  const text = src.text
  const start = src.offsetOfLine(line)
  const LOOKAHEAD_LINES = 6
  let seenNewlines = 0
  for (let i = start; i < text.length; i++) {
    const id = src.idAt(i)
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
