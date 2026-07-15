import { describe, expect, it } from 'vitest'
import { sanitizeSvg } from './svgimport'
import { canStudio } from './studio'

const SVG = 'http://www.w3.org/2000/svg'

describe('sanitizeSvg', () => {
  it('rejects markup that is not svg', () => {
    expect(sanitizeSvg('<div>nope</div>')).toBeNull()
    expect(sanitizeSvg('not even markup')).toBeNull()
  })

  it('keeps ordinary artwork intact', () => {
    const clean = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect x="1" y="1" width="4" height="4" fill="#c00"/><path d="M0,0 L10,10"/></svg>')
    expect(clean).not.toBeNull()
    expect(clean!.querySelector('rect')?.getAttribute('fill')).toBe('#c00')
    expect(clean!.querySelector('path')?.getAttribute('d')).toBe('M0,0 L10,10')
  })

  it('strips scripts, event handlers, and foreignObject', () => {
    const clean = sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg">
      <script>alert(1)</script>
      <rect width="4" height="4" onclick="alert(2)"/>
      <foreignObject><body xmlns="http://www.w3.org/1999/xhtml">html</body></foreignObject>
    </svg>`)
    expect(clean).not.toBeNull()
    expect(clean!.querySelector('script')).toBeNull()
    expect(clean!.querySelector('foreignObject, foreignobject')).toBeNull()
    expect(clean!.querySelector('rect')?.hasAttribute('onclick')).toBe(false)
  })

  it('strips remote and javascript: references but keeps data: images', () => {
    const clean = sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
      <image href="https://evil.example/x.png"/>
      <image href="data:image/png;base64,AAAA"/>
      <a href="javascript:alert(1)"><text>x</text></a>
    </svg>`)
    expect(clean).not.toBeNull()
    const images = [...clean!.querySelectorAll('image')]
    expect(images[0].hasAttribute('href')).toBe(false)
    expect(images[1].getAttribute('href')).toBe('data:image/png;base64,AAAA')
    expect(clean!.querySelector('a')?.hasAttribute('href')).toBe(false)
  })

  it('preserves animation elements — animated imports are supported', () => {
    const clean = sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg">
      <circle r="3"><animate attributeName="r" values="3;5;3" dur="2s" repeatCount="indefinite"/></circle>
    </svg>`)
    expect(clean).not.toBeNull()
    expect(clean!.querySelector('animate')?.getAttribute('dur')).toBe('2s')
  })
})

describe('canStudio', () => {
  it('accepts plain svg artwork', () => {
    const svg = document.createElementNS(SVG, 'svg')
    expect(canStudio(svg)).toBe(true)
  })

  it('refuses scenes — they keep their semantic editor', () => {
    const scene = document.createElementNS(SVG, 'svg')
    scene.setAttribute('class', 'dia-scene')
    expect(canStudio(scene)).toBe(false)
    const full = document.createElementNS(SVG, 'svg')
    full.setAttribute('class', 'dia-scene dia-scene-full')
    expect(canStudio(full)).toBe(false)
  })

  it('refuses non-svg elements', () => {
    expect(canStudio(document.createElement('div'))).toBe(false)
  })
})
