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
import { escapeTex } from '../latex/emit'
import {
  commitDocEdit, insertDocBlock, joinDocBlocks, moveDocBlock, removeDocBlock,
  splitDocBlock, topBlockOf,
} from './sync'

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

/* Structural editing: whole blocks appear, vanish and change places, and
 * the source moves with them in one op. The bar is higher than for a text
 * edit — a structural op owns a REGION spanning more than one block, so
 * every byte outside that region must come through untouched, both ways. */
describe('block structure', () => {
  const firstPara = (doc: { article: HTMLElement }): HTMLElement =>
    [...doc.article.querySelectorAll('p')].find((p) => (p.textContent ?? '').includes('First'))!

  it('inserts a paragraph between two blocks without reformatting either', () => {
    const doc = mount(SAMPLE)
    const p = firstPara(doc)
    const el = insertDocBlock(doc, 'An inserted paragraph.', p, 'after')
    expect(el).not.toBeNull()
    expect([...doc.article.children].indexOf(el!)).toBe([...doc.article.children].indexOf(p) + 1)
    // the ONLY new bytes are the block and the blank line that seats it
    expect(exportTex(doc).replace('\n\nAn inserted paragraph.', '')).toBe(SAMPLE)
  })

  it('an inserted block undoes byte-exactly and redoes', () => {
    const doc = mount(SAMPLE)
    insertDocBlock(doc, 'An inserted paragraph.', firstPara(doc), 'after')
    state.undo()
    expect(exportTex(doc)).toBe(SAMPLE)
    expect(doc.article.textContent).not.toContain('An inserted paragraph.')
    state.redo()
    expect(exportTex(doc)).toContain('An inserted paragraph.')
    state.undo()
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('inserts before the first block and after the last one', () => {
    const doc = mount(SAMPLE)
    const blocks = [...doc.article.children] as HTMLElement[]
    insertDocBlock(doc, '\\section{Front matter}', blocks[0], 'before')
    insertDocBlock(doc, 'A closing remark.', blocks[blocks.length - 1], 'after')
    const out = exportTex(doc)
    expect(out).toContain('\\begin{document}\n\n\\section{Front matter}\n\n\\section{One}')
    expect(out).toContain('A closing remark.\n\n\\end{document}')
    state.undo()
    state.undo()
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('typed specials survive the round trip through the source', () => {
    const doc = mount(SAMPLE)
    const typed = '100% of a_b & c #d $e'
    const el = insertDocBlock(doc, escapeTex(typed), firstPara(doc), 'after')!
    expect(doc.source.text).toContain('100\\% of a\\_b \\& c \\#d \\$e')
    expect(el.textContent).toBe(typed)
    const host = document.createElement('div')
    document.body.appendChild(host)
    expect(loadDoc(serializeDoc(doc), host, 'x.html').article.textContent).toContain(typed)
  })

  it('removing a block takes its separator and nothing else', () => {
    const doc = mount(SAMPLE)
    const math = doc.article.querySelector<HTMLElement>('div.dia-math')!
    expect(removeDocBlock(doc, math)).toBe(true)
    expect(exportTex(doc)).toBe(SAMPLE.replace('\\begin{equation}\\label{eq:e}\ne = mc^2\n\\end{equation}\n\n', ''))
    state.undo()
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('removing the LAST block takes the separator above it', () => {
    const doc = mount(SAMPLE)
    const last = [...doc.article.querySelectorAll('p')].pop()!
    expect(removeDocBlock(doc, last)).toBe(true)
    expect(exportTex(doc)).toBe(SAMPLE.replace('\n\nSecond paragraph references \\ref{sec:one} and \\ref{eq:e}.', ''))
    state.undo()
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('a move relocates the slice — both blocks keep their exact bytes', () => {
    const doc = mount(SAMPLE)
    const p = firstPara(doc)
    expect(moveDocBlock(doc, p, 1)).toBe(true)
    const out = exportTex(doc)
    // the paragraph's deliberate odd whitespace is not reflowed by the move
    expect(out).toContain('First paragraph, with \\textbf{style}   and\n  deliberate    odd whitespace.')
    expect(out.indexOf('\\end{equation}')).toBeLessThan(out.indexOf('First paragraph'))
    // the two slices simply exchanged places: nothing else moved
    const para = 'First paragraph, with \\textbf{style}   and\n  deliberate    odd whitespace.'
    const eq = '\\begin{equation}\\label{eq:e}\ne = mc^2\n\\end{equation}'
    expect(out).toBe(SAMPLE.replace(`${para}\n\n${eq}`, `${eq}\n\n${para}`))
    const kids = [...doc.article.children]
    expect(kids.indexOf(p)).toBe(kids.indexOf(doc.article.querySelector('div.dia-math')!) + 1)
    state.undo()
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('a move up is the mirror of the move down', () => {
    const doc = mount(SAMPLE)
    const math = doc.article.querySelector<HTMLElement>('div.dia-math')!
    expect(moveDocBlock(doc, math, -1)).toBe(true)
    const moved = exportTex(doc)
    state.undo()
    expect(exportTex(doc)).toBe(SAMPLE)
    moveDocBlock(doc, firstPara(doc), 1)
    expect(exportTex(doc)).toBe(moved)
  })

  it('splitting at the end of a paragraph leaves that paragraph byte-untouched', () => {
    const doc = mount(SAMPLE)
    const p = firstPara(doc)
    const tail = splitDocBlock(doc, p, p.innerHTML, 'A brand new paragraph.')
    expect(tail).not.toBeNull()
    const out = exportTex(doc)
    expect(out).toContain('odd whitespace.\n\nA brand new paragraph.')
    expect(out.replace('\n\nA brand new paragraph.', '')).toBe(SAMPLE)
    state.undo()
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('splitting mid-paragraph makes two real blocks', () => {
    const doc = mount(SAMPLE)
    const p = firstPara(doc)
    const tail = splitDocBlock(doc, p, 'Head half.', 'Tail half.')!
    expect(p.textContent).toBe('Head half.')
    expect(tail.textContent).toBe('Tail half.')
    expect(exportTex(doc)).toContain('Head half.\n\nTail half.')
    state.undo()
    expect(exportTex(doc)).toBe(SAMPLE)
    expect(doc.article.querySelectorAll('p').length).toBe(2)
  })

  it('splitting then joining the empty tail back is a no-op on the bytes', () => {
    // the Enter-then-Backspace path: an empty block joined back must not
    // reformat the paragraph it came from
    const doc = mount(SAMPLE)
    const p = firstPara(doc)
    const tail = splitDocBlock(doc, p, p.innerHTML, '')!
    expect(joinDocBlocks(doc, p, tail)).toBe(true)
    expect(exportTex(doc)).toBe(SAMPLE)
    expect(tail.isConnected).toBe(false)
  })

  it('joining two paragraphs merges their text and their source', () => {
    const doc = mount('\\documentclass{article}\n\\begin{document}\n\nAlpha one.\n\nBeta two.\n\n\\end{document}\n')
    const [a, b] = [...doc.article.querySelectorAll('p')]
    expect(joinDocBlocks(doc, a, b)).toBe(true)
    expect(doc.article.querySelectorAll('p').length).toBe(1)
    expect(doc.source.text).toContain('Alpha one.Beta two.')
    state.undo()
    expect(doc.source.text).toContain('Alpha one.\n\nBeta two.')
    expect(doc.article.querySelectorAll('p').length).toBe(2)
  })

  it('a structurally edited document still serializes, validates and reloads', () => {
    const doc = mount(SAMPLE)
    insertDocBlock(doc, '\\section{Added}', firstPara(doc), 'after')
    removeDocBlock(doc, doc.article.querySelector<HTMLElement>('div.dia-math')!)
    const html = serializeDoc(doc)
    expect(validateDocHtml(html).ok).toBe(true)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const reloaded = loadDoc(html, host, 'x.html')
    expect(serializeDoc(reloaded)).toBe(html)
  })

  it('a real paper: insert, move and remove leave every other byte alone', () => {
    const tex = readFileSync(join(repo, 'corpus', 'tex', 'llama', 'llama.tex'), 'utf-8')
    const doc = mount(tex, 'llama.tex')
    const target = [...doc.article.querySelectorAll('p')].find((p) =>
      (p.textContent ?? '').includes('trillions of tokens'))!
    insertDocBlock(doc, 'An inserted note.', target, 'after')
    expect(exportTex(doc).replace('\n\nAn inserted note.', '')).toBe(tex)
    moveDocBlock(doc, target, 1)
    removeDocBlock(doc, target)
    state.undo()
    state.undo()
    state.undo()
    expect(exportTex(doc)).toBe(tex)
  })
})
