/* LaTeX lexer — the keystone of the document pipeline. Tokens carry exact
 * byte spans and TILE the source: every byte belongs to exactly one token,
 * in order, so any consumer that keeps spans can reproduce the file
 * byte-for-byte. Verbatim regions (\verb, verbatim-class environments) are
 * scanned as ONE blob here, so no later stage can ever mis-read their
 * content as markup — a `%` inside \verb is data, not a comment.
 *
 * `[` `]` `&` get their own tokens even though TeX treats them as ordinary
 * characters: optional arguments and tabular cells become token-aligned,
 * which is what lets the parser split them without sub-token surgery. The
 * parser renders stray ones back as literal text. */

export interface Span { start: number; end: number }

export type LxToken =
  /** control sequence: `\name` (letters) or a control symbol `\%` `\\` … */
  | { kind: 'cs'; span: Span; name: string }
  | { kind: 'open'; span: Span }
  | { kind: 'close'; span: Span }
  | { kind: 'bopen'; span: Span }
  | { kind: 'bclose'; span: Span }
  /** `&` — tabular alignment */
  | { kind: 'amp'; span: Span }
  /** `$` or `$$` (span length tells which) */
  | { kind: 'mathshift'; span: Span }
  /** `%` to end of line (newline not included) */
  | { kind: 'comment'; span: Span }
  /** whitespace run containing 2+ newlines — a paragraph boundary */
  | { kind: 'parbreak'; span: Span }
  /** `\begin{name}` / `\end{name}` recognized as a unit */
  | { kind: 'envbegin'; span: Span; name: string }
  | { kind: 'envend'; span: Span; name: string }
  /** an entire \verb|…| or verbatim-class environment, scanned raw */
  | { kind: 'verb'; span: Span; env?: string }
  /** a beamer OVERLAY SPECIFICATION — `<1->`, `<+->`, `<beamer:2>` — sitting
   * between a command (or a \begin tag) and its arguments. It gets a token,
   * and therefore a span, for the same reason `[` and `]` do: the parser can
   * then hand it to the construct it modifies without sub-token surgery, and
   * emission can put the exact bytes back. Rewriting a text inline's `text`
   * instead would leave its span covering bytes the DOM no longer carries —
   * and an edit to that block would delete the spec from the user's file. */
  | { kind: 'overlay'; span: Span }
  /** everything else, single newlines included */
  | { kind: 'text'; span: Span }

/** environments whose bodies must never be tokenized */
const VERBATIM_ENVS = new Set([
  'verbatim', 'verbatim*', 'Verbatim', 'lstlisting', 'minted',
  'alltt', 'comment', 'filecontents', 'filecontents*',
])

/* ---------- beamer overlay specifications ---------- */

/* `<` and `>` are ORDINARY CHARACTERS in TeX prose and in math ($a < b$);
 * \textless and \textgreater exist precisely because of that. So a spec is
 * recognized only where BOTH locks agree:
 *
 *  1. POSITION — the `<` must touch (no space, no intervening text) a
 *     control sequence from OVERLAY_CMDS or a \begin tag from OVERLAY_ENVS.
 *     Nothing else in the corpus, or in TeX, puts `<` there.
 *  2. SHAPE — overlaySpecLength's grammar. Measured 2026-08-09 on the
 *     corpus: 4 real specs (\item<1->/<2->/<3->, \onslide<4->), and 30-odd
 *     other `<…>` runs, all of them HTML/SVG/Rust inside verbatim listings
 *     or prose (`<WikiHow Article>`, `<String, u32>`, `</head>`) — not one
 *     of them touches a command from either set. */
const OVERLAY_CMDS = new Set([
  // the item marker and the bare slide-stepping switches
  'item', 'pause', 'onslide', 'againframe',
  // reveal commands — \only<2>{…} and family
  'only', 'uncover', 'visible', 'invisible', 'alt', 'temporal', 'action',
  'alert', 'structure',
  // beamer overloads the standard text-style commands with a spec
  'textbf', 'textit', 'textsl', 'textsc', 'textsf', 'textrm', 'texttt',
  'textnormal', 'emph', 'underline', 'color', 'textcolor',
  // slide furniture that steps with the overlays
  'frametitle', 'framesubtitle', 'includegraphics',
])
/** environments whose \begin tag can carry a spec. Deliberately NOT every
 * environment: `\begin{equation}` is followed by math, where `<` is a
 * relation and lexing it as furniture would corrupt the formula. */
const OVERLAY_ENVS = new Set([
  'frame', 'block', 'alertblock', 'exampleblock', 'columns', 'column',
  'itemize', 'enumerate', 'description',
  'onlyenv', 'altenv', 'uncoverenv', 'visibleenv', 'invisibleenv',
  'actionenv', 'overprint', 'overlayarea', 'beamercolorbox',
  // beamer defines the theorem family overlay-aware too
  'theorem', 'lemma', 'proposition', 'corollary', 'definition', 'example',
  'proof', 'remark', 'fact',
])

/** The spec's own grammar: slide numbers and ranges (`1`, `2-`, `3-5`),
 * beamer's incremental markers (`+`, `.`), action and mode prefixes
 * (`alert@+`, `beamer:1-`, `handout:0`), joined by `,` and `|`. A `\`, `{`,
 * `}`, `$`, `%`, a second `<`, or a newline ends the match without one,
 * which is what keeps `$a<b$` and a stray `<` in prose out. At least one
 * character must be a digit or one of the range/mode punctuators, so a bare
 * word — the corpus's own `<title>` and `<head>` — is never a spec. */
const OVERLAY_SPEC_RE = /^<[A-Za-z0-9 +\-.,@|:]{1,64}>/

/** length of the overlay specification starting at `at`, or 0 for none.
 * Exported because emit.ts's head walkers and parse.ts's setsNoType meet the
 * same bytes as raw source rather than as tokens, and three copies of this
 * grammar would drift. */
export function overlaySpecLength(src: string, at: number): number {
  if (src[at] !== '<') return 0
  const m = OVERLAY_SPEC_RE.exec(src.slice(at, at + 66))
  if (!m || !/[0-9+.@:|-]/.test(m[0])) return 0
  return m[0].length
}

/** does a token accept an overlay specification directly after it? */
function takesOverlay(tok: LxToken | undefined): boolean {
  if (tok === undefined) return false
  if (tok.kind === 'cs') return OVERLAY_CMDS.has(tok.name)
  if (tok.kind === 'envbegin') return OVERLAY_ENVS.has(starless(tok.name))
  return false
}

const starless = (env: string) => (env.endsWith('*') ? env.slice(0, -1) : env)

const isLetter = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\r' || c === '\n'

const SINGLE: Record<string, LxToken['kind']> = {
  '{': 'open', '}': 'close', '[': 'bopen', ']': 'bclose', '&': 'amp',
}

export function lex(src: string): LxToken[] {
  const out: LxToken[] = []
  const n = src.length
  let i = 0
  let textStart = -1

  const flushText = (end: number) => {
    if (textStart >= 0 && end > textStart) out.push({ kind: 'text', span: { start: textStart, end } })
    textStart = -1
  }

  while (i < n) {
    const c = src[i]

    if (c === '\\') {
      const tok = lexBackslash(src, i)
      if (tok) {
        flushText(i)
        out.push(tok)
        i = tok.span.end
        continue
      }
      // trailing lone backslash at EOF — plain text
      if (textStart < 0) textStart = i
      i++
      continue
    }

    const single = SINGLE[c]
    if (single) {
      flushText(i)
      out.push({ kind: single, span: { start: i, end: i + 1 } } as LxToken)
      i++
      continue
    }

    if (c === '$') {
      flushText(i)
      const end = src[i + 1] === '$' ? i + 2 : i + 1
      out.push({ kind: 'mathshift', span: { start: i, end } })
      i = end
      continue
    }

    // `textStart < 0` IS the position lock: it means no text has accumulated
    // since the last token ended, so this `<` touches that token exactly
    if (c === '<' && textStart < 0 && takesOverlay(out[out.length - 1])) {
      const len = overlaySpecLength(src, i)
      if (len > 0) {
        out.push({ kind: 'overlay', span: { start: i, end: i + len } })
        i += len
        continue
      }
    }

    if (c === '%') {
      flushText(i)
      let end = i + 1
      while (end < n && src[end] !== '\n') end++
      out.push({ kind: 'comment', span: { start: i, end } })
      i = end
      continue
    }

    if (c === '\n') {
      // scan the whole whitespace run; two newlines make a paragraph break,
      // a single one is ordinary text
      let end = i + 1
      let newlines = 1
      while (end < n && isSpace(src[end])) {
        if (src[end] === '\n') newlines++
        end++
      }
      if (newlines >= 2) {
        flushText(i)
        out.push({ kind: 'parbreak', span: { start: i, end } })
        i = end
        continue
      }
      if (textStart < 0) textStart = i
      i = end
      continue
    }

    if (textStart < 0) textStart = i
    i++
  }
  flushText(n)
  return out
}

/** lex from a `\` — control sequence, control symbol, \begin/\end unit,
 * or a whole verbatim blob; null for a lone backslash at EOF */
function lexBackslash(src: string, at: number): LxToken | null {
  const n = src.length
  if (at + 1 >= n) return null
  const first = src[at + 1]

  if (!isLetter(first)) {
    // control symbol: \\ \% \& \$ \# \_ \{ \} \~ \, …
    return { kind: 'cs', span: { start: at, end: at + 2 }, name: first }
  }

  let j = at + 1
  while (j < n && isLetter(src[j])) j++
  const name = src.slice(at + 1, j)

  if (name === 'begin' || name === 'end') {
    const g = matchEnvName(src, j)
    if (g) {
      if (name === 'begin' && VERBATIM_ENVS.has(g.name)) {
        // scan raw to the matching \end{name} — verbatim never nests
        const close = src.indexOf(`\\end{${g.name}}`, g.end)
        const end = close < 0 ? n : close + `\\end{${g.name}}`.length
        return { kind: 'verb', span: { start: at, end }, env: g.name }
      }
      return { kind: name === 'begin' ? 'envbegin' : 'envend', span: { start: at, end: g.end }, name: g.name }
    }
    return { kind: 'cs', span: { start: at, end: j }, name }
  }

  if (name === 'verb') {
    // \verb<delim>…<delim>, optionally starred; delimiter is any non-letter.
    // an unclosed \verb runs to end of line, matching TeX's error recovery
    let k = j
    if (src[k] === '*') k++
    const delim = src[k]
    if (delim !== undefined && !isLetter(delim) && delim !== '\n') {
      let e = k + 1
      while (e < n && src[e] !== delim && src[e] !== '\n') e++
      return { kind: 'verb', span: { start: at, end: e < n && src[e] === delim ? e + 1 : e } }
    }
    return { kind: 'cs', span: { start: at, end: j }, name }
  }

  if (ASSIGN_PARAMS.has(name)) {
    // \looseness=-1 and family: the assignment is part of the command —
    // split, the `=-1` rendered as prose beside a hidden island
    const m = /^\s*=?\s*-?[\d.]+\s*(?:pt|mm|cm|em|ex|sp|in|bp|pc|fil{1,3})?/.exec(src.slice(j))
    if (m && /[\d]/.test(m[0])) return { kind: 'cs', span: { start: at, end: j + m[0].length }, name }
  }

  return { kind: 'cs', span: { start: at, end: j }, name }
}

/* TeX parameters set by assignment — the value rides the token */
const ASSIGN_PARAMS = new Set([
  'looseness', 'tolerance', 'hbadness', 'vbadness', 'hfuzz', 'vfuzz',
  'clubpenalty', 'widowpenalty', 'brokenpenalty', 'exhyphenpenalty',
  'interlinepenalty', 'predisplaypenalty', 'postdisplaypenalty',
  'emergencystretch', 'parindent', 'parskip', 'baselineskip',
])

/** match `\s*\{envname\}` at `from`; envname = letters, digits, `*`, `@` */
function matchEnvName(src: string, from: number): { name: string; end: number } | null {
  let i = from
  while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++
  if (src[i] !== '{') return null
  let j = i + 1
  while (j < src.length && /[A-Za-z0-9@]/.test(src[j])) j++
  if (src[j] === '*') j++
  if (src[j] !== '}' || j === i + 1) return null
  return { name: src.slice(i + 1, j), end: j + 1 }
}

/** the tiling invariant: tokens cover the source exactly, in order, with no
 * gaps or overlaps. Cheap enough to assert on every parse. */
export function tilesExactly(tokens: LxToken[], src: string): boolean {
  let at = 0
  for (const t of tokens) {
    if (t.span.start !== at || t.span.end < t.span.start) return false
    at = t.span.end
  }
  return at === src.length
}
