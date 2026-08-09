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
}

/** what auxnumbers.ts registers: the engine's answer for one ref, or null
 * when this compile never saw that label (a just-typed \label, a failed
 * compile, no daemon at all) and the counter walk has to answer instead */
export type NumberSource = (cmd: string, key: string, kind: RefKind | null) => DerivedNumber | null

/** marks a ref whose number came from our counters rather than the engine.
 * A CLASS and a TOOLTIP rather than a stylesheet rule: the doc stylesheet
 * lives in model/doc.ts, and a marker that needs no CSS is one that works
 * in the editor, in a saved document and in the compiled-mirror pane alike.
 * The class is the hook — inspect surfaces and any later styling pass key
 * off it without this module changing. */
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
    const key = ref.getAttribute('data-dia-ref') ?? ''
    const cmd = ref.getAttribute('data-dia-ref-cmd') ?? 'ref'
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
 * degrades to the bare number rather than to an invented word. */

/** hyperref's \…autorefname defaults, keyed by the label kind. Measured. */
const AUTOREF_NAMES: Record<string, string> = {
  part: 'Part', chapter: 'chapter', section: 'section',
  subsection: 'subsection', subsubsection: 'subsubsection',
  appendix: 'Appendix', figure: 'Figure', table: 'Table',
  equation: 'Equation',
  // enumerate writes the anchor `Item.1`; \autoref prints "item 1"
  Item: 'item', item: 'item',
}

/** cleveref's \crefname defaults: [lowercase for \cref, capitalized for
 * \Cref]. cleveref folds every sectioning level below \chapter onto
 * "section" (measured: \cref of a subsubsection prints "section 1.1.1"),
 * which is exactly the kind of thing a counter model would never guess. */
const CREF_NAMES: Record<string, [string, string]> = {
  part: ['part', 'Part'], chapter: ['chapter', 'Chapter'],
  section: ['section', 'Section'], subsection: ['section', 'Section'],
  subsubsection: ['section', 'Section'],
  appendix: ['appendix', 'Appendix'], subappendix: ['appendix', 'Appendix'],
  figure: ['fig.', 'Figure'], table: ['table', 'Table'],
  equation: ['eq.', 'Equation'],
  enumi: ['item', 'Item'], Item: ['item', 'Item'], item: ['item', 'Item'],
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
      const name = kind === null ? undefined : AUTOREF_NAMES[kind]
      return name ? `${name} ${number}` : number
    }
    case 'cref':
    case 'Cref': {
      const pair = kind === null ? undefined : CREF_NAMES[kind]
      const name = pair?.[cmd === 'Cref' ? 1 : 0]
      // cleveref parenthesizes an equation's number and nothing else's:
      // "eq. (1)" / "Equation (1)", but "fig. 1"
      const body = kind === 'equation' ? `(${number})` : number
      return name ? `${name} ${body}` : body
    }
    default:
      return number
  }
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
