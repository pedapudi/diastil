import { describe, expect, it } from 'vitest'
import { renderTex } from './math'

describe('renderTex', () => {
  it('renders LaTeX to MathML markup', () => {
    const r = renderTex('E = mc^2')
    expect('mathml' in r && r.mathml).toContain('<math')
    expect('mathml' in r && r.mathml).toContain('</math>')
  })

  it('keeps structure for real formulas', () => {
    const r = renderTex('\\frac{a+b}{c}')
    expect('mathml' in r && r.mathml).toContain('mfrac')
  })

  it('reports unparseable input instead of throwing', () => {
    const r = renderTex('\\frac{')
    expect('error' in r).toBe(true)
  })
})
