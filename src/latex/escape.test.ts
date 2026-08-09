/* Every character a writer can type must survive edit -> export -> reopen.
 * The backslash did not: escapeTex chained .replace calls, so the braces of
 * the \textbackslash{} it had just written were escaped by the next pass. */
import { describe, expect, it } from 'vitest'
import { escapeTex } from './emit'
import { state } from '../state'
import { loadDocFromTex, exportTex } from '../model/doc'
import { setInlineHtml } from '../model/ops'
import { commitDocEdit } from '../doc/sync'

const SRC = `\\documentclass{article}
\\begin{document}
Original paragraph.
\\end{document}
`

/** type `typed` into the one paragraph, export, reopen, read it back */
function roundTrip(typed: string): { exported: string; reopened: string } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const doc = loadDocFromTex(SRC, host, 'x.tex')
  state.deck = null
  state.doc = doc
  state.resetLog()
  const p = doc.article.querySelector('p')!
  p.textContent = typed
  commitDocEdit(doc, p, [setInlineHtml(p, p.innerHTML)], 'typed')
  const exported = exportTex(doc)
  host.remove()

  const host2 = document.createElement('div')
  document.body.appendChild(host2)
  const reopened = (loadDocFromTex(exported, host2, 'x.tex').article.querySelector('p')?.textContent ?? '').trim()
  host2.remove()
  return { exported, reopened }
}

describe('escapeTex', () => {
  it('escapes each character exactly once', () => {
    expect(escapeTex('a\\b')).toBe('a\\textbackslash{}b')
    expect(escapeTex('a~b')).toBe('a\\textasciitilde{}b')
    expect(escapeTex('a^b')).toBe('a\\textasciicircum{}b')
    expect(escapeTex('100% of {a_b} & #c $d')).toBe('100\\% of \\{a\\_b\\} \\& \\#c \\$d')
  })

  it('a non-breaking space is still LaTeX\u2019s ~', () => {
    // a source ~ parses to U+00A0, so this is what keeps `Fig.~\ref{}` whole
    expect(escapeTex('Fig.\u00a0x')).toBe('Fig.~x')
  })

  for (const typed of ['a\\b', 'a~b', 'a^b', 'a%b', 'a_b', 'a&b', 'a{b}c', 'a$b', 'a#b',
    'C:\\Users\\me', '\\\\', 'a\\~^%b', '50% & {rising}']) {
    it(`round-trips ${JSON.stringify(typed)}`, () => {
      expect(roundTrip(typed).reopened).toBe(typed)
    })
  }

  it('survives a SECOND edit — escaping must not compound', () => {
    const once = roundTrip('a\\b~c^d')
    const host = document.createElement('div')
    document.body.appendChild(host)
    const doc = loadDocFromTex(once.exported, host, 'x.tex')
    state.doc = doc
    state.resetLog()
    const p = doc.article.querySelector('p')!
    commitDocEdit(doc, p, [setInlineHtml(p, p.innerHTML)], 'touch')
    const host2 = document.createElement('div')
    document.body.appendChild(host2)
    const twice = (loadDocFromTex(exportTex(doc), host2, 'x.tex').article.querySelector('p')?.textContent ?? '').trim()
    host.remove()
    host2.remove()
    expect(twice).toBe('a\\b~c^d')
  })

  it('random hostile strings round-trip', () => {
    const alphabet = [...'ab \\~^%_&#${}', '\u00a0']
    let seed = 20260809
    const rand = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    for (let n = 0; n < 60; n++) {
      const len = 1 + Math.floor(rand() * 12)
      let s = ''
      for (let i = 0; i < len; i++) s += alphabet[Math.floor(rand() * alphabet.length)]
      // leading/trailing whitespace is not preserved by a text round trip
      if (s.trim() !== s || s.trim() === '') continue
      expect(roundTrip(s).reopened, `hostile string ${JSON.stringify(s)}`).toBe(s)
    }
  })
})
