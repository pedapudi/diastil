// @vitest-environment node
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
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

  describe('reference naming mined from the preamble', () => {
    const metaOf = (preamble: string) => {
      const doc = parse(`\\documentclass{article}\n${preamble}\n\\begin{document}\nx\n\\end{document}\n`)
      return (doc.blocks[0] as Extract<LxBlock, { kind: 'preamble' }>).meta
    }

    it('a document that renames nothing carries none of the keys', () => {
      const meta = metaOf('\\title{T}')
      expect(meta.crefNames).toBeUndefined()
      expect(meta.refNames).toBeUndefined()
      expect(meta.language).toBeUndefined()
    })

    it('\\crefname and \\Crefname write into one record per type', () => {
      const meta = metaOf('\\crefname{figure}{fig.}{figs.}\n\\Crefname{figure}{Fig.}{Figs.}\n\\crefname{equation}{eq.}{eqs.}')
      expect(meta.crefNames).toEqual({
        figure: { sg: 'fig.', pl: 'figs.', Sg: 'Fig.', Pl: 'Figs.' },
        equation: { sg: 'eq.', pl: 'eqs.' },
      })
    })

    it('a \\crefname parked behind a comment is not mined', () => {
      expect(metaOf('% \\crefname{figure}{fig.}{figs.}').crefNames).toBeUndefined()
    })

    it('\\<type>autorefname is keyed by TYPE, in every \\newcommand spelling', () => {
      const meta = metaOf('\\renewcommand{\\figureautorefname}{Fig.}\n\\newcommand\\tableautorefname{Tbl.}\n\\providecommand{\\sectionautorefname}{§}')
      expect(meta.refNames).toEqual({ figure: 'Fig.', table: 'Tbl.', section: '§' })
    })

    it('babel: main= wins, else the last option that is not a setting', () => {
      expect(metaOf('\\usepackage[english,ngerman]{babel}').language).toBe('ngerman')
      expect(metaOf('\\usepackage[main=english,french]{babel}').language).toBe('english')
      expect(metaOf('\\usepackage[french,shorthands=off]{babel}').language).toBe('french')
      expect(metaOf('\\usepackage{babel}').language).toBeUndefined()
    })

    it('polyglossia states the main language outright', () => {
      expect(metaOf('\\usepackage{polyglossia}\n\\setmainlanguage[variant=british]{english}').language).toBe('english')
    })
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
    expect(tab.rows[0].cells).toHaveLength(2)
  })

  it('loose prose inside a float parses as body, so it can be seen and edited', () => {
    const [fig] = body(DOC('\\begin{figure}\n\\centering\n\\includegraphics{fig.png}\nA descriptive note that lives inside the float.\n\\caption{The caption.}\n\\label{fig:x}\n\\end{figure}'))
    const f = fig as Extract<LxBlock, { kind: 'float' }>
    expect(f.graphics[0].path).toBe('fig.png')
    const para = f.body.find((b) => b.kind === 'para') as Extract<LxBlock, { kind: 'para' }>
    expect(para, 'the note is a body paragraph').toBeTruthy()
    // the span covers the prose and NOTHING around it: not the graphic
    // before it, not the \caption after it (the surrounding whitespace rides
    // along exactly as a top-level paragraph's does — emission re-seats it)
    const text = DOC('\\begin{figure}\n\\centering\n\\includegraphics{fig.png}\nA descriptive note that lives inside the float.\n\\caption{The caption.}\n\\label{fig:x}\n\\end{figure}')
    const slice = text.slice(para.span.start, para.span.end)
    expect(slice.trim()).toBe('A descriptive note that lives inside the float.')
    expect(slice).not.toContain('\\includegraphics')
    expect(slice).not.toContain('\\caption')
  })

  it('float furniture stays out of the body — only prose-bearing runs become blocks', () => {
    // \centering, sizing declarations and comments are not float-level
    // prose: parsing them as paragraphs would island their command bytes
    // back onto the surface as visible junk
    const [fig] = body(DOC('\\begin{figure}\n\\centering\n\\small\n% a comment\n\\includegraphics{a.png}\n\\caption{C}\n\\end{figure}'))
    const f = fig as Extract<LxBlock, { kind: 'float' }>
    expect(f.body).toHaveLength(0)
  })

  it('a \\subfloat panel is a nested float carrying its bracket sub-caption', () => {
    // the sub-caption is real prose the reader must see, and it belongs to
    // the panel, not to the outer figure — which is also what keeps the
    // furniture around it (\centering, \small) out of the body
    const [fig] = body(DOC('\\begin{figure}\n\\centering\n\\small\n% a comment\n\\subfloat[Left panel]{\\includegraphics{a.png}}\n\\caption{C}\n\\end{figure}'))
    const f = fig as Extract<LxBlock, { kind: 'float' }>
    expect(f.body.map((b) => b.kind)).toEqual(['float'])
    const sub = f.body[0] as Extract<LxBlock, { kind: 'float' }>
    expect(sub.graphics.map((g) => g.path)).toEqual(['a.png'])
    expect(sub.caption!.map((n) => (n.kind === 'text' ? n.text : '')).join('')).toBe('Left panel')
    // the outer caption is still the outer one — never the panel's
    expect(f.caption!.map((n) => (n.kind === 'text' ? n.text : '')).join('')).toBe('C')
  })

  it('float body prose keeps its inline structure', () => {
    const [fig] = body(DOC('\\begin{figure}\n\\includegraphics{f.png}\nNote with \\textbf{bold} and \\ref{tab:x}.\n\\caption{C}\n\\end{figure}'))
    const f = fig as Extract<LxBlock, { kind: 'float' }>
    const para = f.body.find((b) => b.kind === 'para') as Extract<LxBlock, { kind: 'para' }>
    expect(para.inline.some((n) => n.kind === 'style')).toBe(true)
    expect(para.inline.some((n) => n.kind === 'ref')).toBe(true)
  })

  it('tabular strips rule commands from cells and keeps them on the row', () => {
    const [tbl] = body(DOC('\\begin{tabular}{ll}\\toprule a & b \\\\ \\midrule c & d \\\\ \\bottomrule\\end{tabular}'))
    const t = tbl as Extract<LxBlock, { kind: 'tabular' }>
    expect(t.rows).toHaveLength(2)
    expect(t.rows[0].rule).toBe('\\toprule')
    expect(t.rows[1].rule).toBe('\\midrule')
    expect(t.trailingRule).toBe('\\bottomrule')
  })

  it('a chained run of \\cmidrule(lr){…} rides the row verbatim', () => {
    const [tbl] = body(DOC('\\begin{tabular}{llll}a & b & c & d \\\\ \\cmidrule(lr){2-2} \\cmidrule(lr){3-4} e & f & g & h\\end{tabular}'))
    const t = tbl as Extract<LxBlock, { kind: 'tabular' }>
    expect(t.rows[1].rule).toBe('\\cmidrule(lr){2-2} \\cmidrule(lr){3-4}')
  })

  it('tabular \\multicolumn and \\multirow become spanning cells with their spec/width', () => {
    const [tbl] = body(DOC('\\begin{tabular}{ll}\\multicolumn{2}{c}{x} \\\\ \\multirow{2}{*}{a} & b \\\\ & c\\end{tabular}'))
    expect(tbl.kind).toBe('tabular')
    const t = tbl as Extract<LxBlock, { kind: 'tabular' }>
    expect(t.rows[0].cells[0].colspan).toBe(2)
    expect(t.rows[0].cells[0].colspanSpec).toBe('c')
    expect(t.rows[1].cells[0].rowspan).toBe(2)
    expect(t.rows[1].cells[0].rowspanWidth).toBe('*')
    expect(t.rows[2].cells[0].inline).toHaveLength(0) // the covered placeholder
  })

  it('a spanning command with trailing content stays an ordinary cell', () => {
    const [tbl] = body(DOC('\\begin{tabular}{ll}\\multicolumn{2}{c}{x} extra & b\\end{tabular}'))
    expect(tbl.kind).toBe('tabular')
    const t = tbl as Extract<LxBlock, { kind: 'tabular' }>
    expect(t.rows[0].cells[0].colspan).toBeUndefined()
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

  describe('\\frame — optional title argument (issue #20)', () => {
    // returns the frame's body blocks AND the full doc source, so a test
    // can check for bytes by SPAN (inline 'island' nodes carry no text,
    // only a span into the source) rather than by re-serializing
    const frameBody = (src: string) => {
      const full = DOC(src)
      const [w] = body(full)
      expect(w).toMatchObject({ kind: 'wrapper', env: 'frame' })
      return { inner: (w as Extract<LxBlock, { kind: 'wrapper' }>).body, full }
    }
    const bodyText = (inner: LxBlock[], full: string) =>
      inner.map((b) => full.slice(b.span.start, b.span.end)).join('')

    it('a same-line title is consumed as the frame argument, not body', () => {
      const { inner } = frameBody('\\begin{frame}{Outline}\\tableofcontents\\end{frame}')
      expect(inner.every((b) => b.kind !== 'island')).toBe(true)
      expect(inner.some((b) => b.kind === 'para')).toBe(true)
    })

    it('[fragile]{Title} — the bracket arg and the title both scan', () => {
      const { inner } = frameBody('\\begin{frame}[fragile]{Block Size}\\tableofcontents\\end{frame}')
      expect(inner.some((b) => b.kind === 'para')).toBe(true)
    })

    it('THE HAZARD: a titleless frame opening with a bare group keeps that group as body content', () => {
      // the idiom the issue names: no title, the body's first thing is a
      // bare {...} group on its own line. A wrongly-consumed "title" here
      // would delete \centering\includegraphics from the tree entirely.
      const { inner, full } = frameBody(
        '\\begin{frame}\n  {\\centering\\includegraphics{fig.png}}\n\\end{frame}',
      )
      expect(bodyText(inner, full)).toContain('fig.png')
    })

    it('a bare group on the SAME line as \\begin{frame} is still refused: it opens with a layout declaration', () => {
      // \centering is never how a real title begins — rule 2 refuses this
      // even though rule 1 (same line) would otherwise allow it
      const { inner, full } = frameBody('\\begin{frame}{\\centering\\includegraphics{fig.png}}\\end{frame}')
      expect(bodyText(inner, full)).toContain('fig.png')
    })

    it('a group spanning a blank line is refused even on the same opening line', () => {
      const { inner, full } = frameBody('\\begin{frame}{Title\n\n  more}\\tableofcontents\\end{frame}')
      expect(bodyText(inner, full)).toContain('Title')
    })

    it('a titleless frame with no leading group at all parses cleanly', () => {
      const { inner } = frameBody('\\begin{frame}\n  \\titlepage\n\\end{frame}')
      expect(inner.length).toBeGreaterThan(0)
    })

    it('a text-macro title (\\model{} in One Slide) is consumed — not a layout declaration', () => {
      const { inner, full } = frameBody('\\begin{frame}{\\model{} in One Slide}\\tableofcontents\\end{frame}')
      expect(inner.some((b) => b.kind === 'para')).toBe(true)
      // the title bytes are NOT re-emitted as a body paragraph
      expect(bodyText(inner, full)).not.toContain('One Slide')
    })

    it('a consumed title is CARRIED on the wrapper, never silently dropped', () => {
      const [w] = body(DOC('\\begin{frame}{Outline}\\tableofcontents\\end{frame}'))
      const title = (w as Extract<LxBlock, { kind: 'wrapper' }>).title!
      expect(title.map((n) => (n.kind === 'text' ? n.text : '')).join('')).toBe('Outline')
    })

    it('an empty title argument is no title', () => {
      const [w] = body(DOC('\\begin{frame}{}\\titlepage\\end{frame}'))
      expect((w as Extract<LxBlock, { kind: 'wrapper' }>).title).toBeUndefined()
    })
  })

  describe('beamer columns and the block family', () => {
    // measured 2026-08-09: islanded whole, these three were 0.361 of
    // beamer.tex's 0.375 raw-tex ratio, and they hold the deck's prose
    const wrap = (src: string) => {
      const [w] = body(DOC(src))
      expect(w.kind).toBe('wrapper')
      return w as Extract<LxBlock, { kind: 'wrapper' }>
    }

    it('columns nests column wrappers, each swallowing its width', () => {
      const w = wrap('\\begin{columns}\n\\begin{column}{0.5\\textwidth}\nLeft prose.\n\\end{column}\n'
        + '\\begin{column}{0.5\\textwidth}\nRight prose.\n\\end{column}\n\\end{columns}')
      expect(w.env).toBe('columns')
      expect(w.body.map((b) => b.kind)).toEqual(['wrapper', 'wrapper'])
      const left = w.body[0] as Extract<LxBlock, { kind: 'wrapper' }>
      expect(left.env).toBe('column')
      // the WIDTH is an argument, not a heading — and not body prose either
      expect(left.title).toBeUndefined()
      expect(left.body.map((b) => b.kind)).toEqual(['para'])
    })

    it('block and alertblock take a title and keep their prose as blocks', () => {
      for (const env of ['block', 'alertblock', 'exampleblock']) {
        const w = wrap(`\\begin{${env}}{This talk}\nA training recipe that induces \\emph{block} sparsity.\n\\end{${env}}`)
        expect(w.env).toBe(env)
        expect(w.title!.map((n) => (n.kind === 'text' ? n.text : '')).join('')).toBe('This talk')
        const para = w.body[0] as Extract<LxBlock, { kind: 'para' }>
        expect(para.kind).toBe('para')
        expect(para.inline.some((n) => n.kind === 'style')).toBe(true)
      }
    })

    it('a block title on the line BELOW \\begin stays prose rather than vanishing', () => {
      // beamer calls the title required; reading it as required would let a
      // group anywhere below the begin line be deleted from the tree
      const w = wrap('\\begin{block}\n{Not really a title}\nBody.\n\\end{block}')
      expect(w.title).toBeUndefined()
      expect(w.body.map((b) => b.kind)).toContain('para')
    })
  })

  describe('float body groups — content behind a brace (issue #21)', () => {
    const float = (src: string) => {
      const [f] = body(DOC(src))
      expect(f.kind).toBe('float')
      return f as Extract<LxBlock, { kind: 'float' }>
    }
    const TAB = '\\begin{tabular}{lr}a & 1 \\\\\\end{tabular}'

    it('a bare {…} group holding a tabular becomes float body', () => {
      // llama.tex's idiom: \setlength then a bare group around the table.
      // Skipped wholesale, the float rendered as a caption and nothing else.
      const f = float(`\\begin{table}[h]\n\\centering\n\\setlength{\\tabcolsep}{4pt}\n{\n${TAB}\n}\n\\caption{C}\n\\end{table}`)
      expect(f.body.map((b) => b.kind)).toEqual(['tabular'])
      expect(f.caption).toBeTruthy()
    })

    it('a group opening with a declaration still yields its tabular', () => {
      // palm.tex: {\renewcommand{\arraystretch}{1.25} \begin{tabular}…}
      const f = float(`\\begin{table}\n{\\renewcommand{\\arraystretch}{1.25}\n${TAB}}\n\\caption{C}\n\\end{table}`)
      expect(f.body.map((b) => b.kind)).toEqual(['tabular'])
    })

    it('\\resizebox: only the LAST argument is content, never the dimensions', () => {
      const f = float(`\\begin{table}\n\\caption{C}\n\\resizebox{\\textwidth}{!}{%\n${TAB}\n}\n\\end{table}`)
      expect(f.body.map((b) => b.kind)).toEqual(['tabular'])
      // the width/height groups produced no block of their own
      expect(f.body).toHaveLength(1)
    })

    it('\\scalebox: the factor is not body either', () => {
      const f = float(`\\begin{table*}\n\\scalebox{0.72}{\n${TAB}}\n\\caption{C}\n\\end{table*}`)
      expect(f.body.map((b) => b.kind)).toEqual(['tabular'])
    })

    it('a nested \\caption is NEVER hoisted onto the outer float', () => {
      // THE HAZARD: a sub-float's own caption must not become the float's.
      // The outer caption is the one at float level; the inner one stays
      // where it was written (invisible, as before — never misattributed).
      const f = float(`\\begin{figure}\n{\\begin{tabular}{l}x \\\\\\end{tabular}\\caption{Inner}}\n\\caption{Outer}\n\\end{figure}`)
      expect(f.caption).toBeTruthy()
      expect(f.caption!.map((n) => (n.kind === 'text' ? n.text : '')).join('')).toContain('Outer')
    })

    it('a group with no environment or graphic in it is left alone', () => {
      // an OPTIONS group (pgfplots keys, a \renewcommand run) reads exactly
      // like a content group to a brace scanner; only positive evidence —
      // a \begin{…} or an \includegraphics — earns the descent
      const f = float('\\begin{figure}\n{\\footnotesize\\renewcommand{\\arraystretch}{1.2}}\n\\caption{C}\n\\end{figure}')
      expect(f.body).toHaveLength(0)
    })

    it('\\subfigure[]{…}: the image is found, and an EMPTY bracket is no caption', () => {
      // palm.tex's own idiom — `\subfigure[]{…}` declares no sub-caption at
      // all, so the panel must not sprout an empty figcaption
      const f = float('\\begin{figure}[t]\n\\subfigure[]{\n\\centering\n\\includegraphics[width=0.48\\linewidth]{a.pdf}\n}\n\\caption{C}\n\\end{figure}')
      const sub = f.body[0] as Extract<LxBlock, { kind: 'float' }>
      expect(sub.kind).toBe('float')
      expect(sub.graphics.map((g) => g.path)).toEqual(['a.pdf'])
      expect(sub.caption).toBeUndefined()
    })

    it('a bare float used as a page-break hack still shows its \\section', () => {
      // llama.tex: `\begin{figure*}\section{MMLU}\end{figure*}`. The heading
      // is real content at float level; runBearsProse cannot see it, because
      // its prose lives inside the title group.
      const f = float('\\begin{figure*}\n\\section{MMLU}\n\\end{figure*}')
      expect(f.body.map((b) => b.kind)).toEqual(['section'])
      const sec = f.body[0] as Extract<LxBlock, { kind: 'section' }>
      expect(sec.inline.map((n) => (n.kind === 'text' ? n.text : '')).join('')).toBe('MMLU')
    })

    it('a \\section inside a float takes the \\label that follows it', () => {
      // \label after \section binds to the SECTION counter, not the float's
      const f = float('\\begin{figure*}\n\\section{Generations}\n\\label{sec:prompt}\nSome prose.\n\\end{figure*}')
      const sec = f.body[0] as Extract<LxBlock, { kind: 'section' }>
      expect(sec.label).toBe('sec:prompt')
      expect(f.label).toBeUndefined()
      expect(f.body.map((b) => b.kind)).toEqual(['section', 'para'])
    })

    it('an unrecognized environment behind a brace islands honestly rather than vanishing', () => {
      // llama.tex figure: { \tt \tiny \begin{tabularx}… }. tabularx is not
      // in the vocabulary, so the descent yields an island carrying the real
      // source — the compiled mirror shows it typeset either way
      const f = float('\\begin{figure}[h]\n{ \\tt \\tiny\n\\begin{tabularx}{\\linewidth}{rX}a & b \\\\\\end{tabularx}}\n\\caption{C}\n\\end{figure}')
      expect(f.body.map((b) => b.kind)).toEqual(['island'])
    })
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
    expect(inline.find((n) => n.kind === 'ref')).toMatchObject({ keys: ['sec:a'] })
    // a ref's node is plural because cleveref's argument is a LIST
    expect(inlineOf('\\cref{fig:a, fig:b,fig:c}').find((n) => n.kind === 'ref'))
      .toMatchObject({ cmd: 'cref', keys: ['fig:a', 'fig:b', 'fig:c'] })
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

describe('overlay specifications attach to the construct they modify', () => {
  const slice = (src: string, s: { start: number; end: number } | undefined) =>
    s === undefined ? undefined : src.slice(s.start, s.end)

  it('an \\item keeps its spec and its bracket, in beamer\'s own order', () => {
    const src = DOC('\\begin{itemize}\\item<1-> a\\item<2->[$\\to$] b\\end{itemize}')
    const [list] = body(src)
    const l = list as Extract<LxBlock, { kind: 'list' }>
    expect(l.items.map((i) => slice(src, i.overlay))).toEqual(['<1->', '<2->'])
    // the spec is gone from the prose it used to sit in front of
    const first = l.items[0].blocks[0] as Extract<LxBlock, { kind: 'para' }>
    expect(first.inline.map((n) => (n.kind === 'text' ? n.text : n.kind)).join('')).toBe(' a')
    expect(l.items[1].term).toBeTruthy()
  })

  it('an environment keeps the spec on its \\begin tag, title and all', () => {
    const src = DOC('\\begin{frame}<3->{Slide Title}\nProse.\n\\end{frame}')
    const [wrap] = body(src)
    const w = wrap as Extract<LxBlock, { kind: 'wrapper' }>
    expect(slice(src, w.overlay)).toBe('<3->')
    // the title is still found: the spec used to stop the brace matcher dead
    expect(w.title).toBeTruthy()
  })

  it('a style command keeps its own spec', () => {
    const src = DOC('Reveal \\textbf<2>{this} later.')
    const [para] = body(src)
    const p = para as Extract<LxBlock, { kind: 'para' }>
    const style = p.inline.find((n) => n.kind === 'style') as Extract<LxInline, { kind: 'style' }>
    expect(slice(src, style.overlay)).toBe('<2>')
    expect(p.inline.some((n) => n.kind === 'text' && n.text.includes('<2>'))).toBe(false)
  })

  it('an unknown overlay command islands WITH its spec and stops there', () => {
    // \only<2>{…} puts CONTENT in that group — swallowing it into the island
    // would paint a slide's prose as raw mono
    const src = DOC('\\only<2>{real prose here}')
    const [para] = body(src)
    const p = para as Extract<LxBlock, { kind: 'para' }>
    const island = p.inline.find((n) => n.kind === 'island')!
    expect(slice(src, island.span)).toBe('\\only<2>')
    expect(p.inline.some((n) => n.kind === 'text' && n.text.includes('real prose here'))).toBe(true)
  })

  it('a spec no construct claimed stays literal text, spanning its own bytes', () => {
    // a fuzz slice that cut the \begin away, or an environment we island
    const src = DOC('\\begin{onlyenv}<2>\nx\n\\end{onlyenv}')
    const [island] = body(src)
    expect(island.kind).toBe('island')
    expect(slice(src, island.span)).toContain('<2>')
  })

  it('every cut of an overlay-heavy source still stitches back', () => {
    // the corpus fuzz samples 25 random slices per fixture; this one is
    // exhaustive over a source built to land a cut INSIDE every spec, which
    // is where a lexer that guessed at `<` would lose or duplicate bytes
    const src = '\\begin{frame}<2->{T}\n\\begin{itemize}<+->\n\\item<1-> a $x<y$ \\textbf<3>{b}\n\\end{itemize}\n\\onslide<4->{c}\n\\end{frame}\n'
    for (let a = 0; a <= src.length; a++) {
      for (let b = a; b <= src.length; b++) {
        const cut = src.slice(a, b)
        const doc = parseLatex(cut)
        expect(spansSane(doc), `[${a},${b})`).toBe(true)
        expect(stitch(doc) === cut, `[${a},${b}) stitches`).toBe(true)
      }
    }
  })

  it('\\onslide is furniture, spec included — it inks nothing', () => {
    expect(setsNoType('\\onslide<4->')).toBe(true)
    expect(setsNoType('\\pause<3>')).toBe(true)
    // and the rule is confined to switches: a real command stays visible
    expect(setsNoType('\\alert<2>')).toBe(false)
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

/* A float that shows a caption and NOTHING ELSE is the shape that makes an
 * import look broken, so it gets its own corpus ratchet. The ones in
 * corpus.test.ts weigh TOP-LEVEL block spans only: a float is one non-island
 * block whether its body holds a table or nothing at all, so neither the
 * island ratio nor the structure count moves when this defect appears or is
 * fixed. This count only moves DOWN. */
describe('corpus: floats that would render as a bare caption', () => {
  const texDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'corpus', 'tex')
  const fixtures = existsSync(texDir)
    ? readdirSync(texDir, { withFileTypes: true })
        .map((e) => (e.isDirectory() ? join(e.name, `${e.name}.tex`) : e.name))
        .filter((f) => f.endsWith('.tex'))
        .filter((f) => existsSync(join(texDir, f)))
        .sort()
    : []

  /** every float in a source — nested in a wrapper, a list item, or another
   * float included; a float's visible content is its graphics plus its body */
  const floatsIn = (blocks: LxBlock[], out: Array<Extract<LxBlock, { kind: 'float' }>> = []) => {
    for (const b of blocks) {
      if (b.kind === 'float') { out.push(b); floatsIn(b.body, out) }
      else if (b.kind === 'wrapper' || b.kind === 'abstract') floatsIn(b.body, out)
      else if (b.kind === 'list') for (const item of b.items) floatsIn(item.blocks, out)
    }
    return out
  }

  /* measured 2026-08-09, issue #21 (float body groups): 27 → 2 across the
   * whole corpus. What the descent recovered: bare `{ … }` groups (llama 2,
   * palm 2, palm2 1), \resizebox{w}{h}{…} (bloom 5, flan 9, palm2 1),
   * \scalebox{f}{…} (llama 1), \subfigure{…} images (palm 2, palm2 1), and
   * one honest island for llama's \begin{tabularx}. The 2 that remain are
   * llama's \begin{figure*}\section{…}\end{figure*} page-break hack — float
   * level PROSE, a different defect from a group the scanner refused to
   * open, and one no brace descent can reach. */
  const CAPTION_ONLY_CEILING: Record<string, number> = {
    'llama/llama.tex': 2,
  }

  for (const file of fixtures) {
    it(`${file} — caption-only float count holds the ratchet`, () => {
      const src = readFileSync(join(texDir, file), 'utf-8')
      const bare = floatsIn(parse(src).blocks).filter((f) => f.graphics.length === 0 && f.body.length === 0)
      expect(bare.length).toBeLessThanOrEqual(CAPTION_ONLY_CEILING[file] ?? 0)
    })
  }
})
