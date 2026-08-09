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
