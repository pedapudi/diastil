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

import { lex, tilesExactly } from './lex'
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
  | { kind: 'section'; span: Span; level: 1 | 2 | 3 | 4; starred: boolean; inline: LxInline[]; label?: string }
  | { kind: 'para'; span: Span; inline: LxInline[] }
  | { kind: 'abstract'; span: Span; body: LxBlock[] }
  /** transparent/decorative wrappers (center, quote, framed, multicols…) —
   * kept as a block so their interiors stay first-class structure */
  | { kind: 'wrapper'; span: Span; env: string; body: LxBlock[] }
  | { kind: 'list'; span: Span; env: 'itemize' | 'enumerate' | 'description'; items: LxListItem[]; srcEnv?: string }
  | { kind: 'float'; span: Span; env: 'figure' | 'table'; starred: boolean; caption?: LxInline[]; label?: string; graphics: LxGraphic[]; body: LxBlock[] }
  | { kind: 'tabular'; span: Span; colspec: string; rows: LxTabCell[][] }
  /** display math: \[…\], $$…$$, or a math environment */
  | { kind: 'math'; span: Span; tex: string; env?: string; label?: string }
  /** verbatim/lstlisting/minted — mono content, faithfully representable */
  | { kind: 'verbatim'; span: Span; env?: string; text: string }
  | { kind: 'island'; span: Span; reason: string }

/** one table cell; colspan/rowspan carry \multicolumn/\multirow structure */
export interface LxTabCell { inline: LxInline[]; colspan?: number; rowspan?: number }

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
}
export interface LxListItem { span: Span; term?: LxInline[]; blocks: LxBlock[] }
export interface LxGraphic { span: Span; path: string; opts?: string }

export type LxInline =
  | { kind: 'text'; span: Span; text: string }
  | { kind: 'style'; span: Span; cmd: StyleCmd; inner: LxInline[] }
  | { kind: 'math'; span: Span; tex: string }
  | { kind: 'ref'; span: Span; cmd: string; key: string }
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

const SECTION_LEVEL: Record<string, 1 | 2 | 3 | 4> = {
  section: 1, subsection: 2, subsubsection: 3, paragraph: 4, subparagraph: 4,
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
])
/** required brace-argument counts for wrappers that take them */
const WRAPPER_BRACE_ARGS: Record<string, number> = {
  multicols: 1, minipage: 1, subfigure: 1, subtable: 1, spacing: 1,
  addmargin: 1, adjustwidth: 2,
}

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
  pounds: '£', euro: '€', textperthousand: '‰',
}
/** old-style declarations usable as `{\bf …}` */
const STYLE_DECL: Record<string, StyleCmd> = {
  bf: 'bf', bfseries: 'bf', it: 'it', itshape: 'it', em: 'em', tt: 'tt', ttfamily: 'tt', sc: 'sc', scshape: 'sc',
}
const REF_CMDS = new Set(['ref', 'eqref', 'autoref', 'cref', 'Cref', 'pageref'])
const CITE_RE = /^[Cc]ite\w*$|^(parencite|textcite|autocite)$/
/** table-rule commands stripped from cell starts */
const RULE_CMDS = new Set(['hline', 'toprule', 'midrule', 'bottomrule', 'cmidrule', 'cline'])
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

  if (LIST_ENVS.has(base)) return parseList(cur, open, close, base as 'itemize' | 'enumerate' | 'description', span)
  if (LIST_ALIAS[base]) return parseList(cur, open, close, LIST_ALIAS[base], span, name)
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
    let lo = open + 1
    const b = matchBracketGroup(cur, lo, close)
    if (b) lo = b.close + 1
    for (let args = WRAPPER_BRACE_ARGS[base] ?? 0; args > 0; args--) {
      const g = matchBraceGroup(cur, lo, close)
      if (!g) break
      lo = g.close + 1
    }
    return { kind: 'wrapper', span, env: base, body: parseBlocks(cur, lo, close) }
  }
  return { kind: 'island', span, reason: `unknown environment ${name}` }
}

function parseList(cur: Cursor, open: number, close: number, env: 'itemize' | 'enumerate' | 'description', span: Span, srcEnv?: string): LxBlock {
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
    // description items: \item[term]
    const bracket = matchBracketGroup(cur, lo, itemHi)
    if (bracket) {
      term = parseInline(cur, bracket.lo, bracket.hi)
      lo = bracket.close + 1
    }
    const blocks = parseBlocks(cur, lo, itemHi)
    const spanEnd = blocks.length
      ? blocks[blocks.length - 1].span.end
      : (bracket ? cur.toks[bracket.close].span.end : cur.toks[at].span.end)
    items.push({ span: { start: cur.toks[at].span.start, end: spanEnd }, term, blocks })
  }
  return srcEnv ? { kind: 'list', span, env, items, srcEnv } : { kind: 'list', span, env, items }
}

function parseFloatEnv(cur: Cursor, open: number, close: number, env: 'figure' | 'table', starred: boolean, span: Span): LxBlock {
  let caption: LxInline[] | undefined
  let label: string | undefined
  const graphics: LxGraphic[] = []
  const body: LxBlock[] = []

  let i = open + 1
  const placement = matchBracketGroup(cur, i, close)
  if (placement) i = placement.close + 1

  while (i < close) {
    const t = cur.toks[i]
    if (t.kind === 'envbegin') {
      const envClose = findEnvEnd(cur.toks, i, close, t.name)
      if (envClose < 0) { i = close; break }
      body.push(parseEnv(cur, i, envClose, t.name))
      i = envClose + 1
      continue
    }
    if (t.kind === 'cs') {
      if (t.name === 'caption') {
        const b = matchBracketGroup(cur, i + 1, close)
        const g = matchBraceGroup(cur, b ? b.close + 1 : i + 1, close)
        if (g) { caption = parseInline(cur, g.lo, g.hi); i = g.close + 1; continue }
      }
      if (t.name === 'label') {
        const g = matchBraceGroup(cur, i + 1, close)
        if (g) { label = groupText(cur, g); i = g.close + 1; continue }
      }
      if (t.name === 'includegraphics') {
        const b = matchBracketGroup(cur, i + 1, close)
        const g = matchBraceGroup(cur, b ? b.close + 1 : i + 1, close)
        if (g) {
          graphics.push({
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
      // skip a balanced group so nested commands aren't misread as float-level
      const g = matchGroupFrom(cur, i, close)
      i = g ? g.close + 1 : i + 1
      continue
    }
    i++
  }
  return { kind: 'float', span, env, starred, caption, label, graphics, body }
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
  const rows: LxTabCell[][] = []
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
      rows.push(cells.map((c) => parseTabCell(cur, c.lo, c.hi)))
      cells = []
      cellLo = j + 1
    }
  }
  // material after the last \\ — often just \bottomrule, sometimes a row
  cells.push({ lo: cellLo, hi: close })
  const lastRow = cells.map((c) => parseTabCell(cur, c.lo, c.hi))
  if (lastRow.some((cell) => cell.inline.length > 0)) rows.push(lastRow)

  if (rows.length === 0) return { kind: 'island', span, reason: 'tabular rows did not scan' }
  return { kind: 'tabular', span, colspec, rows }
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

  for (let round = 0; round < 2; round++) {
    const t = cur.toks[i]
    if (!(i < hi && t?.kind === 'cs' && (t.name === 'multicolumn' || t.name === 'multirow'))) break
    const g1 = matchBraceGroup(cur, i + 1, hi)
    const g2 = g1 && matchBraceGroup(cur, g1.close + 1, hi)
    const g3 = g2 && matchBraceGroup(cur, g2.close + 1, hi)
    if (!g1 || !g2 || !g3) break
    const n = Number(groupText(cur, g1).trim())
    if (!Number.isInteger(n) || n < 1 || n > 60) break
    if (t.name === 'multicolumn') colspan = n
    else rowspan = n
    // the remaining tokens must be only whitespace — anything else after
    // the closing brace means this is not a plain spanning cell
    let rest = g3.close + 1
    while (rest < hi) {
      const r = cur.toks[rest]
      if (r.kind === 'text' && cur.slice(r.span).trim() === '') { rest++; continue }
      if (r.kind === 'comment') { rest++; continue }
      break
    }
    if (rest !== hi) { colspan = undefined; rowspan = undefined; break }
    // descend into the content group
    hi = g3.hi
    i = skipCellFurniture(cur, g3.lo, hi)
  }

  const inline = parseInline(cur, i, hi)
  const kept = inline.filter((n) => !(n.kind === 'text' && n.text.trim() === '')).length ? inline : []
  const cell: LxTabCell = { inline: kept }
  if (colspan !== undefined && colspan > 1) cell.colspan = colspan
  if (rowspan !== undefined && rowspan > 1) cell.rowspan = rowspan
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
    const g = matchBraceGroup(cur, at + 1, hi)
    if (g) {
      return {
        inline: { kind: 'style', span: { start: t.span.start, end: cur.toks[g.close].span.end }, cmd: style, inner: parseInline(cur, g.lo, g.hi) },
        next: g.close + 1,
      }
    }
  }

  if (REF_CMDS.has(name)) {
    const g = matchBraceGroup(cur, at + 1, hi)
    if (g) {
      return {
        inline: { kind: 'ref', span: { start: t.span.start, end: cur.toks[g.close].span.end }, cmd: name, key: groupText(cur, g) },
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
  for (;;) {
    const b = matchBracketGroup(cur, end, hi)
    if (b) { end = b.close + 1; continue }
    const g = matchBraceGroup(cur, end, hi)
    if (g) { end = g.close + 1; continue }
    break
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
        if (NO_TYPE_BARE.has(name)) { i = j; continue }
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
