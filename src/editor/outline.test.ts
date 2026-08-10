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
import { bindCommentStore, blockLocator } from '../doc/comments'
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

/** a section with prose of its own AND subsections holding more */
const NESTED = `\\documentclass{article}
\\title{Nesting}
\\begin{document}
\\maketitle

\\section{Methods}

One llamas mention directly under the section heading.

\\subsection{Data}

A llamas paragraph in the subsection.

Another llamas paragraph, in the same subsection.

\\subsection{Model}

No mention of the animal here.

\\section{Results}

A final llamas mention.

\\end{document}
`

/** no \\title, so no header line in the paper — and prose above the first
 * heading all the same */
const NO_TITLE = `\\documentclass{article}
\\begin{document}

Front matter about llamas, before any heading at all.

A second llamas paragraph, still above everything.

\\section{Only}

One llamas mention in the only section.

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
  const frontLine = (): HTMLElement | null => col.querySelector('.de-outline-title')

  /* The bar counts the whole document once; the column is that same total
   * broken up by section. They have to be the same number, or one of them
   * is lying — which is the whole reason a row's span stops at the next
   * heading instead of swallowing its subsections. */
  const barTotal = (): number => {
    const text = barHost.querySelector('.de-find-count')!.textContent ?? ''
    return Number(/\/(\d+)$/.exec(text)?.[1] ?? 0)
  }
  const columnTotal = (): number =>
    [...col.querySelectorAll('.de-outline-find')].reduce((n, b) => n + Number(b.textContent), 0)

  function mount(tex = SAMPLE) {
    const surface = document.createElement('div')
    document.body.appendChild(surface)
    const doc = loadDocFromTex(tex, surface, 'sample.tex')
    state.deck = null
    state.doc = doc
    state.resetLog()
    bindCommentStore(doc)
    showOutline(true) // doc mode: the column shows the outline
    return doc
  }

  /** open a thread on the block whose text contains `label` */
  function comment(doc: ReturnType<typeof mount>, label: string): void {
    const store = bindCommentStore(doc)!
    const block = [...doc.article.children].find((b) => (b.textContent ?? '').includes(label))!
    const quote = (block.textContent ?? '').slice(0, 6)
    state.apply(store.addThread(
      { block: blockLocator(doc.article, block), start: 0, end: quote.length, quote, prefix: '', suffix: '' },
      'a note',
    ).op)
  }

  beforeEach(() => {
    clearMirrors()
    state.doc = null
    bindCommentStore(null)
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
    expect(columnTotal()).toBe(barTotal()) // 1 + 2 + 1, and the bar says 4
    expect(barTotal()).toBe(4)
  })

  /* A row's span stops at the NEXT HEADING, whatever its level: a
   * subsection's matches are the subsection's and not also its parent's.
   *
   * The badge is a click target — clicking it scrolls to that row's block —
   * so the number has to count what the reader finds when they land there.
   * A \section reading "3" that puts them on a heading with one match
   * before the next row's heading has told them about two matches that are
   * somewhere else, and the column would no longer add up to the bar: 3 + 2
   * against a document holding 4. Every match sits on exactly one row, the
   * most specific one, and the outline never collapses, so that row is
   * always drawn directly under the parent that would have claimed it. */

  it('a section counts its own prose, not its subsections', () => {
    mount(NESTED)
    openDocFind()
    type('llamas')
    expect(countOn('Methods')).toBe('1') // NOT 3: Data's two are Data's
    expect(countOn('Data')).toBe('2')
    expect(countOn('Model')).toBeNull()
    expect(countOn('Results')).toBe('1')
    expect(barTotal()).toBe(4)
    expect(columnTotal()).toBe(barTotal())
  })

  it('the comment badge splits sections the same way the find badge does', () => {
    // two badges in one column reading the same shape of question two
    // different ways would be worse than either rule on its own
    const doc = mount(NESTED)
    comment(doc, 'A llamas paragraph in the subsection')
    const methods = row('Methods')
    const data = row('Data')
    expect(data.querySelector('.de-outline-badge:not(.de-outline-find)')?.textContent).toBe('1')
    expect(methods.querySelector('.de-outline-badge:not(.de-outline-find)')).toBeNull()
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

  /* A .tex someone starts by hand often has no \title, and then there is no
   * header block in the paper for the front matter to hang on — the abstract
   * and the lead paragraphs were counted by the bar and shown on no row at
   * all. The front line stands whether or not the document names itself;
   * with no \title it borrows the model's own fallback, the file name. */

  it('a document with no \\title still has a row for what is above the first heading', () => {
    const doc = mount(NO_TITLE)
    expect(doc.article.querySelector('.dia-doc-header')).toBeNull()
    expect(frontLine()!.textContent).toBe('sample.tex')
    expect(frontLine()!.classList.contains('de-outline-noname')).toBe(true)

    openDocFind()
    type('llamas')
    expect(titleBadge()!.textContent).toBe('2')
    expect(countOn('Only')).toBe('1')
    expect(barTotal()).toBe(3)
    expect(columnTotal()).toBe(barTotal())
  })

  it('the title-less front line goes to the top of the document', () => {
    mount(NO_TITLE)
    openDocFind()
    type('llamas')
    state.setCurrentBlock(3)
    titleBadge()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(state.currentBlock).toBe(0)
  })

  it('a title-less document with no headings at all puts every match on the front line', () => {
    mount(`\\documentclass{article}
\\begin{document}
A note about llamas.

More llamas, and no heading anywhere in the file.
\\end{document}
`)
    openDocFind()
    type('llamas')
    expect(rows()).toHaveLength(0)
    expect(titleBadge()!.textContent).toBe('2')
    expect(columnTotal()).toBe(barTotal())
  })

  it('a title-less document that opens on a heading grows no front line', () => {
    // nothing above the first heading to point at, and a row that can never
    // say anything is noise in a 132px column
    mount(`\\documentclass{article}
\\begin{document}
\\section{Straight In}

A llamas mention.
\\end{document}
`)
    expect(frontLine()).toBeNull()
    openDocFind()
    type('llamas')
    expect(countOn('Straight In')).toBe('1')
    expect(columnTotal()).toBe(barTotal())
  })

  it('the front line carries the open comments above the first heading', () => {
    // the same gap as the find count had, on the amber badge: a thread on
    // the abstract of a title-less document was counted nowhere in the column
    const doc = mount(NO_TITLE)
    comment(doc, 'Front matter about llamas')
    expect(frontLine()!.querySelector('.de-outline-badge:not(.de-outline-find)')?.textContent).toBe('1')
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
