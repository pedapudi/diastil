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

describe('beamer overlay specifications', () => {
  it('gets its own token after the commands and environments that take one', () => {
    expect(kinds('\\item<1-> a')).toEqual(['cs', 'overlay', 'text'])
    expect(kinds('\\onslide<4->{x}')).toEqual(['cs', 'overlay', 'open', 'text', 'close'])
    expect(kinds('\\textbf<2>{x}')).toEqual(['cs', 'overlay', 'open', 'text', 'close'])
    expect(kinds('\\begin{frame}<3->{T}')).toEqual(['envbegin', 'overlay', 'open', 'text', 'close'])
    expect(kinds('\\begin{itemize}<+->')).toEqual(['envbegin', 'overlay'])
    expect(texts('\\item<beamer:1-|handout:0> a')[1]).toBe('<beamer:1-|handout:0>')
  })

  it('leaves `<` alone everywhere a document may legitimately write one', () => {
    const ordinary = [
      // math: `<` is a relation, and \textless exists for the text case
      '$a < b$', '$a<b$', '\\alpha<\\beta', 'x \\le y < z',
      // prose and code that happens to hold angle brackets
      'the <title> element', 'Vec<String, u32>', '</head>',
      // right command, wrong shape: a bare word is not a spec
      '\\item<title> a', '\\item<> a', '\\emph<see appendix>{x}',
      // right shape, wrong position: a space breaks the attachment, and
      // \section is not an overlay-taking command
      '\\item <1-> a', '\\section<1->{x}', 'plain <1-> text',
      // a spec never crosses a brace, a backslash or a line
      '\\item<1\\to2> a', '\\item<1-\n2> a',
    ]
    for (const src of ordinary) {
      expect(kinds(src), JSON.stringify(src)).not.toContain('overlay')
      expect(tilesExactly(lex(src), src), JSON.stringify(src)).toBe(true)
    }
  })

  it('still tiles exactly with specs in play', () => {
    const src = '\\begin{frame}<2->{T}\n\\begin{itemize}<+->\n\\item<1-> a $x<y$\n\\end{itemize}\n\\end{frame}'
    expect(tilesExactly(lex(src), src)).toBe(true)
  })
})
