/* Doc-mode text editing: $…$ typed into prose becomes rendered inline math
 * on commit, and the whole enriched leaf emits back to faithful LaTeX. */

import { describe, expect, it } from 'vitest'
import { docifyInlineMath } from './textedit'
import { emitInlines } from '../latex/emit'

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
