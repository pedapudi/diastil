/* The raw LaTeX view's find/replace bar, driven the way a user drives it:
 * keystrokes into the textarea, typing into the fields, clicking the
 * buttons. What it must hold is that a replace here is still ONE source
 * session — the view's undo granularity has always been the session, and
 * replace-all does not get to invent a second writer on the buffer. */

import { beforeEach, describe, expect, it } from 'vitest'
import { state } from '../state'
import { exportTex, loadDocFromTex } from '../model/doc'
import { activateSource, deactivateSource, mountSourceView } from './source'

const SAMPLE = `\\documentclass{article}
\\begin{document}

\\section{Widgets}

A widget, a Widget, and another widget.

\\end{document}
`

let main: HTMLElement

function mount(tex = SAMPLE) {
  main = document.createElement('div')
  document.body.appendChild(main)
  mountSourceView(main)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const doc = loadDocFromTex(tex, host, 'sample.tex')
  state.deck = null
  state.doc = doc
  state.resetLog()
  activateSource()
  return doc
}

const ta = (): HTMLTextAreaElement => main.querySelector('textarea.de-src-ta')!
const rows = (): HTMLElement[] => [...main.querySelectorAll<HTMLElement>('.de-src-findrow')]
const findField = (): HTMLInputElement => rows()[0].querySelector('input')!
const replaceField = (): HTMLInputElement => rows()[1].querySelector('input')!
const countEl = (): HTMLElement => main.querySelector('.de-src-findcount')!
const btn = (label: string): HTMLButtonElement =>
  [...main.querySelectorAll<HTMLButtonElement>('.de-src-find button')].find((b) => b.textContent === label)!

function press(el: Element, key: string, mod = false): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: mod, bubbles: true, composed: true }))
}

function type(field: HTMLInputElement, value: string): void {
  field.value = value
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  state.doc = null
  state.resetLog()
})

describe('the source view find bar', () => {
  it('Ctrl+F opens find; Ctrl+H opens it with replace', () => {
    mount()
    const bar = main.querySelector<HTMLElement>('.de-src-find')!
    expect(bar.hidden).toBe(true)
    press(ta(), 'f', true)
    expect(bar.hidden).toBe(false)
    expect(rows()[1].hidden).toBe(true)
    press(ta(), 'h', true)
    expect(rows()[1].hidden).toBe(false)
  })

  it('counts matches case-insensitively, and case-sensitively when asked', () => {
    mount()
    press(ta(), 'f', true)
    type(findField(), 'widget')
    expect(countEl().textContent).toBe('1/4') // \section{Widgets} counts too
    btn('Aa').click()
    expect(countEl().textContent).toBe('1/2')
  })

  it('whole word drops the one inside \\section{Widgets}', () => {
    mount()
    press(ta(), 'f', true)
    type(findField(), 'widget')
    btn('ab').click()
    expect(countEl().textContent).toBe('1/3')
  })

  it('replace changes the current occurrence and lands on the next', () => {
    mount()
    press(ta(), 'h', true)
    type(findField(), 'widget')
    type(replaceField(), 'gadget')
    // the first hit is the one in the heading — the source view searches
    // BYTES, so a match inside a command argument is a match
    btn('replace').click()
    expect(ta().value).toContain('\\section{gadgets}')
    expect(ta().value).toContain('A widget, a Widget, and another widget.')
    expect(countEl().textContent).toBe('1/3')
  })

  it('replace all rewrites the buffer and commits as ONE source op', () => {
    const doc = mount()
    press(ta(), 'h', true)
    type(findField(), 'widget')
    type(replaceField(), 'gadget')
    btn('all').click()
    expect(ta().value).toContain('A gadget, a gadget, and another gadget.')
    expect(countEl().textContent).toBe('0')
    // nothing has been committed yet — the view owns the buffer until it closes
    expect(doc.source.text).toBe(SAMPLE)
    deactivateSource()
    expect(doc.source.text).toContain('A gadget, a gadget, and another gadget.')
    state.undo()
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('escape closes the bar and drops the overlay mark', () => {
    mount()
    press(ta(), 'f', true)
    type(findField(), 'widget')
    press(findField(), 'Escape')
    expect(main.querySelector<HTMLElement>('.de-src-find')!.hidden).toBe(true)
    expect(main.querySelector('.hl-find')).toBeNull()
  })
})
