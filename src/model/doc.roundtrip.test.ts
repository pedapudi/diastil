/* Document round-trip guarantees (DOC-PROFILE §5):
 *   serializeDoc(loadDoc(x)) === x        for anything serializeDoc wrote
 *   exportTex(loadDocFromTex(t)) === t    untouched (trailer excepted)
 * plus: saved artifacts validate in BOTH validators (TS + Python mirror). */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadDoc, loadDocFromTex, serializeDoc, exportTex, splitCommentsTrailer, EMPTY_COMMENTS } from './doc'
import { validateDocHtml, DOC_ATTRS } from './validate'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')

const SAMPLE_TEX = `\\documentclass{article}
\\title{A Sample}
\\author{A. Author \\and B. Author}
\\begin{document}

\\begin{abstract}
We do things with $x^2$ and report them.
\\end{abstract}

\\section{Introduction}\\label{sec:intro}

Prose with \\textbf{bold}, a citation \\cite{knuth84}, math $e^{i\\pi}$,
and a reference to Section~\\ref{sec:intro}.

\\begin{itemize}
\\item first
\\item second with \\emph{style}
\\end{itemize}

\\begin{equation}\\label{eq:main}
E = mc^2
\\end{equation}

\\begin{tikzpicture}
\\draw (0,0) -- (1,1);
\\end{tikzpicture}

\\end{document}
`

function mountTex(tex: string, name = 'sample.tex') {
  const host = document.createElement('div')
  document.body.appendChild(host)
  return loadDocFromTex(tex, host, name)
}

function mountHtml(html: string, name = 'sample.html') {
  const host = document.createElement('div')
  document.body.appendChild(host)
  return loadDoc(html, host, name)
}

describe('doc load', () => {
  it('opens a .tex: header, abstract, sections, islands render', () => {
    const doc = mountTex(SAMPLE_TEX)
    expect(doc.article.querySelector('.dia-doc-header .dia-title')?.textContent).toBe('A Sample')
    expect(doc.article.querySelector('.dia-doc-authors')?.textContent).toContain('A. Author · B. Author')
    expect(doc.article.querySelector('section.dia-abstract')).toBeTruthy()
    expect(doc.article.querySelector('h2.dia-sec')?.getAttribute('data-dia-label')).toBe('sec:intro')
    expect(doc.article.querySelector('div.dia-math')?.getAttribute('data-dia-tex')).toBe('E = mc^2')
    expect(doc.article.querySelector('div.dia-math math')).toBeTruthy()
    const island = doc.article.querySelector('div.dia-tex-island')
    expect(island?.textContent).toContain('tikzpicture')
  })

  it('binds every top-level block to its exact source slice', () => {
    const doc = mountTex(SAMPLE_TEX)
    const eq = doc.article.querySelector('div.dia-math')!
    const slice = doc.source.sliceOf(eq.getAttribute('data-dia-id')!)
    expect(slice).toBe('\\begin{equation}\\label{eq:main}\nE = mc^2\n\\end{equation}')
  })

  it('cleans styling, comments, and escapes out of the derived header', () => {
    const tex = `\\documentclass{article}
\\title{\\textbf{Measurement of Occupancy\\\\ and Crowding}}
\\author{%
  Jason Wei \\hspace{6mm} Xuezhi Wang \\\\
  \\textbf{Brian Ichter} \\\\
  \\texttt{\\{jasonwei,dennyzhou\\}@google.com} \\\\
}
\\begin{document}
\\maketitle
Body text.
\\end{document}
`
    const doc = mountTex(tex)
    expect(doc.article.querySelector('.dia-title')?.textContent)
      .toBe('Measurement of Occupancy and Crowding')
    const by = doc.article.querySelector('.dia-doc-authors')?.textContent ?? ''
    expect(by).toContain('Jason Wei Xuezhi Wang')
    expect(by).toContain('Brian Ichter')
    expect(by).toContain('{jasonwei,dennyzhou}@google.com')
    expect(by).not.toContain('%')
    expect(by).not.toContain('\\textbf')
  })

  it('strips a nested \\thanks from the author line', () => {
    const tex = `\\documentclass{article}
\\title{T}
\\author{Sunil Pedapudi\\thanks{The project. Code: \\url{https://example.com}.}}
\\begin{document}
\\maketitle
Body.
\\end{document}
`
    const doc = mountTex(tex)
    expect(doc.article.querySelector('.dia-doc-authors')?.textContent?.trim()).toBe('Sunil Pedapudi')
  })

  it('treats \\maketitle with riding setup commands as the header marker', () => {
    const tex = `\\documentclass{article}
\\title{T}
\\begin{document}
\\maketitle
\\thispagestyle{empty}

Body.
\\end{document}
`
    const doc = mountTex(tex)
    expect(doc.article.querySelector('.dia-maketitle')).toBeTruthy()
    expect(doc.article.textContent).not.toContain('\\thispagestyle')
  })

  it('quiets no-type islands and expands text macros for reading — source untouched', () => {
    const tex = `\\documentclass{article}
\\newcommand{\\model}{LLaMA\\xspace}
\\title{T}
\\begin{document}
\\looseness=-1 We introduce \\model in this work.

\\clearpage
\\pgfplotsset{compat=1.11}

\\end{document}
`
    const doc = mountTex(tex)
    const quietInline = doc.article.querySelector('span.dia-tex-island.dia-tex-quiet')
    expect(quietInline?.textContent).toContain('\\looseness')
    const macro = doc.article.querySelector('span.dia-tex-macro')
    expect(macro?.getAttribute('data-dia-expand')).toBe('LLaMA')
    expect(macro?.textContent).toBe('\\model') // emit reads this — never the expansion
    // the \clearpage\pgfplotsset paragraph reads as nothing: every island
    // in it is quiet
    const setup = [...doc.article.querySelectorAll('p')].find((p) => /pgfplotsset/.test(p.textContent ?? ''))
    const islands = [...(setup?.querySelectorAll('span.dia-tex-island') ?? [])]
    expect(islands.length).toBeGreaterThan(0)
    expect(islands.every((s) => s.classList.contains('dia-tex-quiet'))).toBe(true)
    // and the source round-trips byte-identically through it all
    expect(exportTex(doc)).toBe(tex)
  })

  it('quiets bare calls of macros whose bodies set no type', () => {
    const tex = `\\documentclass{article}
\\newcommand{\\squeeze}{\\vspace{-2mm}}
\\title{T}
\\begin{document}
\\squeeze Some prose follows here.
\\end{document}
`
    const doc = mountTex(tex)
    const isl = doc.article.querySelector('span.dia-tex-island')
    expect(isl?.classList.contains('dia-tex-quiet')).toBe(true)
    expect(exportTex(doc)).toBe(tex)
  })

  it('title falls back to the file name when the preamble has none', () => {
    const doc = mountTex('no preamble at all', 'plain.tex')
    expect(doc.title).toBe('plain.tex')
  })
})

describe('doc round-trip', () => {
  it('serializeDoc(loadDoc(·)) is byte-stable', () => {
    const s1 = serializeDoc(mountTex(SAMPLE_TEX))
    const s2 = serializeDoc(mountHtml(s1))
    expect(s2).toBe(s1)
  })

  it('open .tex → save .html → export .tex is byte-identical untouched', () => {
    const s1 = serializeDoc(mountTex(SAMPLE_TEX))
    const doc = mountHtml(s1)
    expect(exportTex(doc)).toBe(SAMPLE_TEX)
  })

  it('the artifact escapes </script> hazards in verbatim source', () => {
    const hazard = 'text\n\\begin{verbatim}\n</script><script>alert(1)</script>\n\\end{verbatim}\n'
    const s1 = serializeDoc(mountTex(hazard))
    // the raw close tag must not appear un-escaped inside the source block
    const block = /<script type="application\/json" id="dia-source">([\s\S]*?)<\/script>/.exec(s1)!
    expect(block[1]).not.toContain('</script>')
    const doc = mountHtml(s1)
    expect(exportTex(doc)).toBe(hazard)
  })

  it('saved artifacts strip editor session attributes', () => {
    const out = serializeDoc(mountTex(SAMPLE_TEX))
    expect(out).not.toContain('data-dia-id')
  })

  it('a provisional ref carries its marking AND its rule into the artifact', () => {
    // SAMPLE_TEX has never been compiled, so every ref in it is counted by
    // us — the marking is only worth anything if the saved file can show
    // it, which means the rule must live in the THEME sheet (kept) and not
    // in dia-editor-base (dropped).
    const out = serializeDoc(mountTex(SAMPLE_TEX))
    expect(out).toContain('class="dia-ref dia-ref-provisional"')
    expect(out).toContain('a.dia-ref.dia-ref-provisional')
    expect(out).toContain('title="provisional number')
    // and it survives the reopen, so a second save is still byte-stable
    expect(serializeDoc(mountHtml(out))).toBe(out)
  })

  it('a \\crefrange and a \\subcaptionbox survive .tex → .html → .tex', () => {
    // neither is in the corpus, and both were previously islands. Now that
    // they are structure, the round-trip is the only thing standing between
    // "we parsed it" and "we deleted the author's bytes".
    const tex = '\\documentclass{article}\n\\begin{document}\n'
      + '\\begin{figure}\n\\centering\n'
      + '\\subcaptionbox{Left\\label{sub:a}}[3cm][c]{\\includegraphics{a.png}}\n'
      + '\\subcaptionbox*{Right}{\\includegraphics{b.png}}\n'
      + '\\caption{Panels}\\label{fig:p}\n\\end{figure}\n\n'
      + 'See \\crefrange{fig:a}{fig:c} and \\Crefrange{eq:x}{eq:z}.\n'
      + '\\end{document}\n'
    const s1 = serializeDoc(mountTex(tex))
    const doc = mountHtml(s1)
    expect(exportTex(doc)).toBe(tex)
    expect(serializeDoc(doc)).toBe(s1)
    // the range's two ends ride separate attributes, so nothing in the
    // artifact ever presents them as one comma list
    expect(s1).toContain('data-dia-ref-from="fig:a"')
    expect(s1).toContain('data-dia-ref-to="fig:c"')
    expect(s1).not.toContain('data-dia-ref="fig:a,fig:c"')
    expect(validateDocHtml(s1).ok).toBe(true)
  })

  // one fixture per document FAMILY the corpus covers (see corpus/tex/README.md
  // and issue #8) — a two-column conference paper, plus book/beamer/biblatex/
  // amsthm, each exercising presentation heuristics the others don't
  const REAL_PAPERS = [
    'llama/llama.tex', 'thesis/thesis.tex', 'beamer/beamer.tex',
    'biblatex/biblatex.tex', 'theorems/theorems.tex',
  ]
  for (const rel of REAL_PAPERS) {
    it(`a real paper round-trips byte-identically (${rel})`, () => {
      const tex = readFileSync(join(repo, 'corpus', 'tex', rel), 'utf-8')
      const s1 = serializeDoc(mountTex(tex, rel.split('/').pop()))
      expect(exportTex(mountHtml(s1))).toBe(tex)
      expect(serializeDoc(mountHtml(s1))).toBe(s1)
    })
  }
})

describe('comments trailer', () => {
  const thread = {
    id: 'c-1', status: 'open',
    anchor: { block: 'article > p:nth-of-type(1)', start: 0, end: 5, quote: 'Prose', prefix: '', suffix: ' with' },
    notes: [{ by: 'sunil', at: '2026-08-01T00:00:00Z', text: 'tighten this' }],
  }

  it('exportTex appends a trailer only when threads exist', () => {
    const doc = mountTex(SAMPLE_TEX)
    expect(exportTex(doc)).toBe(SAMPLE_TEX)
    doc.commentsJson = JSON.stringify({ version: 1, threads: [thread] })
    const out = exportTex(doc)
    expect(out).toContain('% === dia:comments v1 ===')
    expect(out).toContain('% dia:comment {"id":"c-1"')
  })

  it('tex → diastil → tex round-trips comments through the trailer', () => {
    const doc = mountTex(SAMPLE_TEX)
    doc.commentsJson = JSON.stringify({ version: 1, threads: [thread] })
    const exported = exportTex(doc)
    const again = mountTex(exported)
    expect(JSON.parse(again.commentsJson).threads).toEqual([thread])
    // and the body source came back exactly
    expect(again.source.text).toBe(SAMPLE_TEX)
  })

  it('splitCommentsTrailer tolerates a mangled line without losing the doc', () => {
    const raw = SAMPLE_TEX + '% === dia:comments v1 ===\n% dia:comment {broken json\n'
    const { tex, commentsJson } = splitCommentsTrailer(raw)
    expect(tex).toBe(SAMPLE_TEX)
    expect(commentsJson).toBe('{"version":1,"threads":[]}')
  })

  it('comments survive the html artifact round-trip', () => {
    const doc = mountTex(SAMPLE_TEX)
    doc.commentsJson = JSON.stringify({ version: 1, threads: [thread] })
    const reloaded = mountHtml(serializeDoc(doc))
    expect(JSON.parse(reloaded.commentsJson).threads).toEqual([thread])
  })

  it('a doc without comments carries the empty block', () => {
    const doc = mountTex(SAMPLE_TEX)
    expect(doc.commentsJson).toBe(EMPTY_COMMENTS)
  })
})

describe('doc profile validation', () => {
  it('saved artifacts validate (TS)', () => {
    const report = validateDocHtml(serializeDoc(mountTex(SAMPLE_TEX)))
    expect(report.findings.filter((f) => f.level === 'error')).toEqual([])
    expect(report.ok).toBe(true)
  })

  it('doc and deck stamps are mutually exclusive', () => {
    const bad = serializeDoc(mountTex(SAMPLE_TEX)).replace(
      'data-dia-doc-version="1"', 'data-dia-doc-version="1" data-dia-version="1"')
    const report = validateDocHtml(bad)
    expect(report.findings.some((f) => f.rule === 'doc/version-exclusive')).toBe(true)
  })

  it('unknown dialect attributes are rejected in the article', () => {
    const bad = serializeDoc(mountTex(SAMPLE_TEX)).replace('<p>', '<p data-dia-mystery="1">')
    const report = validateDocHtml(bad)
    expect(report.findings.some((f) => f.rule === 'content/unknown-dia-attr')).toBe(true)
  })

  it('the Python mirror agrees on the same artifacts (lockstep)', () => {
    const probe = spawnSync('python3', ['--version'])
    if (probe.status !== 0) return // no python here — the mirror runs in service CI
    const good = serializeDoc(mountTex(SAMPLE_TEX))
    const bad = good.replace('<p>', '<p data-dia-mystery="1">')
    for (const [html, expectOk] of [[good, true], [bad, false]] as const) {
      const r = spawnSync('python3', ['-c', [
        'import sys, json',
        `sys.path.insert(0, ${JSON.stringify(join(repo, 'service'))})`,
        'from dia_service.validate import validate_doc_html',
        'print(json.dumps(validate_doc_html(sys.stdin.read())["ok"]))',
      ].join('\n')], { input: html, encoding: 'utf-8' })
      expect(r.status, r.stderr).toBe(0)
      expect(JSON.parse(r.stdout.trim()), 'python verdict matches TS').toBe(expectOk)
    }
  })
})

/* ---------- the two allowlists themselves ---------- */

/* The lockstep case above validates one SAMPLE artifact, which can only ever
 * exercise the attributes that sample happens to use — so it cannot see the
 * two DOC_ATTRS lists drifting apart. They did: \crefrange's two ends were
 * added to the TS list alone, and a saved document containing a range passed
 * validateDocHtml while the daemon's validate_doc_html rejected it as an
 * unknown dialect attribute. Compare the SETS, not a sample. */
describe('the two validators allow exactly the same attributes', () => {
  it('DOC_ATTRS is identical in TypeScript and Python', () => {
    const probe = spawnSync('python3', ['--version'])
    if (probe.status !== 0) return // no python here — the mirror runs in service CI
    const r = spawnSync('python3', ['-c', [
      'import sys, json',
      `sys.path.insert(0, ${JSON.stringify(join(repo, 'service'))})`,
      'from dia_service.validate import DOC_ATTRS',
      'print(json.dumps(sorted(DOC_ATTRS)))',
    ].join('\n')], { encoding: 'utf-8' })
    expect(r.status, r.stderr).toBe(0)
    const py: string[] = JSON.parse(r.stdout.trim())
    const ts = [...DOC_ATTRS].sort()
    expect(py.filter((a) => !DOC_ATTRS.has(a)), 'in Python, missing from TypeScript').toEqual([])
    expect(ts.filter((a) => !py.includes(a)), 'in TypeScript, missing from Python').toEqual([])
  })
})
