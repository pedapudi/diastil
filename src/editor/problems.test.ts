/* The problems drawer's one piece of real arithmetic: a TeX error's line
 * number back to the block that produced it. Blocks tile the source with gaps
 * between them, so this is not a lookup — it is a bounded forward search, and
 * the cases below are the ones that decide whether a click lands in the right
 * paragraph or in the wrong one. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocSource } from '../latex/source'
import type { Doc } from '../model/doc'
import { loadDocFromTex } from '../model/doc'
import { blockForLine, idForLine, mountProblems, problemsOpen, sourceForFile, toggleProblems } from './problems'
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

/* A real two-file project, small enough that every line number below can be
 * counted by eye. Note the main file is `thesis.tex`, not main.tex: the
 * daemon calls the root `main.tex` because that is what the compile job
 * names it, and the two have to be kept apart. */
const MAIN_TEX = `\\documentclass{article}
\\begin{document}

A paragraph that lives in the main file.

\\input{chapters/method}

\\end{document}
`
const METHOD_TEX = `\\section{Method}

The chapter paragraph, which lives in its own file.
`

function chapterDoc(): Doc {
  const host = document.createElement('div')
  document.body.appendChild(host)
  return loadDocFromTex(MAIN_TEX, host, 'thesis.tex', { 'chapters/method.tex': METHOD_TEX })
}

/** the block the chapter's line 3 is in, found the long way for comparison */
function chapterBlock(doc: Doc): HTMLElement {
  return [...doc.article.querySelectorAll<HTMLElement>('[data-dia-id]')]
    .find((e) => (e.textContent ?? '').includes('The chapter paragraph')) as HTMLElement
}

describe('a finding inside an \\input\'d chapter', () => {
  afterEach(() => { vi.unstubAllGlobals(); resetCompileState(); state.doc = null })

  it('the fixture really is two files', () => {
    const doc = chapterDoc()
    expect(doc.project.multiFile).toBe(true)
    expect(chapterBlock(doc)).toBeTruthy()
  })

  it('resolves the line against the CHAPTER, not against the main file', () => {
    const doc = chapterDoc()
    const chapter = doc.project.sourceOfCompilePath('chapters/method.tex') as DocSource
    const id = chapterBlock(doc).getAttribute('data-dia-id')
    // line 3 of the chapter is its paragraph; line 3 of the main file is
    // blank, and resolves forward to the MAIN file's paragraph instead
    expect(blockForLine(doc, 3, undefined, chapter)?.getAttribute('data-dia-id')).toBe(id)
    expect(blockForLine(doc, 3)?.textContent).toContain('lives in the main file')
  })

  it('clicking the row jumps to the chapter’s block', async () => {
    const main = document.createElement('div')
    document.body.append(main)
    mountProblems(main)
    stubFailingService([{
      level: 'error', file: 'chapters/method.tex', line: 3,
      message: 'Undefined control sequence.',
    }])
    const doc = chapterDoc()
    state.doc = doc
    await compileNow(doc)

    const row = main.querySelector('.de-prob-row') as HTMLElement
    expect(row.classList.contains('is-flat')).toBe(false)
    // the whole project-relative path, not just the basename: `method.tex`
    // alone is not something an author can check against their own tree
    expect(row.textContent).toContain('chapters/method.tex:3')
    row.click()
    expect(chapterBlock(doc).classList.contains('de-doc-flash')).toBe(true)
  })

  it('a main-file finding in a multi-file document still jumps to the main file', async () => {
    const main = document.createElement('div')
    document.body.append(main)
    mountProblems(main)
    // the daemon names the root once a document has chapters — a preamble
    // error must not be collateral damage of chapter attribution
    stubFailingService([{ level: 'error', file: 'main.tex', line: 4, message: 'boom' }])
    const doc = chapterDoc()
    state.doc = doc
    await compileNow(doc)

    const row = main.querySelector('.de-prob-row') as HTMLElement
    expect(row.classList.contains('is-flat')).toBe(false)
    row.click()
    expect(doc.article.querySelector('.de-doc-flash')?.textContent)
      .toContain('lives in the main file')
  })

  it('a line the engine could not place stays put in a multi-file document', async () => {
    const main = document.createElement('div')
    document.body.append(main)
    mountProblems(main)
    stubFailingService([{ level: 'error', file: null, line: 3, message: 'Undefined control sequence.' }])
    const doc = chapterDoc()
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
    const doc = chapterDoc()
    state.doc = doc
    await compileNow(doc)

    const row = main.querySelector('.de-prob-row')
    expect(row?.classList.contains('is-flat')).toBe(true)
    expect(row?.getAttribute('title')).toContain('chapters/nope.tex')
  })
})

/* ---------- a chapter the view does not hold ---------- */

/* Only a TOP-LEVEL \input is spliced into the view. One nested inside an
 * environment is read, compiled and exported, but its blocks are never
 * bound — binding them under the enclosing environment's span is the
 * corruption the project layer exists to prevent. So the compile is
 * complete, the log genuinely names the chapter, and there is still nothing
 * on screen to jump to. That is a legitimate state, not a broken resolver,
 * and the drawer has to say so rather than offer a click that does nothing. */
const NESTED_MAIN = `\\documentclass{article}
\\begin{document}

A top-level paragraph.

\\begin{center}
\\input{chapters/intro}
\\end{center}

\\end{document}
`
const NESTED_INTRO = '\\section{Introduction}\n\nThe chapter paragraph.\n'

function nestedDoc(): Doc {
  const host = document.createElement('div')
  document.body.appendChild(host)
  return loadDocFromTex(NESTED_MAIN, host, 'thesis.tex', { 'chapters/intro.tex': NESTED_INTRO })
}

describe('a chapter the view does not hold', () => {
  afterEach(() => { vi.unstubAllGlobals(); resetCompileState(); state.doc = null })

  it('the resolver still returns the chapter’s source, with no blocks bound in it', () => {
    const doc = nestedDoc()
    const chapter = doc.project.sourceOfCompilePath('chapters/intro.tex')
    expect(chapter).not.toBeNull()
    // the right text — the file WAS read and would be compiled and exported
    expect(chapter?.text).toBe(NESTED_INTRO)
    // and nothing bound in it, so no line of it maps to a block
    expect(chapter?.snapshotBindings().size).toBe(0)
    expect(blockForLine(doc, 3, undefined, chapter as DocSource)).toBeNull()
  })

  it('the row declines and says the file is not spliced, rather than clicking into nothing', async () => {
    const main = document.createElement('div')
    document.body.append(main)
    mountProblems(main)
    stubFailingService([{
      level: 'error', file: 'chapters/intro.tex', line: 3, message: 'Undefined control sequence.',
    }])
    const doc = nestedDoc()
    state.doc = doc
    await compileNow(doc)

    const row = main.querySelector('.de-prob-row')
    // still NAMED — the engine was right and the author can go open it
    expect(row?.textContent).toContain('chapters/intro.tex:3')
    expect(row?.classList.contains('is-flat')).toBe(true)
    expect(row?.getAttribute('title')).toContain('does not splice')
  })

  /* An empty body has zero bindings in the ROOT source, exactly like an
   * unspliced chapter — and a brand-new document is now a first-class flow,
   * so "typo in the preamble, first compile" is a real first run. The root
   * must not be told it is \input from somewhere: it is the file on screen.
   * Every spelling the daemon can use for it resolves to the same DocSource,
   * which is what makes the identity check in declineReason sufficient. */
  const EMPTY_BODY = '\\documentclass{article}\n\\begin{document}\n\\end{document}\n'

  it.each([null, 'main.tex', './main.tex', 'untitled.tex'])(
    'an empty document declines with the truthful reason, not the chapter one (file: %s)',
    async (file) => {
      const main = document.createElement('div')
      document.body.append(main)
      mountProblems(main)
      stubFailingService([{ level: 'error', file, line: 2, message: 'boom' }])
      const host = document.createElement('div')
      document.body.appendChild(host)
      const doc = loadDocFromTex(EMPTY_BODY, host, 'untitled.tex')
      // the precondition that makes this test worth having
      expect(doc.source.snapshotBindings().size).toBe(0)
      state.doc = doc
      await compileNow(doc)

      const row = main.querySelector('.de-prob-row')
      expect(row?.classList.contains('is-flat')).toBe(true)
      expect(row?.getAttribute('title')).toContain('nothing in the view covers line 2')
      expect(row?.getAttribute('title')).not.toContain('does not splice')
    })

  it('a line that lands in no block at all declines too, in any document', async () => {
    const main = document.createElement('div')
    document.body.append(main)
    mountProblems(main)
    // line 400 of a fourteen-line document: real file, no block
    stubFailingService([{ level: 'error', file: null, line: 400, message: 'boom' }])
    const doc = docOf()
    state.doc = doc
    await compileNow(doc)

    const row = main.querySelector('.de-prob-row')
    expect(row?.classList.contains('is-flat')).toBe(true)
    expect(row?.getAttribute('title')).toContain('nothing in the view covers line 400')
  })
})

/* ---------- the daemon/project vocabulary, as a contract ---------- */

/* The seam: parse_log EMITS these strings and DocProject ACCEPTS them.
 * Neither side can see the other, so the set is written out here once, on
 * the consuming side, with the producer's rules quoted beside it. The
 * matching producer half is service/tests/test_parse_log.py — if that file
 * grows a shape this table does not have, this test is the one that should
 * have failed first.
 *
 * parse_log's rules, from texcompile.py's `SourceMap`:
 *   - a chapter is its project-relative posix path, extension included
 *   - the root is `main.tex` — the JOB's name for it — and is emitted only
 *     when the document really \input's another of its own sources
 *   - an engine with -file-line-error may prefix `./`
 *   - anything it cannot place with confidence is null, never a guess */
describe('what the daemon emits, the project resolves', () => {
  it('every shape parse_log can emit lands on the right source, or on none', () => {
    const doc = chapterDoc()
    const root = doc.source
    const chapter = doc.project.sourceOfCompilePath('chapters/method.tex')
    expect(chapter).not.toBeNull()
    expect(chapter).not.toBe(root)

    const table: Array<[string | null, unknown]> = [
      // what parse_log emits for a chapter
      ['chapters/method.tex', chapter],
      // the root, named only in a multi-file document
      ['main.tex', root],
      // -file-line-error engines prefix the path they resolved
      ['./main.tex', root],
      ['./chapters/method.tex', chapter],
      // the user's own name for the root also resolves, though the daemon
      // does not emit it — the job always calls the root main.tex
      ['thesis.tex', root],
      // never placed: a bundle file, a chapter this project does not have,
      // and the honest "the log did not say"
      ['geometry.sty', null],
      ['article.cls', null],
      ['chapters/nope.tex', null],
      [null, null],
    ]
    for (const [file, expected] of table) {
      expect(sourceForFile(doc, file), `file: ${file}`).toBe(expected)
    }
  })

  it('a single-file document takes the unplaced line, because there is only one file', () => {
    const doc = docOf()
    expect(doc.project.multiFile).toBe(false)
    expect(sourceForFile(doc, null)).toBe(doc.source)
    // and still refuses a file that is not its own
    expect(sourceForFile(doc, 'geometry.sty')).toBeNull()
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

/* ---------- a document with nothing in it yet ---------- */

/* The unspliced-\input decline reads a source that resolved but bound no
 * blocks. A document with an EMPTY BODY has exactly that shape for its OWN
 * main file — measured: `\documentclass…\begin{document}\end{document}`
 * leaves doc.source with zero bindings — so a reason keyed on the binding
 * count alone would tell someone their main file is "\input from somewhere
 * the editor does not splice", about the file open in front of them.
 *
 * It does not, because the guard is object identity against doc.source
 * rather than a count. That is worth pinning: `dia new --doc` and the
 * editor's own "new document" make an empty body a first-class starting
 * point, so new doc -> preamble typo -> first compile is plausibly the first
 * message this feature ever shows anyone. A refactor to a path comparison
 * would regress it silently. */
describe('an empty-bodied document is not mistaken for an unspliced input', () => {
  afterEach(() => { vi.unstubAllGlobals(); resetCompileState(); state.doc = null })

  const EMPTY = '\\documentclass{article}\n\\usepackage{nope}\n\\begin{document}\n\\end{document}\n'

  it('names the gap, not a splice the document never had', async () => {
    const main = document.createElement('div')
    document.body.append(main)
    mountProblems(main)
    stubFailingService([{
      level: 'error', file: 'main.tex', line: 2, message: 'File `nope.sty\' not found.',
    }])
    const host = document.createElement('div')
    document.body.appendChild(host)
    const doc = loadDocFromTex(EMPTY, host, 'paper.tex')
    state.doc = doc
    await compileNow(doc)

    const row = main.querySelector('.de-prob-row') as HTMLElement
    // the finding is still reported and still named — only the jump declines
    expect(row.textContent).toContain('nope.sty')
    expect(row.classList.contains('is-flat')).toBe(true)
    expect(row.getAttribute('title')).toBe('nothing in the view covers line 2 of main.tex')
    expect(row.getAttribute('title')).not.toContain('does not splice')
    // and the main source really does have the shape that would fool a
    // count-based rule
    expect(doc.source.snapshotBindings().size).toBe(0)
    expect(doc.project.sourceOfCompilePath('main.tex')).toBe(doc.source)
  })
})
