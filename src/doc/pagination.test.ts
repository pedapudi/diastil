/* The page breaks the semantic surface draws come from the engine, so what
 * this file pins is the mapping from synctex's per-block page numbers to the
 * groups a sheet is drawn around — and the two honesty rules that ride with
 * it: a block the engine split does not get a sheet of its own, and breaks
 * from a compile the document has moved past are marked provisional rather
 * than dropped. */

import { describe, expect, it } from 'vitest'
import { breaksAreCurrent, pageBreakCss, pageGroups } from './pagination'
import type { DocumentLayout, PageRect } from './pagelayout'

function article(ids: string[]): { article: HTMLElement; blocks: HTMLElement[] } {
  const el = document.createElement('article')
  el.className = 'dia-doc'
  const blocks = ids.map((id) => {
    const p = document.createElement('p')
    p.setAttribute('data-dia-id', id)
    el.append(p)
    return p
  })
  return { article: el, blocks }
}

function rect(page: number, blockId: string): PageRect {
  return { page, xMin: 0, xMax: 100, yMin: 0, yMax: 10, blockId }
}

function layoutOf(
  byBlock: Record<string, number[]>,
  source?: string,
): DocumentLayout {
  return {
    jobId: 'job-1',
    pages: [],
    source,
    byBlock: new Map(
      Object.entries(byBlock).map(([id, pages]) => [id, pages.map((p) => rect(p, id))]),
    ),
  }
}

describe('pageGroups', () => {
  it('opens a group each time the engine moved to a new page', () => {
    const { blocks } = article(['a', 'b', 'c', 'd'])
    const groups = pageGroups(blocks, layoutOf({ a: [1], b: [1], c: [2], d: [3] }))
    expect(groups.map((g) => [g.page, g.blocks.length])).toEqual([[1, 2], [2, 1], [3, 1]])
  })

  it('has no groups at all without a layout — the surface stays a scroll', () => {
    const { blocks } = article(['a', 'b'])
    expect(pageGroups(blocks, null)).toEqual([])
  })

  it('keeps a block the engine split whole, on the page it starts', () => {
    // `b`'s material stands on pages 1 and 2, so page 2's sheet begins at `c`
    // and carries the mark that page 1 holds some of the same prose
    const { blocks } = article(['a', 'b', 'c'])
    const groups = pageGroups(blocks, layoutOf({ a: [1], b: [1, 2], c: [2] }))
    expect(groups.map((g) => g.page)).toEqual([1, 2])
    expect(groups[0].blocks.map((b) => b.getAttribute('data-dia-id'))).toEqual(['a', 'b'])
    expect(groups[1].straddled).toBe(true)
    expect(groups[0].straddled).toBe(false)
  })

  it('rides an inkless block along instead of opening a page on it', () => {
    // a \clearpage or a label typesets nothing, so synctex reports no box for
    // it — it is not evidence of where a page began
    const { blocks } = article(['a', 'label', 'b'])
    const groups = pageGroups(blocks, layoutOf({ a: [1], b: [2] }))
    expect(groups.map((g) => g.blocks.map((x) => x.getAttribute('data-dia-id'))))
      .toEqual([['a', 'label'], ['b']])
  })

  it('still places inkless blocks that come before any inked one', () => {
    const { blocks } = article(['front', 'a'])
    const groups = pageGroups(blocks, layoutOf({ a: [1] }))
    expect(groups).toHaveLength(1)
    expect(groups[0].blocks.map((b) => b.getAttribute('data-dia-id'))).toEqual(['front', 'a'])
  })

  it('skips a page whose content the semantic view does not hold', () => {
    // a full-page float leaves a page with no block of its own; there is
    // nothing to draw a sheet around, and inventing one would claim content
    const { blocks } = article(['a', 'b'])
    expect(pageGroups(blocks, layoutOf({ a: [1], b: [4] })).map((g) => g.page))
      .toEqual([1, 4])
  })
})

describe('breaksAreCurrent', () => {
  it('is false with no layout — there are no breaks to be current about', () => {
    expect(breaksAreCurrent(null, 'x')).toBe(false)
  })

  it('is true while the document still reads as it compiled', () => {
    expect(breaksAreCurrent(layoutOf({ a: [1] }, 'tex'), 'tex')).toBe(true)
  })

  it('goes false the moment the source moves on', () => {
    // the breaks stay on screen; the surface marks them provisional, the way
    // auxnumbers marks a \ref whose .aux predates the edit
    expect(breaksAreCurrent(layoutOf({ a: [1] }, 'tex'), 'tex + more')).toBe(false)
  })

  it('counts an unknown source as current rather than raising an alarm', () => {
    expect(breaksAreCurrent(layoutOf({ a: [1] }), 'anything')).toBe(true)
    expect(breaksAreCurrent(layoutOf({ a: [1] }, 'tex'), undefined)).toBe(true)
  })
})

describe('pageBreakCss', () => {
  it('gaps every page start but the first, by position', () => {
    const { article: el, blocks } = article(['a', 'b', 'c'])
    const groups = pageGroups(blocks, layoutOf({ a: [1], b: [2], c: [3] }))
    const css = pageBreakCss(el, groups)
    expect(css).toContain('article.dia-doc > :nth-child(2)')
    expect(css).toContain('article.dia-doc > :nth-child(3)')
    expect(css).not.toContain(':nth-child(1)')
  })

  it('names no block, so nothing about the drawing reaches the saved file', () => {
    const { article: el, blocks } = article(['a', 'b'])
    const css = pageBreakCss(el, pageGroups(blocks, layoutOf({ a: [1], b: [2] })))
    expect(css).not.toContain('data-dia-id')
    expect(el.querySelector('[class]')).toBeNull()
  })

  it('hands the paper to the sheets even when the document is one page', () => {
    const { article: el, blocks } = article(['a'])
    const css = pageBreakCss(el, pageGroups(blocks, layoutOf({ a: [1] })))
    expect(css).toContain('background: transparent')
    expect(css).not.toContain('nth-child')
  })
})
