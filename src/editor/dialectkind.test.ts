/* Which kind of file is this? Getting it wrong opens a deck in the document
 * editor (or worse, the reverse), so the rule is worth pinning: the stamp on
 * <html> is the file's own claim and wins; structure speaks only for a file
 * that made no claim. */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dialectKind, isDialectHtml, looksLikeTex } from './slides'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')

const DECK_STAMP = '<!doctype html><html data-dia-version="1">'
const DOC_STAMP = '<!doctype html><html data-dia-doc-version="1">'

describe('dialectKind', () => {
  it('reads the stamp on <html> before anything in the body', () => {
    expect(dialectKind(`${DECK_STAMP}<body><section class="dia-slide">x</section></body></html>`)).toBe('deck')
    expect(dialectKind(`${DOC_STAMP}<body><article class="dia-doc">x</article></body></html>`)).toBe('doc')
  })

  it('a deck that SHOWS the document grammar is still a deck', () => {
    // the regression: a slide teaching the doc dialect with live markup used
    // to outrank the deck's own stamp, because article.dia-doc was tested
    // first. This project's own what-is-dia.html is one escaped <pre> away
    // from being exactly this file.
    const teaching = `${DECK_STAMP}<body>
      <section class="dia-slide"><p>a document looks like:</p>
      <article class="dia-doc"><p>prose</p></article></section></body></html>`
    expect(dialectKind(teaching)).toBe('deck')
  })

  it('a document that SHOWS the deck grammar is still a document', () => {
    const teaching = `${DOC_STAMP}<body>
      <article class="dia-doc"><section class="dia-slide">a slide looks like this</section></article>
      </body></html>`
    expect(dialectKind(teaching)).toBe('doc')
  })

  it('falls back to structure only when the file claims nothing', () => {
    expect(dialectKind('<!doctype html><html><body><section class="dia-slide">x</section></body></html>')).toBe('deck')
    expect(dialectKind('<!doctype html><html><body><article class="dia-doc">x</article></body></html>')).toBe('doc')
    expect(dialectKind('<!doctype html><html><body><p>foreign</p></body></html>')).toBe(null)
    expect(isDialectHtml('<!doctype html><html><body><p>foreign</p></body></html>')).toBe(false)
  })

  it('prose mentioning the dialect is not the dialect', () => {
    // parse-based, not substring — escaped markup is text, not structure
    const talksAboutIt = `<!doctype html><html><body>
      <p>diastil documents wrap prose in &lt;article class="dia-doc"&gt;.</p></body></html>`
    expect(dialectKind(talksAboutIt)).toBe(null)
  })

  it('every shipped artifact classifies as what it is', () => {
    const seen: Array<[string, string | null]> = []
    for (const dir of ['examples', 'docs']) {
      const d = join(repo, dir)
      if (!existsSync(d)) continue
      for (const f of readdirSync(d)) {
        if (!f.endsWith('.html')) continue
        seen.push([`${dir}/${f}`, dialectKind(readFileSync(join(d, f), 'utf-8'))])
      }
    }
    // the decks we ship must open as decks — the landing artifact above all
    expect(seen).toContainEqual(['examples/what-is-dia.html', 'deck'])
    expect(seen).toContainEqual(['examples/demo-deck.html', 'deck'])
    // and nothing we ship may claim to be a document by accident
    expect(seen.filter(([, k]) => k === 'doc')).toEqual([])
  })
})

describe('looksLikeTex', () => {
  it('takes the extension, then sniffs the preamble', () => {
    expect(looksLikeTex('anything at all', 'paper.tex')).toBe(true)
    expect(looksLikeTex('\\documentclass{article}\n', 'paper.txt')).toBe(true)
    expect(looksLikeTex('\\documentclass[twocolumn]{article}', 'x')).toBe(true)
    expect(looksLikeTex('I once read \\documentclass in a book', 'notes.md')).toBe(false)
  })
})
