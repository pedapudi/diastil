/* Multi-file projects: composition, per-file write-back, and the honest
 * degrade when an \input cannot be reached.
 *
 * The invariant with teeth is the same one the single-file editor holds,
 * held PER FILE: editing one block in chapters/intro.tex leaves every
 * other byte of every other file exactly as it was. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { state } from '../state'
import { loadDoc, loadDocFromTex, serializeDoc, exportTex, exportTexFiles } from '../model/doc'
import { setInlineHtml } from '../model/ops'
import { commitDocEdit } from '../doc/sync'
import { matchInputBlock, resolveInputPath, scanInputPaths, readProjectFiles } from './project'

const here = dirname(fileURLToPath(import.meta.url))
const fixtureDir = join(here, '..', '..', 'corpus', 'tex', 'multifile')

const MAIN = `\\documentclass{article}
\\title{A Project}
\\begin{document}

\\maketitle

\\input{chapters/intro}

\\input{chapters/method}

\\section{Conclusion}

The end.

\\end{document}
`

const INTRO = `\\section{Introduction}
\\label{sec:intro}

The opening paragraph of the first chapter.

The second paragraph of the first chapter.
`

const METHOD = `\\section{Method}

What we did, and why we did it that way.
`

const FILES = { 'chapters/intro.tex': INTRO, 'chapters/method.tex': METHOD }

function mount(tex: string, files: Record<string, string> = {}, name = 'main.tex') {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const doc = loadDocFromTex(tex, host, name, files)
  state.deck = null
  state.doc = doc
  state.resetLog()
  return doc
}

beforeEach(() => {
  state.doc = null
  state.resetLog()
})

/* ---------- recognizing includes ---------- */

describe('resolveInputPath', () => {
  it('appends .tex the way TeX does, and only to the last segment', () => {
    expect(resolveInputPath('chapters/intro')).toBe('chapters/intro.tex')
    expect(resolveInputPath('refs.bbl')).toBe('refs.bbl')
    expect(resolveInputPath('  spaced  ')).toBe('spaced.tex')
    expect(resolveInputPath('a.b/c')).toBe('a.b/c.tex')
  })

  it('refuses everything the daemon would refuse', () => {
    // mirrors _safe_asset_path in service/dia_service/texcompile.py — a
    // path this side accepts and that side rejects is an invisible failure
    expect(resolveInputPath('/etc/passwd')).toBeNull()
    expect(resolveInputPath('../../secrets')).toBeNull()
    expect(resolveInputPath('a/../b')).toBeNull()
    expect(resolveInputPath('C:/win')).toBeNull()
    expect(resolveInputPath('a\\b')).toBeNull()
    expect(resolveInputPath('')).toBeNull()
    expect(resolveInputPath('a//b')).toBeNull()
    expect(resolveInputPath('./x')).toBeNull()
  })
})

describe('scanInputPaths', () => {
  it('finds every include, deduplicated', () => {
    expect(scanInputPaths(MAIN)).toEqual(['chapters/intro.tex', 'chapters/method.tex'])
    expect(scanInputPaths('\\include{a}\n\\input{a}\n')).toEqual(['a.tex'])
  })

  it('ignores a commented-out include but not an escaped percent', () => {
    expect(scanInputPaths('% \\input{dead}\n\\input{live}\n')).toEqual(['live.tex'])
    expect(scanInputPaths('100\\% \\input{live}\n')).toEqual(['live.tex'])
  })

  it('does not mistake \\includegraphics for an include', () => {
    expect(scanInputPaths('\\includegraphics{plot.pdf}')).toEqual([])
  })
})

describe('matchInputBlock', () => {
  it('matches only a block that is nothing but the include', () => {
    expect(matchInputBlock('\\input{a/b}')).toEqual({ cmd: 'input', arg: 'a/b' })
    expect(matchInputBlock('  \\include{a}\n')).toEqual({ cmd: 'include', arg: 'a' })
    // prose sharing the block would put a whole chapter under a span the
    // paragraph owns — left alone on purpose
    expect(matchInputBlock('See \\input{a} here.')).toBeNull()
  })
})

/* ---------- composition ---------- */

describe('composition', () => {
  it('splices an included file\'s blocks in at the \\input site', () => {
    const doc = mount(MAIN, FILES)
    const text = doc.article.textContent ?? ''
    expect(text).toContain('The opening paragraph of the first chapter.')
    expect(text).toContain('What we did, and why we did it that way.')
    // in document order: intro, method, then main's own conclusion
    const heads = [...doc.article.querySelectorAll('h2.dia-sec')].map((h) => h.textContent)
    expect(heads).toEqual(['Introduction', 'Method', 'Conclusion'])
  })

  it('attributes every spliced block to the file it came from', () => {
    const doc = mount(MAIN, FILES)
    const fileOf = (text: string) => {
      const el = [...doc.article.children].find((c) => (c.textContent ?? '').includes(text))!
      return doc.project.fileOfId(el.getAttribute('data-dia-id') as string)
    }
    expect(fileOf('The opening paragraph')).toBe('chapters/intro.tex')
    expect(fileOf('What we did')).toBe('chapters/method.tex')
    expect(fileOf('The end.')).toBe('main.tex')
  })

  it('refuses a cycle rather than recursing', () => {
    const doc = mount('\\documentclass{article}\n\\begin{document}\n\\input{a}\n\\end{document}\n', {
      'a.tex': '\\section{A}\n\nBody.\n\n\\input{a}\n',
    })
    expect(doc.article.textContent).toContain('Body.')
    const note = doc.article.querySelector('.dia-input-unreached')
    expect(note?.getAttribute('data-dia-input-state')).toBe('cycle')
  })
})

/* ---------- what the compile calls a file vs. what the project does ---------- */

describe('fileOfCompilePath', () => {
  it('reads the workdir job name as the root, whatever the user calls it', () => {
    const doc = mount(MAIN, FILES, 'thesis.tex')
    expect(doc.project.mainPath).toBe('thesis.tex')
    // the compile always names the root main.tex — the job's name, not the
    // user's. Missing this makes every root-source error unjumpable.
    expect(doc.project.fileOfCompilePath('main.tex')).toBe('thesis.tex')
    expect(doc.project.fileOfCompilePath('./main.tex')).toBe('thesis.tex')
    expect(doc.project.fileOfCompilePath('thesis.tex')).toBe('thesis.tex')
    expect(doc.project.sourceOfCompilePath('main.tex')?.text).toBe(MAIN)
  })

  it('passes an included file through — the asset name IS the project path', () => {
    const doc = mount(MAIN, FILES, 'thesis.tex')
    expect(doc.project.fileOfCompilePath('chapters/intro.tex')).toBe('chapters/intro.tex')
    expect(doc.project.fileOfCompilePath('./chapters/intro.tex')).toBe('chapters/intro.tex')
    expect(doc.project.sourceOfCompilePath('chapters/intro.tex')?.text).toBe(INTRO)
  })

  it('names nothing for a file the project does not hold', () => {
    const doc = mount(MAIN, FILES, 'thesis.tex')
    for (const f of ['neurips.sty', 'book.cls', 'chapters/nope.tex', '/usr/share/texmf/x.tex']) {
      expect(doc.project.fileOfCompilePath(f), f).toBeNull()
    }
  })

  it('a chapter line resolves to a block in the one shared article', () => {
    // the whole point for the problems drawer: file + line -> element
    const doc = mount(MAIN, FILES, 'thesis.tex')
    const source = doc.project.sourceOfCompilePath('chapters/intro.tex')!
    const line = INTRO.split('\n').findIndex((l) => l.includes('The second paragraph')) + 1
    const id = source.idAt(source.offsetOfLine(line))
    expect(id).not.toBeNull()
    const el = doc.article.querySelector(`[data-dia-id="${id}"]`)
    expect(el?.textContent).toContain('The second paragraph of the first chapter.')
  })
})

/* ---------- the root source is ONE object ---------- */

describe('root DocSource identity', () => {
  /* `doc.source` and the project's main file must be the SAME object, not
   * equal copies. Nothing enforces it but mountDoc handing one DocSource to
   * both, and the cost of losing it is silent: a main-file block edit routes
   * through project.sourceOfId -> sourceOfPath(mainPath), while exportTex
   * and serializeDoc read doc.source.text. Two objects means the edit
   * patches one and the save reads the other — measured, with the project
   * stubbed to return a copy: the copy took the edit, the export still said
   * "The original paragraph." Every main-file edit gone from the saved
   * file, no error anywhere.
   *
   * Asserted here rather than left to convention because the tempting
   * refactors (a defensive copy, a per-call view, a wrapper that adds
   * bookkeeping) all look harmless at the call site. */

  it('is the object doc.source is, under every spelling of the root', () => {
    const doc = mount(MAIN, FILES, 'thesis.tex')
    expect(doc.project.sourceOfPath(doc.project.mainPath)).toBe(doc.source)
    for (const spelling of ['main.tex', './main.tex', 'thesis.tex', './thesis.tex']) {
      expect(doc.project.sourceOfCompilePath(spelling), spelling).toBe(doc.source)
    }
  })

  it('and an included file is never that object', () => {
    const doc = mount(MAIN, FILES, 'thesis.tex')
    const chapter = doc.project.sourceOfCompilePath('chapters/intro.tex')
    expect(chapter).not.toBeNull()
    expect(chapter).not.toBe(doc.source)
  })

  it('a main-file edit therefore reaches the export', () => {
    const doc = mount(MAIN, FILES, 'thesis.tex')
    const p = [...doc.article.querySelectorAll('p')]
      .find((el) => (el.textContent ?? '').includes('The end.'))!
    commitDocEdit(doc, p, [setInlineHtml(p, 'A new ending.')], 'Edit text')
    expect(exportTex(doc)).toContain('A new ending.')
  })

  it('holds for a single-file document with an empty body', () => {
    // zero bindings in the root — the shape that makes a count-based rule
    // mistake the file on screen for an unspliced chapter
    const host = document.createElement('div')
    document.body.appendChild(host)
    const doc = loadDocFromTex('\\documentclass{article}\n\\begin{document}\n\\end{document}\n',
      host, 'untitled.tex')
    expect(doc.source.snapshotBindings().size).toBe(0)
    expect(doc.project.sourceOfCompilePath('main.tex')).toBe(doc.source)
    host.remove()
  })
})

/* ---------- the offline degrade ---------- */

describe('an \\input that cannot be read', () => {
  it('keeps the island, says what it could not reach, and drops no bytes', () => {
    const doc = mount(MAIN) // no files: offline, no daemon, no grant
    const note = doc.article.querySelector('.dia-input-unreached')
    expect(note).not.toBeNull()
    expect(note?.getAttribute('data-dia-input-state')).toBe('unreadable')
    expect(note?.textContent).toContain('chapters/intro.tex')
    // the \input's own bytes survive untouched, in both exports
    expect(exportTex(doc)).toBe(MAIN)
    expect(exportTexFiles(doc)).toEqual([{ path: 'main.tex', text: MAIN }])
  })

  it('never writes a file it never read', () => {
    const doc = mount(MAIN)
    // nothing was read, so nothing is in the project to write back
    expect(doc.project.includedPaths()).toEqual([])
    expect(doc.project.multiFile).toBe(false)
  })

  it('is editor furniture: the note reaches neither the emit nor the artifact', () => {
    const doc = mount(MAIN)
    expect(serializeDoc(doc)).not.toContain('dia-input-unreached')
    expect(exportTex(doc)).not.toContain('not reached')
  })

  it('says a file that IS readable but empty is empty, not missing', () => {
    const doc = mount(MAIN, { 'chapters/intro.tex': '\n\n', 'chapters/method.tex': METHOD })
    const notes = [...doc.article.querySelectorAll('.dia-input-unreached')]
    expect(notes.map((n) => n.getAttribute('data-dia-input-state'))).toEqual(['empty'])
  })
})

/* ---------- write-back ---------- */

describe('editing a block of an included file', () => {
  it('patches that file and leaves every other file byte-identical', () => {
    const doc = mount(MAIN, FILES)
    const p = [...doc.article.querySelectorAll('p')]
      .find((el) => (el.textContent ?? '').includes('The opening paragraph'))!
    expect(commitDocEdit(doc, p, [setInlineHtml(p, 'Rewritten opening.')], 'Edit text')).toBe(true)

    const out = Object.fromEntries(exportTexFiles(doc).map((f) => [f.path, f.text]))
    expect(out['chapters/intro.tex']).toContain('Rewritten opening.')
    expect(out['chapters/intro.tex']).not.toContain('The opening paragraph')
    // the rest of intro.tex, and all of main.tex and method.tex, untouched
    expect(out['chapters/intro.tex']).toContain('The second paragraph of the first chapter.')
    expect(out['main.tex']).toBe(MAIN)
    expect(out['chapters/method.tex']).toBe(METHOD)
  })

  it('undo restores the file byte-exactly', () => {
    const doc = mount(MAIN, FILES)
    const p = [...doc.article.querySelectorAll('p')]
      .find((el) => (el.textContent ?? '').includes('What we did'))!
    commitDocEdit(doc, p, [setInlineHtml(p, 'Something else entirely.')], 'Edit text')
    expect(doc.project.sourceOfPath('chapters/method.tex')?.text).not.toBe(METHOD)
    state.undo()
    expect(doc.project.sourceOfPath('chapters/method.tex')?.text).toBe(METHOD)
    expect(doc.source.text).toBe(MAIN)
  })

  it('names exactly the files a save has to write', () => {
    const doc = mount(MAIN, FILES)
    expect(doc.project.changedPaths()).toEqual([])
    const p = [...doc.article.querySelectorAll('p')]
      .find((el) => (el.textContent ?? '').includes('The opening paragraph'))!
    commitDocEdit(doc, p, [setInlineHtml(p, 'Rewritten opening.')], 'Edit text')
    // one chapter edited: that one file, and no other, needs writing
    expect(doc.project.changedPaths()).toEqual(['chapters/intro.tex'])
    doc.project.markSaved(['chapters/intro.tex'])
    expect(doc.project.changedPaths()).toEqual([])
  })

  it('a main-file edit dirties no included file', () => {
    const doc = mount(MAIN, FILES)
    const p = [...doc.article.querySelectorAll('p')]
      .find((el) => (el.textContent ?? '').includes('The end.'))!
    commitDocEdit(doc, p, [setInlineHtml(p, 'A new ending.')], 'Edit text')
    expect(doc.project.changedPaths()).toEqual([])
  })

  it('a main-file edit still touches only the main file', () => {
    const doc = mount(MAIN, FILES)
    const p = [...doc.article.querySelectorAll('p')]
      .find((el) => (el.textContent ?? '').includes('The end.'))!
    commitDocEdit(doc, p, [setInlineHtml(p, 'A new ending.')], 'Edit text')
    const out = Object.fromEntries(exportTexFiles(doc).map((f) => [f.path, f.text]))
    expect(out['main.tex']).toContain('A new ending.')
    expect(out['chapters/intro.tex']).toBe(INTRO)
    expect(out['chapters/method.tex']).toBe(METHOD)
  })
})

/* ---------- round trip ---------- */

describe('round trip', () => {
  it('exports every file byte-identically when nothing was edited', () => {
    const doc = mount(MAIN, FILES)
    expect(exportTexFiles(doc)).toEqual([
      { path: 'main.tex', text: MAIN },
      { path: 'chapters/intro.tex', text: INTRO },
      { path: 'chapters/method.tex', text: METHOD },
    ])
  })

  it('serializeDoc(loadDoc(x)) === x for a multi-file project', () => {
    const doc = mount(MAIN, FILES)
    const html = serializeDoc(doc)
    const host = document.createElement('div')
    document.body.appendChild(host)
    expect(serializeDoc(loadDoc(html, host, 'main.html'))).toBe(html)
  })

  it('a reopened artifact still holds the whole project, offline', () => {
    const html = serializeDoc(mount(MAIN, FILES))
    const host = document.createElement('div')
    document.body.appendChild(host)
    const again = loadDoc(html, host, 'main.html')
    expect(again.article.textContent).toContain('The opening paragraph of the first chapter.')
    expect(again.project.includedPaths()).toEqual(['chapters/intro.tex', 'chapters/method.tex'])
    expect(again.article.querySelector('.dia-input-unreached')).toBeNull()
  })

  it('drops a smuggled path out of a hostile artifact', () => {
    // an artifact is just HTML the user may have been handed. Its `files`
    // keys become write targets on save, so they run through the same
    // resolveInputPath rejections an \input argument does — and the daemon
    // checks again on the way to disk.
    const doc = mount(MAIN, {
      '../../evil.tex': 'pwn',
      '/etc/passwd': 'pwn',
      'chapters/../../out.tex': 'pwn',
      'chapters/intro.tex': INTRO,
    })
    expect(doc.project.includedPaths()).toEqual(['chapters/intro.tex'])
    expect(exportTexFiles(doc).map((f) => f.path)).toEqual(['main.tex', 'chapters/intro.tex'])
  })

  it('a single-file artifact carries no files key at all', () => {
    const html = serializeDoc(mount('\\documentclass{article}\n\\begin{document}\nHi.\n\\end{document}\n'))
    expect(html).not.toContain('"files"')
  })
})

/* ---------- the raw source editor ---------- */

describe('the raw source view', () => {
  it('a main-file source edit does not collapse the chapters back to islands', async () => {
    const doc = mount(MAIN, FILES)
    const { commitSourceEdit } = await import('../doc/sync')
    commitSourceEdit(doc, MAIN.replace('The end.', 'The very end.'))
    expect(doc.article.textContent).toContain('The opening paragraph of the first chapter.')
    expect(doc.article.textContent).toContain('The very end.')
    expect(doc.article.querySelector('.dia-input-unreached')).toBeNull()
    // and the chapters are still editable — bindings were rebuilt
    const p = [...doc.article.querySelectorAll('p')]
      .find((el) => (el.textContent ?? '').includes('The opening paragraph'))!
    expect(doc.project.fileOfId(p.getAttribute('data-dia-id') as string)).toBe('chapters/intro.tex')
  })

  it('undoing a source edit leaves the chapters still writable', async () => {
    // the re-compose clears every file's bindings; an undo that restored
    // only main.tex's would leave chapter blocks on screen, looking
    // editable, with their edits reaching no source at all
    const doc = mount(MAIN, FILES)
    const { commitSourceEdit } = await import('../doc/sync')
    commitSourceEdit(doc, MAIN.replace('The end.', 'The very end.'))
    state.undo()

    const p = [...doc.article.querySelectorAll('p')]
      .find((el) => (el.textContent ?? '').includes('The opening paragraph'))!
    expect(commitDocEdit(doc, p, [setInlineHtml(p, 'Still writable.')], 'Edit text')).toBe(true)
    expect(doc.project.sourceOfPath('chapters/intro.tex')?.text).toContain('Still writable.')
    expect(doc.source.text).toBe(MAIN)
  })
})

describe('an \\input the composition cannot splice', () => {
  /* Only TOP-LEVEL \input blocks are spliced — one buried inside an
   * environment shares a span with that environment's other content, and a
   * chapter spliced under a span it does not own is exactly the corruption
   * this whole layer exists to prevent. It still SHIPS and still exports,
   * so the compile is complete even where the native view is not. */
  const WRAPPED = `\\documentclass{article}
\\begin{document}

\\begin{center}
\\input{chapters/intro}
\\end{center}

\\end{document}
`

  it('leaves the \\input as its own source, but keeps the file whole', () => {
    const doc = mount(WRAPPED, { 'chapters/intro.tex': INTRO })
    // the command shows as itself; nothing pretends the chapter is here
    expect(doc.article.textContent).toContain('\\input{chapters/intro}')
    expect(doc.article.textContent).not.toContain('The opening paragraph')
    // but the file is in the project: exported, and shipped to the compiler
    expect(doc.project.includedTexts()).toEqual({ 'chapters/intro.tex': INTRO })
    expect(exportTexFiles(doc)).toEqual([
      { path: 'main.tex', text: WRAPPED },
      { path: 'chapters/intro.tex', text: INTRO },
    ])
  })

  it('has no blocks, so nothing can write a partial version of it', () => {
    const doc = mount(WRAPPED, { 'chapters/intro.tex': INTRO })
    expect(doc.project.changedPaths()).toEqual([])
    const ids = [...doc.article.querySelectorAll('[data-dia-id]')]
      .map((el) => doc.project.fileOfId(el.getAttribute('data-dia-id') as string))
    expect(ids.every((f) => f === null || f === 'main.tex')).toBe(true)
  })
})

/* ---------- the same file, \input twice ---------- */

describe('a file \\input twice', () => {
  /* Legal TeX, and the PDF really does get the chapter twice. What the
   * EDITOR cannot honestly give is two live renderings: one file has one
   * span space, so two renderings bind different block ids to identical
   * spans, and nothing re-renders one when the other is patched.
   *
   * Measured on the two-rendering version, before this was closed:
   *   - a text edit in the first rendering wrote the file correctly and left
   *     the second showing the OLD text
   *   - a comma then added to that stale second rendering re-emitted its own
   *     screen over the same span: "A carefully rewritten opening." became
   *     "The opening paragraph, really." — the first edit gone, no error
   *   - a remove or a move dropped the twin's overlapping spans, leaving its
   *     blocks unbound: on screen, editable-looking, writing nothing
   *   - an insert anchored on the twin's heading landed at offset 0 of the
   *     file, i.e. above the FIRST rendering, nowhere near the click
   * Every one of those is "an edit that appears to work", so the second and
   * later occurrences are islands instead. */

  const TWICE = `\\documentclass{article}
\\begin{document}

\\input{chapters/intro}

\\section{Middle}

\\input{chapters/intro}

\\end{document}
`

  /** every (file, span) a block is bound to — the collision this guards */
  function bindings(doc: ReturnType<typeof mount>) {
    return [...doc.article.querySelectorAll('[data-dia-id]')].flatMap((el) => {
      const id = el.getAttribute('data-dia-id') as string
      const path = doc.project.fileOfId(id)
      const span = path === null ? null : doc.project.sourceOfPath(path)?.spanOf(id)
      return path && span ? [`${path}:${span.start}-${span.end}`] : []
    })
  }

  it('splices the first occurrence and marks the second as already shown', () => {
    const doc = mount(TWICE, { 'chapters/intro.tex': INTRO })
    const heads = [...doc.article.querySelectorAll('h2.dia-sec')].map((h) => h.textContent)
    expect(heads).toEqual(['Introduction', 'Middle'])
    const notes = [...doc.article.querySelectorAll('.dia-input-unreached')]
    expect(notes.map((n) => n.getAttribute('data-dia-input-state'))).toEqual(['duplicate'])
    // it says where the chapter IS, and that the PDF still has it twice
    expect(notes[0].textContent).toContain('chapters/intro.tex')
    expect(notes[0].textContent).toContain('already spliced in above')
    expect(notes[0].textContent).toContain('PDF has it twice')
  })

  it('never binds two blocks to one span', () => {
    // the collision itself, stated directly: identical spans under different
    // ids is what made an edit to one rendering rewrite the other's bytes
    const doc = mount(TWICE, { 'chapters/intro.tex': INTRO })
    const bound = bindings(doc)
    expect(new Set(bound).size).toBe(bound.length)
  })

  it('exports every byte unchanged, and the second \\input keeps its own', () => {
    const doc = mount(TWICE, { 'chapters/intro.tex': INTRO })
    expect(exportTexFiles(doc)).toEqual([
      { path: 'main.tex', text: TWICE },
      { path: 'chapters/intro.tex', text: INTRO },
    ])
    // the island is editor furniture: neither the emit nor the artifact sees it
    expect(serializeDoc(doc)).not.toContain('dia-input-unreached')
    expect(exportTex(doc)).toBe(TWICE)
  })

  it('the one rendering is editable, writes the file ONCE, and undoes exactly', () => {
    const doc = mount(TWICE, { 'chapters/intro.tex': INTRO })
    const ps = [...doc.article.querySelectorAll('p')]
      .filter((el) => (el.textContent ?? '').includes('The opening paragraph'))
    expect(ps.length).toBe(1)
    expect(commitDocEdit(doc, ps[0], [setInlineHtml(ps[0], 'Rewritten opening.')], 'Edit text')).toBe(true)

    const intro = doc.project.sourceOfPath('chapters/intro.tex')?.text as string
    // written once — not once per \input
    expect(intro.match(/Rewritten opening\./g)?.length).toBe(1)
    expect(intro).not.toContain('The opening paragraph')
    expect(doc.source.text).toBe(TWICE)
    expect(doc.project.changedPaths()).toEqual(['chapters/intro.tex'])

    state.undo()
    expect(doc.project.sourceOfPath('chapters/intro.tex')?.text).toBe(INTRO)
    expect(doc.source.text).toBe(TWICE)
    expect(doc.project.changedPaths()).toEqual([])
  })

  it('survives the artifact round trip with the same shape', () => {
    const doc = mount(TWICE, { 'chapters/intro.tex': INTRO })
    const html = serializeDoc(doc)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const again = loadDoc(html, host, 'main.html')
    expect(serializeDoc(again)).toBe(html)
    expect([...again.article.querySelectorAll('h2.dia-sec')].map((h) => h.textContent))
      .toEqual(['Introduction', 'Middle'])
    const bound = bindings(again)
    expect(new Set(bound).size).toBe(bound.length)
  })

  it('a raw source edit does not resurrect the second rendering', async () => {
    // applySourceText re-composes, so the rule has to hold on that path too —
    // otherwise one trip through the source view reopens the collision
    const doc = mount(TWICE, { 'chapters/intro.tex': INTRO })
    const { commitSourceEdit } = await import('../doc/sync')
    commitSourceEdit(doc, TWICE.replace('\\section{Middle}', '\\section{Centre}'))
    expect([...doc.article.querySelectorAll('h2.dia-sec')].map((h) => h.textContent))
      .toEqual(['Introduction', 'Centre'])
    const bound = bindings(doc)
    expect(new Set(bound).size).toBe(bound.length)
    expect(doc.article.querySelectorAll('.dia-input-unreached').length).toBe(1)
  })

  it('counts occurrences across the whole document, not just one file', () => {
    // two sibling chapters sharing a fragment is the same collision as one
    // file naming it twice — the second one to be walked is the island
    const doc = mount(MAIN, {
      'chapters/intro.tex': '\\section{Introduction}\n\n\\input{shared/defs}\n',
      'chapters/method.tex': '\\section{Method}\n\n\\input{shared/defs}\n',
      'shared/defs.tex': 'The shared fragment.\n',
    })
    expect((doc.article.textContent ?? '').match(/The shared fragment\./g)?.length).toBe(1)
    const notes = [...doc.article.querySelectorAll('.dia-input-unreached')]
    expect(notes.map((n) => n.getAttribute('data-dia-input-state'))).toEqual(['duplicate'])
  })

  it('a file that never got a rendering is not something to be a duplicate of', () => {
    // unreadable twice is unreadable twice: nothing was spliced the first
    // time, so the second \input is not repeating anything
    const doc = mount(TWICE)
    const notes = [...doc.article.querySelectorAll('.dia-input-unreached')]
    expect(notes.map((n) => n.getAttribute('data-dia-input-state')))
      .toEqual(['unreadable', 'unreadable'])
    // and the same for a file that was read and holds no blocks
    const empty = mount(TWICE, { 'chapters/intro.tex': '\n\n' })
    expect([...empty.article.querySelectorAll('.dia-input-unreached')]
      .map((n) => n.getAttribute('data-dia-input-state'))).toEqual(['empty', 'empty'])
  })

  it('still says "includes itself" when a file is its own second occurrence', () => {
    // cycle outranks duplicate: both are true of a self-include, and only one
    // of them tells the author what to go fix
    const doc = mount('\\documentclass{article}\n\\begin{document}\n\\input{a}\n\\end{document}\n', {
      'a.tex': '\\section{A}\n\nBody.\n\n\\input{a}\n',
    })
    expect(doc.article.querySelector('.dia-input-unreached')
      ?.getAttribute('data-dia-input-state')).toBe('cycle')
  })
})

/* ---------- reading a project ---------- */

describe('readProjectFiles', () => {
  it('asks only for paths the source names, transitively', async () => {
    const disk: Record<string, string> = {
      'chapters/intro.tex': '\\input{shared/macros}\nIntro.\n',
      'shared/macros.tex': 'Macros.\n',
      'chapters/method.tex': METHOD,
      'secret.tex': 'never asked for',
    }
    const asked: string[] = []
    const files = await readProjectFiles(MAIN, async (p) => {
      asked.push(p)
      return disk[p] ?? null
    }, 'main.tex')
    expect(Object.keys(files).sort()).toEqual(
      ['chapters/intro.tex', 'chapters/method.tex', 'shared/macros.tex'])
    expect(asked).not.toContain('secret.tex')
  })

  it('returns what it could read when a file is missing', async () => {
    const files = await readProjectFiles(MAIN, async (p) =>
      p === 'chapters/intro.tex' ? INTRO : null)
    expect(Object.keys(files)).toEqual(['chapters/intro.tex'])
  })
})

/* ---------- the real fixture ---------- */

describe('corpus/tex/multifile', () => {
  const read = (p: string) => readFileSync(join(fixtureDir, p), 'utf-8')
  const main = read('multifile.tex')
  const files = {
    'chapters/intro.tex': read('chapters/intro.tex'),
    'chapters/method.tex': read('chapters/method.tex'),
    'chapters/results.tex': read('chapters/results.tex'),
  }

  it('opens whole: every chapter\'s sections are in the one article', () => {
    const doc = mount(main, files, 'multifile.tex')
    const heads = [...doc.article.querySelectorAll('h2.dia-sec')].map((h) => h.textContent)
    expect(heads).toEqual(['Introduction', 'Method', 'Results', 'Conclusion'])
    expect(doc.article.querySelector('.dia-input-unreached')).toBeNull()
    expect(doc.article.querySelectorAll('table').length).toBe(2)
  })

  it('re-exports all four files byte-identically', () => {
    const doc = mount(main, files, 'multifile.tex')
    const out = Object.fromEntries(exportTexFiles(doc).map((f) => [f.path, f.text]))
    expect(out['multifile.tex']).toBe(main)
    for (const [path, text] of Object.entries(files)) expect(out[path]).toBe(text)
  })

  it('opens offline too — three islands that say what they could not reach', () => {
    const doc = mount(main, {}, 'multifile.tex')
    const notes = [...doc.article.querySelectorAll('.dia-input-unreached')]
    expect(notes.length).toBe(3)
    expect(exportTex(doc)).toBe(main)
  })
})
