// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseLatex, setsNoType, spansSane, stitch } from './parse'
import type { LxBlock, LxInline } from './parse'

const parse = (src: string) => {
  const doc = parseLatex(src)
  // every parse must satisfy the span invariants — no exceptions
  expect(spansSane(doc), 'spans sane').toBe(true)
  expect(stitch(doc), 'stitch reproduces source').toBe(src)
  return doc
}

const body = (src: string): LxBlock[] =>
  parse(src).blocks.filter((b) => b.kind !== 'preamble' && b.kind !== 'postamble')

const DOC = (inner: string) =>
  `\\documentclass{article}\n\\title{T}\n\\begin{document}\n${inner}\n\\end{document}\n`

describe('parseLatex structure', () => {
  it('splits preamble / body / postamble', () => {
    const doc = parse(DOC('Hello.'))
    expect(doc.blocks[0].kind).toBe('preamble')
    expect(doc.blocks.at(-1)!.kind).toBe('postamble')
    const para = doc.blocks.find((b) => b.kind === 'para')!
    expect(para).toBeTruthy()
  })

  it('expands simple parameterless text macros in meta strings only', () => {
    const doc = parse('\\documentclass{article}\\newcommand{\\model}{LLaMA\\xspace}\\title{\\model: Open Models}\\begin{document}\\model{} in prose stays an island\\end{document}')
    const pre = doc.blocks[0] as Extract<LxBlock, { kind: 'preamble' }>
    expect(pre.meta.title).toBe('LLaMA: Open Models')
    // the BODY keeps its island — expansion is a display courtesy for the
    // derived header, not a macro processor
    const para = doc.blocks.find((b) => b.kind === 'para') as Extract<LxBlock, { kind: 'para' }>
    expect(para.inline.some((n) => n.kind === 'island')).toBe(true)
  })

  it('mines preamble metadata with balanced braces', () => {
    const doc = parse('\\documentclass[11pt]{article}\\title{On {Nested} Things}\\author{A \\and B}\\begin{document}x\\end{document}')
    const pre = doc.blocks[0] as Extract<LxBlock, { kind: 'preamble' }>
    expect(pre.meta.docclass).toBe('article')
    expect(pre.meta.title).toBe('On {Nested} Things')
    expect(pre.meta.author).toBe('A \\and B')
  })

  it('parses a fragment without \\documentclass as plain body', () => {
    const blocks = parse('Just a paragraph.').blocks
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe('para')
  })

  it('sections carry level, title inline, and a following label', () => {
    const [sec] = body(DOC('\\section{Intro}\\label{sec:intro}'))
    expect(sec).toMatchObject({ kind: 'section', level: 1, starred: false, label: 'sec:intro' })
  })

  it('starred sections', () => {
    const [sec] = body(DOC('\\section*{Ack}'))
    expect(sec).toMatchObject({ kind: 'section', starred: true })
  })

  it('paragraphs split on blank lines', () => {
    const blocks = body(DOC('One.\n\nTwo.'))
    expect(blocks.map((b) => b.kind)).toEqual(['para', 'para'])
  })

  it('lists: items at the right depth, nested lists inside items', () => {
    const [list] = body(DOC('\\begin{itemize}\\item a\\item b\n\\begin{itemize}\\item b1\\end{itemize}\\end{itemize}'))
    expect(list.kind).toBe('list')
    const l = list as Extract<LxBlock, { kind: 'list' }>
    expect(l.items).toHaveLength(2)
    expect(l.items[1].blocks.some((b) => b.kind === 'list')).toBe(true)
  })

  it('description items keep their terms', () => {
    const [list] = body(DOC('\\begin{description}\\item[alpha] first\\item[beta] second\\end{description}'))
    const l = list as Extract<LxBlock, { kind: 'list' }>
    expect(l.env).toBe('description')
    expect(l.items[0].term).toBeTruthy()
  })

  it('figure floats: caption, label, graphics', () => {
    const [fig] = body(DOC('\\begin{figure}[htbp]\\centering\\includegraphics[width=\\linewidth]{plot.pdf}\\caption{A plot}\\label{fig:p}\\end{figure}'))
    const f = fig as Extract<LxBlock, { kind: 'float' }>
    expect(f).toMatchObject({ kind: 'float', env: 'figure', label: 'fig:p' })
    expect(f.graphics[0].path).toBe('plot.pdf')
    expect(f.graphics[0].opts).toBe('width=\\linewidth')
    expect(f.caption).toBeTruthy()
  })

  it('table float with tabular body', () => {
    const [tbl] = body(DOC('\\begin{table}\\caption{C}\\begin{tabular}{lr}a & 1 \\\\ b & 2 \\\\\\end{tabular}\\end{table}'))
    const f = tbl as Extract<LxBlock, { kind: 'float' }>
    expect(f.env).toBe('table')
    const tab = f.body.find((b) => b.kind === 'tabular') as Extract<LxBlock, { kind: 'tabular' }>
    expect(tab.colspec).toBe('lr')
    expect(tab.rows).toHaveLength(2)
    expect(tab.rows[0]).toHaveLength(2)
  })

  it('tabular strips rule commands from cells', () => {
    const [tbl] = body(DOC('\\begin{tabular}{ll}\\toprule a & b \\\\ \\midrule c & d \\\\ \\bottomrule\\end{tabular}'))
    const t = tbl as Extract<LxBlock, { kind: 'tabular' }>
    expect(t.rows).toHaveLength(2)
  })

  it('tabular \\multicolumn and \\multirow become spanning cells', () => {
    const [tbl] = body(DOC('\\begin{tabular}{ll}\\multicolumn{2}{c}{x} \\\\ \\multirow{2}{*}{a} & b \\\\ & c\\end{tabular}'))
    expect(tbl.kind).toBe('tabular')
    const t = tbl as Extract<LxBlock, { kind: 'tabular' }>
    expect(t.rows[0][0].colspan).toBe(2)
    expect(t.rows[1][0].rowspan).toBe(2)
    expect(t.rows[2][0].inline).toHaveLength(0) // the covered placeholder
  })

  it('a spanning command with trailing content stays an ordinary cell', () => {
    const [tbl] = body(DOC('\\begin{tabular}{ll}\\multicolumn{2}{c}{x} extra & b\\end{tabular}'))
    expect(tbl.kind).toBe('tabular')
    const t = tbl as Extract<LxBlock, { kind: 'tabular' }>
    expect(t.rows[0][0].colspan).toBeUndefined()
  })

  it('expands *{n}{spec} and strips >{…} decorations in the colspec test', () => {
    const [tbl] = body(DOC('\\begin{tabular}{>{\\centering}l*{3}{c}}a & b & c & d\\end{tabular}'))
    expect(tbl.kind).toBe('tabular')
  })

  it('display math: \\[..\\], $$..$$, and environments with labels', () => {
    const blocks = body(DOC('\\[x^2\\]\n\n$$y^2$$\n\n\\begin{equation}\\label{eq:z}z^2\\end{equation}'))
    expect(blocks.map((b) => b.kind)).toEqual(['math', 'math', 'math'])
    expect((blocks[0] as Extract<LxBlock, { kind: 'math' }>).tex).toBe('x^2')
    expect((blocks[2] as Extract<LxBlock, { kind: 'math' }>).env).toBe('equation')
    expect((blocks[2] as Extract<LxBlock, { kind: 'math' }>).label).toBe('eq:z')
  })

  it('verbatim environments become faithful verbatim blocks', () => {
    const [v] = body(DOC('\\begin{verbatim}\nx = 1 % kept\n\\end{verbatim}'))
    expect(v).toMatchObject({ kind: 'verbatim', text: 'x = 1 % kept' })
  })

  it('lstlisting options are stripped from the body', () => {
    const [v] = body(DOC('\\begin{lstlisting}[language=C]\nint x;\n\\end{lstlisting}'))
    expect(v).toMatchObject({ kind: 'verbatim', text: 'int x;' })
  })

  it('unknown environments island whole, nested same-name counted', () => {
    const [isl] = body(DOC('\\begin{tikzpicture}\\begin{tikzpicture}\\end{tikzpicture}\\draw;\\end{tikzpicture}'))
    expect(isl.kind).toBe('island')
    expect(parse(DOC('\\begin{tikzpicture}\\draw;\\end{tikzpicture}')).src).toContain('draw')
  })

  it('unclosed environments island to the end of the region', () => {
    const blocks = body(DOC('before\n\n\\begin{tikzpicture}\\draw;'))
    expect(blocks.at(-1)!.kind).toBe('island')
  })

  it('wrapper environments keep their interiors first-class', () => {
    const [w] = body(DOC('\\begin{center}\\begin{tabular}{l}a\\end{tabular}\\end{center}'))
    expect(w).toMatchObject({ kind: 'wrapper', env: 'center' })
    expect((w as Extract<LxBlock, { kind: 'wrapper' }>).body[0].kind).toBe('tabular')
  })

  it('multicols swallows its column-count argument, framed takes none', () => {
    const [w] = body(DOC('\\begin{multicols}{2}text here\\end{multicols}'))
    const inner = (w as Extract<LxBlock, { kind: 'wrapper' }>).body
    expect(inner[0].kind).toBe('para')
    const [f] = body(DOC('\\begin{framed}{\\bf boxed} text\\end{framed}'))
    const fp = (f as Extract<LxBlock, { kind: 'wrapper' }>).body[0] as Extract<LxBlock, { kind: 'para' }>
    expect(fp.inline[0]).toMatchObject({ kind: 'style', cmd: 'bf' })
  })

  it('abstract becomes a first-class block', () => {
    const [a] = body(DOC('\\begin{abstract}We study things.\\end{abstract}'))
    expect(a.kind).toBe('abstract')
    expect((a as Extract<LxBlock, { kind: 'abstract' }>).body[0].kind).toBe('para')
  })

  it('wrapfigure parses as a figure float', () => {
    const [f] = body(DOC('\\begin{wrapfigure}{r}{0.4\\textwidth}\\includegraphics{x.png}\\caption{W}\\end{wrapfigure}'))
    expect(f).toMatchObject({ kind: 'float', env: 'figure' })
    expect((f as Extract<LxBlock, { kind: 'float' }>).graphics[0].path).toBe('x.png')
  })
})

describe('parseLatex inline', () => {
  const inlineOf = (src: string): LxInline[] => {
    const [p] = body(DOC(src))
    expect(p.kind).toBe('para')
    return (p as Extract<LxBlock, { kind: 'para' }>).inline
  }

  it('styles, nested', () => {
    const inline = inlineOf('\\textbf{bold \\emph{both}} plain')
    expect(inline[0]).toMatchObject({ kind: 'style', cmd: 'bf' })
    const inner = (inline[0] as Extract<LxInline, { kind: 'style' }>).inner
    expect(inner.some((n) => n.kind === 'style' && n.cmd === 'em')).toBe(true)
  })

  it('old-style {\\bf …} declaration groups', () => {
    const inline = inlineOf('{\\bf heavy} text')
    expect(inline[0]).toMatchObject({ kind: 'style', cmd: 'bf' })
  })

  it('inline math via $…$ and \\(…\\)', () => {
    const inline = inlineOf('a $x+y$ b \\(z\\) c')
    const math = inline.filter((n) => n.kind === 'math')
    expect(math.map((m) => (m as Extract<LxInline, { kind: 'math' }>).tex)).toEqual(['x+y', 'z'])
  })

  it('two-optional-arg cites parse (\\citep[pre][post]{…}), not island', () => {
    const inline = inlineOf('as shown \\citep[][\\textit{inter alia}]{smith20} here')
    const cite = inline.find((n) => n.kind === 'cite') as Extract<LxInline, { kind: 'cite' }>
    expect(cite).toBeTruthy()
    expect(cite.keys).toEqual(['smith20'])
    expect(cite.pre).toBe('')
    expect(cite.opt).toBe('\\textit{inter alia}')
  })

  it('refs, cites with options, labels', () => {
    const inline = inlineOf('see \\ref{sec:a}, \\cite[p.~3]{knuth84,lamport94} \\label{here}')
    expect(inline.find((n) => n.kind === 'ref')).toMatchObject({ key: 'sec:a' })
    const cite = inline.find((n) => n.kind === 'cite') as Extract<LxInline, { kind: 'cite' }>
    expect(cite.keys).toEqual(['knuth84', 'lamport94'])
    expect(cite.opt).toBe('p.~3')
    expect(inline.find((n) => n.kind === 'label')).toMatchObject({ key: 'here' })
  })

  it('footnotes recurse', () => {
    const inline = inlineOf('claim\\footnote{with \\emph{style}}')
    const fn = inline.find((n) => n.kind === 'footnote') as Extract<LxInline, { kind: 'footnote' }>
    expect(fn.inner.some((n) => n.kind === 'style')).toBe(true)
  })

  it('\\url and \\href', () => {
    const inline = inlineOf('\\url{https://x.test} and \\href{https://y.test}{y}')
    const urls = inline.filter((n) => n.kind === 'url') as Extract<LxInline, { kind: 'url' }>[]
    expect(urls[0].url).toBe('https://x.test')
    expect(urls[1].url).toBe('https://y.test')
    expect(urls[1].inner).toBeTruthy()
  })

  it('character escapes decode; stray brackets stay literal', () => {
    const inline = inlineOf('50\\% of [maybe] \\&co')
    const text = inline.filter((n) => n.kind === 'text').map((n) => (n as Extract<LxInline, { kind: 'text' }>).text).join('')
    expect(text).toContain('%')
    expect(text).toContain('[maybe]')
    expect(text).toContain('&co')
  })

  it('unknown commands island with their arguments consumed greedily', () => {
    const inline = inlineOf('a \\textcolor{red}{warm} b')
    const isl = inline.find((n) => n.kind === 'island')!
    const src = parse(DOC('a \\textcolor{red}{warm} b')).src
    expect(src.slice(isl.span.start, isl.span.end)).toBe('\\textcolor{red}{warm}')
  })

  it('\\verb inline becomes code with the exact body', () => {
    const inline = inlineOf('run \\verb|x & y| now')
    expect(inline.find((n) => n.kind === 'verb')).toMatchObject({ text: 'x & y' })
  })

  it('unclosed inline math islands to the end of the paragraph, not beyond', () => {
    const blocks = body(DOC('broken $x\n\nnext para'))
    expect(blocks).toHaveLength(2)
    expect((blocks[0] as Extract<LxBlock, { kind: 'para' }>).inline.some((n) => n.kind === 'island')).toBe(true)
    expect(blocks[1].kind).toBe('para')
  })
})

describe('adversarial spans', () => {
  it('never throws and always stitches on hostile fragments', () => {
    const nasty = [
      '}{',
      '\\end{itemize}',
      '\\begin{itemize}',
      '$$',
      '$',
      '\\',
      '\\verb',
      '{\\bf',
      '\\section',
      '\\item[unclosed',
      'a & b \\\\ c',
      '% only a comment',
      '\\begin{a}\\begin{b}\\end{a}\\end{b}',
    ]
    for (const src of nasty) {
      const doc = parseLatex(src)
      expect(spansSane(doc), JSON.stringify(src)).toBe(true)
      expect(stitch(doc), JSON.stringify(src)).toBe(src)
    }
  })
})

describe('setsNoType', () => {
  it('recognizes pure setup and layout runs', () => {
    expect(setsNoType('\\clearpage')).toBe(true)
    expect(setsNoType('\\newpage\n\\pgfplotsset{compat=1.11, /pgfplots/ybar legend/.style={ legend image code/.code={% comment\n\\draw[##1] (0cm,0cm) rectangle (7pt,0.8em);}, }, }')).toBe(true)
    expect(setsNoType('\\clearpage \\appendix \\renewcommand{\\thesection}{A\\arabic{section}} \\setcounter{section}{0}')).toBe(true)
    expect(setsNoType('\\thispagestyle{empty}')).toBe(true)
  })
  it('never hides visible content', () => {
    expect(setsNoType('\\clearpage Some words follow.')).toBe(false)
    expect(setsNoType('Prose only.')).toBe(false)
    expect(setsNoType('\\section{MMLU}')).toBe(false)
    expect(setsNoType('\\draw (0,0) -- (1,1);')).toBe(false)
    expect(setsNoType('\\bibliography{custom}')).toBe(false)
    expect(setsNoType('\\%')).toBe(false)
  })
})

describe('setsNoType assignments', () => {
  it('consumes TeX parameter assignments', () => {
    expect(setsNoType('\\looseness=-1')).toBe(true)
    expect(setsNoType('\\looseness=-1 \\tolerance 2000')).toBe(true)
    expect(setsNoType('\\looseness=-1 But words remain.')).toBe(false)
  })
})

describe('expanded environments', () => {
  const DOC2 = (body: string) => `\\documentclass{article}\\begin{document}\n${body}\n\\end{document}\n`
  const bodyOf = (tex: string) => parseLatex(tex).blocks.filter((b) => b.kind !== 'preamble' && b.kind !== 'postamble')

  it('minipage and tcolorbox are wrappers, their interiors first-class', () => {
    const [box] = bodyOf(DOC2('\\begin{minipage}[t]{0.5\\textwidth}\nInner prose.\n\\end{minipage}'))
    expect(box.kind).toBe('wrapper')
    const w = box as Extract<LxBlock, { kind: 'wrapper' }>
    expect(w.env).toBe('minipage')
    expect(w.body[0]?.kind).toBe('para')
    const [tcb] = bodyOf(DOC2('\\begin{tcolorbox}[title=Note]\nBoxed prose.\n\\end{tcolorbox}'))
    expect(tcb.kind).toBe('wrapper')
  })

  it('theorem-like environments are wrappers keeping their names', () => {
    const [prop] = bodyOf(DOC2('\\begin{proposition}[Main]\nAll models are wrong.\n\\end{proposition}'))
    expect(prop.kind).toBe('wrapper')
    expect((prop as Extract<LxBlock, { kind: 'wrapper' }>).env).toBe('proposition')
  })

  it('packed list aliases parse as lists and remember their source env', () => {
    const [list] = bodyOf(DOC2('\\begin{itemizepacked}\n\\item one\n\\item two\n\\end{itemizepacked}'))
    expect(list.kind).toBe('list')
    const l = list as Extract<LxBlock, { kind: 'list' }>
    expect(l.env).toBe('itemize')
    expect(l.srcEnv).toBe('itemizepacked')
  })

  it('symbol commands become their characters', () => {
    const [p] = bodyOf(DOC2('See \\S3 and more\\dots{} end.'))
    expect(p.kind).toBe('para')
    const text = (p as Extract<LxBlock, { kind: 'para' }>).inline
      .map((n) => (n.kind === 'text' ? n.text : '')).join('')
    expect(text).toContain('§')
    expect(text).toContain('…')
  })

  it('\\textsf parses as a style', () => {
    const [p] = bodyOf(DOC2('Uses \\textsf{ambit} throughout.'))
    const styled = (p as Extract<LxBlock, { kind: 'para' }>).inline.find((n) => n.kind === 'style')
    expect(styled && (styled as Extract<LxInline, { kind: 'style' }>).cmd).toBe('sf')
  })
})
