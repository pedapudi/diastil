/* The engine's own numbering, read from the .aux.
 *
 * LaTeX writes what it actually numbered into main.aux, one line per label:
 *
 *     \newlabel{sec:app}{{A}{1}}                            (plain)
 *     \newlabel{sec:app}{{A}{1}{Appendix}{appendix.A}{}}    (hyperref)
 *     \newlabel{sec:app@cref}{{[subappendix][1][…]A}{…}}    (cleveref)
 *
 * — the resolved NUMBER, then the PAGE, then (hyperref) the title and an
 * anchor whose prefix names the label's kind, and (cleveref) a companion
 * entry carrying cleveref's own name for that kind. That is the whole of
 * what \ref, \pageref, \autoref and \cref print, and none of it is
 * reproducible from the document's structure: measured on a 25-line probe
 * against tectonic 0.15.0, \renewcommand{\thesection}, \setcounter,
 * \appendix and \section* each made derived.ts's counter walk disagree with
 * the engine, four wrong out of six. \pageref is not even approachable from
 * this side — a page break is a typesetting outcome — and it is free here.
 *
 * This is bibliography.ts's shape applied a second time: the daemon serves
 * the artifact verbatim (GET /compile/{id}/aux, texcompile.aux_text), the
 * parsing and the rendering live here, and derived.ts stays the single
 * writer of a.dia-ref's text. It registers itself as derived.ts's
 * NumberSource rather than doing a second pass over the DOM, because
 * refreshDerived runs on EVERY edit — a second pass would be overwritten by
 * the next keystroke.
 *
 * The .aux is per-compile state. It can be absent (no daemon, first open, a
 * compile that failed before the engine wrote one) and it can be STALE, and
 * a stale number shown as current is worse than a provisional one shown as
 * provisional. So the snapshot remembers the source text it was compiled
 * from; once the document has moved on, its numbers stay on screen — they
 * are still the best answer anyone has — but they go back to being marked
 * provisional. */

import { state } from '../state'
import { SERVICE_BASE } from '../service/client'
import { lastCompileJobId, onCompileState } from '../editor/doccompile'
import { refDisplay, refreshDerived, setNumberSource, type RefKind } from './derived'

/** one label as the engine resolved it */
export interface AuxLabel {
  /** what \ref prints: "S-10", "A.1", "1.1" */
  number: string
  /** what \pageref prints */
  page: string
  /** hyperref's anchor kind — 'section', 'appendix', 'figure', the capital-I
   * 'Item' enumerate writes — or null in a document without hyperref, where
   * the .aux carries only {number}{page} */
  anchorKind: RefKind | null
  /** cleveref's own name for the kind, from the `key@cref` companion entry.
   * A DIFFERENT vocabulary from the anchor's on purpose: measured, a section
   * inside \appendix has anchor `section.A.1` (so \autoref says "section
   * A.1") but cref kind `subappendix` (so \cref says "appendix A.1"). */
  crefKind: RefKind | null
}

/* ---------- the .aux parser (pure) ---------- */

// A control sequence, so the backslash must sit immediately before the name
// and the brace immediately after: this must NOT match the
// `\oldnewlabel{#1}{{#2}{#3}}` or the `\gdef\newlabel#1#2` inside the
// hyperref preamble block every hyperref .aux opens with. Built per call —
// the scan drives `lastIndex` by hand to skip over an entry's nested
// braces, and a shared regex carrying that state between calls is a bug
// waiting for its second caller.
const newlabelScan = () => /\\newlabel\{/g
// cleveref's companion entry, and the `[type]` that opens its first group
const CREF_SUFFIX = '@cref'
const CREF_TYPE = /^\[([^\]]*)\]/
// `figure.1`, `subsection.1.1`, `appendix.A`, `Item.1` — the kind is
// everything before the first dot
const ANCHOR_KIND = /^([^.]+)\./

/** Parse a .aux's \newlabel entries into key → AuxLabel. Anything that is
 * not a \newlabel — \@writefile, \bibcite, hyperref's preamble block — is
 * skipped; a malformed entry is dropped rather than guessed at. */
export function parseAux(text: string): Map<string, AuxLabel> {
  const raw = new Map<string, string[]>()
  const scan = newlabelScan()
  for (let m = scan.exec(text); m; m = scan.exec(text)) {
    const keyEnd = matchBrace(text, m.index + m[0].length - 1)
    if (keyEnd < 0) continue
    const key = text.slice(m.index + m[0].length, keyEnd)
    // the second argument, whose fields are the number, the page, …
    const argStart = text.indexOf('{', keyEnd + 1)
    if (argStart < 0) continue
    const argEnd = matchBrace(text, argStart)
    if (argEnd < 0) continue
    raw.set(key, fields(text.slice(argStart + 1, argEnd)))
    scan.lastIndex = argEnd + 1
  }

  const out = new Map<string, AuxLabel>()
  for (const [key, parts] of raw) {
    if (key.endsWith(CREF_SUFFIX)) continue
    if (parts.length < 2) continue
    const anchor = parts[3] ?? ''
    const cref = raw.get(key + CREF_SUFFIX)
    out.set(key, {
      number: parts[0],
      page: parts[1],
      anchorKind: ANCHOR_KIND.exec(anchor)?.[1] ?? null,
      crefKind: CREF_TYPE.exec(cref?.[0] ?? '')?.[1] || null,
    })
  }
  return out
}

/** index of the `}` closing the `{` at `open`, or -1. TeX nests: a hyperref
 * entry's title field is real document text and routinely carries brace
 * groups of its own (`\textsc {tpch-q3}` in corpus/tex/multifile). */
function matchBrace(s: string, open: number): number {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') { i++; continue }
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i
  }
  return -1
}

/** split `{A}{1}{Appendix}{appendix.A}{}` into its top-level brace groups */
function fields(s: string): string[] {
  const out: string[] = []
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue
    const end = matchBrace(s, i)
    if (end < 0) break
    out.push(s.slice(i + 1, end))
    i = end
  }
  return out
}

/* ---------- rendering a ref from the .aux (pure) ---------- */

/** The engine-backed text for one \ref-family command, or null when this
 * compile never saw the label — a \label typed since, or one inside an
 * \input the compile could not read. Null is not a failure: derived.ts
 * falls back to its counters and marks the result provisional.
 *
 * `domKind` is what the DOM walk saw. It is only ever a fallback: the .aux
 * knows kinds the DOM cannot (an \appendix section is still an `h2.dia-sec`
 * here, but `appendix` there), so it loses to both aux kinds. */
export function auxRefText(
  labels: ReadonlyMap<string, AuxLabel>, cmd: string, key: string, domKind: RefKind | null,
): string | null {
  const entry = labels.get(key)
  if (!entry) return null
  const kind = (cmd === 'cref' || cmd === 'Cref')
    ? entry.crefKind ?? entry.anchorKind ?? domKind
    : entry.anchorKind ?? domKind
  return refDisplay(cmd, kind, entry.number, entry.page, key)
}

/* ---------- the snapshot: which document these numbers describe ---------- */

interface AuxSnapshot {
  labels: Map<string, AuxLabel>
  /** the document source as it stood when this compile's .aux was read */
  source: string | null
}

let snapshot: AuxSnapshot | null = null

/** Install a parsed .aux as derived.ts's number source. `source` is the
 * document text the compile ran on; a later refresh compares it against the
 * live text to decide whether these numbers are still current. */
export function setAuxLabels(labels: Map<string, AuxLabel>, source: string | null): void {
  snapshot = { labels, source }
  setNumberSource((cmd, key, kind) => {
    const text = auxRefText(labels, cmd, key, kind)
    if (text === null) return null
    return { text, provisional: !sourceUnchanged(source) }
  })
}

/** Forget the engine's numbers — a different document is loading, and the
 * previous one's .aux describes nothing that is on screen. */
export function clearAuxLabels(): void {
  snapshot = null
  setNumberSource(null)
}

/** tests reach for this */
export function auxLabels(): ReadonlyMap<string, AuxLabel> {
  return snapshot?.labels ?? new Map()
}

/** Has the document moved since that compile? Unknown source (a test, or a
 * session with no live document) counts as unchanged: the caller handed us
 * these labels for this article and there is nothing better to compare. */
function sourceUnchanged(source: string | null): boolean {
  if (source === null) return true
  const live = state.doc?.source.text
  return live === undefined || live === source
}

/* ---------- fetching the compile's .aux ---------- */

/** GET the raw .aux for a finished compile job; empty map on 404 (no .aux —
 * an engine that kept no intermediates, or a compile that never got that
 * far) or any network failure. Never on the critical path. */
export async function fetchAuxNumbers(jobId: string): Promise<Map<string, AuxLabel>> {
  let res: Response
  try {
    res = await fetch(`${SERVICE_BASE}/compile/${encodeURIComponent(jobId)}/aux`)
  } catch {
    return new Map()
  }
  if (!res.ok) return new Map()
  const text = await res.text().catch(() => '')
  return parseAux(text)
}

/* ---------- wiring: a successful compile renumbers the document ---------- */

let installed = false
let shownJob: string | null = null

/** Wire .aux numbering to the compile controller — the same shape as
 * bibliography.ts's installBibliography, and installed beside it.
 * Idempotent; the shell calls it once. */
export function installAuxNumbers(): void {
  if (installed) return
  installed = true

  onCompileState((s) => {
    if (s.status !== 'ok') return
    const jobId = lastCompileJobId()
    if (!jobId || jobId === shownJob) return
    shownJob = jobId
    const article = state.doc?.article
    if (!article) return
    // the source THIS job compiled: read now, before the fetch, so an edit
    // landing while the request is in flight is correctly seen as a change
    const source = state.doc?.source.text ?? null
    void fetchAuxNumbers(jobId).then((labels) => {
      // a newer job may have superseded this fetch while it was in flight
      if (lastCompileJobId() !== jobId) return
      const current = state.doc?.article
      if (!current || labels.size === 0) return
      setAuxLabels(labels, source)
      refreshDerived(current)
    })
  })

  state.bus.on((e) => {
    if (e.type !== 'doc-loaded') return
    shownJob = null
    clearAuxLabels()
  })
}
