/* Derived document content — what LaTeX numbers for you: section, figure,
 * table, and equation numbers, resolved into \ref texts. A pure DOM pass
 * (the dia-chart-derived contract): no ops, no source changes.
 *
 * Because derived text lives INSIDE source-backed blocks, every mutation
 * here must re-seal the render memos on the ancestor chain — otherwise
 * emit.ts would read the block as "edited" and reconstruct instead of
 * re-emitting its exact source bytes. loadDoc runs this pass before the
 * first serialization so saved bodies are deterministic.
 *
 * TWO SOURCES, one of them authoritative. The counter walk below is a
 * REIMPLEMENTATION of LaTeX's counter model, and a reimplementation of a
 * macro language loses. Measured on a 25-line probe (see auxnumbers.ts for
 * the compile), four of six \ref texts were wrong:
 *
 *     \renewcommand{\thesection}{S-\arabic{section}}   we said 2, LaTeX S-2
 *     \setcounter{section}{9}                          we said 3, LaTeX S-10
 *     \appendix                                        we said 4, LaTeX A
 *     \section*                                        we said 5, LaTeX A
 *
 * None of those are exotic. So when a compile has happened, auxnumbers.ts
 * registers itself here as the NUMBER SOURCE and the engine's own .aux
 * answers every ref; the walk below stays as the offline answer — a
 * document opened with no daemon still shows numbers — and everything it
 * produces is marked PROVISIONAL, because a number we guessed and a number
 * LaTeX printed must not look alike. */

import { blockMemo } from '../latex/render'
import { cleanOuter } from '../latex/emit'

/** The kind of thing a label names. Deliberately a bare string: offline it
 * is what the DOM walk saw ('section', 'figure', …), but the .aux speaks a
 * wider and not-quite-matching vocabulary of its own ('subappendix', the
 * capital-I 'Item' anchor enumerate writes), and flattening those into a
 * closed union would throw away exactly the distinctions \autoref and
 * \cref are made of. */
export type RefKind = string

/** one resolved \ref text, and whether we vouch for it */
export interface DerivedNumber {
  text: string
  /** true = our own counters, or an engine answer we know is out of date */
  provisional: boolean
  /** The raw number and the kind the source resolved this label to, when it
   * knows them. `text` has already had one command's words wrapped round it,
   * and a RANGE cannot be assembled from two such texts — it needs both
   * numbers bare and the one kind they share, to print "figs. 1 to 3" and
   * not "fig. 1 to fig. 3". Optional so a source that only formats (a test
   * fake) still satisfies the type; a range then degrades to its keys. */
  number?: string
  kind?: RefKind | null
}

/** what auxnumbers.ts registers: the engine's answer for one ref, or null
 * when this compile never saw that label (a just-typed \label, a failed
 * compile, no daemon at all) and the counter walk has to answer instead */
export type NumberSource = (cmd: string, key: string, kind: RefKind | null) => DerivedNumber | null

/** marks a ref whose number came from our counters rather than the engine.
 * A CLASS and a TOOLTIP: this module writes both and owns neither pixel of
 * the result. The rule that makes the class visible lives with the rest of
 * the document's look in model/doc.ts's defaultDocThemeCss — the THEME
 * stylesheet, not the editor-base one, because serializeDoc keeps the theme
 * and drops the base, so the marking survives into a saved artifact and
 * into the compiled-mirror pane rather than being an editor-only hint. */
export const PROVISIONAL_CLASS = 'dia-ref-provisional'
export const PROVISIONAL_TITLE =
  'provisional number — counted by diastil, not by LaTeX; compile to resolve it'

let numberSource: NumberSource | null = null

/** Install (or with null, remove) the engine-backed number source. Called by
 * auxnumbers.ts when a compile's .aux lands and on doc-loaded; injected
 * rather than imported so this module keeps no dependency on the network
 * half, and so tests can pin the resolution rules with a fake .aux. */
export function setNumberSource(fn: NumberSource | null): void {
  numberSource = fn
}

/* ---------- the document's own words for the kinds ----------
 *
 * The .aux records a label's KIND and never the word printed for it, so
 * \autoref and \cref are rendered here from name tables — and a document is
 * free to rewrite those tables in its preamble. \crefname{figure}{diagram}
 * {diagrams} means every \cref to a figure prints "diagram", and nothing in
 * the .aux hints at it. So the preamble's declarations win over the
 * measured defaults below, exactly the way setRenderMacros lets the
 * preamble's \newcommand bodies win over the renderer's own idea of a
 * macro. */

/** cleveref's four forms for one kind: \crefname{type}{sg}{pl} and
 * \Crefname{type}{Sg}{Pl}. The plurals are what \crefrange prints — a range
 * names its kind in the plural ("figs. 1 to 3") — so this is the table
 * rangeDisplay reads, not a second hardcoded one. (\cref{a,b} still reaches
 * refDisplay as the single key "a,b", so a comma LIST is not pluralized
 * here; that is a separate gap, not this one.) */
export interface CrefName { sg?: string; pl?: string; Sg?: string; Pl?: string }

/** The preamble's reference-word declarations, as minePreamble mines them.
 * Every field optional: the overwhelmingly common document declares none of
 * these, and that document must keep rendering exactly as it did. */
export interface RefNameMeta {
  /** \crefname / \Crefname, keyed by cleveref's type name */
  crefNames?: Record<string, CrefName>
  /** \<type>autorefname (hyperref), keyed by the anchor kind */
  refNames?: Record<string, string>
  /** babel's / polyglossia's main language, if the document names one */
  language?: string
}

let crefOverrides: Record<string, CrefName> = {}
let autorefOverrides: Record<string, string> = {}
/** true when the document declared a language the tables below were NOT
 * measured in — see builtinAllowed for what that costs */
let foreignLanguage = false

/** Install the preamble's reference words. Takes the whole meta rather than
 * three positional arguments (setRenderMacros's shape) because the three
 * fields only make sense together: `language` decides whether the built-in
 * tables may answer at all, so a caller that passed two of three would be
 * asking a question this module cannot answer. Called once per mount, so
 * loading a second document replaces the first's vocabulary wholesale. */
export function setRefNames(meta?: RefNameMeta): void {
  crefOverrides = meta?.crefNames ?? {}
  autorefOverrides = meta?.refNames ?? {}
  foreignLanguage = meta?.language !== undefined && !ENGLISH.has(meta.language.trim().toLowerCase())
}

/** babel's and polyglossia's names for English, dialects included. A
 * document that declares one of these is still an English document, so the
 * measured tables stay RIGHT for it — suppressing them there would be a
 * regression dressed up as caution. */
const ENGLISH = new Set([
  'english', 'american', 'usenglish', 'american english',
  'british', 'ukenglish', 'britishenglish', 'british english',
  'canadian', 'australian', 'newzealand',
])

/** May the built-in (English, measured) name tables answer, given what the
 * document declared for this kind?
 *
 * NO, when the document declared some other language and did not declare
 * the name itself. babel and cleveref translate these words internally —
 * a German document prints "Abschnitt 1" where AUTOREF_NAMES says "section
 * 1" — and we do not have those translations. Typing a German table from
 * memory is precisely the invention this file's tables exist to avoid:
 * every entry in them was read off a real compile.
 *
 * So a declared foreign language with no declared names degrades to the
 * bare NUMBER, the same degradation an unknown kind already gets. The
 * asymmetry is deliberate: "1" is incomplete, but "section 1" inside German
 * prose is WRONG in a way that reads as the author's own text. A compile
 * does not rescue this either — the .aux carries the number and the kind,
 * never the word — so the fix is the document saying \crefname, and that
 * path works. */
function builtinAllowed(declared: string | undefined): boolean {
  return declared === undefined && !foreignLanguage
}

/** \autoref's word for a kind: \<kind>autorefname if the document set one,
 * then hyperref's measured default. */
function autorefName(kind: RefKind): string | undefined {
  const declared = autorefOverrides[kind]
  return builtinAllowed(declared) ? AUTOREF_NAMES[kind] : declared
}

/** \cref's / \Cref's word for a kind, with cleveref's own fallback between
 * the two cases: \crefname alone also supplies the capitalized forms, by
 * uppercasing the first letter. The reverse is NOT done — lowercasing
 * "Diagram" is harmless in English and wrong in German, where the noun is
 * capitalized by grammar, so a document that declared only \Crefname keeps
 * that word as it wrote it.
 *
 * `plural` picks the \crefrange half of the same table. A plural is never
 * DERIVED from a singular: cleveref prints "appendices" for "appendix" and
 * "figs." for "fig.", and no rule over the singular produces both. So a
 * document that declared only a singular has no plural here, and a range
 * degrades to the bare numbers exactly as an unmeasured kind does. */
function crefName(kind: RefKind, cap: boolean, plural: boolean): string | undefined {
  const own = crefOverrides[kind]
  const declared = plural
    ? (cap ? own?.Pl ?? upperFirst(own?.pl) : own?.pl)
    : (cap ? own?.Sg ?? upperFirst(own?.sg) : own?.sg)
  return builtinAllowed(declared) ? CREF_NAMES[kind]?.[(plural ? 2 : 0) + (cap ? 1 : 0)] : declared
}

function upperFirst(s: string | undefined): string | undefined {
  return s === undefined ? undefined : s.charAt(0).toUpperCase() + s.slice(1)
}

export function refreshDerived(article: HTMLElement): void {
  const numbers = new Map<string, string>()
  const kinds = new Map<string, RefKind>()
  const counters = [0, 0, 0, 0]
  let chapters = 0
  let figures = 0
  let tables = 0
  let equations = 0

  for (const el of article.querySelectorAll<HTMLElement>(
    'h1.dia-sec, h2.dia-sec, h3.dia-sec, h4.dia-sec, figure.dia-figure, div.dia-math[data-dia-env]',
  )) {
    const label = el.getAttribute('data-dia-label')
    // \chapter (book/report classes) sits above \section: its own counter,
    // never folded into `counters` — chapter-less documents (the common
    // case) keep numbering \section as "1", "2" exactly as before
    if (el.matches('h1.dia-sec')) {
      chapters++
      counters.fill(0)
      if (label) {
        numbers.set(label, String(chapters))
        kinds.set(label, 'chapter')
      }
      continue
    }
    if (el.matches('.dia-sec')) {
      const level = Number(el.tagName[1]) - 2 // h2 → 0
      counters[level]++
      for (let i = level + 1; i < counters.length; i++) counters[i] = 0
      if (label) {
        const own = counters.slice(0, level + 1).join('.')
        numbers.set(label, chapters > 0 ? `${chapters}.${own}` : own)
        kinds.set(label, SECTION_KINDS[level] ?? 'section')
      }
      continue
    }
    if (el.matches('figure.dia-figure')) {
      const isTable = el.getAttribute('data-dia-float') === 'table'
      const n = isTable ? ++tables : ++figures
      if (label) {
        numbers.set(label, String(n))
        kinds.set(label, isTable ? 'table' : 'figure')
      }
      continue
    }
    // numbered math environments (starred ones don't count)
    const env = el.getAttribute('data-dia-env') ?? ''
    if (!env.endsWith('*')) {
      equations++
      if (label) {
        numbers.set(label, String(equations))
        kinds.set(label, 'equation')
      }
    }
  }

  for (const ref of article.querySelectorAll<HTMLElement>('a.dia-ref')) {
    const cmd = ref.getAttribute('data-dia-ref-cmd') ?? 'ref'
    if (ref.matches('a.dia-refrange')) {
      applyRefText(ref, resolveRange(ref, cmd, numbers, kinds), article)
      continue
    }
    const key = ref.getAttribute('data-dia-ref') ?? ''
    const kind = kinds.get(key) ?? null
    // the engine first — it is the only one that knows what it printed
    const resolved = numberSource?.(cmd, key, kind)
      // …and our counters otherwise, always flagged for what they are.
      // \pageref gets no number at all here: a page break is a typesetting
      // outcome, not a structural one, so the honest offline answer is the
      // key, the same placeholder an unresolved \ref already shows.
      ?? { text: refDisplay(cmd, kind, numbers.get(key) ?? null, null, key), provisional: true }
    applyRefText(ref, resolved, article)
  }
}

/** Resolve one \crefrange: both ends, then the shared kind, then the words.
 *
 * The two ends are resolved INDEPENDENTLY and the range is provisional if
 * either of them is — a range half-answered by a stale .aux is exactly as
 * untrustworthy as its worse half. When the ends disagree about their kind
 * the range prints no word at all: cleveref cannot name a mixed range
 * either (measured, it sets "?? 3.1–3.1"), and inventing one here would put
 * a claim in the author's prose that the engine will not back. */
function resolveRange(
  ref: HTMLElement, cmd: string,
  numbers: Map<string, string>, kinds: Map<string, RefKind>,
): DerivedNumber {
  const fromKey = ref.getAttribute('data-dia-ref-from') ?? ''
  const toKey = ref.getAttribute('data-dia-ref-to') ?? ''
  const end = (key: string) => {
    const domKind = kinds.get(key) ?? null
    const engine = numberSource?.(cmd, key, domKind)
    if (engine) return { number: engine.number ?? null, kind: engine.kind ?? domKind, provisional: engine.provisional }
    return { number: numbers.get(key) ?? null, kind: domKind, provisional: true }
  }
  const a = end(fromKey)
  const b = end(toKey)
  const kind = a.kind !== null && a.kind === b.kind ? a.kind : null
  return {
    text: rangeDisplay(cmd, kind, a.number, b.number, fromKey, toKey),
    provisional: a.provisional || b.provisional,
  }
}

/** h2/h3/h4 → the sectioning kind \autoref and \cref name them by */
const SECTION_KINDS = ['section', 'subsection', 'subsubsection', 'subsubsection']

/** Write one ref's derived text and its provisional marking, resealing the
 * memos only when something actually changed — refreshDerived runs on every
 * edit, and a no-op reseal on every ref in the document is pure cost. */
function applyRefText(ref: HTMLElement, n: DerivedNumber, article: HTMLElement): void {
  const marked = ref.classList.contains(PROVISIONAL_CLASS)
  if (ref.textContent === n.text && marked === n.provisional) return
  ref.textContent = n.text
  if (n.provisional) {
    ref.classList.add(PROVISIONAL_CLASS)
    ref.setAttribute('title', PROVISIONAL_TITLE)
  } else {
    ref.classList.remove(PROVISIONAL_CLASS)
    ref.removeAttribute('title')
  }
  resealMemos(ref, article)
}

/* ---------- what each \ref-family command prints ----------
 *
 * Shared by both number sources, so the engine's numbers and our own are
 * shaped identically and only the NUMBER differs. Every name below was read
 * off a real tectonic 0.15.0 compile (pdftotext of the probes in the
 * aux-numbering work), never guessed: hyperref's \autoref names are a
 * mixture of cased and uncased ("Figure 1", but "section 1"), and
 * cleveref's \cref abbreviates where \Cref does not ("fig. 1" / "Figure 1")
 * — neither is derivable from the other. A kind with no measured entry
 * degrades to the bare number rather than to an invented word.
 *
 * These are DEFAULTS. They hold for a document that leaves the vocabulary
 * alone, which is most of them; setRefNames above puts the preamble's own
 * \crefname / \…autorefname ahead of every entry here, and takes them all
 * off the table when the document declares a language they were not
 * measured in. */

/** hyperref's \…autorefname defaults, keyed by the label kind. Measured. */
const AUTOREF_NAMES: Record<string, string> = {
  part: 'Part', chapter: 'chapter', section: 'section',
  subsection: 'subsection', subsubsection: 'subsubsection',
  appendix: 'Appendix', figure: 'Figure', table: 'Table',
  equation: 'Equation',
  // enumerate writes the anchor `Item.1`; \autoref prints "item 1"
  Item: 'item', item: 'item',
}

/** cleveref's \crefname defaults, as [sg, Sg, pl, Pl] — the singulars \cref
 * and \Cref print, then the plurals \crefrange and \Crefrange print.
 * cleveref folds every sectioning level below \chapter onto "section"
 * (measured: \cref of a subsubsection prints "section 1.1.1", \crefrange of
 * two prints "sections 1.1.1 to 1.1.2"), which is exactly the kind of thing
 * a counter model would never guess.
 *
 * The plural column was measured 2026-08-09 on tectonic 0.15.0, pdftotext
 * of three probes (article, report, article+\appendix) — it is not the
 * singular plus "s", and could not have been: "fig." pluralizes to "figs."
 * but "Figure" to "Figures" (the abbreviation moves), and "appendix" to
 * "appendices". Read off the PDF:
 *
 *   \crefrange / \Crefrange        \cref / \Cref
 *   sections 1 to 3   Sections     section 1     Section
 *   sections 3.1 to 3.2 (subsec)   section 3.1   Section
 *   sections 1.1.1 to 1.1.2        section 1.1.1 Section
 *   chapters 1 to 3   Chapters     chapter 1     Chapter
 *   parts I to II     Parts        part I        Part
 *   appendices A to B Appendices   appendix A.1  Appendix
 *   figs. 1 to 3      Figures      fig. 1        Figure
 *   tables 1 to 2     Tables       table 1       Table
 *   eqs. (1) to (3)   Equations    eq. (1)       Equation
 *   items 1 to 3      Items        item 1        Item
 */
const CREF_NAMES: Record<string, [string, string, string, string]> = {
  part: ['part', 'Part', 'parts', 'Parts'],
  chapter: ['chapter', 'Chapter', 'chapters', 'Chapters'],
  section: ['section', 'Section', 'sections', 'Sections'],
  subsection: ['section', 'Section', 'sections', 'Sections'],
  subsubsection: ['section', 'Section', 'sections', 'Sections'],
  appendix: ['appendix', 'Appendix', 'appendices', 'Appendices'],
  subappendix: ['appendix', 'Appendix', 'appendices', 'Appendices'],
  figure: ['fig.', 'Figure', 'figs.', 'Figures'],
  table: ['table', 'Table', 'tables', 'Tables'],
  equation: ['eq.', 'Equation', 'eqs.', 'Equations'],
  enumi: ['item', 'Item', 'items', 'Items'],
  Item: ['item', 'Item', 'items', 'Items'],
  item: ['item', 'Item', 'items', 'Items'],
}

/** The text one \ref-family command prints for a label, given whatever is
 * known about it. `number` null (nothing knows this label) or `page` null
 * (\pageref with no compile) fall back to the key — the honest placeholder
 * render.ts already puts in the element. */
export function refDisplay(
  cmd: string, kind: RefKind | null, number: string | null, page: string | null, key: string,
): string {
  if (cmd === 'pageref') return page ?? key
  if (number === null) return key
  switch (cmd) {
    case 'eqref':
      return `(${number})`
    case 'autoref': {
      const name = kind === null ? undefined : autorefName(kind)
      return name ? `${name} ${number}` : number
    }
    case 'cref':
    case 'Cref': {
      const name = kind === null ? undefined : crefName(kind, cmd === 'Cref', false)
      // cleveref parenthesizes an equation's number and nothing else's:
      // "eq. (1)" / "Equation (1)", but "fig. 1"
      const body = kind === 'equation' ? `(${number})` : number
      return name ? `${name} ${body}` : body
    }
    default:
      return number
  }
}

/** cleveref's separator between a range's endpoints. Measured, and NOT the
 * en-dash: `\crefrange{a}{b}` sets "figs. 1 to 3" in words. (The en-dash
 * does appear — in cleveref's own FAILURE output, `1.1.1–??`, when one end
 * does not resolve. That is an error marker, not the range form.) */
const RANGE_JOIN = ' to '

/** The text \crefrange / \Crefrange print for a pair of labels.
 *
 * A SIBLING of refDisplay rather than a case inside it, because its inputs
 * are genuinely different: two numbers and one shared kind, where refDisplay
 * takes one of each. Collapsing them would mean passing a range through a
 * field shaped like a list, which is how "figs. 1 to 5" turns into "figs. 1
 * and 5" — the exact confusion the refrange node exists to prevent.
 *
 * `kind` is the kind BOTH endpoints share; the caller passes null when they
 * disagree, because cleveref itself cannot name a mixed range (measured:
 * \crefrange{fig:a}{tab:a} sets "?? 3.1–3.1"). Null kind, an unmeasured
 * kind, and a foreign language all degrade the same way — to the bare
 * numbers, never to an invented word. */
export function rangeDisplay(
  cmd: string, kind: RefKind | null, from: string | null, to: string | null,
  fromKey: string, toKey: string,
): string {
  // an unresolved end has no number to range over — show the keys, the same
  // honest placeholder a single unresolved \ref already shows
  if (from === null || to === null) return `${fromKey}${RANGE_JOIN}${toKey}`
  const name = kind === null ? undefined : crefName(kind, cmd === 'Crefrange', true)
  // each endpoint is parenthesized on its own: "eqs. (1) to (3)", measured
  const body = (n: string) => (kind === 'equation' ? `(${n})` : n)
  const span = `${body(from)}${RANGE_JOIN}${body(to)}`
  return name ? `${name} ${span}` : span
}

/** derived text changed inside a block: update the pristine-markup seal on
 * every memoized ancestor so unedited blocks keep emitting exact bytes.
 * Exported: bibliography.ts's citation resolution reseals the same way,
 * on its own schedule (a compile's .bbl lands after the fact, not before
 * the first serialization like refreshDerived's ref pass does). */
export function resealMemos(from: Element, article: HTMLElement): void {
  let cur: Element | null = from
  while (cur && cur !== article) {
    if (cur instanceof HTMLElement) {
      const memo = blockMemo.get(cur)
      if (memo) memo.html = cleanOuter(cur)
    }
    cur = cur.parentElement
  }
}
