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
    fontWeight: 400, fontStyle: 'normal', letterSpacing: 'normal', textTransform: 'none',
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

describe('ink carry', () => {
  const TOKENS = {
    '--dia-ink': 'rgb(20, 20, 20)',
    '--dia-ink-soft': 'rgb(110, 110, 110)',
    '--dia-accent': 'rgb(180, 85, 45)',
    '--dia-paper': 'rgb(255, 255, 255)',
    '--dia-rule': 'rgb(220, 220, 220)',
  }
  const two = (bodyColor: string) => minimalSlide({
    html: '<div data-dia-x="0"><h1 data-dia-x="1">Title</h1><p data-dia-x="2">body text</p></div>',
    texts: [],
    samples: {
      0: sample({ x: 0, y: 0, w: 1280, h: 720, ownChars: 0, ownText: '' }),
      1: sample({ y: 100, ownText: 'Title', fontSizePx: 40, color: 'rgb(20, 20, 20)' }),
      2: sample({ y: 200, ownText: 'body text', fontSizePx: 20, color: bodyColor }),
    },
  })
  const bodyOf = (slide: ExtractedSlide) => {
    const conv = convertSlide(slide, 0, [], 0, TOKENS)
    return new DOMParser().parseFromString(conv.html, 'text/html').querySelector<HTMLElement>('.dia-body')!
  }

  it('body text matching the deck ink is NOT left to the soft role default', () => {
    expect(bodyOf(two('rgb(20, 20, 20)')).style.color).toBe('var(--dia-ink)')
  })

  it('body text matching the soft token stays with the theme rule', () => {
    expect(bodyOf(two('rgb(110, 110, 110)')).style.color).toBe('')
  })

  it('a non-token color carries literally', () => {
    expect(bodyOf(two('rgb(200, 40, 90)')).style.color).toBe('rgb(200, 40, 90)')
  })

  it('a token-matching color binds as a var so the theme picker retints it', () => {
    expect(bodyOf(two('rgb(180, 85, 45)')).style.color).toBe('var(--dia-accent)')
  })

  it('without harvested tokens the pass stays out of the way', () => {
    const conv = convertSlide(two('rgb(200, 40, 90)'), 0)
    const el = new DOMParser().parseFromString(conv.html, 'text/html').querySelector<HTMLElement>('.dia-body')!
    expect(el.style.color).toBe('')
  })
})

describe('vertical anchoring', () => {
  it('a trailing low block separated by a gap pins to the bottom', () => {
    const slide = minimalSlide({
      html: '<div data-dia-x="0"><h1 data-dia-x="1">Title</h1><p data-dia-x="2">content</p><p data-dia-x="3">footer · page 12</p></div>',
      texts: [],
      samples: {
        0: sample({ x: 0, y: 0, w: 1280, h: 720, ownChars: 0, ownText: '' }),
        1: sample({ y: 60, h: 60, ownText: 'Title', fontSizePx: 40 }),
        2: sample({ y: 140, h: 80, ownText: 'content' }),
        3: sample({ y: 650, h: 30, ownText: 'footer · page 12', fontSizePx: 12 }),
      },
    })
    const doc = convertToDoc(slide)
    const section = doc.querySelector<HTMLElement>('section.dia-slide')!
    expect(section.style.display).toBe('flex')
    const blocks = [...section.children] as HTMLElement[]
    const footer = blocks.find((b) => b.textContent?.includes('footer'))!
    expect(footer.style.marginTop).toBe('auto')
    // body starts near the top — no auto margin above it
    expect(blocks[0].style.marginTop).toBe('')
  })

  it('body clear of the top AND a footer → both anchored (body centered between)', () => {
    const slide = minimalSlide({
      html: '<div data-dia-x="0"><p data-dia-x="1">statement</p><p data-dia-x="2">footer</p></div>',
      texts: [],
      samples: {
        0: sample({ x: 0, y: 0, w: 1280, h: 720, ownChars: 0, ownText: '' }),
        1: sample({ y: 280, h: 80, ownText: 'statement', fontSizePx: 40 }),
        2: sample({ y: 660, h: 30, ownText: 'footer', fontSizePx: 12 }),
      },
    })
    const doc = convertToDoc(slide)
    const blocks = [...doc.querySelector('section.dia-slide')!.children] as HTMLElement[]
    expect(blocks[0].style.marginTop).toBe('auto')
    expect(blocks[1].style.marginTop).toBe('auto')
  })

  it('content flowing to the bottom stays plain flow — no false footer', () => {
    const slide = minimalSlide({
      html: '<div data-dia-x="0"><h1 data-dia-x="1">Title</h1><p data-dia-x="2">a</p><p data-dia-x="3">b</p></div>',
      texts: [],
      samples: {
        0: sample({ x: 0, y: 0, w: 1280, h: 720, ownChars: 0, ownText: '' }),
        1: sample({ y: 60, h: 60, ownText: 'Title' }),
        2: sample({ y: 140, h: 260, ownText: 'a' }),
        3: sample({ y: 420, h: 260, ownText: 'b' }),
      },
    })
    const doc = convertToDoc(slide)
    const section = doc.querySelector<HTMLElement>('section.dia-slide')!
    expect([...section.children].every((b) => (b as HTMLElement).style.marginTop === '')).toBe(true)
  })
})

describe('typesetting carry (family · weight · slant)', () => {
  const TOKENS = {
    '--dia-ink': 'rgb(20, 20, 20)',
    '--dia-ink-soft': 'rgb(110, 110, 110)',
    '--dia-accent': 'rgb(180, 85, 45)',
    '--dia-face-display': 'Georgia, serif',
    '--dia-face-body': 'Helvetica, sans-serif',
    '--dia-face-label': '"SF Mono", monospace',
  }
  const one = (over: Partial<ElementSample>) => minimalSlide({
    html: '<div data-dia-x="0"><h1 data-dia-x="1">Big</h1><p data-dia-x="2">body text</p></div>',
    texts: [],
    samples: {
      0: sample({ x: 0, y: 0, w: 1280, h: 720, ownChars: 0, ownText: '' }),
      1: sample({ y: 100, ownText: 'Big', fontSizePx: 40, color: 'rgb(20, 20, 20)', fontFamily: 'Georgia, serif' }),
      2: sample({ y: 200, ownText: 'body text', fontSizePx: 20, color: 'rgb(110, 110, 110)', fontFamily: 'Helvetica, sans-serif', ...over }),
    },
  })
  const bodyEl = (over: Partial<ElementSample>) => {
    const conv = convertSlide(one(over), 0, [], 0, TOKENS)
    return new DOMParser().parseFromString(conv.html, 'text/html').querySelector<HTMLElement>('.dia-body')!
  }

  it('a face matching another face token binds as its var', () => {
    expect(bodyEl({ fontFamily: '"SF Mono", ui-monospace, monospace' }).style.fontFamily)
      .toBe('var(--dia-face-label)')
  })

  it('an off-token face carries literally', () => {
    expect(bodyEl({ fontFamily: '"Comic Sans MS", cursive' }).style.fontFamily).toBe('"Comic Sans MS", cursive')
  })

  it('the role face stays with the theme rule', () => {
    expect(bodyEl({}).style.fontFamily).toBe('')
  })

  it('bold body text keeps its weight; the title role default does not leak in', () => {
    expect(bodyEl({ fontWeight: 700 }).style.fontWeight).toBe('700')
    expect(bodyEl({ fontWeight: 500 }).style.fontWeight).toBe('') // rendering noise
  })

  it('a light title keeps its weight against the 700 role default', () => {
    const conv = convertSlide(one({}), 0, [], 0, TOKENS)
    const doc = new DOMParser().parseFromString(conv.html, 'text/html')
    expect(doc.querySelector<HTMLElement>('.dia-title')!.style.fontWeight).toBe('400')
  })

  it('italic carries as font-style', () => {
    expect(bodyEl({ fontStyle: 'italic' }).style.fontStyle).toBe('italic')
  })
})

describe('explicit inter-block spacing', () => {
  it('a large source gap becomes a proportional margin', () => {
    const slide = minimalSlide({
      html: '<div data-dia-x="0"><h1 data-dia-x="1">Title</h1><p data-dia-x="2">later</p></div>',
      texts: [],
      samples: {
        0: sample({ x: 0, y: 0, w: 1280, h: 720, ownChars: 0, ownText: '' }),
        1: sample({ y: 60, h: 60, ownText: 'Title' }),
        2: sample({ y: 300, h: 60, ownText: 'later' }), // gap 180 of 720
      },
    })
    const doc = convertToDoc(slide)
    const later = [...doc.querySelectorAll<HTMLElement>('section.dia-slide > *')]
      .find((b) => b.textContent?.includes('later'))!
    // read the attribute: happy-dom's CSSOM drops cqw values on re-parse
    expect(later.getAttribute('style')).toContain('margin-top: 14.06cqw') // 180/1280
  })

  it('small flow gaps stay with the theme', () => {
    const slide = minimalSlide({
      html: '<div data-dia-x="0"><h1 data-dia-x="1">Title</h1><p data-dia-x="2">next</p></div>',
      texts: [],
      samples: {
        0: sample({ x: 0, y: 0, w: 1280, h: 720, ownChars: 0, ownText: '' }),
        1: sample({ y: 60, h: 60, ownText: 'Title' }),
        2: sample({ y: 140, h: 60, ownText: 'next' }), // gap 20 < 4% of 720
      },
    })
    const doc = convertToDoc(slide)
    const next = [...doc.querySelectorAll<HTMLElement>('section.dia-slide > *')]
      .find((b) => b.textContent?.includes('next'))!
    expect(next.style.marginTop).toBe('')
  })
})

describe('animated svgs survive conversion', () => {
  const withSvg = (svg: string) => minimalSlide({
    html: `<div data-dia-x="0"><h1 data-dia-x="1">Title</h1><svg data-dia-x="2" viewBox="0 0 100 100">${svg}</svg></div>`,
    texts: [],
    samples: {
      0: sample({ x: 0, y: 0, w: 1280, h: 720, ownChars: 0, ownText: '' }),
      1: sample({ y: 60, h: 60, ownText: 'Title' }),
      2: sample({ y: 200, h: 300, w: 300, ownChars: 0, ownText: '' }),
    },
  })

  it('SMIL animation is kept verbatim, never lifted', () => {
    const doc = convertToDoc(withSvg(
      '<rect x="10" y="10" width="50" height="20"><animate attributeName="x" from="10" to="40" dur="2s" repeatCount="indefinite"/></rect>'))
    expect(doc.querySelector('animate')).not.toBeNull()
    expect(doc.querySelector('[data-dia-node]')).toBeNull() // no lift
    expect(doc.querySelector('svg')?.closest('.dia-figure, figure')).not.toBeNull()
  })

  it('css-animated svgs (inline animation-name) stay verbatim, unlifted', () => {
    // happy-dom's parser drops <style> inside svg, so this exercises the
    // inline animation-name detection (extraction always writes it); the
    // keyframes <style> path is browser-verified
    const doc = convertToDoc(withSvg(
      '<rect x="10" y="10" width="50" height="20" style="animation-name: spin; animation-duration: 2s;"/>'))
    expect(doc.querySelector('svg rect')?.getAttribute('style')).toContain('animation-name')
    expect(doc.querySelector('[data-dia-node]')).toBeNull()
  })

  it('a static svg still lifts deterministically', () => {
    const doc = convertToDoc(withSvg('<rect x="10" y="10" width="50" height="20"/>'))
    expect(doc.querySelector('[data-dia-node]')).not.toBeNull()
  })
})
