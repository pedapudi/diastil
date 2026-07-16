/* Profile validator — each rule id from profile/PROFILE.md fires on the
 * construct it names, and islands are exempt from content rules. */

import { describe, expect, it } from 'vitest'
import demoRaw from '../../examples/demo-deck.html?raw'
import { validateDeckHtml, validateDocument, type ProfileReport } from './validate'

function check(mutate?: (doc: Document) => void): ProfileReport {
  const doc = new DOMParser().parseFromString(demoRaw, 'text/html')
  mutate?.(doc)
  return validateDocument(doc)
}

const rules = (r: ProfileReport) => r.findings.map((f) => f.rule)
const slide = (doc: Document) => doc.querySelector<HTMLElement>('section.dia-slide')!

it('the demo deck is in-profile with no findings', () => {
  const r = check()
  expect(r.findings).toEqual([])
  expect(r.ok).toBe(true)
  expect(r.slideCount).toBe(8)
  expect(r.version).toBe('1')
})

describe('frame rules', () => {
  it('frame/version — missing data-dia-version', () => {
    const r = check((d) => d.documentElement.removeAttribute('data-dia-version'))
    expect(rules(r)).toContain('frame/version')
    expect(r.ok).toBe(false)
  })

  it('frame/theme — missing theme block', () => {
    const r = check((d) => d.querySelector('style#dia-theme')!.remove())
    expect(rules(r)).toContain('frame/theme')
  })

  it('frame/theme-tokens — tokenless theme is advisory only', () => {
    const r = check((d) => { d.querySelector('style#dia-theme')!.textContent = 'section { color: red }' })
    expect(r.findings).toContainEqual(expect.objectContaining({ rule: 'frame/theme-tokens', level: 'advisory' }))
    expect(r.ok).toBe(true)
  })

  it('frame/runtime — missing runtime is advisory', () => {
    const r = check((d) => d.querySelector('script#dia-runtime')!.remove())
    expect(r.findings).toContainEqual(expect.objectContaining({ rule: 'frame/runtime', level: 'advisory' }))
    expect(r.ok).toBe(true)
  })

  it('frame/slides + frame/stray-content', () => {
    const r = check((d) => {
      for (const s of d.querySelectorAll('section.dia-slide')) s.remove()
      d.body.appendChild(d.createElement('main'))
    })
    expect(rules(r)).toContain('frame/slides')
    expect(rules(r)).toContain('frame/stray-content')
  })
})

describe('content rules', () => {
  it('content/script — script inside a dialect region', () => {
    const r = check((d) => slide(d).appendChild(d.createElement('script')))
    expect(rules(r)).toContain('content/script')
  })

  it('content/event-handler — inline on* attribute', () => {
    const r = check((d) => slide(d).querySelector('.dia-title')!.setAttribute('onclick', 'boom()'))
    expect(rules(r)).toContain('content/event-handler')
  })

  it('content/embed — iframe outside an island', () => {
    const r = check((d) => slide(d).appendChild(d.createElement('iframe')))
    expect(rules(r)).toContain('content/embed')
  })

  it('content/unknown-dia-attr — out-of-vocabulary attribute', () => {
    const r = check((d) => slide(d).setAttribute('data-dia-bogus', '1'))
    expect(rules(r)).toContain('content/unknown-dia-attr')
  })

  it('content/editor-artifact — leaked session attribute', () => {
    const r = check((d) => slide(d).setAttribute('data-dia-id', 'n1'))
    expect(rules(r)).toContain('content/editor-artifact')
  })

  it('content/inline-color — literal color is advisory', () => {
    const r = check((d) => slide(d).querySelector('.dia-title')!.setAttribute('style', 'color: #ff0000'))
    expect(r.findings).toContainEqual(expect.objectContaining({ rule: 'content/inline-color', level: 'advisory' }))
    expect(r.ok).toBe(true)
  })

  it('style/left-rail — accent border-left stripe is advisory, inline and in the theme', () => {
    const r = check((d) => slide(d).querySelector('.dia-title')!.setAttribute(
      'style', 'border-left: 4px solid var(--dia-accent); padding-left: 12px'))
    expect(r.findings).toContainEqual(expect.objectContaining({ rule: 'style/left-rail', level: 'advisory' }))
    expect(r.ok).toBe(true)
    const t = check((d) => {
      const theme = d.querySelector('style#dia-theme')!
      theme.textContent += '\n.callout { border-left: 3px solid var(--dia-ink); }'
    })
    expect(rules(t)).toContain('style/left-rail')
  })

  it('style/left-rail — a thin rule-colored divider passes', () => {
    const r = check((d) => slide(d).querySelector('.dia-title')!.setAttribute(
      'style', 'border-left: 1.5px solid var(--dia-rule); padding-left: 8px'))
    expect(rules(r)).not.toContain('style/left-rail')
  })

  it('inline token references are fully in-grammar — no findings', () => {
    // what the inspector's per-element controls write
    const r = check((d) => slide(d).querySelector('.dia-title')!.setAttribute(
      'style', 'color: var(--dia-accent); font-size: var(--dia-scale-6); font-family: var(--dia-face-label)'))
    expect(r.findings).toEqual([])
  })

  it('islands are exempt from every content rule', () => {
    const r = check((d) => {
      const island = d.createElement('div')
      island.setAttribute('data-dia-island', '')
      island.innerHTML = '<div onclick="x()"><script>live()</script><iframe></iframe><b data-dia-weird="1">kept</b></div>'
      slide(d).appendChild(island)
    })
    expect(r.findings).toEqual([])
    expect(r.ok).toBe(true)
  })
})

describe('scene rules', () => {
  const scene = (d: Document) => d.querySelector<SVGSVGElement>('svg.dia-scene')!

  it('scene/node-id-duplicate', () => {
    const r = check((d) => scene(d).querySelectorAll('[data-dia-node]')[1].setAttribute('data-dia-node', 'original'))
    expect(rules(r)).toContain('scene/node-id-duplicate')
  })

  it('scene/node-geometry — non-numeric coordinate', () => {
    const r = check((d) => scene(d).querySelector('[data-dia-node]')!.setAttribute('data-x', 'left'))
    expect(rules(r)).toContain('scene/node-geometry')
  })

  it('scene/node-shape — unknown shape', () => {
    const r = check((d) => scene(d).querySelector('[data-dia-node]')!.setAttribute('data-shape', 'blob'))
    expect(rules(r)).toContain('scene/node-shape')
  })

  it('scene/node-shape — parametric shapes are in-vocabulary', () => {
    const r = check((d) => {
      const nodes = scene(d).querySelectorAll('[data-dia-node]')
      nodes[0].setAttribute('data-shape', 'cylinder')
      nodes[1].setAttribute('data-shape', 'cloud')
    })
    expect(rules(r)).not.toContain('scene/node-shape')
  })

  it('scene/node-path — shape "path" requires data-path', () => {
    const r = check((d) => scene(d).querySelector('[data-dia-node]')!.setAttribute('data-shape', 'path'))
    expect(rules(r)).toContain('scene/node-path')
  })

  it('scene/node-path — well-formed data-path passes, junk fails', () => {
    const ok = check((d) => {
      const n = scene(d).querySelector('[data-dia-node]')!
      n.setAttribute('data-shape', 'path')
      n.setAttribute('data-path', 'M10,50 A40,40 0 1 1 90,50 A40,40 0 1 1 10,50 Z')
    })
    expect(rules(ok)).not.toContain('scene/node-path')
    const bad = check((d) => {
      const n = scene(d).querySelector('[data-dia-node]')!
      n.setAttribute('data-shape', 'path')
      n.setAttribute('data-path', 'url(javascript:alert(1))')
    })
    expect(rules(bad)).toContain('scene/node-path')
  })

  it('scene/edge-endpoint — dangling edge', () => {
    const r = check((d) => scene(d).querySelector('[data-dia-edge]')!.setAttribute('data-dia-edge', 'original->nowhere'))
    expect(rules(r)).toContain('scene/edge-endpoint')
  })

  it('scene/edge-format — malformed spec', () => {
    const r = check((d) => scene(d).querySelector('[data-dia-edge]')!.setAttribute('data-dia-edge', 'loneid'))
    expect(rules(r)).toContain('scene/edge-format')
  })

  it('scene/edge-route + scene/edge-anchors', () => {
    const r = check((d) => {
      const e = scene(d).querySelector('[data-dia-edge]')!
      e.setAttribute('data-route', 'zigzag')
      e.setAttribute('data-anchors', 'NE,Q')
    })
    expect(rules(r)).toContain('scene/edge-route')
    expect(rules(r)).toContain('scene/edge-anchors')
  })
})

describe('behavior rules', () => {
  it('behavior/step — non-positive-integer step', () => {
    const r = check((d) => d.querySelector('[data-dia-step]')!.setAttribute('data-dia-step', 'first'))
    expect(rules(r)).toContain('behavior/step')
  })
})

describe('scene/node-rotate', () => {
  const scene = (d: Document) => d.querySelector<SVGSVGElement>('svg.dia-scene')!

  it('non-numeric rotation is an error; numeric passes', () => {
    const bad = check((d) => scene(d).querySelector('[data-dia-node]')!.setAttribute('data-rotate', 'lots'))
    expect(rules(bad)).toContain('scene/node-rotate')
    const ok = check((d) => scene(d).querySelector('[data-dia-node]')!.setAttribute('data-rotate', '-22.5'))
    expect(rules(ok)).not.toContain('scene/node-rotate')
  })
})

describe('behavior/transition', () => {
  const deck = (attrs: string) => `<!doctype html>
<html data-dia-version="1"><head><style id="dia-theme">:root{--dia-ink:#000}</style></head>
<body><section class="dia-slide" ${attrs}><h1 class="dia-title">Hi</h1></section></body></html>`

  it('accepts the four transition values and absence', () => {
    for (const v of ['none', 'fade', 'slide', 'rise']) {
      const r = validateDeckHtml(deck(`data-dia-transition="${v}"`))
      expect(r.findings.filter((f) => f.rule === 'behavior/transition')).toEqual([])
    }
    expect(validateDeckHtml(deck('')).findings.filter((f) => f.rule === 'behavior/transition')).toEqual([])
  })

  it('rejects junk values', () => {
    const r = validateDeckHtml(deck('data-dia-transition="spin"'))
    expect(r.findings.some((f) => f.rule === 'behavior/transition' && f.level === 'error')).toBe(true)
  })
})


/* data-via: an edge's user-owned waypoint must be an "x,y" pair */
describe('scene edge via', () => {
  const deck = (via: string) => `<!doctype html><html data-dia-version="1"><head>
    <style id="dia-theme">:root { --dia-paper: #fff; }</style></head><body>
    <section class="dia-slide"><svg class="dia-scene" viewBox="0 0 100 100">
      <g data-dia-node="a" data-x="0" data-y="0" data-w="10" data-h="10"></g>
      <g data-dia-node="b" data-x="50" data-y="50" data-w="10" data-h="10"></g>
      <g data-dia-edge="a->b" ${via}></g>
    </svg></section><script id="dia-runtime"></script></body></html>`
  it('accepts an x,y waypoint', () => {
    const r = validateDeckHtml(deck('data-via="120.5,64"'))
    expect(r.findings.filter((f) => f.rule === 'scene/edge-via')).toEqual([])
  })
  it('rejects a malformed waypoint', () => {
    const r = validateDeckHtml(deck('data-via="northwest"'))
    expect(r.findings.some((f) => f.rule === 'scene/edge-via' && f.level === 'error')).toBe(true)
  })
})
