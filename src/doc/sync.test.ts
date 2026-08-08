/* The paired-op contract, end to end: an edit changes ONLY its block's
 * bytes in the exported source; undo restores the source byte-exactly;
 * math and derived refs stay coherent. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { state } from '../state'
import { loadDocFromTex, exportTex, serializeDoc, loadDoc } from '../model/doc'
import { setInlineHtml, setAttr } from '../model/ops'
import { validateDocHtml } from '../model/validate'
import { commitDocEdit, topBlockOf } from './sync'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')

const SAMPLE = `\\documentclass{article}
\\begin{document}

\\section{One}\\label{sec:one}

First paragraph, with \\textbf{style}   and
  deliberate    odd whitespace.

\\begin{equation}\\label{eq:e}
e = mc^2
\\end{equation}

Second paragraph references \\ref{sec:one} and \\ref{eq:e}.

\\end{document}
`

function mount(tex: string, name = 'sample.tex') {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const doc = loadDocFromTex(tex, host, name)
  state.deck = null
  state.doc = doc
  state.resetLog()
  return doc
}

beforeEach(() => {
  state.doc = null
  state.resetLog()
})

describe('commitDocEdit', () => {
  it('an edit changes only its own block bytes in the export', () => {
    const doc = mount(SAMPLE)
    const p = doc.article.querySelector('p')!
    commitDocEdit(doc, p, [setInlineHtml(p, 'Rewritten paragraph.')], 'Edit text')
    const out = exportTex(doc)
    expect(out).toContain('Rewritten paragraph.')
    // every byte outside the edited block is untouched
    const before = SAMPLE.indexOf('First paragraph')
    expect(out.slice(0, before)).toBe(SAMPLE.slice(0, before))
    const afterMark = '\\begin{equation}'
    expect(out.slice(out.indexOf(afterMark))).toBe(SAMPLE.slice(SAMPLE.indexOf(afterMark)))
  })

  it('undo restores the source byte-exactly', () => {
    const doc = mount(SAMPLE)
    const p = doc.article.querySelector('p')!
    commitDocEdit(doc, p, [setInlineHtml(p, 'Changed.')], 'Edit text')
    expect(exportTex(doc)).not.toBe(SAMPLE)
    state.undo()
    expect(exportTex(doc)).toBe(SAMPLE)
    state.redo()
    expect(exportTex(doc)).toContain('Changed.')
    state.undo()
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('two sequential edits in different blocks compose; undo unwinds both', () => {
    const doc = mount(SAMPLE)
    const paras = doc.article.querySelectorAll('p')
    commitDocEdit(doc, paras[0], [setInlineHtml(paras[0], 'A.')], 'Edit text')
    commitDocEdit(doc, paras[1], [setInlineHtml(paras[1], 'B.')], 'Edit text')
    const out = exportTex(doc)
    expect(out).toContain('A.')
    expect(out).toContain('B.')
    state.undo()
    state.undo()
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('a math edit pairs data-dia-tex with the source patch', () => {
    const doc = mount(SAMPLE)
    const math = doc.article.querySelector<HTMLElement>('div.dia-math')!
    commitDocEdit(doc, math, [setAttr(math, 'data-dia-tex', 'e = mc^3')], 'Edit math')
    const out = exportTex(doc)
    expect(out).toContain('\\begin{equation}\\label{eq:e}\ne = mc^3\n\\end{equation}')
    state.undo()
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('derived refs resolve to numbers and re-resolve after edits', () => {
    const doc = mount(SAMPLE)
    const second = doc.article.querySelectorAll('p')[1]
    expect(second.textContent).toContain('references 1 and 1')
    // an edit inside the ref paragraph keeps the derived texts coherent
    commitDocEdit(doc, second, [setInlineHtml(second, second.innerHTML + ' now')], 'Edit text')
    expect(second.textContent).toContain('now')
  })

  it('the derived header refuses edits (not source-backed)', () => {
    const doc = mount('\\documentclass{article}\\title{T}\\begin{document}\\maketitle\n\nBody.\n\\end{document}\n')
    const h1 = doc.article.querySelector<HTMLElement>('.dia-doc-header .dia-title')!
    expect(topBlockOf(doc, h1)).toBeNull()
    expect(commitDocEdit(doc, h1, [setInlineHtml(h1, 'X')], 'Edit')).toBe(false)
  })

  it('edited documents still serialize to valid, reloadable artifacts', () => {
    const doc = mount(SAMPLE)
    const p = doc.article.querySelector('p')!
    commitDocEdit(doc, p, [setInlineHtml(p, 'Edited &amp; saved with 100% care.')], 'Edit text')
    const html = serializeDoc(doc)
    expect(validateDocHtml(html).ok).toBe(true)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const reloaded = loadDoc(html, host, 'x.html')
    expect(reloaded.article.textContent).toContain('Edited & saved with 100% care.')
    expect(serializeDoc(reloaded)).toBe(html)
  })

  it('an edited block keeps the blank lines that separate it from its neighbours', () => {
    // a block's span owns the newline before it. Re-emitting the block
    // alone over that span glues it onto the line above — source that still
    // compiles, into a document that is not the one on screen.
    const doc = mount('\\documentclass{article}\n\\begin{document}\n\n'
      + '\\section{Introduction}\nThe first paragraph.\n\nThe second paragraph.\n\n'
      + '\\end{document}\n')
    const first = [...doc.article.querySelectorAll('p')]
      .find((p) => (p.textContent ?? '').includes('first'))!
    commitDocEdit(doc, first, [setInlineHtml(first, 'Rewritten.')], 'Edit text')
    expect(doc.source.text).toContain('\\section{Introduction}\nRewritten.\n\nThe second paragraph.')
    expect(doc.source.text).not.toContain('\\section{Introduction}Rewritten.')
  })

  it('a real paper: edit one paragraph, everything else byte-identical', () => {
    const tex = readFileSync(join(repo, 'corpus', 'tex', 'llama', 'llama.tex'), 'utf-8')
    const doc = mount(tex, 'llama.tex')
    const target = [...doc.article.querySelectorAll('p')].find((p) =>
      (p.textContent ?? '').includes('trillions of tokens'))!
    commitDocEdit(doc, target, [setInlineHtml(target, 'Shortened.')], 'Edit text')
    const out = exportTex(doc)
    expect(out).toContain('Shortened.')
    state.undo()
    expect(exportTex(doc)).toBe(tex)
  })

  it('beamer (issue #20): editing one frame\'s body leaves every other frame\'s title bytes untouched', () => {
    const tex = readFileSync(join(repo, 'corpus', 'tex', 'beamer', 'beamer.tex'), 'utf-8')
    const doc = mount(tex, 'beamer.tex')
    const target = [...doc.article.querySelectorAll('p')].find((p) =>
      (p.textContent ?? '').includes('accelerator with peak throughput'))!
    commitDocEdit(doc, target, [setInlineHtml(target, 'Shortened bandwidth claim.')], 'Edit text')
    const out = exportTex(doc)
    expect(out).toContain('Shortened bandwidth claim.')
    // every OTHER frame's begin line — bracket and title argument bytes —
    // survives verbatim, including the `[fragile]` frame and the `\model{}`
    // macro-in-title frame
    expect(out).toContain('\\begin{frame}\n  \\titlepage\n\\end{frame}')
    expect(out).toContain('\\begin{frame}{Outline}')
    expect(out).toContain('\\begin{frame}{\\model{} in One Slide}')
    expect(out).toContain('\\begin{frame}[fragile]{Block Size, By Layer}')
    state.undo()
    expect(exportTex(doc)).toBe(tex)
  })
})
