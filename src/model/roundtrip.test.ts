/* Round-trip guarantee (profile §8): serialize(parse(·)) is byte-stable,
 * editor artifacts stripped, saved output in-profile. */

import { describe, expect, it } from 'vitest'
import demoRaw from '../../examples/demo-deck.html?raw'
import { loadDeck } from './parse'
import { serializeDeck } from './serialize'
import { validateDeckHtml } from './validate'

function mount(html: string, name = 'demo.html') {
  const host = document.createElement('div')
  document.body.appendChild(host)
  return loadDeck(html, host, name)
}

describe('parse', () => {
  it('loads the demo deck', () => {
    const deck = mount(demoRaw)
    expect(deck.root.querySelectorAll('section.dia-slide').length).toBe(6)
    expect(deck.title).toBe('diastil demo deck')
    expect(deck.version).toBe('1')
    expect(deck.themeStyle.textContent).toContain('--dia-paper')
  })

  it('stamps session ids on every slide element', () => {
    const deck = mount(demoRaw)
    for (const el of deck.root.querySelectorAll('section.dia-slide, section.dia-slide *')) {
      expect(el.hasAttribute('data-dia-id')).toBe(true)
    }
  })
})

describe('round-trip', () => {
  it('serialize(parse(·)) is idempotent — byte-stable', () => {
    const s1 = serializeDeck(mount(demoRaw))
    const s2 = serializeDeck(mount(s1))
    expect(s2).toBe(s1)
  })

  it('strips editor session attributes on save', () => {
    const deck = mount(demoRaw)
    const slide = deck.root.querySelector<HTMLElement>('section.dia-slide')!
    slide.setAttribute('data-dia-selected', '1')
    slide.setAttribute('contenteditable', 'true')
    slide.setAttribute('data-dia-current', '1')
    const out = serializeDeck(deck)
    for (const leak of ['data-dia-id', 'data-dia-selected', 'contenteditable', 'data-dia-current']) {
      expect(out).not.toContain(leak)
    }
  })

  it('embeds the runtime and unscopes :host back to :root', () => {
    const out = serializeDeck(mount(demoRaw))
    expect(out).toContain('<script id="dia-runtime">')
    expect(out).not.toContain(':host')
    expect(out).toContain(':root')
  })

  it('saved output is in-profile', () => {
    const report = validateDeckHtml(serializeDeck(mount(demoRaw)))
    expect(report.findings.filter((f) => f.level === 'error')).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.slideCount).toBe(6)
  })

  it('content survives an edit + save', () => {
    const deck = mount(demoRaw)
    deck.root.querySelector('.dia-title')!.textContent = 'Edited title'
    const out = serializeDeck(deck)
    expect(out).toContain('Edited title')
    // and the edit round-trips stably too
    expect(serializeDeck(mount(out))).toBe(out)
  })
})
