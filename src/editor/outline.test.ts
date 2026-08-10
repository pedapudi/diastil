/* The outline as the find bar's GLOBAL locator.
 *
 * The shading is on the match you stand on and a crop tab is on a picture
 * you can see; both are local. These cases hold the third answer: a count
 * per section for the matches that are on no screen at all — and the two
 * rules the rest of find lives by, that a search moves not one byte and
 * that it stays cheap enough to run on every keystroke. */

import { beforeEach, describe, expect, it } from 'vitest'
import { state } from '../state'
import { exportTex, loadDocFromTex, serializeDoc } from '../model/doc'
import { clearMirrors } from '../doc/blockmirror'
import { closeDocFind, mountDocFind, openDocFind } from './docfind'
import { mountOutline, showOutline } from './outline'

const SAMPLE = `\\documentclass{article}
\\title{A Short Paper}
\\begin{document}
\\maketitle

Front matter about llamas, before any heading at all.

\\section{One}

A paragraph about llamas in section one.

Another llamas paragraph, still under the same heading.

\\subsection{One A}

Nothing of interest under here.

\\section{Two}

A single llamas mention down in section two.

\\end{document}
`

describe('outline find counts', () => {
  let col: HTMLElement
  let barHost: HTMLElement

  const field = (): HTMLInputElement => barHost.querySelector<HTMLInputElement>('.de-find-row .dn-input')!
  const type = (v: string): void => {
    const f = field()
    f.value = v
    f.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const rows = (): HTMLElement[] => [...col.querySelectorAll<HTMLElement>('.de-outline-row')]
  const row = (label: string): HTMLElement =>
    rows().find((r) => (r.querySelector('.de-outline-text')!.textContent ?? '').includes(label))!
  const findBadge = (label: string): HTMLElement | null => row(label).querySelector('.de-outline-find')
  const countOn = (label: string): string | null => findBadge(label)?.textContent ?? null
  const titleBadge = (): HTMLElement | null => col.querySelector('.de-outline-title .de-outline-find')

  function mount(tex = SAMPLE) {
    const surface = document.createElement('div')
    document.body.appendChild(surface)
    const doc = loadDocFromTex(tex, surface, 'sample.tex')
    state.deck = null
    state.doc = doc
    state.resetLog()
    showOutline(true) // doc mode: the column shows the outline
    return doc
  }

  beforeEach(() => {
    clearMirrors()
    state.doc = null
    state.resetLog()
    col = document.createElement('aside')
    document.body.appendChild(col)
    mountOutline(col)
    barHost = document.createElement('div')
    document.body.appendChild(barHost)
    mountDocFind(barHost, () => true)
  })

  it('counts the matches under each heading, and above the first one', () => {
    mount()
    openDocFind()
    type('llamas')
    // the front matter is nobody's section, so the title line carries it
    expect(titleBadge()!.textContent).toBe('1')
    expect(countOn('One')).toBe('2')
    expect(countOn('One A')).toBeNull() // a section with none says nothing
    expect(countOn('Two')).toBe('1')
  })

  /* The header's text is DERIVED (the preamble's \title), so find reports
   * it and refuses to rewrite it. It is still somewhere the reader can go,
   * and the title line is that header — on llama.tex a search for "the"
   * counted 688 in the bar against 687 in the column until the byline's
   * match had a row to sit on. */

  it('a match in the derived title header lands on the title line', () => {
    mount()
    openDocFind()
    type('short') // \title{A Short Paper}, and nowhere in the body
    expect(titleBadge()!.textContent).toBe('1')
    expect(col.querySelectorAll('.de-outline-find')).toHaveLength(1)
  })

  it('follows the term as it is typed, and clears when the bar closes', () => {
    mount()
    openDocFind()
    type('llamas')
    expect(countOn('Two')).toBe('1')
    type('interest')
    expect(countOn('Two')).toBeNull()
    expect(countOn('One A')).toBe('1')
    type('zzz-nothing')
    expect(col.querySelectorAll('.de-outline-find')).toHaveLength(0)
    type('llamas')
    closeDocFind()
    expect(col.querySelectorAll('.de-outline-find')).toHaveLength(0)
  })

  /* A badge inside a heading row is inside the row's BUTTON, so the click
   * that already scrolls the document does the work — clicking a count must
   * not be a second, differently-behaved way to move. */

  it('clicking a section count takes the reader to that section', () => {
    const doc = mount()
    openDocFind()
    type('llamas')
    const two = [...doc.article.children].findIndex((b) => (b.textContent ?? '').includes('Two'))
    state.setCurrentBlock(0)
    findBadge('Two')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(state.currentBlock).toBe(two)
  })

  it('clicking the front-matter count goes back to the top', () => {
    mount()
    openDocFind()
    type('llamas')
    state.setCurrentBlock(6)
    titleBadge()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(state.currentBlock).toBe(0)
  })

  /* A search is DECORATION. The counts hang in the editor's own column,
   * outside the article entirely, and the saved artifact must not be able
   * to tell a search ever happened. */

  it('a search with counts showing moves not one byte of the document', () => {
    const doc = mount()
    const tex = exportTex(doc)
    const html = serializeDoc(doc)

    openDocFind()
    type('llamas')
    expect(countOn('One')).toBe('2') // counting really happened
    expect(doc.article.querySelector('.de-outline-find')).toBeNull()
    expect(exportTex(doc)).toBe(tex)
    expect(serializeDoc(doc)).toBe(html)

    closeDocFind()
    expect(exportTex(doc)).toBe(tex)
    expect(serializeDoc(doc)).toBe(html)
  })

  /* paint() runs on every keystroke of a search that may hold MAX_HITS
   * matches. Rebuilding the heading tree there would make the outline the
   * thing that makes a big search slow, so the counts are painted onto the
   * rows that are already standing. */

  it('typing repaints badges without rebuilding the heading rows', () => {
    mount()
    openDocFind()
    type('llamas')
    const before = rows()
    const badge = findBadge('One')
    type('llama')
    type('llamas')
    expect(rows()).toEqual(before)
    expect(findBadge('One')).toBe(badge) // the same badge, retitled
  })

  it('a rebuild mid-search keeps the counts', () => {
    mount()
    openDocFind()
    type('llamas')
    state.bus.emit({ type: 'comments-changed' })
    expect(countOn('One')).toBe('2')
    expect(titleBadge()!.textContent).toBe('1')
  })

  it('counts nothing while the outline is not mounted into a document', () => {
    // deck mode: no document, no rows, and setFindCounts must not throw
    state.doc = null
    closeDocFind()
    expect(col.querySelectorAll('.de-outline-find')).toHaveLength(0)
  })
})
