/* The pptx renderer against the deterministic fixture: geometry scaled to
 * the 1280 design box, placeholder inheritance from layout+master, theme
 * colors and fonts resolved, bullets, images, tables, chart lift hints,
 * speaker notes, hidden slides skipped. */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { looksLikePptx, pptxToHtml } from './pptx'

const bytes = new Uint8Array(readFileSync('src/ingest/__fixtures__/basic.pptx'))
const html = pptxToHtml(bytes, 'basic.pptx')
const doc = new DOMParser().parseFromString(html, 'text/html')
const slides = [...doc.querySelectorAll('section.pptx-slide')]

describe('pptxToHtml', () => {
  it('detects pptx by name and magic', () => {
    expect(looksLikePptx(bytes, 'x.pptx')).toBe(true)
    expect(looksLikePptx(bytes)).toBe(true) // PK magic
    expect(looksLikePptx(new Uint8Array([1, 2, 3, 4]))).toBe(false)
  })

  it('renders visible slides at the design size and skips hidden ones', () => {
    expect(slides.length).toBe(2) // slide 3 is show="0"
    expect(html).not.toContain('HIDDEN SLIDE')
    const style = slides[0].getAttribute('style') ?? ''
    expect(style).toContain('width: 1280px')
    expect(style).toContain('height: 720px')
    expect(style).toContain('#fdfbf7') // master bg via scheme bg1 → lt1
  })

  it('title inherits geometry from the layout and style from the master', () => {
    const title = [...slides[0].querySelectorAll('span')].find((s) => s.textContent === 'Quarterly Review')!
    expect(title).toBeTruthy()
    const span = title.getAttribute('style') ?? ''
    expect(span).toContain('font-weight: bold') // titleStyle b=1
    expect(span).toContain('Georgia') // +mj-lt → theme major font
    expect(span).toContain('#30404f') // tx2 → dk2
    // geometry from the layout placeholder (the slide sp has no xfrm)
    const box = title.closest('div[style*="left:"]')!
    expect(box.getAttribute('style')).toContain('left: 88px') // 838200 EMU
  })

  it('body bullets: level markers and per-run overrides', () => {
    const s1 = slides[0]
    expect(s1.textContent).toContain('• Revenue grew steadily')
    expect(s1.textContent).toContain('– EMEA led the growth') // lvl2 buChar
    const costs = [...s1.querySelectorAll('span')].find((s) => s.textContent === 'Costs held flat')!
    expect(costs.getAttribute('style')).toContain('font-weight: bold')
    expect(costs.getAttribute('style')).toContain('#c05330') // accent2 run color
  })

  it('shapes: rotation, lum-transformed scheme fill, border', () => {
    const badge = [...slides[0].querySelectorAll('div')].find((d) =>
      (d.getAttribute('style') ?? '').includes('rotate(45deg)'))!
    expect(badge).toBeTruthy()
    const style = badge.getAttribute('style') ?? ''
    expect(style).toContain('border-radius') // roundRect
    expect(style).toContain('border: 2px solid #123456')
    // accent1 2E6FBA with lumMod 75% is darker than the base
    expect(style).toMatch(/background: #[0-9a-f]{6}/)
    expect(style).not.toContain('background: #2e6fba')
  })

  it('images embed as data URIs', () => {
    const img = slides[0].querySelector('img')!
    expect(img.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
  })

  it('tables carry cells, header fills, and column widths', () => {
    const table = slides[1].querySelector('table')!
    expect(table.textContent).toContain('EMEA')
    expect(table.textContent).toContain('44%')
    const th = [...table.querySelectorAll('td')].find((td) => td.textContent?.includes('Region'))!
    expect(th.getAttribute('style')).toContain('background: #2e6fba') // accent1 header
  })

  it('charts render bars and carry dia-chart lift hints', () => {
    const chart = slides[1].querySelector('svg[data-chart]')!
    expect(chart.getAttribute('data-chart')).toBe('bar')
    expect(chart.getAttribute('data-values')).toBe('Q1:12, Q2:19, Q3:7')
    expect(chart.querySelectorAll('rect').length).toBe(3)
  })

  it('speaker notes land as aside.dia-notes', () => {
    const notes = slides[0].querySelector('aside.dia-notes')!
    expect(notes.textContent).toContain('EMEA anecdote')
    expect(slides[1].querySelector('aside.dia-notes')).toBeNull()
  })

  it('rejects non-presentations with a readable error', () => {
    expect(() => pptxToHtml(new Uint8Array([0x50, 0x4b, 3, 4]), 'junk.pptx')).toThrow(/junk\.pptx/)
  })
})
