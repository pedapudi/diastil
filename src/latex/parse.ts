/* LaTeX structural parser — token stream → block tree with exact spans.
 *
 * This parser's one hard job is finding BLOCK BOUNDARIES accurately; it is
 * not a TeX engine and never pretends to be. Everything it understands maps
 * to dialect structure; everything it does not becomes a verbatim ISLAND
 * carrying its raw source, so nothing is ever lost and the real engine
 * (daemon compile) is always the semantic authority. When a construct can't
 * be scanned confidently the island WIDENS — span correctness always beats
 * block granularity.
 *
 * Top-level block spans are ordered and non-overlapping; the source is
 * reproducible as gap + block + gap + … (see stitch()). Gaps hold only
 * inter-block whitespace, paragraph breaks, and full-line comments. */

import { lex, overlaySpecLength, tilesExactly } from './lex'
import type { LxToken, Span } from './lex'

/* ---------- tree ---------- */

export interface LxDoc {
  src: string
  blocks: LxBlock[]
}

export type LxBlock =
  /** \documentclass … \begin{document}; rendered as the doc header only */
  | { kind: 'preamble'; span: Span; meta: PreambleMeta }
  /** \end{document} to EOF; preserved, never rendered */
  | { kind: 'postamble'; span: Span }
  | { kind: 'section'; span: Span; level: 0 | 1 | 2 | 3 | 4; starred: boolean; inline: LxInline[]; label?: string }
  | { kind: 'para'; span: Span; inline: LxInline[] }
  | { kind: 'abstract'; span: Span; body: LxBlock[] }
  /** transparent/decorative wrappers (center, quote, framed, multicols…) —
   * kept as a block so their interiors stay first-class structure.
   * `title` is the environment's own heading argument where it has one
   * (beamer's \begin{frame}{Title} and the block family) — see
   * TITLED_WRAPPERS: without it, consuming the argument would DELETE every
   * slide heading in a deck from the reading surface. */
  | { kind: 'wrapper'; span: Span; env: string; body: LxBlock[]; title?: LxInline[]; overlay?: Span }
  | { kind: 'list'; span: Span; env: 'itemize' | 'enumerate' | 'description'; items: LxListItem[]; srcEnv?: string; overlay?: Span }
  | { kind: 'float'; span: Span; env: 'figure' | 'table'; starred: boolean; caption?: LxInline[]; label?: string; graphics: LxGraphic[]; body: LxBlock[] }
  | { kind: 'tabular'; span: Span; colspec: string; rows: LxTabRow[]; trailingRule?: string }
  /** display math: \[…\], $$…$$, or a math environment */
  | { kind: 'math'; span: Span; tex: string; env?: string; label?: string }
  /** verbatim/lstlisting/minted — mono content, faithfully representable */
  | { kind: 'verbatim'; span: Span; env?: string; text: string }
  | { kind: 'island'; span: Span; reason: string }

/** one table row: its cells, plus the exact source text of any rule
 * commands that ran immediately before it — \toprule, \midrule, \bottomrule,
 * \hline, \cline{…}, or a chained run of \cmidrule(lr){…} — verbatim, so
 * reconstruction never downgrades a partial rule to a full-width one */
export interface LxTabRow { cells: LxTabCell[]; rule?: string }

/** one table cell; colspan/rowspan carry \multicolumn/\multirow structure.
 * colspanSpec/rowspanWidth are those commands' own {spec}/{width} argument
 * text verbatim — re-emitting a spanning cell as plain {c}/{*} silently
 * drops a paper's actual column alignment and multirow width */
export interface LxTabCell {
  inline: LxInline[]
  colspan?: number
  rowspan?: number
  colspanSpec?: string
  rowspanWidth?: string
  /** source span of the cell's content — after furniture and any
   * \multicolumn/\multirow unwrap, exactly the range parseInline consumed.
   * Session-only, like a block's own span: it lets emission splice an
   * edited cell back into its row's exact original bytes instead of
   * reconstructing the whole row. */
  contentSpan: Span
}

export interface PreambleMeta {
  docclass?: string
  title?: string
  author?: string
  date?: string
  /** parameterless \newcommand macros with plain-text bodies — the safe
   * subset the renderer may show expanded (display only, never emitted) */
  textMacros?: Record<string, string>
  /** parameterless macros whose bodies provably set no type (\notsotiny =
   * a font-size switch) — the renderer may hide their bare calls */
  quietMacros?: string[]
  /** cleveref's own words per reference type, from \crefname{type}{sg}{pl}
   * and \Crefname{type}{Sg}{Pl}. Both commands write into ONE record per
   * type, because both name the same type and a document routinely gives
   * only one of them. Absent entirely when the document declares none. */
  crefNames?: Record<string, { sg?: string; pl?: string; Sg?: string; Pl?: string }>
  /** hyperref's \autoref word per type, from a \newcommand/\renewcommand/
   * \providecommand of \<type>autorefname. Keyed by TYPE (`figure`), not by
   * macro name, so it lines up with crefNames above. */
  refNames?: Record<string, string>
  /** the document's main language, from babel's options (the `main=` key
   * when present, else the last option that is not a key=value setting) or
   * polyglossia's \setmainlanguage. Reference words are language-dependent,
   * so a package default is only right for a document that said nothing. */
  language?: string
}
/** `term` is `\item[…]`'s bracket argument. For a description list it IS the
 * term; for itemize/enumerate the same bracket sets a CUSTOM BULLET
 * (beamer.tex writes `\item[$\to$]`) — rendered and re-emitted either way,
 * because an argument the DOM carries no node for is an argument an edited
 * list silently deletes from the file.
 *
 * `overlay` is a beamer overlay specification's own span (`\item<1->`). */
export interface LxListItem { span: Span; term?: LxInline[]; blocks: LxBlock[]; overlay?: Span }
export interface LxGraphic { span: Span; path: string; opts?: string }

export type LxInline =
  | { kind: 'text'; span: Span; text: string }
  /** `overlay` is beamer's spec on the style command itself: `\textbf<2>{…}` */
  | { kind: 'style'; span: Span; cmd: StyleCmd; inner: LxInline[]; overlay?: Span }
  | { kind: 'math'; span: Span; tex: string }
  /** keys, plural: cleveref takes a LIST — `\cref{fig:a,fig:b}` sets
   * "figs. 1 and 2", and a consecutive list sets a range. Read as one
   * opaque key the whole reference resolved to nothing. Same split rule
   * as cite's keys, and for the same reason. */
  | { kind: 'ref'; span: Span; cmd: string; keys: string[] }
  /** opt = the post-note; pre = the pre-note when \cite[pre][post]{…} */
  | { kind: 'cite'; span: Span; cmd: string; keys: string[]; opt?: string; pre?: string }
  | { kind: 'footnote'; span: Span; inner: LxInline[] }
  | { kind: 'url'; span: Span; url: string; inner?: LxInline[] }
  | { kind: 'label'; span: Span; key: string }
  /** \\ inside a paragraph */
  | { kind: 'break'; span: Span }
  /** \verb blob — inline code */
  | { kind: 'verb'; span: Span; text: string }
  | { kind: 'island'; span: Span }

export type StyleCmd = 'bf' | 'it' | 'em' | 'tt' | 'ul' | 'sc' | 'sf'

/* ---------- vocabulary ---------- */

/** \chapter sits one level above \section (book/report classes) — level 0
 * renders as h1.dia-sec, distinct from the derived-header's h1.dia-title */
const SECTION_LEVEL: Record<string, 0 | 1 | 2 | 3 | 4> = {
  chapter: 0, section: 1, subsection: 2, subsubsection: 3, paragraph: 4, subparagraph: 4,
}
const LIST_ENVS = new Set(['itemize', 'enumerate', 'description'])
/** wrapfigure/wraptable are floats with extra leading args the scanner skips */
const FLOAT_ENVS: Record<string, 'figure' | 'table'> = {
  figure: 'figure', table: 'table', wrapfigure: 'figure', wraptable: 'table',
}
const MATH_ENVS = new Set([
  'equation', 'align', 'gather', 'multline', 'displaymath', 'eqnarray',
  'alignat', 'flalign',
])
/** wrappers whose interiors stay first-class blocks; leading [..]/{..}
 * arguments (multicols count, framed options) are skipped by the scanner */
const WRAPPER_ENVS = new Set([
  'center', 'flushleft', 'flushright', 'quote', 'quotation',
  'framed', 'mdframed', 'multicols', 'sloppypar', 'samepage',
  // measured on the corpus: boxes and sub-floats whose interiors are
  // ordinary blocks — the box itself is decoration the mirror shows anyway
  'tcolorbox', 'minipage', 'subfigure', 'subtable', 'centering',
  'small', 'footnotesize', 'scriptsize', 'singlespace', 'spacing',
  'keywords', 'acks', 'addmargin', 'adjustwidth',
  // beamer's slide — see WRAPPER_OPTIONAL_BRACE_ARGS: its title is an
  // OPTIONAL brace arg, unlike every entry in WRAPPER_BRACE_ARGS below
  'frame',
  // beamer's in-slide layout and callouts. Measured 2026-08-09: columns +
  // column + block + alertblock were 0.361 of beamer.tex's 0.375 raw-tex
  // ratio, islanded whole by `unknown environment` — and they hold the
  // deck's ORDINARY PROSE, not decoration. Structurally they are the same
  // shape as the wrappers above: `columns` is a bare container, `column`
  // takes a width exactly as minipage does, and the block family takes a
  // title exactly as \begin{frame}{Title} does.
  'columns', 'column', 'block', 'alertblock', 'exampleblock',
])
/** required brace-argument counts for wrappers that take them */
const WRAPPER_BRACE_ARGS: Record<string, number> = {
  multicols: 1, minipage: 1, subfigure: 1, subtable: 1, spacing: 1,
  addmargin: 1, adjustwidth: 2,
  // a beamer column's {0.5\textwidth} is a dimension, never body — the
  // same argument minipage takes, read the same way
  column: 1,
}
/** OPTIONAL leading brace-argument counts. Unlike WRAPPER_BRACE_ARGS (a
 * REQUIRED count — the scanner just stops early if the group is missing,
 * which is safe because a required arg is never body content), consuming
 * one of these wrongly means real content silently disappears: the group
 * becomes a "title" that rides in no block and is never emitted anywhere.
 * matchOptionalBraceArg only takes the group when several signals agree
 * it is a title, not a frame body that happens to open with `{...}`. */
const WRAPPER_OPTIONAL_BRACE_ARGS: Record<string, number> = {
  frame: 1,
  // beamer DECLARES the block family's title required, but reading it as
  // required would mean a title written on the line BELOW \begin{block}
  // (or absent) silently deletes the group it lands on. Optional costs
  // nothing when the title is where beamer wants it, and degrades to
  // "title shows as the block's first prose" when it is not. (An overlay
  // spec before the title — `\begin{block}<2->{…}` — used to defeat the
  // brace matcher too; it is a token now, stepped over in parseEnv.)
  block: 1, alertblock: 1, exampleblock: 1,
}

/** wrappers whose LAST consumed brace argument is a heading a reader must
 * see. A consumed argument rides in no block and is emitted by nobody, so
 * for these it is parsed as inlines and shown — a deck whose every slide
 * heading vanished into the \begin line would be a worse import than the
 * islands this all replaced. `column`'s argument is a WIDTH, so it is
 * deliberately not here. */
const TITLED_WRAPPERS = new Set(['frame', 'block', 'alertblock', 'exampleblock'])

/** theorem-like environments — wrappers whose head the theme styles
 * (numbering is the compiled mirror's job, not ours) */
const THEOREM_ENVS = new Set([
  'theorem', 'lemma', 'proposition', 'corollary', 'definition', 'remark',
  'example', 'claim', 'fact', 'observation', 'conjecture', 'proof',
])

/** packed/compact list variants papers define locally — same structure,
 * same \item grammar; the ORIGINAL name rides data-dia-env for emission */
const LIST_ALIAS: Record<string, 'itemize' | 'enumerate'> = {
  itemizepacked: 'itemize', enumeratepacked: 'enumerate',
  compactitem: 'itemize', compactenum: 'enumerate',
  itemizesquish: 'itemize', enumeratesquish: 'enumerate',
}
const STYLE_CMD: Record<string, StyleCmd> = {
  textbf: 'bf', textit: 'it', emph: 'em', texttt: 'tt', underline: 'ul', textsc: 'sc',
  textsf: 'sf',
}

/** symbol commands that ARE a character — rendered as text; an edited
 * block emits the character itself, which any modern engine sets */
const SYMBOL_CMD: Record<string, string> = {
  S: '§', P: '¶', dag: '†', ddag: '‡', copyright: '©',
  textregistered: '®', texttrademark: '™', textdegree: '°',
  ldots: '…', dots: '…', textellipsis: '…',
  textendash: '–', textemdash: '—',
  textbackslash: '\\', textbar: '|', textless: '<', textgreater: '>',
  // emit.ts writes these for a typed ~ and ^; without them the file reopened
  // showing the macro NAME as prose, and editing that paragraph escaped the
  // backslash again — one round trip per edit, compounding
  textasciitilde: '~', textasciicircum: '^',
  pounds: '£', euro: '€', textperthousand: '‰',
}
/** old-style declarations usable as `{\bf …}` */
const STYLE_DECL: Record<string, StyleCmd> = {
  bf: 'bf', bfseries: 'bf', it: 'it', itshape: 'it', em: 'em', tt: 'tt', ttfamily: 'tt', sc: 'sc', scshape: 'sc',
}
/* One grammar per command set. \crefrange{a}{b} is deliberately absent: it
 * takes TWO brace groups and means a RANGE, where a ref node's `keys` is a
 * comma LIST — the same field with a different meaning, which is how a
 * resolver quietly starts printing "figs. 1 and 5" for "figs. 1 to 5". No
 * corpus fixture uses it, so there is no measurement to justify the risk;
 * as an island it stays honest and the compiled mirror sets it correctly. */
const REF_CMDS = new Set(['ref', 'eqref', 'autoref', 'cref', 'Cref', 'pageref'])
// biblatex's "capitalize the first cite of a sentence" companions —
// \Autocite, \Parencite, \Textcite — carry the same {keys} grammar as their
// lowercase counterparts already below
const CITE_RE = /^[Cc]ite\w*$|^[Pp]arencite$|^[Tt]extcite$|^[Aa]utocite$/
/** table-rule commands stripped from cell starts */
const RULE_CMDS = new Set(['hline', 'toprule', 'midrule', 'bottomrule', 'cmidrule', 'cline'])
/** does a furniture span actually contain a rule command, vs. just blank
 * text/comments skipCellFurniture also swallows? */
const RULE_TEXT_RE = /\\(?:hline|toprule|midrule|bottomrule|cmidrule|cline)\b/
/** control symbols that are literal characters */
const CHAR_ESCAPES: Record<string, string> = {
  '%': '%', '&': '&', '$': '$', '#': '#', '_': '_', '{': '{', '}': '}', ' ': ' ',
}

const starless = (env: string) => (env.endsWith('*') ? env.slice(0, -1) : env)

/* ---------- entry ---------- */

export function parseLatex(src: string): LxDoc {
  const tokens = lex(src)
  if (!tilesExactly(tokens, src)) {
    // a tiling failure means spans can no longer be trusted — surface loudly
    // (never throw: an un-editable parse is still better than a dead open)
    console.error('dia-latex: lexer tiling invariant broken; treating whole source as one island')
    return { src, blocks: [{ kind: 'island', span: { start: 0, end: src.length }, reason: 'lexer tiling failure' }] }
  }
  const blocks: LxBlock[] = []

  // split at \begin{document} / \end{document} when present
  let bodyLo = 0
  let bodyHi = tokens.length
  const beginDoc = tokens.findIndex((t) => t.kind === 'envbegin' && t.name === 'document')
  if (beginDoc >= 0) {
    blocks.push({
      kind: 'preamble',
      span: { start: 0, end: tokens[beginDoc].span.end },
      meta: minePreamble(src.slice(0, tokens[beginDoc].span.start)),
    })
    bodyLo = beginDoc + 1
  }
  let endDoc = -1
  for (let i = bodyLo; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.kind === 'envend' && t.name === 'document') { endDoc = i; break }
  }
  if (endDoc >= 0) bodyHi = endDoc

  blocks.push(...parseBlocks(new Cursor(tokens, src), bodyLo, bodyHi))

  if (endDoc >= 0) blocks.push({ kind: 'postamble', span: { start: tokens[endDoc].span.start, end: src.length } })

  return { src, blocks }
}

/** reproduce the source from a parse — the round-trip invariant's teeth */
export function stitch(doc: LxDoc): string {
  let out = ''
  let at = 0
  for (const b of doc.blocks) {
    out += doc.src.slice(at, b.span.end)
    at = b.span.end
  }
  return out + doc.src.slice(at)
}

/** top-level spans ordered, non-overlapping, in bounds — every parse */
export function spansSane(doc: LxDoc): boolean {
  let at = 0
  for (const b of doc.blocks) {
    if (b.span.start < at || b.span.end < b.span.start || b.span.end > doc.src.length) return false
    at = b.span.end
  }
  return true
}

/* ---------- block parsing ---------- */

class Cursor {
  constructor(public toks: LxToken[], public src: string) {}
  slice(s: Span): string { return this.src.slice(s.start, s.end) }
}

function parseBlocks(cur: Cursor, lo: number, hi: number): LxBlock[] {
  const blocks: LxBlock[] = []
  let i = lo
  while (i < hi) {
    const t = cur.toks[i]

    // inter-block material: whitespace, blank lines, full-line comments
    if (t.kind === 'parbreak' || t.kind === 'comment' || (t.kind === 'text' && cur.slice(t.span).trim() === '')) {
      i++
      continue
    }

    if (t.kind === 'cs' && SECTION_LEVEL[t.name] !== undefined) {
      const r = parseSection(cur, i, hi)
      blocks.push(r.block)
      i = r.next
      continue
    }

    if (t.kind === 'verb' && t.env !== undefined) {
      blocks.push({ kind: 'verbatim', span: t.span, env: t.env, text: verbatimBody(cur.slice(t.span)) })
      i++
      continue
    }

    if (t.kind === 'envbegin') {
      const close = findEnvEnd(cur.toks, i, hi, t.name)
      if (close < 0) {
        // unclosed environment: the rest of the region is one island
        blocks.push({ kind: 'island', span: { start: t.span.start, end: endOf(cur, hi) }, reason: `unclosed \\begin{${t.name}}` })
        i = hi
        continue
      }
      blocks.push(parseEnv(cur, i, close, t.name))
      i = close + 1
      continue
    }

    if ((t.kind === 'mathshift' && t.span.end - t.span.start === 2) || (t.kind === 'cs' && t.name === '[')) {
      const r = parseDisplayMath(cur, i, hi)
      blocks.push(r.block)
      i = r.next
      continue
    }

    if (t.kind === 'envend') {
      // stray \end{…}: cannot belong to anything we know — island it
      blocks.push({ kind: 'island', span: t.span, reason: `stray \\end{${t.name}}` })
      i++
      continue
    }

    // otherwise a paragraph runs to the next block boundary
    const r = parsePara(cur, i, hi)
    blocks.push(r.block)
    i = r.next
  }
  return blocks
}

/** a paragraph ends at a blank line or ANY block-level construct — lists and
 * floats commonly begin mid-paragraph without a blank line */
function isBlockBoundary(t: LxToken): boolean {
  if (t.kind === 'parbreak' || t.kind === 'envbegin' || t.kind === 'envend') return true
  if (t.kind === 'verb' && t.env !== undefined) return true
  if (t.kind === 'mathshift' && t.span.end - t.span.start === 2) return true
  if (t.kind === 'cs' && (SECTION_LEVEL[t.name] !== undefined || t.name === '[')) return true
  return false
}

function parsePara(cur: Cursor, at: number, hi: number): { block: LxBlock; next: number } {
  let end = at
  while (end < hi && !isBlockBoundary(cur.toks[end])) end++
  // trailing whitespace-only text belongs to the gap, not the paragraph
  let last = end - 1
  while (last > at && cur.toks[last].kind === 'text' && cur.slice(cur.toks[last].span).trim() === '') last--
  const span = { start: cur.toks[at].span.start, end: cur.toks[last].span.end }
  const inline = parseInline(cur, at, last + 1)
  return { block: { kind: 'para', span, inline }, next: end }
}

function parseSection(cur: Cursor, at: number, hi: number): { block: LxBlock; next: number } {
  const t = cur.toks[at] as Extract<LxToken, { kind: 'cs' }>
  const level = SECTION_LEVEL[t.name]
  let i = at + 1
  let starred = false
  if (cur.toks[i]?.kind === 'text' && cur.slice(cur.toks[i].span).trim() === '*') {
    starred = true
    i++
  }
  // optional [short title] — skipped for structure, kept in span
  const short = matchBracketGroup(cur, i, hi)
  if (short) i = short.close + 1
  const g = matchBraceGroup(cur, i, hi)
  if (!g) {
    // \section without a scannable argument — island the command alone
    return { block: { kind: 'island', span: t.span, reason: `\\${t.name} without argument` }, next: at + 1 }
  }
  const inline = parseInline(cur, g.lo, g.hi)
  let end = g.close + 1
  let label: string | undefined
  // capture an immediately-following \label{…} into the block
  let j = end
  while (j < hi && cur.toks[j].kind === 'text' && cur.slice(cur.toks[j].span).trim() === '') j++
  const lt = cur.toks[j]
  if (lt?.kind === 'cs' && lt.name === 'label') {
    const lg = matchBraceGroup(cur, j + 1, hi)
    if (lg) {
      label = groupText(cur, lg)
      end = lg.close + 1
    }
  }
  const span = { start: t.span.start, end: cur.toks[end - 1].span.end }
  return { block: { kind: 'section', span, level, starred, inline, label }, next: end }
}

function parseDisplayMath(cur: Cursor, at: number, hi: number): { block: LxBlock; next: number } {
  const open = cur.toks[at]
  const isDollar = open.kind === 'mathshift'
  let close = -1
  for (let i = at + 1; i < hi; i++) {
    const t = cur.toks[i]
    if (isDollar && t.kind === 'mathshift' && t.span.end - t.span.start === 2) { close = i; break }
    if (!isDollar && t.kind === 'cs' && t.name === ']') { close = i; break }
  }
  if (close < 0) {
    return {
      block: { kind: 'island', span: { start: open.span.start, end: endOf(cur, hi) }, reason: 'unclosed display math' },
      next: hi,
    }
  }
  const span = { start: open.span.start, end: cur.toks[close].span.end }
  const tex = cur.src.slice(open.span.end, cur.toks[close].span.start).trim()
  return { block: { kind: 'math', span, tex }, next: close + 1 }
}

function parseEnv(cur: Cursor, open: number, close: number, name: string): LxBlock {
  const span = { start: cur.toks[open].span.start, end: cur.toks[close].span.end }
  const base = starless(name)
  // `\begin{frame}<2->` — the lexer only emits an overlay token where the
  // \begin tag can legally carry one, so finding it here is enough
  const head = cur.toks[open + 1]
  const overlay = open + 1 < close && head?.kind === 'overlay' ? head.span : undefined

  if (LIST_ENVS.has(base)) return parseList(cur, open, close, base as 'itemize' | 'enumerate' | 'description', span, undefined, overlay)
  if (LIST_ALIAS[base]) return parseList(cur, open, close, LIST_ALIAS[base], span, name, overlay)
  if (FLOAT_ENVS[base]) return parseFloatEnv(cur, open, close, FLOAT_ENVS[base], name.endsWith('*'), span)
  if (base === 'tabular') return parseTabular(cur, open, close, span)
  if (MATH_ENVS.has(base)) {
    const raw = cur.src.slice(cur.toks[open].span.end, cur.toks[close].span.start)
    // the label rides separately (data-dia-label); tex carries pure math so
    // rendering and editing never see \label
    return {
      kind: 'math', span,
      tex: raw.replace(/\\label\{[^}]*\}/g, '').trim(),
      env: name,
      label: mineLabel(raw),
    }
  }
  if (base === 'abstract') {
    return { kind: 'abstract', span, body: parseBlocks(cur, open + 1, close) }
  }
  if (WRAPPER_ENVS.has(base) || THEOREM_ENVS.has(base)) {
    // skip declared argument groups (multicols takes {n}) and any optional
    // [..] (a theorem's display name); a brace group after an argument-less
    // wrapper is CONTENT
    // an overlay spec sits between the \begin tag and every argument, so it
    // is stepped over FIRST — without that, matchBracketGroup/matchBraceGroup
    // stop dead on its token and a `\begin{block}<2->{Title}` loses its title
    let lo = overlay ? open + 2 : open + 1
    let afterPos = overlay ? overlay.end : cur.toks[open].span.end
    let last: Group | null = null
    const b = matchBracketGroup(cur, lo, close)
    if (b) { lo = b.close + 1; afterPos = b.closeSpan.end }
    for (let args = WRAPPER_BRACE_ARGS[base] ?? 0; args > 0; args--) {
      const g = matchBraceGroup(cur, lo, close)
      if (!g) break
      lo = g.close + 1
      afterPos = g.closeSpan.end
      last = g
    }
    // OPTIONAL brace args (frame's title): each candidate must survive
    // matchOptionalBraceArg's disambiguation before it is taken
    for (let args = WRAPPER_OPTIONAL_BRACE_ARGS[base] ?? 0; args > 0; args--) {
      const g = matchOptionalBraceArg(cur, lo, close, afterPos)
      if (!g) break
      lo = g.close + 1
      afterPos = g.closeSpan.end
      last = g
    }
    const body = parseBlocks(cur, lo, close)
    if (last && TITLED_WRAPPERS.has(base)) {
      const title = parseInline(cur, last.lo, last.hi)
      // an empty title argument (`\begin{frame}{}`) is no title at all
      if (title.some((n) => !(n.kind === 'text' && n.text.trim() === ''))) {
        return { kind: 'wrapper', span, env: base, body, title, overlay }
      }
    }
    return { kind: 'wrapper', span, env: base, body, overlay }
  }
  return { kind: 'island', span, reason: `unknown environment ${name}` }
}

function parseList(cur: Cursor, open: number, close: number, env: 'itemize' | 'enumerate' | 'description', span: Span, srcEnv?: string, overlay?: Span): LxBlock {
  // find \item boundaries at THIS nesting depth only
  let depth = 0
  const marks: number[] = []
  for (let i = open + 1; i < close; i++) {
    const t = cur.toks[i]
    if (t.kind === 'envbegin') depth++
    else if (t.kind === 'envend') depth--
    else if (depth === 0 && t.kind === 'cs' && t.name === 'item') marks.push(i)
  }
  if (marks.length === 0) return { kind: 'island', span, reason: `\\begin{${env}} with no \\item` }

  const items: LxListItem[] = []
  for (let m = 0; m < marks.length; m++) {
    const at = marks[m]
    const itemHi = m + 1 < marks.length ? marks[m + 1] : close
    let lo = at + 1
    let term: LxInline[] | undefined
    // beamer's grammar is `\item<overlay>[label]`, in that order
    const ov = lo < itemHi && cur.toks[lo]?.kind === 'overlay' ? cur.toks[lo].span : undefined
    if (ov) lo++
    // \item[…]: a description list's term, an itemize's custom bullet
    const bracket = matchBracketGroup(cur, lo, itemHi)
    if (bracket) {
      term = parseInline(cur, bracket.lo, bracket.hi)
      lo = bracket.close + 1
    }
    const blocks = parseBlocks(cur, lo, itemHi)
    const spanEnd = blocks.length
      ? blocks[blocks.length - 1].span.end
      : (bracket ? cur.toks[bracket.close].span.end : ov ? ov.end : cur.toks[at].span.end)
    items.push({ span: { start: cur.toks[at].span.start, end: spanEnd }, term, blocks, overlay: ov })
  }
  return { kind: 'list', span, env, items, srcEnv, overlay }
}

function parseFloatEnv(cur: Cursor, open: number, close: number, env: 'figure' | 'table', starred: boolean, span: Span): LxBlock {
  const sink: FloatSink = { env, graphics: [], body: [] }
  let i = open + 1
  const placement = matchBracketGroup(cur, i, close)
  if (placement) i = placement.close + 1
  scanFloatLevel(cur, i, close, sink, true, 0)
  return { kind: 'float', span, env, starred, caption: sink.caption, label: sink.label, graphics: sink.graphics, body: sink.body }
}

interface FloatSink { env: 'figure' | 'table'; caption?: LxInline[]; label?: string; graphics: LxGraphic[]; body: LxBlock[] }

/** sub-float COMMANDS with the `[caption]{content}` grammar — subfig's
 * \subfloat and the older subfigure package's \subfigure. (The subcaption
 * package's \begin{subfigure} environment is a different construct and is
 * already a wrapper; \subcaptionbox takes its caption in a BRACE and is
 * left alone rather than read with the wrong grammar.) */
const SUBFLOAT_CMDS = new Set(['subfigure', 'subfloat'])

/** how deep a chain of nested brace groups the float scanner will follow.
 * Real floats bottom out at two or three ({\small \resizebox{w}{h}{…}}); the
 * limit is only there so a pathological source cannot recurse unboundedly. */
const FLOAT_GROUP_DEPTH = 6

/** Scan a float's interior for its caption, label, graphics and body blocks.
 *
 * Recurses into a depth-0 brace group ONLY when the group carries positive
 * evidence of content — a \begin{…} or an \includegraphics somewhere inside
 * it. Skipping every group wholesale made real tables invisible: llama/palm/
 * palm2 wrap the tabular in a bare `{ … }`, and bloom/flan/palm2 wrap it in
 * \resizebox{w}{h}{…}. Descending into every group instead would parse a
 * pgfplots/keyval OPTIONS group, or a layout command's own argument
 * (\setlength{\tabcolsep}{4pt}), as body — so the evidence test is the whole
 * discrimination, and it gets the boxes for free: \resizebox's {width} and
 * {height} and \scalebox's {factor} hold no environment and no graphic, so
 * only the LAST argument is ever descended.
 *
 * `top` is false inside any descended group, and that is what keeps a nested
 * \caption (a \subfigure's, an inner box's) from being hoisted onto the outer
 * float — it belongs to whatever construct encloses it, so below float level
 * a \caption is left exactly where it was written.
 *
 * A LOOSE RUN is everything between two float-level constructs: the prose a
 * float carries beside its graphic ("(a) left, (b) right", a note written
 * under the image). Kept unparsed it stays in the source but never reaches
 * the surface the user edits in — visible in the compiled mirror, absent from
 * the document. Runs are flushed through parseBlocks only when they actually
 * BEAR PROSE (runBearsProse): a run of pure furniture — \centering, \small, a
 * \subfloat whose only text sits in its bracket argument — would otherwise
 * island its command bytes onto the surface as junk, a worse defect than the
 * one being fixed. A group we DESCEND into ends the run before it; a group we
 * do not (options, dimensions) stays part of the run around it. */
function scanFloatLevel(cur: Cursor, lo: number, hi: number, sink: FloatSink, top: boolean, depth: number): void {
  let i = lo
  let runLo = -1
  const flushRun = (runHi: number) => {
    if (runLo >= 0 && runBearsProse(cur, runLo, runHi)) sink.body.push(...parseBlocks(cur, runLo, runHi))
    runLo = -1
  }

  while (i < hi) {
    const t = cur.toks[i]
    if (t.kind === 'envbegin') {
      flushRun(i)
      const envClose = findEnvEnd(cur.toks, i, hi, t.name)
      if (envClose < 0) break
      sink.body.push(parseEnv(cur, i, envClose, t.name))
      i = envClose + 1
      continue
    }
    if (t.kind === 'cs') {
      // A SECTIONING command at float level. Papers use a bare float as a
      // page-break hack (llama: `\begin{figure*}\section{MMLU}\end{figure*}`,
      // and one more that carries a whole appendix opening), and the heading
      // inside is a real heading nobody could see: runBearsProse cannot
      // rescue it, because its only prose sits inside the title GROUP, where
      // the filter deliberately refuses to look. Reading the command itself
      // is exact where widening that filter would not be — it is the same
      // move \caption and \includegraphics already get. parseSection's
      // island fallback is declined on purpose: a \section the scanner could
      // not read is left in its run rather than shown as command bytes.
      if (SECTION_LEVEL[t.name] !== undefined) {
        const r = parseSection(cur, i, hi)
        if (r.block.kind === 'section') {
          flushRun(i)
          sink.body.push(r.block)
          i = r.next
          continue
        }
      }
      // \subfloat[sub-caption]{panel}: the panel's own caption, in a
      // BRACKET where runBearsProse (depth-0 text only) can never see it —
      // palm2's two panels carry a sentence each. Read as a nested float so
      // the prose stays WITH its graphic instead of being hoisted to the end
      // of the outer figure, and so render/emit reuse the float machinery
      // they already have (emit.ts patches the bracket, see emitFloat).
      if (SUBFLOAT_CMDS.has(t.name)) {
        const b = matchBracketGroup(cur, i + 1, hi)
        const g = matchBraceGroup(cur, b ? b.close + 1 : i + 1, hi)
        if (g) {
          flushRun(i)
          const sub: FloatSink = { env: sink.env, graphics: [], body: [] }
          scanFloatLevel(cur, g.lo, g.hi, sub, true, depth + 1)
          const caption = b ? parseInline(cur, b.lo, b.hi) : []
          sink.body.push({
            kind: 'float',
            span: { start: t.span.start, end: cur.toks[g.close].span.end },
            env: sub.env,
            starred: false,
            // `\subfigure[]{…}` (palm's own idiom) declares an EMPTY
            // sub-caption — no caption at all, not an empty one
            caption: caption.some((n) => !(n.kind === 'text' && n.text.trim() === '')) ? caption : sub.caption,
            label: sub.label,
            graphics: sub.graphics,
            body: sub.body,
          })
          i = g.close + 1
          continue
        }
      }
      if (top && t.name === 'caption') {
        const b = matchBracketGroup(cur, i + 1, hi)
        const g = matchBraceGroup(cur, b ? b.close + 1 : i + 1, hi)
        if (g) { flushRun(i); sink.caption = parseInline(cur, g.lo, g.hi); i = g.close + 1; continue }
      }
      if (top && t.name === 'label') {
        const g = matchBraceGroup(cur, i + 1, hi)
        if (g) { flushRun(i); sink.label = groupText(cur, g); i = g.close + 1; continue }
      }
      if (t.name === 'includegraphics') {
        const b = matchBracketGroup(cur, i + 1, hi)
        const g = matchBraceGroup(cur, b ? b.close + 1 : i + 1, hi)
        if (g) {
          flushRun(i)
          sink.graphics.push({
            span: { start: t.span.start, end: cur.toks[g.close].span.end },
            path: groupText(cur, g).trim(),
            opts: b ? groupText(cur, b) : undefined,
          })
          i = g.close + 1
          continue
        }
      }
    }
    if (t.kind === 'open') {
      const g = matchGroupFrom(cur, i, hi)
      if (!g) { i++; continue }
      if (depth < FLOAT_GROUP_DEPTH && groupHoldsContent(cur, g)) {
        flushRun(i)
        scanFloatLevel(cur, g.lo, g.hi, sink, false, depth + 1)
      } else if (runLo < 0) {
        runLo = i
      }
      i = g.close + 1
      continue
    }
    if (runLo < 0) runLo = i
    i++
  }
  flushRun(hi)
}

/** does this group hold something that sets content the float should show?
 * A \begin{…} of ANY environment counts, recognized or not: an unknown one
 * parses to an island carrying its real source, which is this parser's
 * honest fallback everywhere else and beats the content vanishing. Key/value
 * option groups and dimension arguments contain neither. */
function groupHoldsContent(cur: Cursor, g: Group): boolean {
  for (let i = g.lo; i < g.hi; i++) {
    const t = cur.toks[i]
    if (t.kind === 'envbegin') return true
    if (t.kind === 'cs' && t.name === 'includegraphics') return true
  }
  return false
}

/** glue primitives whose dimension is a BARE argument, not a braced one
 * (\vspace{1em} is already a group, and its text never reaches depth 0).
 * Measured on the corpus: `\centering \small \vskip 0.1in` opens a dozen
 * palm/flan floats, and that "0.1in" is the only depth-0 text they have —
 * without this the spacing run would be promoted to a paragraph and its
 * command bytes shown as islands under the figure. */
const BARE_DIMEN_RE = /\\(?:vskip|hskip|kern|addvspace|abovedisplayskip|belowdisplayskip|raise|lower)\b\s*=?\s*-?[\d.]*\s*(?:pt|mm|cm|em|ex|sp|in|bp|pc|fil{1,3})?/g

/** does a float-level run carry text a reader would call prose? Only
 * DEPTH-0 text counts: `\subfloat[Left panel]{…}` and `\resizebox{…}{…}{…}`
 * put their words inside groups, where they are a command's argument, not
 * float body. Command names themselves don't count either — an unknown
 * macro is not evidence of prose, and treating it as such would island
 * every layout run in the corpus onto the surface.
 *
 * What's left after both strips must contain a character that is neither
 * whitespace nor punctuation nor a symbol: `(a)` and CJK prose qualify, a
 * stray `.`, a `~` or an orphaned `\\` do not. A run whose ONLY content is
 * a macro call (`\model{}`) stays unparsed — conservative on purpose, the
 * cost is invisibility (the bytes are still exported) where the cost of a
 * false positive is visible junk on every figure. */
function runBearsProse(cur: Cursor, lo: number, hi: number): boolean {
  let depth = 0
  let flat = ''
  for (let i = lo; i < hi; i++) {
    const t = cur.toks[i]
    if (t.kind === 'open' || t.kind === 'bopen') { depth++; continue }
    if (t.kind === 'close' || t.kind === 'bclose') { depth--; continue }
    if (depth !== 0 || t.kind === 'comment') continue
    flat += cur.slice(t.span)
  }
  const bare = flat
    .replace(BARE_DIMEN_RE, ' ')
    .replace(/\\[a-zA-Z@]+\*?/g, ' ')
    .replace(/\\[\s\S]/g, ' ')
  return /[^\s\p{P}\p{S}]/u.test(bare)
}

function parseTabular(cur: Cursor, open: number, close: number, span: Span): LxBlock {
  // optional [pos], then the column spec group
  let i = open + 1
  const pos = matchBracketGroup(cur, i, close)
  if (pos) i = pos.close + 1
  const spec = matchBraceGroup(cur, i, close)
  if (!spec) return { kind: 'island', span, reason: 'tabular without column spec' }
  const colspec = groupText(cur, spec)
  // the ORIGINAL spec is what emits; only the sanity test reads the
  // normalized form (`*{3}{c}` repetitions expanded, `>{...}` decorations
  // dropped — they style, they don't structure)
  const normSpec = normalizeColspec(colspec)
  if (!/^[lrcpmbS|@{}\s\d.a-z*]*$/i.test(normSpec)) {
    return { kind: 'island', span, reason: 'complex tabular colspec' }
  }

  // split rows on depth-0 \\ and cells on depth-0 & — token-aligned
  const rows: LxTabRow[] = []
  let cells: Array<{ lo: number; hi: number }> = []
  let cellLo = spec.close + 1
  let depth = 0
  for (let j = spec.close + 1; j < close; j++) {
    const t = cur.toks[j]
    if (t.kind === 'open' || t.kind === 'envbegin' || t.kind === 'bopen') { depth++; continue }
    if (t.kind === 'close' || t.kind === 'envend' || t.kind === 'bclose') { depth--; continue }
    if (depth !== 0) continue
    if (t.kind === 'amp') {
      cells.push({ lo: cellLo, hi: j })
      cellLo = j + 1
    } else if (t.kind === 'cs' && t.name === '\\') {
      cells.push({ lo: cellLo, hi: j })
      rows.push(buildRow(cur, cells))
      cells = []
      cellLo = j + 1
    }
  }
  // material after the last \\ — often just \bottomrule, sometimes a row
  cells.push({ lo: cellLo, hi: close })
  const tail = buildRow(cur, cells)
  let trailingRule: string | undefined
  if (tail.cells.some((cell) => cell.inline.length > 0)) {
    rows.push(tail)
  } else {
    // no row followed the last \\ — capture the trailing rule verbatim so a
    // from-scratch reconstruction (no original bytes to splice into) can
    // still close the table with it; an edited-cell splice never needs this,
    // the bytes ride along in the untouched tail of the block's own slice
    const from = cur.toks[cellLo]?.span.start ?? cur.toks[close].span.start
    const raw = cur.src.slice(from, cur.toks[close].span.start).trim()
    if (RULE_TEXT_RE.test(raw)) trailingRule = raw
  }

  if (rows.length === 0) return { kind: 'island', span, reason: 'tabular rows did not scan' }
  return trailingRule !== undefined
    ? { kind: 'tabular', span, colspec, rows, trailingRule }
    : { kind: 'tabular', span, colspec, rows }
}

function buildRow(cur: Cursor, cellSpans: Array<{ lo: number; hi: number }>): LxTabRow {
  const cells = cellSpans.map((c) => parseTabCell(cur, c.lo, c.hi))
  const rule = cellSpans.length > 0 ? ruleTextBefore(cur, cellSpans[0].lo, cellSpans[0].hi) : undefined
  return rule !== undefined ? { cells, rule } : { cells }
}

/** exact source text of any rule commands (+ their own arguments) leading a
 * cell span — \toprule, \midrule, a chained run of \cmidrule(lr){…}, \hline,
 * \cline{…} — or undefined when the row opens directly with content */
function ruleTextBefore(cur: Cursor, lo: number, hi: number): string | undefined {
  const end = skipCellFurniture(cur, lo, hi)
  if (end === lo) return undefined
  const raw = cur.src.slice(cur.toks[lo].span.start, cur.toks[end - 1].span.end).trim()
  return RULE_TEXT_RE.test(raw) ? raw : undefined
}

/** expand `*{n}{spec}` repetitions and drop `>{…} <{…} !{…}` decorations —
 * for the SANITY TEST only; the raw spec is preserved for emission */
function normalizeColspec(spec: string): string {
  let out = spec
  for (let round = 0; round < 4; round++) {
    const next = out.replace(/\*\s*\{(\d+)\}\s*\{([^{}]*)\}/g, (_, n: string, body: string) =>
      body.repeat(Math.min(Number(n), 30)))
    if (next === out) break
    out = next
  }
  return out
    .replace(/[><!]\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, '')
    // a sized column's width is opaque (`p{0.75\textwidth}`) — the column
    // KIND is all the sanity test needs
    .replace(/([pmb])\{[^{}]*\}/g, '$1')
}

/** a cell that may open with \multicolumn{n}{spec}{content} and, inside
 * that or bare, \multirow{n}{width}{content} — the structure becomes
 * colspan/rowspan, the content parses as ordinary inlines */
function parseTabCell(cur: Cursor, lo: number, hi: number): LxTabCell {
  let i = skipCellFurniture(cur, lo, hi)
  let colspan: number | undefined
  let rowspan: number | undefined
  let colspanSpec: string | undefined
  let rowspanWidth: string | undefined

  for (let round = 0; round < 2; round++) {
    const t = cur.toks[i]
    if (!(i < hi && t?.kind === 'cs' && (t.name === 'multicolumn' || t.name === 'multirow'))) break
    const g1 = matchBraceGroup(cur, i + 1, hi)
    const g2 = g1 && matchBraceGroup(cur, g1.close + 1, hi)
    const g3 = g2 && matchBraceGroup(cur, g2.close + 1, hi)
    if (!g1 || !g2 || !g3) break
    const n = Number(groupText(cur, g1).trim())
    if (!Number.isInteger(n) || n < 1 || n > 60) break
    if (t.name === 'multicolumn') { colspan = n; colspanSpec = groupText(cur, g2) }
    else { rowspan = n; rowspanWidth = groupText(cur, g2) }
    // the remaining tokens must be only whitespace — anything else after
    // the closing brace means this is not a plain spanning cell
    let rest = g3.close + 1
    while (rest < hi) {
      const r = cur.toks[rest]
      if (r.kind === 'text' && cur.slice(r.span).trim() === '') { rest++; continue }
      if (r.kind === 'comment') { rest++; continue }
      break
    }
    if (rest !== hi) { colspan = undefined; rowspan = undefined; colspanSpec = undefined; rowspanWidth = undefined; break }
    // descend into the content group
    hi = g3.hi
    i = skipCellFurniture(cur, g3.lo, hi)
  }

  // the content span this cell's inline was parsed from — an empty span at
  // the boundary token (closing brace, `&`, `\\`, or the tabular's own
  // close) when the cell has nothing between furniture and boundary
  const contentSpan: Span = i < hi
    ? { start: cur.toks[i].span.start, end: cur.toks[hi - 1].span.end }
    : { start: cur.toks[hi]?.span.start ?? cur.src.length, end: cur.toks[hi]?.span.start ?? cur.src.length }

  const inline = parseInline(cur, i, hi)
  const kept = inline.filter((n) => !(n.kind === 'text' && n.text.trim() === '')).length ? inline : []
  const cell: LxTabCell = { inline: kept, contentSpan }
  if (colspan !== undefined && colspan > 1) cell.colspan = colspan
  if (rowspan !== undefined && rowspan > 1) cell.rowspan = rowspan
  if (cell.colspan !== undefined && colspanSpec !== undefined) cell.colspanSpec = colspanSpec
  if (cell.rowspan !== undefined && rowspanWidth !== undefined) cell.rowspanWidth = rowspanWidth
  return cell
}

/** leading rule commands and blank text before a cell's content */
function skipCellFurniture(cur: Cursor, lo: number, hi: number): number {
  let i = lo
  for (;;) {
    const t = cur.toks[i]
    if (i >= hi) break
    if (t.kind === 'text' && cur.slice(t.span).trim() === '') { i++; continue }
    if (t.kind === 'parbreak' || t.kind === 'comment') { i++; continue }
    if (t.kind === 'cs' && RULE_CMDS.has(t.name)) {
      i++
      // \cmidrule(lr){2-3} / \cline{1-2} argument groups; the (lr) trim
      // spec is a plain text token, not a bracket group
      const p = cur.toks[i]
      if (p?.kind === 'text' && /^\s*\([^()]*\)\s*$/.test(cur.slice(p.span))) i++
      const b = matchBracketGroup(cur, i, hi)
      if (b) i = b.close + 1
      const g = matchBraceGroup(cur, i, hi)
      if (g) i = g.close + 1
      continue
    }
    break
  }
  return i
}

/* ---------- inline parsing ---------- */

function parseInline(cur: Cursor, lo: number, hi: number): LxInline[] {
  const out: LxInline[] = []
  let i = lo
  while (i < hi) {
    const t = cur.toks[i]

    if (t.kind === 'comment' || t.kind === 'parbreak') { i++; continue }

    if (t.kind === 'text') {
      // a bare ~ in SOURCE bytes is a non-breaking space, and this is the one
      // place text comes from source bytes — every other text inline below is
      // a substituted literal (a stray bracket, \%, \textasciitilde). The
      // renderer used to do this instead, which meant it could not tell the
      // two apart: a typed tilde came back from \textasciitilde{} as a space.
      out.push({ kind: 'text', span: t.span, text: cur.slice(t.span).replace(/~/g, ' ') })
      i++
      continue
    }

    if (t.kind === 'overlay') {
      // an overlay spec no construct claimed (a fuzz slice that cut its
      // command away, an environment this parser islands anyway): show the
      // literal bytes, exactly as before the spec had a token of its own.
      // Its span still covers them, so an edit re-emits them unchanged.
      out.push({ kind: 'text', span: t.span, text: cur.slice(t.span) })
      i++
      continue
    }

    // stray brackets/ampersands outside their structural role are literal
    if (t.kind === 'bopen' || t.kind === 'bclose' || t.kind === 'amp') {
      out.push({ kind: 'text', span: t.span, text: t.kind === 'bopen' ? '[' : t.kind === 'bclose' ? ']' : '&' })
      i++
      continue
    }

    if (t.kind === 'verb') {
      out.push({ kind: 'verb', span: t.span, text: verbBody(cur.slice(t.span), t.env) })
      i++
      continue
    }

    if (t.kind === 'mathshift') {
      // inline `$…$` (a `$$` here is display math leaking in — island it)
      if (t.span.end - t.span.start === 2) {
        out.push({ kind: 'island', span: t.span })
        i++
        continue
      }
      let close = -1
      for (let j = i + 1; j < hi; j++) {
        const u = cur.toks[j]
        if (u.kind === 'mathshift' && u.span.end - u.span.start === 1) { close = j; break }
      }
      if (close < 0) {
        out.push({ kind: 'island', span: { start: t.span.start, end: endOf(cur, hi) } })
        i = hi
        continue
      }
      out.push({
        kind: 'math',
        span: { start: t.span.start, end: cur.toks[close].span.end },
        tex: cur.src.slice(t.span.end, cur.toks[close].span.start),
      })
      i = close + 1
      continue
    }

    if (t.kind === 'open') {
      const g = matchGroupFrom(cur, i, hi)
      if (!g) {
        out.push({ kind: 'island', span: { start: t.span.start, end: endOf(cur, hi) } })
        i = hi
        continue
      }
      // old-style declaration group `{\bf …}` → style; else transparent group
      const first = cur.toks[i + 1]
      const decl = first?.kind === 'cs' ? STYLE_DECL[first.name] : undefined
      const span = { start: t.span.start, end: cur.toks[g.close].span.end }
      if (decl) out.push({ kind: 'style', span, cmd: decl, inner: parseInline(cur, i + 2, g.close) })
      else out.push(...parseInline(cur, i + 1, g.close))
      i = g.close + 1
      continue
    }

    if (t.kind === 'close') {
      // unbalanced close — island it alone, keep going
      out.push({ kind: 'island', span: t.span })
      i++
      continue
    }

    if (t.kind === 'cs') {
      const r = parseInlineCs(cur, i, hi)
      out.push(r.inline)
      i = r.next
      continue
    }

    // an environment inside inline context (caption with center, …):
    // island to the matching end when possible, alone when not
    if (t.kind === 'envbegin') {
      const close = findEnvEnd(cur.toks, i, hi, t.name)
      const end = close >= 0 ? cur.toks[close].span.end : endOf(cur, hi)
      out.push({ kind: 'island', span: { start: t.span.start, end } })
      i = close >= 0 ? close + 1 : hi
      continue
    }
    out.push({ kind: 'island', span: t.span })
    i++
  }
  return out
}

function parseInlineCs(cur: Cursor, at: number, hi: number): { inline: LxInline; next: number } {
  const t = cur.toks[at] as Extract<LxToken, { kind: 'cs' }>
  const name = t.name

  if (CHAR_ESCAPES[name] !== undefined) {
    return { inline: { kind: 'text', span: t.span, text: CHAR_ESCAPES[name] }, next: at + 1 }
  }
  if (name === '\\') return { inline: { kind: 'break', span: t.span }, next: at + 1 }

  if (name === '(') {
    // \( … \)
    for (let j = at + 1; j < hi; j++) {
      const u = cur.toks[j]
      if (u.kind === 'cs' && u.name === ')') {
        return {
          inline: { kind: 'math', span: { start: t.span.start, end: u.span.end }, tex: cur.src.slice(t.span.end, u.span.start) },
          next: j + 1,
        }
      }
    }
    return { inline: { kind: 'island', span: { start: t.span.start, end: endOf(cur, hi) } }, next: hi }
  }

  const style = STYLE_CMD[name]
  if (style) {
    // beamer overloads these with an overlay spec: `\textbf<2>{…}`
    const ovTok = cur.toks[at + 1]
    const overlay = at + 1 < hi && ovTok?.kind === 'overlay' ? ovTok.span : undefined
    const g = matchBraceGroup(cur, overlay ? at + 2 : at + 1, hi)
    if (g) {
      return {
        inline: { kind: 'style', span: { start: t.span.start, end: cur.toks[g.close].span.end }, cmd: style, inner: parseInline(cur, g.lo, g.hi), overlay },
        next: g.close + 1,
      }
    }
  }

  if (REF_CMDS.has(name)) {
    const g = matchBraceGroup(cur, at + 1, hi)
    if (g) {
      const keys = groupText(cur, g).split(',').map((k) => k.trim()).filter(Boolean)
      return {
        inline: { kind: 'ref', span: { start: t.span.start, end: cur.toks[g.close].span.end }, cmd: name, keys },
        next: g.close + 1,
      }
    }
  }

  if (CITE_RE.test(name)) {
    // up to TWO optional args: \citep[post]{…} and \citep[pre][post]{…}
    const b1 = matchBracketGroup(cur, at + 1, hi)
    const b2 = b1 ? matchBracketGroup(cur, b1.close + 1, hi) : null
    const g = matchBraceGroup(cur, b2 ? b2.close + 1 : b1 ? b1.close + 1 : at + 1, hi)
    if (g) {
      return {
        inline: {
          kind: 'cite',
          span: { start: t.span.start, end: cur.toks[g.close].span.end },
          cmd: name,
          keys: groupText(cur, g).split(',').map((k) => k.trim()).filter(Boolean),
          opt: b2 ? groupText(cur, b2) : b1 ? groupText(cur, b1) : undefined,
          pre: b2 && b1 ? groupText(cur, b1) : undefined,
        },
        next: g.close + 1,
      }
    }
  }

  if (name === 'footnote') {
    const g = matchBraceGroup(cur, at + 1, hi)
    if (g) {
      return {
        inline: { kind: 'footnote', span: { start: t.span.start, end: cur.toks[g.close].span.end }, inner: parseInline(cur, g.lo, g.hi) },
        next: g.close + 1,
      }
    }
  }

  if (name === 'url') {
    const g = matchBraceGroup(cur, at + 1, hi)
    if (g) {
      return {
        inline: { kind: 'url', span: { start: t.span.start, end: cur.toks[g.close].span.end }, url: groupText(cur, g).trim() },
        next: g.close + 1,
      }
    }
  }
  if (name === 'href') {
    const g1 = matchBraceGroup(cur, at + 1, hi)
    const g2 = g1 ? matchBraceGroup(cur, g1.close + 1, hi) : null
    if (g1 && g2) {
      return {
        inline: {
          kind: 'url',
          span: { start: t.span.start, end: cur.toks[g2.close].span.end },
          url: groupText(cur, g1).trim(),
          inner: parseInline(cur, g2.lo, g2.hi),
        },
        next: g2.close + 1,
      }
    }
  }

  if (name === 'label') {
    const g = matchBraceGroup(cur, at + 1, hi)
    if (g) {
      return {
        inline: { kind: 'label', span: { start: t.span.start, end: cur.toks[g.close].span.end }, key: groupText(cur, g) },
        next: g.close + 1,
      }
    }
  }

  if (SYMBOL_CMD[name] !== undefined) {
    // the character itself; an empty trailing {} (the \dots{} idiom) rides
    // along in the span
    const g = matchBraceGroup(cur, at + 1, hi)
    const bare = g && groupText(cur, g).trim() === ''
    return {
      inline: {
        kind: 'text',
        span: { start: t.span.start, end: bare ? cur.toks[g.close].span.end : t.span.end },
        text: SYMBOL_CMD[name],
      },
      next: bare ? g.close + 1 : at + 1,
    }
  }

  // unknown command: consume it and any directly attached [..]/{..} argument
  // groups — the standard heuristic; the island's span stays exact either way
  let end = at + 1
  if (end < hi && cur.toks[end]?.kind === 'overlay') {
    // …with one exception. A command carrying an overlay spec is one of
    // beamer's, and every beamer overlay command puts CONTENT in the group
    // after the spec (\only<2>{…}, \uncover<2->{…}, \alert<3>{…}). Swallowing
    // that group into the island would paint a slide's prose as raw mono —
    // the defect the wrapper work just removed from this same deck. So the
    // spec joins the island, tight against its command, and the scan stops.
    end++
  } else {
    for (;;) {
      const b = matchBracketGroup(cur, end, hi)
      if (b) { end = b.close + 1; continue }
      const g = matchBraceGroup(cur, end, hi)
      if (g) { end = g.close + 1; continue }
      break
    }
  }
  return {
    inline: { kind: 'island', span: { start: t.span.start, end: end > at + 1 ? cur.toks[end - 1].span.end : t.span.end } },
    next: end,
  }
}

/* ---------- helpers ---------- */

/** matching \end for the \begin at `open`, counting same-name nesting */
function findEnvEnd(toks: LxToken[], open: number, hi: number, name: string): number {
  let depth = 0
  for (let i = open + 1; i < hi; i++) {
    const t = toks[i]
    if (t.kind === 'envbegin' && t.name === name) depth++
    else if (t.kind === 'envend' && t.name === name) {
      if (depth === 0) return i
      depth--
    }
  }
  return -1
}

interface Group { lo: number; hi: number; close: number; closeSpan: Span }

/** brace group starting at the first non-space token at/after `at` */
function matchBraceGroup(cur: Cursor, at: number, hi: number): Group | null {
  let i = at
  while (i < hi && cur.toks[i].kind === 'text' && cur.slice(cur.toks[i].span).trim() === '') i++
  if (cur.toks[i]?.kind !== 'open') return null
  return matchGroupFrom(cur, i, hi)
}

/** An OPTIONAL leading brace argument (frame's title), taken only when it
 * cannot plausibly be the environment's BODY instead. `afterPos` is the
 * source position right after the construct this argument would hug
 * (the \begin{env} tag, or a preceding [..]). Every check leans toward
 * NOT consuming: an unconsumed group still renders, as an extra body
 * paragraph; a wrongly-consumed one is deleted from the tree.
 *
 *  1. same line — a title's `{` sits on the same source line as what it
 *     hugs; a body's opening group conventionally starts on the next
 *     line (the common `\begin{frame}\n  {\centering\includegraphics{…}}`
 *     idiom this guards against). matchBraceGroup happily crosses that
 *     single newline (it only skips blank text), so this is checked
 *     against the raw source, not just token kinds.
 *  2. does not open with a layout/declaration command — reuses
 *     NO_TYPE_BARE (\centering, \raggedright, \small, …): real slide
 *     titles are prose or a text macro, never a bare declaration: a
 *     group opening with one is almost certainly body content that
 *     merely happens to sit on the begin line.
 *  3. single paragraph — a title never spans a blank line; a group that
 *     does is body content, not a title.
 *
 * All three must agree; any one failing means the group is left alone. */
function matchOptionalBraceArg(cur: Cursor, at: number, hi: number, afterPos: number): Group | null {
  const g = matchBraceGroup(cur, at, hi)
  if (!g) return null
  const openSpan = cur.toks[g.lo - 1].span
  if (cur.src.slice(afterPos, openSpan.start).includes('\n')) return null
  const text = groupText(cur, g).replace(/^\s+/, '')
  const decl = /^\\([a-zA-Z@]+)\*?/.exec(text)
  if (decl && NO_TYPE_BARE.has(decl[1])) return null
  for (let i = g.lo; i < g.hi; i++) {
    if (cur.toks[i].kind === 'parbreak') return null
  }
  return g
}

function matchGroupFrom(cur: Cursor, open: number, hi: number): Group | null {
  let depth = 0
  for (let i = open + 1; i < hi; i++) {
    const t = cur.toks[i]
    if (t.kind === 'open') depth++
    else if (t.kind === 'close') {
      if (depth === 0) return { lo: open + 1, hi: i, close: i, closeSpan: t.span }
      depth--
    }
  }
  return null
}

/** `[…]` group — token-aligned since the lexer emits bopen/bclose.
 * Optional arguments never span a paragraph break. */
function matchBracketGroup(cur: Cursor, at: number, hi: number): Group | null {
  let i = at
  while (i < hi && cur.toks[i].kind === 'text' && cur.slice(cur.toks[i].span).trim() === '') i++
  if (cur.toks[i]?.kind !== 'bopen') return null
  let depth = 0
  for (let j = i + 1; j < hi; j++) {
    const t = cur.toks[j]
    if (t.kind === 'bopen') depth++
    else if (t.kind === 'bclose') {
      if (depth === 0) return { lo: i + 1, hi: j, close: j, closeSpan: t.span }
      depth--
    } else if (t.kind === 'parbreak') break
  }
  return null
}

function groupText(cur: Cursor, g: Group): string {
  const start = cur.toks[g.lo]?.span.start ?? g.closeSpan.start
  return cur.src.slice(Math.min(start, g.closeSpan.start), g.closeSpan.start)
}

function endOf(cur: Cursor, hi: number): number {
  const last = cur.toks[Math.min(hi, cur.toks.length) - 1]
  return last ? last.span.end : 0
}

/** verbatim env body: strip `\begin{env}` + any same-line [opts]/{args} and
 * the line's newline, plus the trailing `\end{env}` */
function verbatimBody(blob: string): string {
  let i = blob.indexOf('}') + 1
  // same-line optional/required args ([language=C], {python})
  for (;;) {
    if (blob[i] === '[') {
      const c = blob.indexOf(']', i)
      if (c < 0 || blob.slice(i, c).includes('\n')) break
      i = c + 1
      continue
    }
    if (blob[i] === '{') {
      const c = blob.indexOf('}', i)
      if (c < 0 || blob.slice(i, c).includes('\n')) break
      i = c + 1
      continue
    }
    break
  }
  if (blob[i] === '\n') i++
  const close = blob.lastIndexOf('\\end{')
  let body = blob.slice(i, close < 0 ? blob.length : close)
  if (body.endsWith('\n')) body = body.slice(0, -1)
  return body
}

function verbBody(blob: string, env?: string): string {
  if (env !== undefined) return verbatimBody(blob)
  // \verb<delim>…<delim>
  const m = blob.match(/^\\verb\*?(.)([\s\S]*?)\1?$/)
  return m ? m[2] : blob
}

function mineLabel(tex: string): string | undefined {
  const m = tex.match(/\\label\{([^}]*)\}/)
  return m ? m[1] : undefined
}

/* ---------- does a source slice set any type? ---------- */

/* setup commands whose arguments are consumed whole — nothing in them
 * reaches the page */
const NO_TYPE_ARG = new Set([
  'newcommand', 'renewcommand', 'providecommand', 'newenvironment',
  'renewenvironment', 'newtheorem', 'theoremstyle', 'DeclareMathOperator',
  'setcounter', 'addtocounter', 'counterwithin', 'numberwithin',
  'setlength', 'addtolength', 'settowidth', 'definecolor', 'pagecolor',
  'pgfplotsset', 'tikzset', 'usetikzlibrary', 'usepgfplotslibrary',
  'hypersetup', 'captionsetup', 'graphicspath', 'lstset', 'setlist',
  'geometry', 'pagestyle', 'thispagestyle', 'pagenumbering',
  'bibliographystyle', 'label', 'vspace', 'hspace', 'phantom', 'vphantom',
  'hphantom', 'markboth', 'markright', 'fancyhead', 'fancyfoot',
  'renewpagestyle', 'titlespacing', 'titleformat', 'addcontentsline',
  'enlargethispage', 'crefname', 'Crefname', 'floatstyle', 'restylefloat',
])
/* TeX parameters set by assignment — \looseness=-1 and family */
const NO_TYPE_ASSIGN = new Set([
  'looseness', 'tolerance', 'hbadness', 'vbadness', 'hfuzz', 'vfuzz',
  'clubpenalty', 'widowpenalty', 'brokenpenalty', 'exhyphenpenalty',
  'interlinepenalty', 'predisplaypenalty', 'postdisplaypenalty',
  'parskip', 'parindent', 'baselineskip', 'emergencystretch',
])

/* bare commands that move paper around without inking it */
const NO_TYPE_BARE = new Set([
  'clearpage', 'cleardoublepage', 'newpage', 'appendix', 'onecolumn',
  'twocolumn', 'noindent', 'indent', 'bigskip', 'medskip', 'smallskip',
  'par', 'centering', 'raggedright', 'raggedleft', 'sloppy', 'fussy',
  'relax', 'normalsize', 'small', 'footnotesize', 'scriptsize', 'tiny',
  'large', 'Large', 'LARGE', 'huge', 'Huge', 'frontmatter', 'mainmatter',
  'backmatter', 'onehalfspacing', 'singlespacing', 'doublespacing',
  'phantomsection', 'nopagebreak', 'pagebreak', 'linebreak', 'newline',
  'begingroup', 'endgroup', 'bgroup', 'egroup', 'ignorespaces',
  // beamer's overlay breaks: they split a slide into steps and ink nothing.
  // Left visible they set raw mono in the middle of a slide's prose.
  // \onslide is here for its BARE form — `\onslide<4->` and `\onslide<4->{…}`
  // both leave the group beside them to be read as ordinary content, exactly
  // as the source's own braces already were.
  'pause', 'onslide',
])

/** Would the engine set NOTHING for this source? True for pure setup and
 * layout runs (\clearpage \appendix \renewcommand{\thesection}{…}
 * \pgfplotsset{…}) — shown as raw mono between compiled crops they read as
 * defects, and hiding them loses nothing the page ever showed. Any bare
 * text, unknown command, or text argument keeps the block visible. */
export function setsNoType(slice: string): boolean {
  const s = slice.replace(/(^|[^\\])%[^\n]*/g, '$1')
  let visible = ''
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === '\\') {
      const m = /^[a-zA-Z@]+\*?/.exec(s.slice(i + 1))
      if (m) {
        const name = m[0].replace(/\*$/, '')
        const j = i + 1 + m[0].length
        if (NO_TYPE_ARG.has(name)) { i = consumeArgs(s, j); continue }
        // a bare switch's own overlay spec is stepped over with it: without
        // that, `\onslide<4->` reads as four visible characters and every
        // beamer switch stays loud on the surface. Confined to NO_TYPE_BARE
        // on purpose — after any other command the name has already made
        // `visible` non-empty, so the spec cannot change the answer, and a
        // narrower rule cannot misfire on a `<` that is a relation.
        if (NO_TYPE_BARE.has(name)) { i = j + overlaySpecLength(s, j); continue }
        if (NO_TYPE_ASSIGN.has(name)) {
          const rhs = /^\s*=?\s*-?[\d.]+\s*(?:pt|mm|cm|em|ex|sp|in|bp|pc|fil{1,3})?/.exec(s.slice(j))
          i = j + (rhs ? rhs[0].length : 0)
          continue
        }
        visible += '\\' + name
        i = j
        continue
      }
      // control symbol: \\ and spacing set nothing; an escape (\%, \&) is
      // a printable character
      const c = s[i + 1]
      if (c === '\\' || c === ',' || c === ';' || c === '!' || c === ' ' || c === undefined) { i += 2; continue }
      visible += c
      i += 2
      continue
    }
    if (ch === '{' || ch === '}') { i++; continue }
    visible += ch
    i++
  }
  return visible.trim() === ''
}

/** past any run of [..] and balanced {..} argument groups */
function consumeArgs(s: string, from: number): number {
  let i = from
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i++
    if (s[i] === '[') {
      const close = s.indexOf(']', i)
      if (close < 0) return s.length
      i = close + 1
      continue
    }
    if (s[i] === '{') {
      let depth = 0
      let j = i
      for (; j < s.length; j++) {
        if (s[j] === '\\') { j++; continue }
        if (s[j] === '{') depth++
        else if (s[j] === '}' && --depth === 0) break
      }
      i = j < s.length ? j + 1 : s.length
      continue
    }
    return i
  }
}

/** regex-mine \documentclass/\title/\author/\date from preamble source —
 * balanced-brace aware for the argument. Simple parameterless text macros
 * (\newcommand{\model}{LLaMA\xspace}) are expanded IN THE META STRINGS
 * only: the title is the most prominent line in the whole document, and
 * showing it as "\model: Open and Efficient…" is honesty nobody wanted.
 * Body text keeps its islands — the compiled mirror shows those typeset. */
function minePreamble(src: string): PreambleMeta {
  const meta: PreambleMeta = {}
  const dc = src.match(/\\documentclass(?:\[[^\]]*\])?\{([^}]*)\}/)
  if (dc) meta.docclass = dc[1]

  // parameterless \newcommand/\renewcommand whose body is plain text
  // (\xspace stripped — it only manages spacing); anything with arguments,
  // nested braces, or other commands stays unexpanded
  const macros = new Map<string, string>()
  const quiet: string[] = []
  for (const m of src.matchAll(/\\(?:re)?newcommand\*?\s*(?:\{\\([a-zA-Z]+)\}|\\([a-zA-Z]+))\s*(?:\[0\])?\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
    const name = m[1] ?? m[2]
    const body = m[3].replace(/\\xspace\b/g, '')
    if (/^[^\\]*$/.test(body)) macros.set(name, body)
    else if (setsNoType(body)) quiet.push(name)
  }
  const expand = (text: string): string => {
    let out = text
    for (let round = 0; round < 3; round++) {
      const before = out
      out = out.replace(/\\([a-zA-Z]+)/g, (whole, name: string) => macros.get(name) ?? whole)
      if (out === before) break
    }
    return out
  }
  if (macros.size > 0) meta.textMacros = Object.fromEntries(macros)
  if (quiet.length > 0) meta.quietMacros = quiet

  mineRefNaming(src, meta)

  for (const key of ['title', 'author', 'date'] as const) {
    const at = src.search(new RegExp(`\\\\${key}\\s*\\{`))
    if (at < 0) continue
    const open = src.indexOf('{', at)
    let depth = 0
    for (let i = open + 1; i < src.length; i++) {
      if (src[i] === '\\') { i++; continue }
      if (src[i] === '{') depth++
      else if (src[i] === '}') {
        if (depth === 0) { meta[key] = expand(src.slice(open + 1, i)); break }
        depth--
      }
    }
  }
  return meta
}

/** How a document names its own REFERENCES: cleveref's \crefname/\Crefname,
 * hyperref's \<type>autorefname, and the language the words come from. A
 * paper that renames "figure" to "Fig." or writes in German means every
 * \cref in it reads wrong when resolved against the package default, and
 * the defaults are the only thing available without this.
 *
 * Read from a COMMENT-STRIPPED copy (the same strip setsNoType uses):
 * preambles carry alternative declarations parked behind `%`, and mining
 * one of those is worse than mining nothing. Values are kept verbatim, not
 * trimmed — the trailing space in `{Fig.~}` is the author's spacing. A
 * document that declares none of these leaves all three keys absent. */
function mineRefNaming(src: string, meta: PreambleMeta): void {
  const bare = src.replace(/(^|[^\\])%[^\n]*/g, '$1')

  const crefNames: Record<string, { sg?: string; pl?: string; Sg?: string; Pl?: string }> = {}
  for (const m of bare.matchAll(/\\(c|C)refname\s*(?=\{)/g)) {
    const args = braceArgsAt(bare, m.index + m[0].length, 3)
    if (!args) continue
    const type = args[0].trim()
    if (!type) continue
    // \crefname and \Crefname name the SAME type — one record, so a
    // document that declares only the lowercase form still has a home for
    // the uppercase one if it appears later
    const rec = (crefNames[type] ??= {})
    if (m[1] === 'c') { rec.sg = args[1]; rec.pl = args[2] }
    else { rec.Sg = args[1]; rec.Pl = args[2] }
  }
  if (Object.keys(crefNames).length > 0) meta.crefNames = crefNames

  const refNames: Record<string, string> = {}
  for (const m of bare.matchAll(/\\(?:new|renew|provide)command\*?\s*(?:\{\s*\\([a-zA-Z]+)\s*\}|\\([a-zA-Z]+))\s*(?=\{)/g)) {
    const name = m[1] ?? m[2]
    if (name === 'autorefname' || !name.endsWith('autorefname')) continue
    const args = braceArgsAt(bare, m.index + m[0].length, 1)
    if (!args) continue
    refNames[name.slice(0, -'autorefname'.length)] = args[0]
  }
  if (Object.keys(refNames).length > 0) meta.refNames = refNames

  // babel: `main=` wins outright when present, because that is exactly what
  // it means; otherwise babel's own rule is that the LAST language option
  // is the main one. key=value options (shorthands=off, provide=*) are not
  // languages and must not be mistaken for the last one.
  const babel = bare.match(/\\usepackage\s*\[([^\]]*)\]\s*\{[^}]*\bbabel\b[^}]*\}/)
  if (babel) {
    const opts = babel[1].split(',').map((o) => o.trim()).filter(Boolean)
    const main = opts.find((o) => /^main\s*=/.test(o))
    const lang = main ? main.replace(/^main\s*=\s*/, '') : [...opts].reverse().find((o) => !o.includes('='))
    if (lang) meta.language = lang
  }
  // polyglossia states the main language outright, and a document loading
  // it is not also using babel — so it simply wins
  const poly = bare.match(/\\set(?:main|default)language\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/)
  if (poly) meta.language = poly[1].trim()
}

/** contents of `n` consecutive balanced {…} groups starting at `from`
 * (whitespace between them skipped), or null when fewer are there */
function braceArgsAt(src: string, from: number, n: number): string[] | null {
  const out: string[] = []
  let i = from
  for (let k = 0; k < n; k++) {
    while (i < src.length && /\s/.test(src[i])) i++
    if (src[i] !== '{') return null
    let depth = 0
    let j = i
    for (; j < src.length; j++) {
      if (src[j] === '\\') { j++; continue }
      if (src[j] === '{') depth++
      else if (src[j] === '}' && --depth === 0) break
    }
    if (j >= src.length) return null
    out.push(src.slice(i + 1, j))
    i = j + 1
  }
  return out
}
