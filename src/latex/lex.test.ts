// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { lex, tilesExactly } from './lex'

const kinds = (src: string) => lex(src).map((t) => t.kind)
const texts = (src: string) => lex(src).map((t) => src.slice(t.span.start, t.span.end))

describe('lex', () => {
  it('tiles every input exactly — the invariant everything rests on', () => {
    const cases = [
      '',
      'plain prose with spaces\n',
      '\\section{One}\n\nTwo $x$ three\n\n\\begin{itemize}\\item a\\end{itemize}',
      'a % comment\nb',
      'x \\% not a comment % real\n',
      '$$e=mc^2$$ and $a<b$',
      '\\verb|a % $ { b|rest',
      '\\begin{verbatim}\n% not a comment\n\\end{document}\n\\end{verbatim}after',
      'unclosed \\begin{lstlisting}[language=C]\nint x;',
      'tab & cell [opt] {group} \\\\ row',
      'trailing backslash \\',
    ]
    for (const src of cases) expect(tilesExactly(lex(src), src), JSON.stringify(src)).toBe(true)
  })

  it('recognizes \\begin/\\end as units with the env name', () => {
    const toks = lex('\\begin{itemize}\\item x\\end{itemize}')
    expect(toks[0]).toMatchObject({ kind: 'envbegin', name: 'itemize' })
    expect(toks.at(-1)).toMatchObject({ kind: 'envend', name: 'itemize' })
  })

  it('keeps starred env names', () => {
    expect(lex('\\begin{figure*}\\end{figure*}')[0]).toMatchObject({ kind: 'envbegin', name: 'figure*' })
  })

  it('scans verbatim environments as one blob — % $ { } \\end{other} inside are data', () => {
    const src = '\\begin{verbatim}\n% $ { } \\end{itemize}\n\\end{verbatim}'
    const toks = lex(src)
    expect(toks).toHaveLength(1)
    expect(toks[0]).toMatchObject({ kind: 'verb', env: 'verbatim' })
  })

  it('scans \\verb blobs with arbitrary delimiters', () => {
    const toks = lex('\\verb|a%b$c| tail')
    expect(toks[0].kind).toBe('verb')
    expect(texts('\\verb|a%b$c| tail')[0]).toBe('\\verb|a%b$c|')
  })

  it('an unclosed \\verb stops at end of line, like TeX error recovery', () => {
    const src = '\\verb|oops\nnext line'
    expect(texts(src)[0]).toBe('\\verb|oops')
    expect(tilesExactly(lex(src), src)).toBe(true)
  })

  it('distinguishes $ from $$ by span length', () => {
    const toks = lex('$a$ $$b$$')
    const shifts = toks.filter((t) => t.kind === 'mathshift')
    expect(shifts.map((t) => t.span.end - t.span.start)).toEqual([1, 1, 2, 2])
  })

  it('comments run to end of line, newline excluded', () => {
    const toks = lex('a % rest\nb')
    const comment = toks.find((t) => t.kind === 'comment')!
    expect(comment.span).toEqual({ start: 2, end: 8 })
  })

  it('control symbols are single cs tokens — \\% is not a comment', () => {
    const toks = lex('100\\% sure')
    expect(toks.some((t) => t.kind === 'comment')).toBe(false)
    expect(toks[1]).toMatchObject({ kind: 'cs', name: '%' })
  })

  it('blank lines are parbreaks; single newlines are text', () => {
    expect(kinds('a\nb')).toEqual(['text'])
    expect(kinds('a\n\nb')).toEqual(['text', 'parbreak', 'text'])
    expect(kinds('a\n  \n  b')).toEqual(['text', 'parbreak', 'text'])
  })

  it('brackets and ampersands get their own tokens', () => {
    expect(kinds('[x] & y')).toEqual(['bopen', 'text', 'bclose', 'text', 'amp', 'text'])
  })
})
