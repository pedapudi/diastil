/* The movable-unit rule is STRUCTURAL: any role class, any block tag,
 * math as a whole, islands as a whole, and top-level custom blocks —
 * never an allow-list that works on one element and dies on its
 * neighbor, and never inline runs or list-marker decoration. */

import { describe, expect, it } from 'vitest'
import { movableBlockFor } from './elemdrag'

function slideWith(inner: string): HTMLElement {
  const slide = document.createElement('section')
  slide.className = 'dia-slide'
  slide.innerHTML = inner
  document.body.appendChild(slide)
  return slide
}

describe('movableBlockFor', () => {
  it('role classes are units, from any inner target', () => {
    const slide = slideWith('<h2 class="dia-title">Big <em>idea</em></h2>')
    const em = slide.querySelector('em')!
    expect(movableBlockFor(em, slide)?.className).toBe('dia-title')
  })

  it('bare block tags are units even without a role class', () => {
    const slide = slideWith('<h2>plain heading</h2><p>plain para</p>')
    expect(movableBlockFor(slide.querySelector('h2')!, slide)?.tagName).toBe('H2')
    expect(movableBlockFor(slide.querySelector('p')!, slide)?.tagName).toBe('P')
  })

  it('math moves as one formula', () => {
    const slide = slideWith('<div class="dia-math"><math><mi>x</mi></math></div>')
    const mi = slide.querySelector('mi')!
    expect(movableBlockFor(mi, slide)?.className).toBe('dia-math')
  })

  it('custom-class blocks sitting on the slide are units', () => {
    const slide = slideWith('<div class="panel"><span>label</span></div>')
    const span = slide.querySelector('span')!
    expect(movableBlockFor(span, slide)?.className).toBe('panel')
  })

  it('the island root wins over anything inside it', () => {
    const slide = slideWith('<div data-dia-island="chart"><p>inside</p></div>')
    const p = slide.querySelector('p')!
    expect(movableBlockFor(p, slide)?.hasAttribute('data-dia-island')).toBe(true)
  })

  it('list markers are never a unit — the list is', () => {
    const slide = slideWith('<ul><li><span class="dia-marker">▸</span> item</li></ul>')
    const marker = slide.querySelector('.dia-marker')!
    expect(movableBlockFor(marker, slide)?.tagName).toBe('UL')
  })

  it('the slide itself is never a unit', () => {
    const slide = slideWith('<p>x</p>')
    expect(movableBlockFor(slide, slide)).toBeNull()
  })
})
