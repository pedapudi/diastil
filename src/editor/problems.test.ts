/* The problems drawer's one piece of real arithmetic: a TeX error's line
 * number back to the block that produced it. Blocks tile the source with gaps
 * between them, so this is not a lookup — it is a bounded forward search, and
 * the cases below are the ones that decide whether a click lands in the right
 * paragraph or in the wrong one. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadDocFromTex } from '../model/doc'
import { blockForLine, idForLine, mountProblems, problemsOpen, toggleProblems } from './problems'
import { compileNow, resetCompileState } from './doccompile'
import { state } from '../state'

const TEX = `\\documentclass{article}
\\begin{document}

\\section{Introduction}

The first paragraph, which is prose and nothing else.

The second paragraph, mentioning \\textbf{something bold}.

\\section{Method}

The third paragraph lives under the second heading.

\\end{document}
`

function docOf(tex = TEX) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  return loadDocFromTex(tex, host, 'paper.tex')
}

/** the text of the block a 1-based source line resolves to */
function blockTextAt(line: number): string | null {
  const doc = docOf()
  const el = blockForLine(doc, line)
  return el === null ? null : (el.textContent ?? '').replace(/\s+/g, ' ').trim()
}

describe('idForLine', () => {
  it('a line inside a paragraph resolves to that paragraph', () => {
    expect(blockTextAt(6)).toContain('The first paragraph')
  })

  it('a line inside a later paragraph resolves to that one, not the first', () => {
    const text = blockTextAt(8)
    expect(text).toContain('The second paragraph')
    expect(text).not.toContain('The first paragraph')
  })

  it('a heading line resolves to the heading', () => {
    expect(blockTextAt(4)).toBe('Introduction')
  })

  it('a blank line between blocks resolves FORWARD to the block that follows', () => {
    // line 5 is empty; the block a stray line belongs to is the next one
    expect(blockTextAt(5)).toContain('The first paragraph')
  })

  it('a line past the end of the document resolves to nothing rather than guessing', () => {
    expect(blockTextAt(400)).toBeNull()
  })

  it('the search is bounded — a far-away gap does not reach the next block', () => {
    const gap = `\\documentclass{article}
\\begin{document}
${'\n'.repeat(40)}
Prose at the end.

\\end{document}
`
    expect(idForLine(docOf(gap), 3)).toBeNull()
  })

  it('the mapping composes the same way the drawer does it', () => {
    const doc = docOf()
    // line 12 is the third paragraph; offset -> id -> element must agree
    const offset = doc.source.offsetOfLine(12)
    expect(doc.source.text.slice(offset, offset + 9)).toBe('The third')
    const id = doc.source.idAt(offset)
    expect(id).not.toBeNull()
    expect(idForLine(doc, 12)).toBe(id)
    const el = blockForLine(doc, 12)
    expect(el?.getAttribute('data-dia-id')).toBe(id)
    expect(el?.textContent).toContain('The third paragraph')
  })

  it('lineOf and offsetOfLine are inverses at line starts — the mapping’s floor', () => {
    const doc = docOf()
    for (let line = 1; line <= 14; line++) {
      expect(doc.source.lineOf(doc.source.offsetOfLine(line))).toBe(line)
    }
  })
})

/* ---------- the drawer ---------- */

/** stub the daemon: one compile that fails with `n` findings */
function stubFailingService(findings: unknown[]): void {
  const enc = new TextEncoder()
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    if (String(url).endsWith('/compile')) {
      return new Response(JSON.stringify({ jobId: 'j' }), { status: 200 })
    }
    return new Response(new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({
          type: 'done', status: 'error', pages: null, durationMs: 10, errors: findings,
        })}\n\n`))
        c.close()
      },
    }), { status: 200 })
  }))
}

describe('the problems drawer', () => {
  afterEach(() => { vi.unstubAllGlobals(); resetCompileState(); state.doc = null })

  it('opens itself on a failed compile and lists one row per finding', async () => {
    const main = document.createElement('div')
    document.body.append(main)
    mountProblems(main)
    expect(problemsOpen()).toBe(false)

    stubFailingService([
      { level: 'error', file: './main.tex', line: 6, message: 'Undefined control sequence.' },
      { level: 'warning', file: null, line: 3, message: 'Reference `x` undefined.' },
    ])
    const doc = docOf()
    state.doc = doc
    await compileNow(doc)

    expect(problemsOpen()).toBe(true)
    const rows = main.querySelectorAll('.de-prob-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('main.tex:6')
    expect(rows[1].classList.contains('is-warn')).toBe(true)
  })

  it('stays closed once the user closes it — a later poll must not shove it back', async () => {
    const main = document.createElement('div')
    document.body.append(main)
    mountProblems(main)
    stubFailingService([{ level: 'error', file: './main.tex', line: 6, message: 'boom' }])
    const doc = docOf()
    state.doc = doc
    await compileNow(doc)
    expect(problemsOpen()).toBe(true)

    toggleProblems(false)
    // the health poll the copilot rail fires every few seconds
    window.dispatchEvent(new CustomEvent('dia-service-status', {
      detail: { online: true, tex: { engine: 'tectonic', downloadable: false } },
    }))
    expect(problemsOpen()).toBe(false)
  })

  it('a finding in another file is shown but not clickable — no plausible wrong jump', async () => {
    const main = document.createElement('div')
    document.body.append(main)
    mountProblems(main)
    stubFailingService([{ level: 'error', file: 'geometry.sty', line: 91, message: 'Package error.' }])
    const doc = docOf()
    state.doc = doc
    await compileNow(doc)

    const row = main.querySelector('.de-prob-row')
    expect(row?.classList.contains('is-flat')).toBe(true)
    expect(row?.getAttribute('title')).toContain('geometry.sty')
  })
})
