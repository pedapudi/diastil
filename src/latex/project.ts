/* Multi-file LaTeX projects — following \input/\include.
 *
 * A thesis or a collaborative paper is almost never one file. Before this
 * module an `\input{chapters/intro}` was an ISLAND: one grey line on
 * screen, the actual chapter in a file the editor never opened, and a
 * compile that died on `File 'chapters/intro.tex' not found`.
 *
 * The shape of the fix, and why it is this shape:
 *
 *   ONE DocSource PER FILE. The single-file model (latex/source.ts) is a
 *   string plus a session-only id→span map, and it is exactly right — per
 *   file. A project is a SET of those, never a concatenation: concatenating
 *   would make one span space and one line space out of several, and both
 *   are load-bearing elsewhere (compile errors, SyncTeX, and the raw source
 *   view all speak in per-file line numbers). Blocks from `chapters/intro`
 *   bind their spans in intro's OWN DocSource, so patching one block writes
 *   into that file and touches no byte of any other — the same invariant
 *   the single-file editor already held, held per file.
 *
 *   PATHS ARE RELATIVE TO THE PROJECT ROOT, not to the including file.
 *   That is TeX's own rule: the engine resolves \input against the working
 *   directory it was launched in, so a chapter that itself says
 *   \input{figures/plot} means <root>/figures/plot.tex even though the
 *   chapter lives in chapters/. Resolving relative to the includer would
 *   quietly build a different document than the one that compiles.
 *
 *   AN UNREADABLE INCLUDE STAYS AN ISLAND. Offline, with no daemon and no
 *   folder grant, there is nothing to read; the document still opens, the
 *   \input keeps its own bytes and SAYS what it could not reach. A file
 *   with no DocSource has no blocks and therefore no write path — a
 *   truncated write-back is impossible by construction, not by care. */

import { parseLatex } from './parse'
import { renderDoc } from './render'
import { DocSource } from './source'
import type { PreambleMeta } from './parse'

/** How deep \input nesting may go. Real projects are 2 levels (main →
 * chapter → occasional shared fragment); the cap exists so a cycle the
 * visited-set somehow misses still terminates. */
export const MAX_INPUT_DEPTH = 8

/* ---------- recognizing an include ---------- */

/** `\input{path}` / `\include{path}` and nothing else, modulo surrounding
 * whitespace. Deliberately narrow: an \input buried mid-paragraph shares a
 * block with prose, and splicing a whole chapter into the middle of a
 * paragraph's span would put that chapter's blocks under a span they do
 * not own. Real projects put the command on its own line, and \include
 * (which forces a \clearpage) is always standalone anyway. */
const INPUT_BLOCK_RE = /^\\(input|include)\s*\{([^{}]*)\}$/

export interface InputCall { cmd: 'input' | 'include'; arg: string }

export function matchInputBlock(slice: string): InputCall | null {
  const m = INPUT_BLOCK_RE.exec(slice.trim())
  return m ? { cmd: m[1] as 'input' | 'include', arg: m[2] } : null
}

/** Every \input/\include in a source, wherever it sits — used to decide
 * which files a project NEEDS (what to ask the folder grant for, what to
 * ship to the compiler), which is a strictly wider question than which
 * ones can be spliced into the view. */
const INPUT_SCAN_RE = /(^|[^\\])\\(input|include)\s*\{([^{}]*)\}/g

export function scanInputPaths(tex: string): string[] {
  const out: string[] = []
  // a commented-out \input is not a dependency; strip line comments the
  // same way the parser's own no-type scan does (an escaped \% is not one)
  const live = tex.replace(/(^|[^\\])%[^\n]*/g, '$1')
  for (const m of live.matchAll(INPUT_SCAN_RE)) {
    const path = resolveInputPath(m[3])
    if (path && !out.includes(path)) out.push(path)
  }
  return out
}

/** An \input argument as a project-relative path, or null when it is one
 * this module refuses to reach for.
 *
 * The rejections MIRROR the daemon's `_safe_asset_path`
 * (service/dia_service/texcompile.py) on purpose: whatever we resolve here
 * is what gets read off the user's disk and shipped back as a compile
 * asset, so a path this side accepts and that side refuses is a compile
 * that fails for a reason the user cannot see. Absolute paths, `..`, and
 * drive letters are out; a bare name gets `.tex` the way TeX does. */
export function resolveInputPath(arg: string): string | null {
  const raw = arg.trim()
  if (!raw) return null
  // TeX takes `/` on every platform; a backslash here is an escape, and an
  // escape in a filename is not something to guess at
  if (raw.includes('\\')) return null
  if (raw.startsWith('/') || raw.includes(':')) return null
  const parts = raw.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null
  const last = parts[parts.length - 1]
  // `\input{chapters/intro}` means intro.tex; `\input{refs.bbl}` means the
  // .bbl. Only the LAST segment's extension counts.
  const path = last.includes('.') ? parts.join('/') : `${parts.join('/')}.tex`
  return path
}

/* ---------- the project ---------- */

export interface ProjectFile { path: string; source: DocSource }

/** every file's span map plus the block-id → file map, as one value */
export interface ProjectBindings {
  owner: Map<string, string>
  spans: Map<string, Map<string, { start: number; end: number }>>
}

/** An \input the composition could not turn into content, and why — the
 * honest degrade, surfaced on the island itself. */
export interface UnresolvedInput {
  /** the block element that kept its \input bytes */
  el: HTMLElement
  /** the resolved project-relative path, or the raw argument when the path
   * itself is what was refused */
  path: string
  reason: 'unreadable' | 'refused' | 'empty' | 'cycle' | 'too-deep'
}

export class DocProject {
  /** included files that were actually READ, path → its own DocSource.
   * A file that could not be read has no entry: no source, no blocks, no
   * write path. */
  private readonly included = new Map<string, DocSource>()
  /** block id → the path of the file whose DocSource holds its span.
   * Session-only, exactly like the spans themselves (source.ts) — a fresh
   * session rebuilds it by re-composing, so nothing can rot in the DOM. */
  private readonly owner = new Map<string, string>()
  /** each included file's bytes AS READ. A save must write the files that
   * actually changed and no others: rewriting a file the user never
   * touched is how a project's whole mtime history disappears into one
   * commit, and NOT writing one they did edit is the worse half — the
   * edit is on screen and not on disk. */
  private readonly pristine = new Map<string, string>()

  constructor(
    /** the main file's own name, as the project sees it — the cycle check
     * needs it, so a chapter that \inputs the main file is refused */
    readonly mainPath: string,
    readonly main: DocSource,
    texts: Record<string, string> = {},
  ) {
    for (const [path, text] of Object.entries(texts)) {
      const clean = resolveInputPath(path)
      if (clean !== null && clean !== mainPath) {
        this.included.set(clean, new DocSource(text))
        this.pristine.set(clean, text)
      }
    }
  }

  /** the DocSource for a project-relative path, main included */
  sourceOfPath(path: string): DocSource | null {
    if (path === this.mainPath) return this.main
    return this.included.get(path) ?? null
  }

  has(path: string): boolean {
    return path === this.mainPath || this.included.has(path)
  }

  /** included files only, sorted — the order everything that iterates
   * files uses, so serialization is byte-stable across sessions */
  includedPaths(): string[] {
    return [...this.included.keys()].sort()
  }

  includedTexts(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const path of this.includedPaths()) out[path] = (this.included.get(path) as DocSource).text
    return out
  }

  /** every file in the project, main first then included in sorted order */
  files(): ProjectFile[] {
    return [
      { path: this.mainPath, source: this.main },
      ...this.includedPaths().map((path) => ({ path, source: this.included.get(path) as DocSource })),
    ]
  }

  /** remember a file was read; used by the resolvers that arrive AFTER the
   * document opened (folder grant, daemon read) */
  adopt(path: string, text: string): void {
    if (path === this.mainPath) return
    this.included.set(path, new DocSource(text))
    this.pristine.set(path, text)
  }

  /** included files whose bytes differ from what was read — exactly the
   * set a save has to write back */
  changedPaths(): string[] {
    return this.includedPaths().filter((p) => (this.included.get(p) as DocSource).text !== this.pristine.get(p))
  }

  /** after a successful write: these bytes are now what is on disk */
  markSaved(paths: readonly string[] = this.includedPaths()): void {
    for (const p of paths) {
      const source = this.included.get(p)
      if (source) this.pristine.set(p, source.text)
    }
  }

  /** bind a rendered block's span in the file that actually owns it */
  bind(id: string, path: string, span: { start: number; end: number }): void {
    const source = this.sourceOfPath(path)
    if (!source) return
    source.bind(id, span)
    this.owner.set(id, path)
  }

  /** which file a block's bytes live in — what the write path routes on */
  fileOfId(id: string): string | null {
    return this.owner.get(id) ?? null
  }

  /** A project path from a file name as the COMPILE names it, or null when
   * it names nothing this project holds (a .sty, a class, a font).
   *
   * The two namings genuinely differ and the difference is invisible at
   * the call site, which is why it is normalized here once rather than
   * guessed at by each consumer. The workdir always calls the root source
   * `main.tex` — that is the job's name, not the user's, whose file is
   * `thesis.tex`. Included files keep their own paths, because the asset
   * name we ship IS the project path (`chapters/intro.tex`), so those need
   * only `./` and separator tidying.
   *
   * `main.tex` reads as the ROOT even in the rare project that also holds
   * a file of that name: the compile only ever means the job by it, and
   * the daemon refuses to write a root-level main.tex asset at all. */
  fileOfCompilePath(file: string): string | null {
    const clean = file.replace(/\\/g, '/').replace(/^\.\//, '')
    if (clean === 'main.tex' || clean === this.mainPath) return this.mainPath
    return this.included.has(clean) ? clean : null
  }

  /** the DocSource behind a compile-reported file name — line numbers in a
   * chapter's log record index THAT file, never the main one */
  sourceOfCompilePath(file: string): DocSource | null {
    const path = this.fileOfCompilePath(file)
    return path === null ? null : this.sourceOfPath(path)
  }

  sourceOfId(id: string): DocSource | null {
    const path = this.owner.get(id)
    return path === undefined ? null : this.sourceOfPath(path)
  }

  /** drop every binding — a whole-source re-compose rebuilds them all */
  clearBindings(): void {
    for (const f of this.files()) f.source.clearBindings()
    this.owner.clear()
  }

  /** Bindings for EVERY file, for an undo that has to put the whole
   * composition back. The main file's own snapshot is not enough: a
   * re-compose clears the chapters' spans and the owner map too, and an
   * undo that restores only main leaves every chapter block bound to
   * nothing — its edits stop reaching the source, quietly. */
  snapshotBindings(): ProjectBindings {
    return {
      owner: new Map(this.owner),
      spans: new Map(this.files().map((f) => [f.path, f.source.snapshotBindings()])),
    }
  }

  restoreBindings(snapshot: ProjectBindings): void {
    this.owner.clear()
    for (const [id, path] of snapshot.owner) this.owner.set(id, path)
    for (const [path, spans] of snapshot.spans) this.sourceOfPath(path)?.restoreBindings(spans)
  }

  /** true when this project is more than its main file — the cheap check
   * every single-file path uses to stay exactly as it was */
  get multiFile(): boolean {
    return this.included.size > 0
  }
}

/* ---------- composition ---------- */

export interface ComposedBlock {
  el: HTMLElement
  span: { start: number; end: number }
  /** the file this block's span indexes into */
  path: string
}

export interface ComposedProject {
  article: HTMLElement
  blocks: ComposedBlock[]
  meta: PreambleMeta
  unresolved: UnresolvedInput[]
}

/** Render a whole project into ONE article: the main file's blocks, with
 * every resolvable \input replaced in place by the blocks of the file it
 * names. `mainText` overrides project.main.text for the raw-editor commit
 * path, which re-composes from text it has not stored yet. */
export function composeProject(project: DocProject, mainText?: string): ComposedProject {
  const text = mainText ?? project.main.text
  const rendered = renderDoc(parseLatex(text))
  const blocks: ComposedBlock[] = rendered.blocks.map((b) => ({ el: b.el, span: b.span, path: project.mainPath }))
  const unresolved: UnresolvedInput[] = []
  spliceInputs(project, project.mainPath, text, blocks, unresolved, 0, new Set([project.mainPath]))
  return { article: rendered.article, blocks, meta: rendered.meta, unresolved }
}

/** Walk `blocks` (in place), replacing every \input block whose file is
 * readable with that file's own rendered blocks. The DOM splice and the
 * block-list splice happen together so the two can never disagree. */
function spliceInputs(
  project: DocProject,
  fromPath: string,
  fromText: string,
  blocks: ComposedBlock[],
  unresolved: UnresolvedInput[],
  depth: number,
  visited: Set<string>,
): void {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (b.path !== fromPath) continue
    const call = matchInputBlock(fromText.slice(b.span.start, b.span.end))
    if (!call) continue

    const path = resolveInputPath(call.arg)
    if (path === null) {
      unresolved.push({ el: b.el, path: call.arg, reason: 'refused' })
      continue
    }
    if (depth >= MAX_INPUT_DEPTH) {
      unresolved.push({ el: b.el, path, reason: 'too-deep' })
      continue
    }
    if (visited.has(path)) {
      unresolved.push({ el: b.el, path, reason: 'cycle' })
      continue
    }
    const source = project.sourceOfPath(path)
    if (source === null) {
      unresolved.push({ el: b.el, path, reason: 'unreadable' })
      continue
    }

    const inner = renderDoc(parseLatex(source.text))
    const innerBlocks: ComposedBlock[] = inner.blocks.map((x) => ({ el: x.el, span: x.span, path }))
    if (innerBlocks.length === 0) {
      // the file was read and holds no blocks. Splicing nothing in would
      // make the \input vanish from the view with no way to tell an empty
      // chapter from a lost one — keep the island and say which it is.
      unresolved.push({ el: b.el, path, reason: 'empty' })
      continue
    }
    spliceInputs(project, path, source.text, innerBlocks, unresolved, depth + 1, new Set([...visited, path]))

    b.el.replaceWith(...innerBlocks.map((x) => x.el))
    blocks.splice(i, 1, ...innerBlocks)
    i += innerBlocks.length - 1
  }
}

/* ---------- the honest degrade ---------- */

/** Mark an \input the composition could not follow, ON the block itself.
 *
 * The note is a `.dia-editor-artifact` child, which is the codebase's
 * established way to say "editor furniture, not document": both
 * emit.ts's cleanOuter and doc.ts's cleanClone strip that class, so the
 * block's render memo still matches its pristine markup (it re-emits its
 * own bytes verbatim) and the saved artifact never carries the note. The
 * \input keeps every byte it arrived with. */
export function markUnresolved(list: UnresolvedInput[]): void {
  for (const u of list) {
    if (u.el.querySelector('.dia-input-unreached')) continue
    const note = document.createElement('span')
    note.className = 'dia-input-unreached dia-editor-artifact'
    // the reason rides the NOTE, never the block: an attribute on the block
    // would change its markup against the render memo, and emit.ts would
    // read that as an edit and rebuild bytes nobody touched
    note.setAttribute('data-dia-input-state', u.reason)
    note.textContent = unresolvedText(u)
    u.el.appendChild(note)
  }
}

function unresolvedText(u: UnresolvedInput): string {
  switch (u.reason) {
    case 'unreadable':
      return `${u.path} was not read — open the document's folder to edit this chapter here`
    case 'refused':
      return `${u.path} is not a path this editor will follow (absolute, or leaves the project folder)`
    case 'empty':
      return `${u.path} was read and holds no content`
    case 'cycle':
      return `${u.path} includes itself — not followed`
    case 'too-deep':
      return `${u.path} is nested deeper than ${MAX_INPUT_DEPTH} levels — not followed`
  }
}

/* ---------- reading a project off some filesystem ---------- */

/** Read every file a project transitively needs, given anything that can
 * fetch one by project-relative path. Bounded three ways — the depth cap,
 * the visited set, and the fact that only paths the SOURCE names are ever
 * asked for — so this can never become "slurp the folder". Files that
 * cannot be read are simply absent; the caller's document still opens. */
export async function readProjectFiles(
  mainText: string,
  read: (path: string) => Promise<string | null>,
  mainPath?: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const seen = new Set<string>(mainPath ? [mainPath] : [])
  let frontier = scanInputPaths(mainText).filter((p) => !seen.has(p))
  for (let depth = 0; depth < MAX_INPUT_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = []
    for (const path of frontier) {
      if (seen.has(path)) continue
      seen.add(path)
      const text = await read(path)
      if (text === null) continue
      out[path] = text
      for (const p of scanInputPaths(text)) if (!seen.has(p)) next.push(p)
    }
    frontier = next
  }
  return out
}
