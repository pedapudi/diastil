/* The document surface's right-click verbs. The menu is a faster path to
 * the paired ops, so what it must prove is that its entries are the ones
 * that make sense HERE and that running one moves the LaTeX too. */

import { beforeEach, describe, expect, it } from 'vitest'
import { state } from '../state'
import { exportTex, loadDocFromTex } from '../model/doc'
import { closeMenu } from './menu'
import { docEntries, installContextMenu } from './contextmenu'
import { topBlockOf } from '../doc/sync'
import type { Item } from './menu'

const SAMPLE = `\\documentclass{article}
\\begin{document}

\\section{One}\\label{sec:one}

First paragraph.

Second paragraph.

\\end{document}
`

function mount(tex = SAMPLE) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const doc = loadDocFromTex(tex, host, 'sample.tex')
  state.deck = null
  state.doc = doc
  state.resetLog()
  return { doc, host }
}

/** the same, for a main file with \input'd chapters */
function mountProject(main: string, files: Record<string, string>) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const doc = loadDocFromTex(main, host, 'main.tex', files)
  state.deck = null
  state.doc = doc
  state.resetLog()
  return { doc, host }
}

const labels = (entries: ReturnType<typeof docEntries>): string[] =>
  entries.filter((e): e is Item => typeof e !== 'symbol').map((e) => e.label)

const find = (entries: ReturnType<typeof docEntries>, label: string): Item =>
  entries.filter((e): e is Item => typeof e !== 'symbol').find((e) => e.label === label)!

beforeEach(() => {
  closeMenu()
  state.doc = null
  state.deck = null
  state.selection = { kind: 'none' }
  state.resetLog()
})

describe('document context menu', () => {
  it('offers the block verbs over a paragraph', () => {
    const { doc } = mount()
    const p = doc.article.querySelector<HTMLElement>('p')!
    expect(labels(docEntries(doc, p, p))).toEqual([
      'edit text', '+ paragraph', '+ section', 'move block up', 'move block down', 'delete block',
    ])
  })

  it('disables the move that has nowhere to go', () => {
    const { doc } = mount()
    const first = topBlockOf(doc, doc.article.querySelector('h2')!)!
    expect(find(docEntries(doc, first, first), 'move block up').disabled).toBe(true)
    expect(find(docEntries(doc, first, first), 'move block down').disabled).toBe(false)
  })

  it('the only block left cannot be deleted', () => {
    const { doc } = mount('\\documentclass{article}\n\\begin{document}\n\nOnly one.\n\n\\end{document}\n')
    const p = doc.article.querySelector<HTMLElement>('p')!
    expect(labels(docEntries(doc, p, p))).not.toContain('delete block')
  })

  it('+ paragraph inserts a block after this one, source and all', () => {
    const { doc } = mount()
    const p = doc.article.querySelector<HTMLElement>('p')!
    find(docEntries(doc, p, p), '+ paragraph').run()
    expect(doc.article.querySelectorAll('p').length).toBe(3)
    expect(exportTex(doc)).toContain('First paragraph.\n\nNew paragraph')
    state.undo()
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('+ section inserts a heading, opened for typing', () => {
    const { doc } = mount()
    const p = doc.article.querySelector<HTMLElement>('p')!
    find(docEntries(doc, p, p), '+ section').run()
    expect(doc.source.text).toContain('\\section{New section}')
    expect(doc.article.querySelectorAll('h2.dia-sec').length).toBe(2)
    state.undo()
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('delete block removes it from the DOM and the source together', () => {
    const { doc } = mount()
    const p = doc.article.querySelector<HTMLElement>('p')!
    find(docEntries(doc, p, p), 'delete block').run()
    expect(exportTex(doc)).not.toContain('First paragraph.')
    expect(doc.article.querySelectorAll('p').length).toBe(1)
    state.undo()
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('move block down trades places with the next block', () => {
    const { doc } = mount()
    const p = doc.article.querySelector<HTMLElement>('p')!
    find(docEntries(doc, p, p), 'move block down').run()
    expect(exportTex(doc)).toContain('Second paragraph.\n\nFirst paragraph.')
    state.undo()
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('a move across a chapter seam names the file it moves into', () => {
    const { doc, host } = mountProject(
      '\\documentclass{article}\n\\begin{document}\n\n\\input{a}\n\n\\input{b}\n\n\\end{document}\n',
      { 'a.tex': 'Alpha one.\n\nAlpha two.\n', 'b.tex': 'Beta one.\n' },
    )
    const ps = [...doc.article.querySelectorAll<HTMLElement>('p')]
    const [first, last] = [ps[0], ps[1]] // both a.tex; ps[2] is b.tex
    // a move inside one file needs no warning; the seam one does — nothing
    // in continuous prose shows that the block is about to change file
    expect(find(docEntries(doc, first, first), 'move block down').hint).toBeUndefined()
    const across = find(docEntries(doc, last, last), 'move block down')
    expect(across.hint).toBe('moves this block into b.tex')
    expect(across.disabled).toBeFalsy()
    host.remove()
  })

  it('right-clicking a block opens the menu; the header keeps the native one', () => {
    const { doc, host } = mount()
    installContextMenu(host)
    const p = doc.article.querySelector<HTMLElement>('p')!
    p.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true }))
    expect(document.querySelector('.de-menu')).not.toBeNull()
    expect([...document.querySelectorAll('.de-menu button')].map((b) => b.textContent))
      .toContain('+ paragraph')
    closeMenu()
    // the shadow host itself is not a block — no menu, no preventDefault
    const ev = new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true })
    doc.article.dispatchEvent(ev)
    expect(document.querySelector('.de-menu')).toBeNull()
    expect(ev.defaultPrevented).toBe(false)
  })
})
