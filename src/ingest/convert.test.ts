/* Ingest conversion — deck assembly is in-profile, islands preserve the
 * original subtree verbatim and stay exempt, text-sacred confidence math. */

import { describe, expect, it } from 'vitest'
import { validateDeckHtml } from '../model/validate'
import { assembleDeck, islandEntireSlide, tokensToCss } from './convert'
import type { ExtractedSlide } from './extract'

function minimalSlide(over: Partial<ExtractedSlide> = {}): ExtractedSlide {
  return {
    index: 0,
    source: document.createElement('div'),
    html: '<div></div>',
    sourceHtml: '<div>hello</div>',
    originalHtml: '',
    rect: { x: 0, y: 0, w: 1280, h: 720 },
    layoutW: 1280,
    bg: '#ffffff',
    samples: {},
    texts: ['hello'],
    padPx: 48,
    gaps: [],
    ...over,
  }
}

describe('tokensToCss', () => {
  it('emits a :root block with one declaration per token', () => {
    const css = tokensToCss({ '--dia-paper': '#fff', '--dia-gap': '24px' })
    expect(css).toContain(':root {')
    expect(css).toContain('--dia-paper: #fff;')
    expect(css).toContain('--dia-gap: 24px;')
  })
})

describe('assembleDeck', () => {
  it('produces an in-profile document', () => {
    const html = assembleDeck(
      ['<section class="dia-slide"><h1 class="dia-title">Hi</h1></section>'],
      { '--dia-paper': '#fbfaf6' },
      'converted deck',
    )
    const report = validateDeckHtml(html)
    expect(report.findings.filter((f) => f.level === 'error')).toEqual([])
    expect(report.slideCount).toBe(1)
    expect(html).toContain('<title>converted deck</title>')
  })
})

describe('islandEntireSlide', () => {
  it('preserves the original subtree verbatim, marked as an island', () => {
    const source = '<div onclick="tick()">live widget<script>tick()</script></div>'
    const conv = islandEntireSlide(minimalSlide({ sourceHtml: source, texts: ['live widget'] }), 0)
    expect(conv.html).toContain('data-dia-island')
    expect(conv.html).toContain('onclick="tick()"')
    expect(conv.islands).toBe(1)
    expect(conv.notes[0]).toMatchObject({ kind: 'island', slideIndex: 0 })
  })

  it('islanded slides still assemble to an in-profile deck (island exemption)', () => {
    const conv = islandEntireSlide(
      minimalSlide({ sourceHtml: '<div onclick="x()"><iframe></iframe>sim</div>', texts: ['sim'] }),
      0,
    )
    const report = validateDeckHtml(assembleDeck([conv.html], {}, 'islands'))
    expect(report.findings.filter((f) => f.level === 'error')).toEqual([])
  })

  it('applies the 0.9 island confidence factor when text survives', () => {
    const conv = islandEntireSlide(minimalSlide({ sourceHtml: '<p>hello</p>', texts: ['hello'] }), 0)
    expect(conv.confidence).toBe(0.9)
    expect(conv.warnings).toEqual([])
  })
})
