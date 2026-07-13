/* Markdown-lite: model output renders as structure, never as markup. */

import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

function host(src: string): HTMLElement {
  const d = document.createElement('div')
  d.appendChild(renderMarkdown(src))
  return d
}

describe('renderMarkdown', () => {
  it('paragraphs, bold, italic, inline code', () => {
    const el = host('Hello **world**, try `x = 1` and *soft* emphasis.')
    expect(el.querySelectorAll('p.dia-md-p').length).toBe(1)
    expect(el.querySelector('strong')?.textContent).toBe('world')
    expect(el.querySelector('code')?.textContent).toBe('x = 1')
    expect(el.querySelector('em')?.textContent).toBe('soft')
  })

  it('lists — unordered and ordered', () => {
    const el = host('- one\n- two\n\n1. first\n2. second')
    expect(el.querySelector('ul')?.querySelectorAll('li').length).toBe(2)
    expect(el.querySelector('ol')?.querySelectorAll('li').length).toBe(2)
  })

  it('fenced code blocks keep their text verbatim', () => {
    const el = host('before\n\n```css\n.dia-title { color: red; }\n```\n\nafter')
    expect(el.querySelector('pre')?.textContent).toBe('.dia-title { color: red; }')
    expect(el.querySelectorAll('p').length).toBe(2)
  })

  it('headings render as heading lines', () => {
    const el = host('## Plan\ndetails')
    expect(el.querySelector('.dia-md-h')?.textContent).toBe('Plan')
  })

  it('links: only http(s), with safe rel/target', () => {
    const el = host('see [docs](https://example.com/a) and [bad](javascript:alert(1))')
    const a = el.querySelectorAll('a')
    expect(a.length).toBe(1)
    expect(a[0].getAttribute('href')).toBe('https://example.com/a')
    expect(a[0].getAttribute('rel')).toContain('noopener')
  })

  it('html in model output stays text, never markup', () => {
    const el = host('<img src=x onerror=alert(1)> and **<b>bold</b>**')
    expect(el.querySelector('img')).toBeNull()
    expect(el.querySelector('b')).toBeNull()
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(el.querySelector('strong')?.textContent).toBe('<b>bold</b>')
  })
})
