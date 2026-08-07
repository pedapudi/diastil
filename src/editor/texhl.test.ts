import { describe, expect, it } from 'vitest'
import { highlightLine } from './texhl'

/** the overlay invariant: stripping tags returns EXACTLY the input */
const textOf = (html: string): string => {
  const tmp = document.createElement('div')
  tmp.innerHTML = html
  return tmp.textContent ?? ''
}

describe('highlightLine', () => {
  it('never changes the visible characters — the register invariant', () => {
    const lines = [
      '\\section{Intro} % a comment',
      'plain text with $x^2$ and \\textbf{bold}',
      '100\\% sure & <html> "entities" \'quotes\'',
      '\\begin{tabular}{lrc} a & b \\\\',
      '',
      '  \\item [opt] {group}',
      '$$display$$',
      'trailing backslash \\',
    ]
    for (const line of lines) expect(textOf(highlightLine(line)), line).toBe(line)
  })

  it('marks commands, comments, math, and env names', () => {
    const out = highlightLine('\\begin{align} $x$ % note')
    expect(out).toContain('hl-cs')
    expect(out).toContain('hl-env')
    expect(out).toContain('hl-math')
    expect(out).toContain('hl-comment')
  })

  it('escaped percent is a command, not a comment', () => {
    const out = highlightLine('50\\% left')
    expect(out).not.toContain('hl-comment')
  })

  it('escapes HTML metacharacters', () => {
    const out = highlightLine('<script>alert(1)</script>')
    expect(out).not.toContain('<script>')
    expect(textOf(out)).toBe('<script>alert(1)</script>')
  })
})
