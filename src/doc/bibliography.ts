/* Citation resolution — display only. `a.dia-cite`'s TEXT is derived exactly
 * the way `a.dia-ref`'s is (see derived.ts): the source truth stays in
 * data-dia-cite / -cmd / -pre / -opt, emit.ts reads only those, and this
 * module's whole job is to make the on-screen text say what natbib would
 * print instead of the raw \cite key.
 *
 * The data comes from the compile's own .bbl (service/dia_service/texcompile
 * .py: CompileJob.bbl_path) — bibtex's output, or the precompiled one an
 * arXiv bundle shipped and _adopt_precompiled_bbl adopted. A .bbl's
 * \bibitem[{Author et al.(2020)Author, Other, …}]{key} carries an OPTIONAL
 * label whose text up to the year is exactly natbib's short-author form;
 * the full name list after the year is only for internal disambiguation
 * and is never shown here.
 *
 * A document with no bibliography — no .bbl, or a 404 from the daemon —
 * keeps showing [key], which is what render.ts already puts there. */

import { state } from '../state'
import { SERVICE_BASE } from '../service/client'
import { lastCompileJobId, onCompileState } from '../editor/doccompile'
import { resealMemos } from './derived'

export interface BibEntry {
  /** natbib's short author form, e.g. "Austin et al.", "Elman", "Wiegreffe
   * and Marasović" — already de-TeXed (accents decoded, `~` → space) */
  authors: string
  /** the bibitem's year, with any \natexlab{a,b,…} disambiguator appended */
  year: string
}

/* ---------- the .bbl parser (pure) ---------- */

const BIBITEM = /\\bibitem(?:\[([^]*?)\])?\{([^}]+)\}/g
// short-author text, then (year), then the full name list this module
// ignores; \natexlab{x} inside the year is bibtex's same-year disambiguator
const LABEL_SPLIT = /^(.*?)\((\d{4})(?:\{\\natexlab\{([a-zA-Z])\}\})?\)/

/** Parse a .bbl's \bibitem labels into key → {authors, year}. A \bibitem
 * with no optional label (plain numeric styles) contributes nothing — there
 * is no author-year text to resolve to, and the key keeps showing [key]. */
export function parseBbl(text: string): Map<string, BibEntry> {
  const out = new Map<string, BibEntry>()
  for (const m of text.matchAll(BIBITEM)) {
    const [, rawLabel, rawKey] = m
    if (!rawLabel) continue
    const entry = parseLabel(rawLabel)
    if (entry) out.set(rawKey.trim(), entry)
  }
  return out
}

function parseLabel(raw: string): BibEntry | null {
  // the label wraps across source lines purely for .bbl line width; TeX
  // reads the break as ordinary space, so this collapse is what it renders
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  const m = LABEL_SPLIT.exec(stripOuterBraces(collapsed))
  if (!m) return null
  const authors = decodeLatexText(m[1])
  if (!authors) return null
  return { authors, year: m[2] + (m[3] ?? '') }
}

/** natbib wraps the whole optional label in one `{}` pair so it survives a
 * movable argument; strip exactly that pair, not a brace group that merely
 * starts the string (e.g. "{BIG-bench collaboration}(2021)" stays whole). */
function stripOuterBraces(s: string): string {
  if (s[0] !== '{' || s[s.length - 1] !== '}') return s
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') depth++
    else if (s[i] === '}') {
      depth--
      if (depth === 0) return i === s.length - 1 ? s.slice(1, -1) : s
    }
  }
  return s
}

// mark → { plain letter → accented letter }, covering the accents this
// project's real corpus actually uses (llama/cot/flan bbl fixtures)
const ACCENTS: Record<string, Record<string, string>> = {
  "'": { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', y: 'ý', c: 'ć', n: 'ń', s: 'ś', z: 'ź',
    A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú', C: 'Ć', N: 'Ń' },
  '`': { a: 'à', e: 'è', i: 'ì', o: 'ò', u: 'ù', y: 'ỳ', A: 'À', E: 'È' },
  '^': { a: 'â', e: 'ê', i: 'î', o: 'ô', u: 'û', A: 'Â', E: 'Ê' },
  '"': { a: 'ä', e: 'ë', i: 'ï', o: 'ö', u: 'ü', y: 'ÿ', A: 'Ä', O: 'Ö', U: 'Ü' },
  '~': { a: 'ã', n: 'ñ', o: 'õ', A: 'Ã', N: 'Ñ', O: 'Õ' },
  '=': { a: 'ā', e: 'ē', i: 'ī', o: 'ō', u: 'ū' },
  '.': { z: 'ż', Z: 'Ż' },
  v: { c: 'č', s: 'š', z: 'ž', e: 'ě', r: 'ř', n: 'ň', d: 'ď', t: 'ť', C: 'Č', S: 'Š', Z: 'Ž' },
  u: { a: 'ă', g: 'ğ' },
  c: { c: 'ç', s: 'ş', C: 'Ç' },
  H: { o: 'ő', u: 'ű' },
  k: { a: 'ą', e: 'ę' },
  r: { a: 'å', A: 'Å' },
}
const LIGATURES: Record<string, string> = {
  ae: 'æ', AE: 'Æ', o: 'ø', O: 'Ø', l: 'ł', L: 'Ł', ss: 'ß', i: 'ı', j: 'j',
}

/** the tiny slice of LaTeX text macros an author name actually needs:
 * accent commands, the `~` non-breaking space bibtex writes into "et~al.",
 * and stray grouping braces — nothing here touches math or command args
 * generally, this is not a TeX text renderer */
function decodeLatexText(s: string): string {
  let out = s.replace(/\\([`'^"~=.vucHkr])\{?([a-zA-Z])\}?/g, (_m, mark: string, letter: string) =>
    ACCENTS[mark]?.[letter] ?? letter)
  out = out.replace(/\\(ae|AE|ss|i|j|[oOlL])(?![a-zA-Z])/g, (_m, name: string) => LIGATURES[name] ?? name)
  out = out.replace(/\\&/g, '&').replace(/[{}]/g, '').replace(/~/g, ' ')
  return out.replace(/\s+/g, ' ').trim()
}

/* ---------- rendering a citation (pure) ---------- */

// citet-family: the author sits outside the parens, "Author (Year)". Every
// other \cite* / parencite / autocite / … this project parses (CITE_RE in
// ../latex/parse.ts) renders the citep shape, "(Author, Year)" — including
// the bare \cite this codebase treats as citep's synonym
const TEXTUAL_CITE = /^[Cc]itet$|^[Tt]extcite$/

/** The natbib-style text for one `a.dia-cite`. `bib` empty ⇒ no bibliography
 * was resolvable at all, so every key keeps [key] — today's honest default.
 * A key present in `keys` but absent from `bib` keeps the WHOLE group as
 * [key1, key2, …]: a citation half-resolved into "(Author, 2020; ??)" would
 * read as a bug, not as the gap it is. */
export function citeText(
  cmd: string, keys: string[], pre: string | null, opt: string | null,
  bib: ReadonlyMap<string, BibEntry>,
): string {
  const fallback = `[${keys.join(', ')}]`
  if (bib.size === 0 || keys.length === 0) return fallback
  const entries: BibEntry[] = []
  for (const k of keys) {
    const e = bib.get(k)
    if (!e) return fallback
    entries.push(e)
  }
  return TEXTUAL_CITE.test(cmd)
    ? textualCite(entries, pre, opt)
    : parentheticalCite(entries, pre, opt)
}

function parentheticalCite(entries: BibEntry[], pre: string | null, opt: string | null): string {
  let body = entries.map((e) => `${e.authors}, ${e.year}`).join('; ')
  if (opt) body += `, ${opt}`
  if (pre !== null && pre !== '') body = `${pre} ${body}`
  return `(${body})`
}

function textualCite(entries: BibEntry[], pre: string | null, opt: string | null): string {
  // a post-note belongs inside ONE citation's year parens; natbib's own
  // rare multi-key case (\citet[][note]{a,b}) is not worth guessing at, so
  // the note lands on the single-key form and is appended plainly otherwise
  let body = entries.length === 1 && opt
    ? `${entries[0].authors} (${entries[0].year}, ${opt})`
    : entries.map((e) => `${e.authors} (${e.year})`).join('; ')
  if (entries.length > 1 && opt) body += `, ${opt}`
  if (pre !== null && pre !== '') body = `${pre} ${body}`
  return body
}

/* ---------- applying it to the article (DOM, no ops, no source changes) --- */

/** Rewrite every `a.dia-cite`'s text against `bib`, resealing memos on the
 * ones that changed — the exact refreshDerived contract for a.dia-ref,
 * reused rather than re-implemented (resealMemos is exported for this). */
export function applyBibliography(article: HTMLElement, bib: ReadonlyMap<string, BibEntry>): void {
  for (const cite of article.querySelectorAll<HTMLElement>('a.dia-cite')) {
    const keys = (cite.getAttribute('data-dia-cite') ?? '').split(',').map((k) => k.trim()).filter(Boolean)
    const cmd = cite.getAttribute('data-dia-cite-cmd') ?? 'cite'
    const pre = cite.getAttribute('data-dia-cite-pre')
    const opt = cite.getAttribute('data-dia-cite-opt')
    const want = citeText(cmd, keys, pre, opt, bib)
    if (cite.textContent === want) continue
    cite.textContent = want
    resealMemos(cite, article)
  }
}

/* ---------- fetching the compile's .bbl ---------- */

/** GET the raw .bbl for a finished compile job; empty map on 404 (no
 * bibliography) or any network failure — never on the critical path. */
export async function fetchBibliography(jobId: string): Promise<Map<string, BibEntry>> {
  let res: Response
  try {
    res = await fetch(`${SERVICE_BASE}/compile/${encodeURIComponent(jobId)}/bbl`)
  } catch {
    return new Map()
  }
  if (!res.ok) return new Map()
  const text = await res.text().catch(() => '')
  return parseBbl(text)
}

/* ---------- wiring: a successful compile resolves citations ---------- */

let installed = false
let shownJob: string | null = null

/** Wire citation resolution to the compile controller — mirrors
 * blockmirror.ts's installBlockMirror. Idempotent; the shell calls it once. */
export function installBibliography(): void {
  if (installed) return
  installed = true

  onCompileState((s) => {
    if (s.status !== 'ok') return
    const jobId = lastCompileJobId()
    if (!jobId || jobId === shownJob) return
    shownJob = jobId
    const article = state.doc?.article
    if (!article) return
    void fetchBibliography(jobId).then((bib) => {
      // a newer job may have superseded this fetch while it was in flight
      if (lastCompileJobId() !== jobId) return
      const current = state.doc?.article
      if (current) applyBibliography(current, bib)
    })
  })

  state.bus.on((e) => {
    if (e.type === 'doc-loaded') shownJob = null
  })
}
