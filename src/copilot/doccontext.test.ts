/* What a document turn actually ships: the current SECTION, its LaTeX, the
 * comments anchored in it — and nothing from the rest of the paper. */

import { beforeEach, describe, expect, it } from 'vitest'
import { state } from '../state'
import { loadDocFromTex, exportTex } from '../model/doc'
import { blockLocator } from '../doc/comments'
import { buildDocContext, describeDocContext, sectionAround } from './doccontext'

const SAMPLE = `\\documentclass{article}
\\begin{document}

\\section{Introduction}

Intro paragraph one.

Intro paragraph two.

\\section{Methods}

We measured the thing carefully.

\\subsection{Apparatus}

The apparatus was a box.

\\section{Results}

It worked.

\\end{document}
`

function mount(tex = SAMPLE) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const doc = loadDocFromTex(tex, host, 'sample.tex')
  state.deck = null
  state.doc = doc
  state.resetLog()
  state.setCurrentBlock(0)
  return doc
}

/** index of the first top-level block whose text starts with `prefix` */
function blockAt(prefix: string): number {
  return state.blocks().findIndex((el) => (el.textContent ?? '').startsWith(prefix))
}

beforeEach(() => {
  state.doc = null
  state.deck = null
  state.resetLog()
})

describe('sectionAround', () => {
  it('runs from the heading to the next same-level heading', () => {
    const doc = mount()
    const blocks = state.blocks()
    const section = sectionAround(doc.article, blocks[blockAt('Intro paragraph two')])
    expect(section.number).toBe('1')
    expect(section.title).toBe('Introduction')
    expect(section.blocks.map((b) => b.tagName)).toEqual(['H2', 'P', 'P'])
  })

  it('a subsection is its own section, ending at the next h2', () => {
    const doc = mount()
    const section = sectionAround(doc.article, state.blocks()[blockAt('The apparatus')])
    expect(section.title).toBe('Apparatus')
    expect(section.blocks.map((b) => b.tagName)).toEqual(['H3', 'P'])
  })

  it('blocks before the first heading are front matter', () => {
    const doc = mount('\\documentclass{article}\\begin{document}\n\nLead paragraph.\n\n\\section{After}\n\nBody.\n\n\\end{document}\n')
    const section = sectionAround(doc.article, state.blocks()[0])
    expect(section.number).toBe('')
    expect(section.blocks.map((b) => b.tagName)).toEqual(['P'])
  })
})

describe('buildDocContext', () => {
  it('ships the section markup and the LaTeX behind it, and nothing else', async () => {
    mount()
    state.setCurrentBlock(blockAt('We measured'))
    const ctx = await buildDocContext()
    expect(ctx.docMode).toBe(true)
    expect(ctx.sectionHtml).toContain('We measured the thing carefully.')
    expect(ctx.sectionHtml).not.toContain('Intro paragraph one')
    expect(ctx.sectionHtml).not.toContain('It worked')
    expect(ctx.sourceExcerpt).toContain('\\section{Methods}')
    expect(ctx.sourceExcerpt).toContain('We measured the thing carefully.')
    expect(ctx.sourceExcerpt).not.toContain('\\section{Results}')
  })

  it('the excerpt is the document\'s own bytes', async () => {
    const doc = mount()
    state.setCurrentBlock(blockAt('Intro paragraph one'))
    const ctx = await buildDocContext()
    expect(exportTex(doc)).toContain(ctx.sourceExcerpt as string)
  })

  it('a section past the cap is windowed on the current block, and says so', async () => {
    const filler = Array.from({ length: 200 }, (_, i) => `Paragraph ${i} with enough words in it to add up.`).join('\n\n')
    mount(`\\documentclass{article}\\begin{document}\n\n\\section{Long}\n\n${filler}\n\n\\end{document}\n`)
    state.setCurrentBlock(blockAt('Paragraph 150'))
    const ctx = await buildDocContext()
    const excerpt = ctx.sourceExcerpt as string
    expect(excerpt).toContain('Paragraph 150 ')
    expect(excerpt).not.toContain('Paragraph 0 ')
    expect(excerpt).toContain('omitted')
    expect(excerpt.length).toBeLessThan(4200)
  })

  it('carries open comment threads anchored in the section, and only those', async () => {
    const doc = mount()
    const blocks = state.blocks()
    const here = blocks[blockAt('We measured')]
    const elsewhere = blocks[blockAt('Intro paragraph one')]
    doc.commentsJson = JSON.stringify({
      version: 1,
      threads: [
        { id: 'c-1', status: 'open', anchor: anchor(doc.article, here, 'measured'), notes: [{ by: 'you', at: '', text: 'say how' }] },
        { id: 'c-2', status: 'resolved', anchor: anchor(doc.article, here, 'thing'), notes: [{ by: 'you', at: '', text: 'done' }] },
        { id: 'c-3', status: 'open', anchor: anchor(doc.article, elsewhere, 'Intro'), notes: [{ by: 'you', at: '', text: 'other section' }] },
      ],
    })
    state.setCurrentBlock(blockAt('We measured'))
    const ctx = await buildDocContext()
    expect(ctx.comments).toEqual([{ id: 'c-1', quote: 'measured', note: 'say how' }])
  })

  it('an unreadable comments block costs the turn nothing', async () => {
    const doc = mount()
    doc.commentsJson = '{not json'
    const ctx = await buildDocContext()
    expect(ctx.comments).toBeUndefined()
    expect(ctx.sectionHtml).toBeTruthy()
  })

  it('describes the context the way the rail line claims', () => {
    mount()
    state.setCurrentBlock(blockAt('The apparatus'))
    expect(describeDocContext()).toBe('section 2.1 › Apparatus')
    state.setCurrentBlock(blockAt('It worked'))
    expect(describeDocContext()).toBe('section 3 › Results')
  })
})

function anchor(article: HTMLElement, block: HTMLElement, quote: string) {
  const text = block.textContent ?? ''
  const start = text.indexOf(quote)
  return { block: blockLocator(article, block), start, end: start + quote.length, quote, prefix: '', suffix: '' }
}
