/* Extractor registry — each framework fixture is detected by the right
 * extractor with the right slide roots. The generic `siblings` heuristic
 * needs layout, so it is exercised in-browser, not here. */

import { describe, expect, it } from 'vitest'
import revealRaw from '../../../examples/fixtures/foreign-reveal.html?raw'
import marpRaw from '../../../examples/fixtures/foreign-marp.html?raw'
import remarkRaw from '../../../examples/fixtures/foreign-remark.html?raw'
import impressRaw from '../../../examples/fixtures/foreign-impress.html?raw'
import { findSlideRoots } from './index'

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html')

describe('framework extractors', () => {
  it('reveal: flattens vertical stacks into linear order', () => {
    const { roots, method } = findSlideRoots(parse(revealRaw))
    expect(method).toBe('reveal')
    expect(roots.length).toBe(4) // 2 top-level + 2 from the vertical stack
    expect(roots[2].querySelector('h2')?.textContent).toBe('Risks — infra')
    expect(roots[3].querySelector('h2')?.textContent).toBe('Risks — product')
  })

  it('marp: one root per section, outermost only', () => {
    const { roots, method } = findSlideRoots(parse(marpRaw))
    expect(method).toBe('marp')
    expect(roots.length).toBe(3)
    expect(roots[0].querySelector('h1')?.textContent).toBe('Design system notes')
  })

  it('remark: slide content elements, all containers (not just visible)', () => {
    const { roots, method } = findSlideRoots(parse(remarkRaw))
    expect(method).toBe('remark')
    expect(roots.length).toBe(3)
    expect(roots[1].querySelector('h2')?.textContent).toBe('Timeline')
  })

  it('impress: steps in document order', () => {
    const { roots, method } = findSlideRoots(parse(impressRaw))
    expect(method).toBe('impress')
    expect(roots.length).toBe(3)
    expect(roots[1].querySelector('h1')?.textContent).toBe('Platform')
  })

  it('unrecognized static markup falls back to whole-body', () => {
    const { roots, method } = findSlideRoots(parse('<p>just a page</p>'))
    expect(method).toBe('body')
    expect(roots.length).toBe(1)
  })
})

describe('siblings extractor (layout simulated)', () => {
  function rect(w: number, h: number, top = 0): () => DOMRect {
    return () => ({ width: w, height: h, top, bottom: top + h, left: 0, right: w, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
  }

  it('one-visible-at-a-time deck: state class folds, hidden majority accepted', () => {
    // the zicato shape: 12 div.slide under one wrapper, the runtime marks the
    // current slide `slide on`; the other 11 are display:none (zero rect)
    document.body.innerHTML = '<div id="wrap"></div>'
    const wrap = document.getElementById('wrap')!
    for (let i = 0; i < 12; i++) {
      const d = document.createElement('div')
      d.className = i === 0 ? 'slide on' : 'slide'
      d.getBoundingClientRect = rect(i === 0 ? 1280 : 0, i === 0 ? 720 : 0)
      wrap.appendChild(d)
    }
    const { roots, method } = findSlideRoots(document)
    expect(method).toBe('siblings')
    expect(roots.length).toBe(12)
    document.body.innerHTML = ''
  })

  it('a larger deeper group beats a shallow qualifying pair', () => {
    document.body.innerHTML = '<div id="a"></div><div id="b"></div>'
    const a = document.getElementById('a')!
    const b = document.getElementById('b')!
    a.getBoundingClientRect = rect(1280, 720, 0)
    b.getBoundingClientRect = rect(1280, 720, 720)
    for (let i = 0; i < 3; i++) {
      const d = document.createElement('div')
      d.className = 'page'
      d.getBoundingClientRect = rect(1280, 720, i * 720)
      a.appendChild(d)
    }
    const { roots } = findSlideRoots(document)
    expect(roots.length).toBe(3)
    expect(roots[0].className).toBe('page')
    document.body.innerHTML = ''
  })
})
