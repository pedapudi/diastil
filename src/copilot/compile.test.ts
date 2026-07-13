/* Target resolution is forgiving on purpose: models describe elements the
 * way people do ("slide 2 title"), not by session ids. */

import { describe, expect, it } from 'vitest'
import { resolveTarget } from './compile'

const DECK = `
<section class="dia-slide">
  <div class="dia-kicker">diastil</div>
  <h1 class="dia-title" data-dia-id="id-t1">First title</h1>
  <div class="dia-body">Intro body</div>
</section>
<section class="dia-slide">
  <div class="dia-kicker">premise</div>
  <h1 class="dia-title">The saved file is plain HTML</h1>
  <div class="dia-body"><p>Alpha paragraph.</p><p>Beta paragraph.</p></div>
  <div class="dia-body">Second body block</div>
</section>`

function setup(): { root: HTMLElement; slides: HTMLElement[] } {
  const root = document.createElement('div')
  root.innerHTML = DECK
  return { root, slides: [...root.querySelectorAll<HTMLElement>('section.dia-slide')] }
}

describe('resolveTarget', () => {
  const { root, slides } = setup()
  const find = (t: string, current = 0) => resolveTarget(t, root, slides, current)

  it('data-dia-id wins outright', () => {
    expect(find('id-t1')?.textContent).toBe('First title')
  })

  it('"slide N" resolves the section', () => {
    expect(find('slide 2')).toBe(slides[1])
    expect(find('Slide #1')).toBe(slides[0])
  })

  it('"slide N <role>" with friendly aliases', () => {
    expect(find('slide 2 title')?.textContent).toBe('The saved file is plain HTML')
    expect(find('slide 2 kicker')?.textContent).toBe('premise')
    expect(find('slide 1 dia-body')?.textContent).toBe('Intro body')
  })

  it('ordinals pick the nth match', () => {
    expect(find('slide 2 body 2')?.textContent).toBe('Second body block')
    expect(find('slide 2 dia-body #2')?.textContent).toBe('Second body block')
  })

  it('bare descriptors resolve against the current slide first', () => {
    expect(find('title', 1)?.textContent).toBe('The saved file is plain HTML')
    expect(find('title', 0)?.textContent).toBe('First title')
  })

  it('CSS selectors still work', () => {
    expect(find('section.dia-slide .dia-kicker')?.textContent).toBe('diastil')
  })

  it('text matching finds the innermost element', () => {
    expect(find('"Beta paragraph."')?.tagName).toBe('P')
    expect(find('The saved file')?.classList.contains('dia-title')).toBe(true)
  })

  it('unresolvable targets are null, never a throw', () => {
    expect(find('slide 9 title')).toBeNull()
    expect(find('nothing matches this at all')).toBeNull()
  })
})
