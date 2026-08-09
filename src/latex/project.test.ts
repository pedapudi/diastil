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

/* ---------- the root resolves to doc.source ITSELF ---------- */

/* The root's DocSource and `doc.source` must be the SAME OBJECT, not an equal
 * copy — under every spelling the daemon can emit for the root.
 *
 * This was first written to defend the problems drawer, which used to tell
 * the root from a chapter by comparing source objects. That guard has since
 * moved to `fileOfCompilePath` against `mainPath`, which rests on this
 * module's documented normalization instead — a better dependency, and the
 * reason this file no longer explains itself by pointing at the drawer.
 *
 * The identity still matters, for something worse than a wrong message:
 * edits route through the project to find the file a block's bytes live in,
 * so a defensive copy or a per-call view here would take a main-file edit,
 * apply it to the copy, and drop it. Measured, not argued — returning
 * `Object.create(this.main)` for the root fails these three tests AND
 * `a main-file edit still touches only the main file` above. */
describe('the root source is doc.source by identity, not by value', () => {
  const SPELLINGS = ['main.tex', './main.tex', 'paper.tex', './paper.tex']

  it('every spelling of the root returns the same object', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const doc = loadDocFromTex('\\documentclass{article}\n\\begin{document}\nHi.\n\\end{document}\n',
      host, 'paper.tex')
    for (const spelling of SPELLINGS) {
      expect(doc.project.sourceOfCompilePath(spelling), spelling).toBe(doc.source)
    }
    host.remove()
  })

  it('holds for a multi-file project too, where a chapter is a DIFFERENT object', () => {
    const main = readFileSync(join(fixtureDir, 'multifile.tex'), 'utf-8')
    const files: Record<string, string> = {}
    for (const rel of ['chapters/intro.tex', 'chapters/method.tex', 'chapters/results.tex']) {
      files[rel] = readFileSync(join(fixtureDir, rel), 'utf-8')
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const doc = loadDocFromTex(main, host, 'multifile.tex', files)
    expect(doc.project.multiFile).toBe(true)
    for (const spelling of ['main.tex', './main.tex', 'multifile.tex']) {
      expect(doc.project.sourceOfCompilePath(spelling), spelling).toBe(doc.source)
    }
    // and a chapter must NOT be the root, or the guard would swallow chapters
    const chapter = doc.project.sourceOfCompilePath('chapters/intro.tex')
    expect(chapter).not.toBeNull()
    expect(chapter).not.toBe(doc.source)
    host.remove()
  })

  it('survives an empty body, where the root holds no bindings at all', () => {
    // zero bindings in the root — the shape that makes a count-based rule
    // mistake the open file for an unspliced chapter (editor/problems.test.ts)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const doc = loadDocFromTex('\\documentclass{article}\n\\begin{document}\n\\end{document}\n',
      host, 'untitled.tex')
    expect(doc.source.snapshotBindings().size).toBe(0)
    expect(doc.project.sourceOfCompilePath('main.tex')).toBe(doc.source)
    host.remove()
  })
})
