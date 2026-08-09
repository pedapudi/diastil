/* The problems drawer's one piece of real arithmetic: a TeX error's line
 * number back to the block that produced it. Blocks tile the source with gaps
 * between them, so this is not a lookup — it is a bounded forward search, and
 * the cases below are the ones that decide whether a click lands in the right
 * paragraph or in the wrong one. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocSource } from '../latex/source'
import type { Doc } from '../model/doc'
import { loadDocFromTex } from '../model/doc'
import { blockForLine, idForLine, mountProblems, problemsOpen, toggleProblems } from './problems'
import { compileNow, compileState, resetCompileState } from './doccompile'
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

/* ---------- a finding inside an \input'd chapter ---------- */

/* The line number the daemon reports is counted in the file it names, not in
 * the main file. These pin the two halves of that: the right chapter's
 * source is what the line is looked up in, and a line the engine could NOT
 * place stays put in a document that has more than one file. */

/** a genuine multi-file document: a main file that \\input's a chapter, with
 * both files' blocks rendered into the one article.
 *
 * This was hand-built against a fake project object while latex/project.ts
 * lived on another branch. The fake carried only the two members this file
 * read, and doccompile asks a multi-file document for includedTexts() when it
 * ships assets — so the fake made every compile in this suite throw the moment
 * both landed. The real model costs nothing here and cannot drift. */
function chapterDoc(): { doc: Doc; chapter: DocSource; id: string } {
  const mainTex = '\\documentclass{article}\n\\begin{document}\n\n'
    + 'The first paragraph of the main file.\n\n'
    + '\\input{chapters/method}\n\n\\end{document}\n'
  const chapterTex = '\\section{Method}\n\nThe third paragraph lives under the second heading.\n'
  const host = document.createElement('div')
  document.body.appendChild(host)
  const doc = loadDocFromTex(mainTex, host, 'paper.tex', { 'chapters/method.tex': chapterTex })
  const chapter = doc.project.sourceOfPath('chapters/method.tex') as DocSource
  const el = [...doc.article.querySelectorAll<HTMLElement>('[data-dia-id]')]
    .find((e) => (e.textContent ?? '').includes('The third paragraph')) as HTMLElement
  return { doc, chapter, id: el.getAttribute('data-dia-id') as string }
}

describe('a finding inside an \\input\'d chapter', () => {
  afterEach(() => { vi.unstubAllGlobals(); resetCompileState(); state.doc = null })

  it('resolves the line against the CHAPTER, not against the main file', () => {
    const { doc, chapter, id } = chapterDoc()
    // line 3 of the chapter; line 3 of the main file is `\begin{document}`
    expect(blockForLine(doc, 3, undefined, chapter)?.getAttribute('data-dia-id')).toBe(id)
    expect(blockForLine(doc, 3)?.getAttribute('data-dia-id')).not.toBe(id)
  })

  it('clicking the row jumps to the chapter’s block', async () => {
    const main = document.createElement('div')
    document.body.append(main)
    mountProblems(main)
    stubFailingService([{
      level: 'error', file: 'chapters/method.tex', line: 3,
      message: 'Undefined control sequence.',
    }])
    const { doc, id } = chapterDoc()
    state.doc = doc
    await compileNow(doc)

    const row = main.querySelector('.de-prob-row') as HTMLElement
    expect(row.classList.contains('is-flat')).toBe(false)
    // the whole project-relative path, not just the basename: `method.tex`
    // alone is not something an author can check against their own tree
    expect(row.textContent).toContain('chapters/method.tex:3')
    row.click()
    expect(doc.article.querySelector(`[data-dia-id="${id}"]`)?.classList
      .contains('de-doc-flash')).toBe(true)
  })

  it('a main-file finding in a multi-file document still jumps to the main file', async () => {
    const main = document.createElement('div')
    document.body.append(main)
    mountProblems(main)
    // the daemon names the root once a document has chapters — a preamble
    // error must not be collateral damage of chapter attribution
    // line 4 of the main file is its own paragraph; line 6 is the \input
    stubFailingService([{ level: 'error', file: 'main.tex', line: 4, message: 'boom' }])
    const { doc } = chapterDoc()
    state.doc = doc
    await compileNow(doc)

    const row = main.querySelector('.de-prob-row') as HTMLElement
    expect(row.classList.contains('is-flat')).toBe(false)
    row.click()
    expect(doc.article.querySelector('.de-doc-flash')?.textContent)
      .toContain('The first paragraph')
  })

  it('a line the engine could not place stays put in a multi-file document', async () => {
    const main = document.createElement('div')
    document.body.append(main)
    mountProblems(main)
    stubFailingService([{ level: 'error', file: null, line: 6, message: 'Undefined control sequence.' }])
    const { doc } = chapterDoc()
    state.doc = doc
    await compileNow(doc)

    const row = main.querySelector('.de-prob-row')
    expect(row?.classList.contains('is-flat')).toBe(true)
    expect(row?.getAttribute('title')).toContain('not which file')
  })

  it('the same unplaced line still jumps in a SINGLE-file document', async () => {
    const main = document.createElement('div')
    document.body.append(main)
    mountProblems(main)
    stubFailingService([{ level: 'error', file: null, line: 6, message: 'Undefined control sequence.' }])
    const doc = docOf()
    state.doc = doc
    await compileNow(doc)

    const row = main.querySelector('.de-prob-row') as HTMLElement
    expect(row.classList.contains('is-flat')).toBe(false)
    row.click()
    expect(doc.article.querySelector('.de-doc-flash')?.textContent)
      .toContain('The first paragraph')
  })

  it('a chapter the project does not have is named but not jumped to', async () => {
    const main = document.createElement('div')
    document.body.append(main)
    mountProblems(main)
    stubFailingService([{ level: 'error', file: 'chapters/nope.tex', line: 3, message: 'boom' }])
    const { doc } = chapterDoc()
    state.doc = doc
    await compileNow(doc)

    const row = main.querySelector('.de-prob-row')
    expect(row?.classList.contains('is-flat')).toBe(true)
    expect(row?.getAttribute('title')).toContain('chapters/nope.tex')
  })
})

/* ---------- the folder-grant offer ---------- */

/** stub the daemon: one compile that fails as a BLIND missing-file failure —
 * the one shape reduceCompile marks blindMissing for */
function stubBlindMissingService(): void {
  const enc = new TextEncoder()
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    if (String(url).endsWith('/compile')) {
      return new Response(JSON.stringify({ jobId: 'j', texinputs: false }), { status: 200 })
    }
    return new Response(new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({
          type: 'done', status: 'failed', pages: null, durationMs: 10,
          errors: [{ level: 'error', file: 'main.tex', line: 37, message: "LaTeX Error: File `neurips_2022.sty' not found." }],
        })}\n\n`))
        c.close()
      },
    }), { status: 200 })
  }))
}

describe('the folder-grant offer in the drawer', () => {
  afterEach(() => { vi.unstubAllGlobals(); resetCompileState(); state.doc = null })

  it('stays absent when the API is unavailable, even on a blind missing-file failure', async () => {
    const main = document.createElement('div')
    document.body.append(main)
    mountProblems(main)
    stubBlindMissingService()
    const doc = docOf()
    state.doc = doc
    await compileNow(doc)

    expect(main.querySelector('.de-prob-grant')).toBeNull()
  })

  it('offers the grant, and picking a folder resubmits the compile with its assets', async () => {
    // the picker must be available BEFORE the failing compile renders — the
    // drawer decides whether to offer the row at render time
    const dir = {
      kind: 'directory' as const,
      name: 'papers',
      async *values() {
        yield {
          kind: 'file' as const, name: 'neurips_2022.sty',
          getFile: async () => new File(['% style'], 'neurips_2022.sty', { type: 'text/plain' }),
        }
      },
    }
    vi.stubGlobal('showDirectoryPicker', vi.fn(async () => dir))

    const main = document.createElement('div')
    document.body.append(main)
    mountProblems(main)
    stubBlindMissingService()
    const doc = docOf()
    state.doc = doc
    await compileNow(doc)
    expect(main.querySelector('.de-prob-grant')).not.toBeNull()

    // now swap the fetch stub for the recompile the click will trigger —
    // grantFolderAndRecompile reads the folder, then calls compileNow again
    const enc = new TextEncoder()
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/compile')) {
        const body = JSON.parse(String(init?.body)) as { assets?: Record<string, string> }
        expect(body.assets).toEqual({ 'neurips_2022.sty': '% style' })
        return new Response(JSON.stringify({ jobId: 'j2', texinputs: false }), { status: 200 })
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({
            type: 'done', status: 'ok', pages: 4, durationMs: 50, errors: [],
          })}\n\n`))
          c.close()
        },
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const btn = main.querySelector<HTMLButtonElement>('.de-prob-grant button')
    expect(btn).not.toBeNull()
    btn?.click()
    // let the picker + read + recompile settle
    await vi.waitFor(() => expect(compileState().status).toBe('ok'))
    expect(fetchMock).toHaveBeenCalled()
  })
})
