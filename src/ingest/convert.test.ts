/* Ingest conversion — deck assembly is in-profile, islands preserve the
 * original subtree verbatim and stay exempt, text-sacred confidence math. */

import { describe, expect, it } from 'vitest'
import { validateDeckHtml } from '../model/validate'
import { assembleDeck, convertSlide, islandEntireSlide, tokensToCss } from './convert'
import type { ElementSample, ExtractedSlide } from './extract'

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

/* Conversion carries MEANING the pixel score can't see: staggered entrance
 * delays become build steps, and measured typography (transform, tracking,
 * leading) overrides the role rules' one-voice guess. */

function sample(over: Partial<ElementSample> = {}): ElementSample {
  return {
    x: 100, y: 100, w: 400, h: 40,
    fontSizePx: 20, fontFamily: 'Georgia, serif', color: 'rgb(20, 20, 20)',
    fontWeight: 400, letterSpacing: 'normal', textTransform: 'none',
    position: 'static', objectFit: 'fill',
    background: 'rgba(0, 0, 0, 0)', bgImage: 'none',
    borderW: 0, borderColor: 'rgb(0, 0, 0)', borderStyle: 'none', borderUniform: true,
    radius: '0px', transform: 'none',
    lineHeight: 0,
    ownChars: over.ownText?.length ?? 5, ownText: 'hello',
    ...over,
  }
}

function convertToDoc(slide: ExtractedSlide): Document {
  const conv = convertSlide(slide, 0)
  return new DOMParser().parseFromString(conv.html, 'text/html')
}

describe('build steps from entrance delays', () => {
  const stacked = (i: number) => ({ x: 100, y: 100 + i * 120, w: 400, h: 40 })

  it('distinct positive delays become ordered data-dia-step groups', () => {
    const slide = minimalSlide({
      html: '<div data-dia-x="0"><p data-dia-x="1">alpha</p><p data-dia-x="2">beta</p><p data-dia-x="3">gamma</p></div>',
      texts: [],
      samples: {
        0: sample({ x: 0, y: 0, w: 1280, h: 720, ownChars: 0, ownText: '' }),
        1: sample({ ...stacked(0), ownText: 'alpha', stepDelayMs: 200 }),
        2: sample({ ...stacked(1), ownText: 'beta', stepDelayMs: 400 }),
        3: sample({ ...stacked(2), ownText: 'gamma', stepDelayMs: 400 }),
      },
    })
    const doc = convertToDoc(slide)
    const stepped = [...doc.querySelectorAll('[data-dia-step]')]
    expect(stepped.map((el) => [el.textContent, el.getAttribute('data-dia-step')])).toEqual([
      ['alpha', '1'], ['beta', '2'], ['gamma', '2'],
    ])
  })

  it('a single distinct delay is a flourish, not a build — no steps', () => {
    const slide = minimalSlide({
      html: '<div data-dia-x="0"><p data-dia-x="1">alpha</p><p data-dia-x="2">beta</p></div>',
      texts: [],
      samples: {
        0: sample({ x: 0, y: 0, w: 1280, h: 720, ownChars: 0, ownText: '' }),
        1: sample({ ...stacked(0), ownText: 'alpha', stepDelayMs: 300 }),
        2: sample({ ...stacked(1), ownText: 'beta', stepDelayMs: 300 }),
      },
    })
    expect(convertToDoc(slide).querySelector('[data-dia-step]')).toBeNull()
  })

  it('an animation soup (>9 distinct delays) leaves the slide static', () => {
    const samples: Record<number, ElementSample> = {
      0: sample({ x: 0, y: 0, w: 1280, h: 720, ownChars: 0, ownText: '' }),
    }
    let html = '<div data-dia-x="0">'
    for (let i = 1; i <= 11; i++) {
      html += `<p data-dia-x="${i}">t${i}</p>`
      samples[i] = sample({ ...stacked(i - 1), ownText: `t${i}`, stepDelayMs: i * 100 })
    }
    html += '</div>'
    const slide = minimalSlide({ html, texts: [], samples })
    expect(convertToDoc(slide).querySelector('[data-dia-step]')).toBeNull()
  })

  it('a frozen looping animation is noted, never silent', () => {
    const slide = minimalSlide({
      html: '<div data-dia-x="0"><p data-dia-x="1">alpha</p></div>',
      texts: [],
      samples: {
        0: sample({ x: 0, y: 0, w: 1280, h: 720, ownChars: 0, ownText: '' }),
        1: sample({ ownText: 'alpha' }),
      },
      hasLoopingAnimation: true,
    })
    const conv = convertSlide(slide, 0)
    expect(conv.notes.some((n) => n.note.includes('looping animation'))).toBe(true)
  })
})

describe('typography capture', () => {
  it('uppercase + tracking carry onto non-kicker roles', () => {
    const slide = minimalSlide({
      html: '<div data-dia-x="0"><p data-dia-x="1">shouted words</p></div>',
      texts: [],
      samples: {
        0: sample({ x: 0, y: 0, w: 1280, h: 720, ownChars: 0, ownText: '' }),
        1: sample({
          ownText: 'shouted words', fontSizePx: 20,
          textTransform: 'uppercase', letterSpacing: '2px',
        }),
      },
    })
    const el = convertToDoc(slide).querySelector<HTMLElement>('.dia-title, .dia-body')!
    expect(el).not.toBeNull()
    expect(el.style.textTransform).toBe('uppercase')
    expect(el.style.letterSpacing).toBe('0.1em')
  })

  it('measured leading overrides the role default when it deviates >15%', () => {
    const slide = minimalSlide({
      html: '<div data-dia-x="0"><p data-dia-x="1">roomy title</p></div>',
      texts: [],
      samples: {
        0: sample({ x: 0, y: 0, w: 1280, h: 720, ownChars: 0, ownText: '' }),
        // the sole text block becomes the title (leading default 1.14)
        1: sample({ ownText: 'roomy title', fontSizePx: 20, lineHeight: 40 }),
      },
    })
    const el = convertToDoc(slide).querySelector<HTMLElement>('.dia-title')!
    expect(el).not.toBeNull()
    expect(el.style.lineHeight).toBe('2')
  })

  it('leading close to the role default stays with the theme', () => {
    const slide = minimalSlide({
      html: '<div data-dia-x="0"><p data-dia-x="1">normal title</p></div>',
      texts: [],
      samples: {
        0: sample({ x: 0, y: 0, w: 1280, h: 720, ownChars: 0, ownText: '' }),
        1: sample({ ownText: 'normal title', fontSizePx: 20, lineHeight: 23 }),
      },
    })
    const el = convertToDoc(slide).querySelector<HTMLElement>('.dia-title')!
    expect(el).not.toBeNull()
    expect(el.style.lineHeight).toBe('')
  })

  it('kickers stay with the theme — no double uppercase/tracking', () => {
    const slide = minimalSlide({
      html: '<div data-dia-x="0"><p data-dia-x="1">THE KICKER</p><p data-dia-x="2">The big title</p></div>',
      texts: [],
      samples: {
        0: sample({ x: 0, y: 0, w: 1280, h: 720, ownChars: 0, ownText: '' }),
        1: sample({
          ownText: 'THE KICKER', fontSizePx: 12, y: 60, h: 16,
          textTransform: 'uppercase', letterSpacing: '1.68px',
        }),
        2: sample({ ownText: 'The big title', fontSizePx: 44, y: 120, h: 52 }),
      },
    })
    const doc = convertToDoc(slide)
    const kicker = doc.querySelector<HTMLElement>('.dia-kicker')
    expect(kicker).not.toBeNull()
    expect(kicker!.style.textTransform).toBe('')
    expect(kicker!.style.letterSpacing).toBe('')
  })
})
