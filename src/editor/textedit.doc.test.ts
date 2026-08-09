/* Doc-mode text editing: $…$ typed into prose becomes rendered inline math
 * on commit, and the whole enriched leaf emits back to faithful LaTeX.
 * Enter and Backspace do structure here — and nowhere else: decks and
 * documents share this module, and the deck's Enter still means "done". */

import { beforeEach, describe, expect, it } from 'vitest'
import { docifyInlineMath, installTextEditing, isEditingText, startEdit } from './textedit'
import { emitInlines } from '../latex/emit'
import { state } from '../state'
import { exportTex, loadDocFromTex } from '../model/doc'

const asNodes = (html: string): NodeList => {
  const tmp = document.createElement('div')
  tmp.innerHTML = html
  return tmp.childNodes
}

describe('docifyInlineMath', () => {
  it('converts $…$ runs in plain text to inline math spans', () => {
    const out = docifyInlineMath('the value $x^2$ grows')
    expect(out).toContain('class="dia-math dia-math-inline"')
    expect(out).toContain('data-dia-tex="x^2"')
    expect(out).toContain('<math')
  })

  it('leaves existing math spans alone', () => {
    const html = 'a <span class="dia-math dia-math-inline" data-dia-tex="y">$y$</span> b'
    expect(docifyInlineMath(html)).toBe(html)
  })

  it('unparseable runs stay literal text', () => {
    const out = docifyInlineMath('broken $\\frac{$ thing')
    expect(out).not.toContain('dia-math')
  })

  it('handles several runs and preserves surrounding markup', () => {
    const out = docifyInlineMath('<strong>both $a$ and $b$</strong>')
    expect(out.match(/dia-math-inline/g)).toHaveLength(2)
    expect(out.startsWith('<strong>')).toBe(true)
  })

  it('the enriched leaf emits back to $…$ LaTeX', () => {
    const out = docifyInlineMath('value $e^{i\\pi}$ here')
    expect(emitInlines(asNodes(out))).toBe('value $e^{i\\pi}$ here')
  })
})

/* ---------- Enter / Backspace as structure ---------- */

const SAMPLE = `\\documentclass{article}
\\begin{document}

\\section{One}\\label{sec:one}

First paragraph, with \\textbf{style}   and
  deliberate    odd whitespace.

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
  return doc
}

/** put the caret at one end of an element's contents */
function caret(el: HTMLElement, where: 'start' | 'end'): void {
  const r = document.createRange()
  r.selectNodeContents(el)
  r.collapse(where === 'start')
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(r)
}

function press(el: HTMLElement, key: string): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

// the module keeps ONE open edit, on ONE focused element; a test that ends
// mid-edit must close it the way the editor does (escape), or the next
// test's focus() fires the stale element's blur into the new edit
installTextEditing(document.createElement('div'))

/** escape whatever is still open — the element lives inside a shadow root,
 * so a plain document query would not find it */
function closeOpenEdit(): void {
  const roots: Array<Document | ShadowRoot> = [document]
  for (const el of document.querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot)
  for (const root of roots) {
    for (const el of root.querySelectorAll<HTMLElement>('[contenteditable]')) press(el, 'Escape')
  }
}

beforeEach(() => {
  closeOpenEdit()
  state.bus.emit({ type: 'doc-loaded' })
  state.doc = null
  state.deck = null
  state.resetLog()
})

describe('Enter in a document', () => {
  it('splits the paragraph into two real blocks, in the DOM and the source', () => {
    const doc = mount()
    const p = doc.article.querySelector<HTMLElement>('p')!
    startEdit(p)
    caret(p, 'end')
    press(p, 'Enter')
    expect(doc.article.querySelectorAll('p').length).toBe(3)
    // the paragraph it came from is not an edit: its bytes stay as written
    expect(exportTex(doc)).toContain('First paragraph, with \\textbf{style}   and\n  deliberate    odd whitespace.')
    // and the caret moved into the new block
    expect(isEditingText()).toBe(true)
    state.undo()
    expect(exportTex(doc)).toBe(SAMPLE)
    expect(doc.article.querySelectorAll('p').length).toBe(2)
  })

  it('splits mid-paragraph at the caret', () => {
    const doc = mount('\\documentclass{article}\n\\begin{document}\n\nAlphabeta.\n\n\\end{document}\n')
    const p = doc.article.querySelector<HTMLElement>('p')!
    startEdit(p)
    const r = document.createRange()
    r.setStart(p.firstChild!, 5)
    r.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(r)
    press(p, 'Enter')
    const paras = [...doc.article.querySelectorAll('p')]
    expect(paras.map((x) => x.textContent)).toEqual(['Alpha', 'beta.'])
    expect(doc.source.text).toContain('Alpha\n\nbeta.')
    state.undo()
    expect(doc.source.text).toContain('Alphabeta.')
  })

  it('keeps the typing that preceded it', () => {
    const doc = mount('\\documentclass{article}\n\\begin{document}\n\nOne.\n\n\\end{document}\n')
    const p = doc.article.querySelector<HTMLElement>('p')!
    startEdit(p)
    p.innerHTML = 'One and more.'
    caret(p, 'end')
    press(p, 'Enter')
    expect(doc.source.text).toContain('One and more.')
    state.undo()
    expect(doc.source.text).toContain('\n\nOne.\n\n')
  })
})

describe('Backspace in a document', () => {
  it('joins an empty block back into the paragraph above, byte-exactly', () => {
    const doc = mount()
    const p = doc.article.querySelector<HTMLElement>('p')!
    startEdit(p)
    caret(p, 'end')
    press(p, 'Enter')
    const tail = doc.article.querySelectorAll<HTMLElement>('p')[1]
    expect(tail.textContent).toBe('')
    caret(tail, 'start')
    press(tail, 'Backspace')
    expect(doc.article.querySelectorAll('p').length).toBe(2)
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('joins a non-empty block into the one above at its start', () => {
    const doc = mount('\\documentclass{article}\n\\begin{document}\n\nAlpha.\n\nBeta.\n\n\\end{document}\n')
    const second = doc.article.querySelectorAll<HTMLElement>('p')[1]
    startEdit(second)
    caret(second, 'start')
    press(second, 'Backspace')
    expect(doc.article.querySelectorAll('p').length).toBe(1)
    expect(doc.source.text).toContain('Alpha.Beta.')
    state.undo()
    expect(doc.source.text).toContain('Alpha.\n\nBeta.')
  })

  it('leaves Backspace alone in the middle of a line', () => {
    const doc = mount()
    const p = doc.article.querySelector<HTMLElement>('p')!
    startEdit(p)
    caret(p, 'end')
    press(p, 'Backspace')
    expect(doc.article.querySelectorAll('p').length).toBe(2)
    expect(isEditingText()).toBe(true)
  })
})

describe('the deck keeps its Enter', () => {
  it('Enter commits the edit and creates nothing', () => {
    // no document loaded: this is the deck path, unchanged since it shipped
    const host = document.createElement('div')
    host.innerHTML = '<section class="dia-slide"><p class="dia-body">a</p></section>'
    document.body.appendChild(host)
    const p = host.querySelector<HTMLElement>('p')!
    startEdit(p)
    p.textContent = 'typed'
    press(p, 'Enter')
    expect(isEditingText()).toBe(false)
    expect(host.querySelectorAll('p').length).toBe(1)
    expect(p.textContent).toBe('typed')
    state.undo()
    expect(p.textContent).toBe('a')
  })
})
