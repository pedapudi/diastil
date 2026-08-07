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
  /** everything else, single newlines included */
  | { kind: 'text'; span: Span }

/** environments whose bodies must never be tokenized */
const VERBATIM_ENVS = new Set([
  'verbatim', 'verbatim*', 'Verbatim', 'lstlisting', 'minted',
  'alltt', 'comment', 'filecontents', 'filecontents*',
])

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
