/* Whole-source commits: reconcile keeps unchanged blocks' element identity
 * (ids, memos — and with them comment anchors and byte-exact emission);
 * the setDocSource op undoes to the exact previous state. */

import { beforeEach, describe, expect, it } from 'vitest'
import { state } from '../state'
import { loadDocFromTex, exportTex } from '../model/doc'
import { commitSourceEdit } from './sync'

const SAMPLE = `\\section{One}

Alpha paragraph.

Beta paragraph.
`

function mount(tex: string) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const doc = loadDocFromTex(tex, host, 'sample.tex')
  state.deck = null
  state.doc = doc
  state.resetLog()
  return doc
}

beforeEach(() => {
  state.doc = null
  state.resetLog()
})

describe('commitSourceEdit', () => {
  it('rebuilds the article from the new source', () => {
    const doc = mount(SAMPLE)
    commitSourceEdit(doc, SAMPLE.replace('Alpha', 'ALPHA'))
    expect(doc.article.textContent).toContain('ALPHA paragraph.')
    expect(exportTex(doc)).toContain('ALPHA')
  })

  it('unchanged blocks keep their element identity and ids', () => {
    const doc = mount(SAMPLE)
    const beta = [...doc.article.querySelectorAll('p')].find((p) => p.textContent?.includes('Beta'))!
    const betaId = beta.getAttribute('data-dia-id')
    commitSourceEdit(doc, SAMPLE.replace('Alpha', 'ALPHA'))
    const betaAfter = [...doc.article.querySelectorAll('p')].find((p) => p.textContent?.includes('Beta'))!
    expect(betaAfter).toBe(beta)
    expect(betaAfter.getAttribute('data-dia-id')).toBe(betaId)
  })

  it('kept blocks still emit byte-exactly after the session', () => {
    const doc = mount(SAMPLE)
    commitSourceEdit(doc, SAMPLE.replace('Alpha', 'ALPHA'))
    // beta's bytes (and the section's) are untouched in the new export
    const out = exportTex(doc)
    expect(out.endsWith('Beta paragraph.\n')).toBe(true)
    expect(out.startsWith('\\section{One}')).toBe(true)
  })

  it('a clean commit is a no-op (no op log entry)', () => {
    const doc = mount(SAMPLE)
    expect(commitSourceEdit(doc, SAMPLE)).toBe(false)
    state.undo() // nothing to undo — must not throw or change anything
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('undo restores text, DOM, and bindings exactly; redo replays', () => {
    const doc = mount(SAMPLE)
    const before = [...doc.article.children]
    commitSourceEdit(doc, '\\section{Two}\n\nGamma.\n')
    expect(doc.article.textContent).toContain('Gamma.')
    state.undo()
    expect(exportTex(doc)).toBe(SAMPLE)
    expect([...doc.article.children]).toEqual(before)
    // bindings restored: a subsequent native edit still works
    state.redo()
    expect(doc.article.textContent).toContain('Gamma.')
  })

  it('structural rewrites (splitting a paragraph) parse into new blocks', () => {
    const doc = mount(SAMPLE)
    commitSourceEdit(doc, SAMPLE.replace('Alpha paragraph.', 'Alpha.\n\nInserted between.'))
    const texts = [...doc.article.querySelectorAll('p')].map((p) => p.textContent?.trim())
    expect(texts).toEqual(['Alpha.', 'Inserted between.', 'Beta paragraph.'])
  })
})
