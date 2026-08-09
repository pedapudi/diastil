/* The document surface's block rail: the same structural verbs the context
 * menu offers, one click away, acting on the block you selected. */

import { beforeEach, describe, expect, it } from 'vitest'
import { state } from '../state'
import { exportTex, loadDocFromTex } from '../model/doc'
import { activateDoc, mountDocView } from './docview'

const SAMPLE = `\\documentclass{article}
\\begin{document}

\\section{One}\\label{sec:one}

First paragraph.

Second paragraph.

\\end{document}
`

let main: HTMLElement

function mount(tex = SAMPLE) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const doc = loadDocFromTex(tex, host, 'sample.tex')
  state.deck = null
  state.doc = doc
  state.resetLog()
  state.bus.emit({ type: 'doc-loaded' })
  activateDoc()
  return doc
}

const rail = (): HTMLElement => main.querySelector<HTMLElement>('.de-docrail')!
const button = (title: string): HTMLButtonElement =>
  rail().querySelector<HTMLButtonElement>(`button[data-verb="${title}"]`)!

beforeEach(() => {
  state.doc = null
  state.deck = null
  state.selection = { kind: 'none' }
  state.resetLog()
  main = document.createElement('div')
  document.body.appendChild(main)
  mountDocView(main, document.createElement('div'))
})

describe('the doc block rail', () => {
  it('stays hidden until a document is showing', () => {
    expect(rail().hidden).toBe(true)
    mount()
    expect(rail().hidden).toBe(false)
  })

  it('acts on the selected block: + paragraph lands after it', () => {
    const doc = mount()
    const p = doc.article.querySelector<HTMLElement>('p')!
    state.selection = { kind: 'block', block: p }
    button('new paragraph after this block').click()
    expect(exportTex(doc)).toContain('First paragraph.\n\nNew paragraph')
    state.undo()
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('moves and deletes the selected block, source and DOM together', () => {
    const doc = mount()
    const p = doc.article.querySelector<HTMLElement>('p')!
    state.selection = { kind: 'block', block: p }
    button('move this block down').click()
    expect(exportTex(doc)).toContain('Second paragraph.\n\nFirst paragraph.')
    button('delete this block').click()
    expect(exportTex(doc)).not.toContain('First paragraph.')
    state.undo()
    state.undo()
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('greys out the move that has nowhere to go', () => {
    const doc = mount()
    const head = doc.article.querySelector<HTMLElement>('h2.dia-sec')!
    state.selection = { kind: 'block', block: head }
    expect(button('move this block up').disabled).toBe(true)
    expect(button('move this block down').disabled).toBe(false)
  })
})
