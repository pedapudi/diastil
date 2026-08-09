/* Starting a new file from inside the editor. Three things must hold and
 * each has cost someone their work somewhere: the scaffold has to be a
 * REAL document (round-trips, validates, compiles), the new file must not
 * inherit the old file's save target, and nothing may replace unsaved work
 * without asking. Geometry (where the menu lands) is not testable here —
 * happy-dom has no layout. */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bootFromCli, confirmReplace, deckScaffoldHtml, newDeck, newDocument, servicePathOf,
} from './slides'
import { docScaffoldTex, exportTex, loadDoc, loadDocFromTex, serializeDoc } from '../model/doc'
import { loadDeck } from '../model/parse'
import { serializeDeck } from '../model/serialize'
import { validateDeckHtml, validateDocHtml } from '../model/validate'
import { state } from '../state'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')

function host(): HTMLElement {
  const el = document.createElement('div')
  document.body.append(el)
  return el
}

afterEach(() => {
  vi.unstubAllGlobals()
  state.doc = null
  state.deck = null
})

describe('the document scaffold', () => {
  const tex = docScaffoldTex('A New Paper')

  it('is a document, not a template — title, section, prose, math', () => {
    expect(tex).toContain('\\documentclass{article}')
    expect(tex).toContain('\\title{A New Paper}')
    expect(tex).toContain('\\section{Introduction}')
    expect(tex).toContain('\\end{document}\n')
  })

  it('falls back to a title rather than leaving \\title empty', () => {
    expect(docScaffoldTex('')).toContain('\\title{Untitled}')
  })

  it('round-trips as LaTeX: open it, export it, get the same bytes', () => {
    expect(exportTex(loadDocFromTex(tex, host(), 'untitled.tex'))).toBe(tex)
  })

  it('saves to an artifact that reloads byte-for-byte', () => {
    const html = serializeDoc(loadDocFromTex(tex, host(), 'untitled.tex'))
    expect(serializeDoc(loadDoc(html, host(), 'untitled.html'))).toBe(html)
  })

  it('saves to an artifact the profile validator accepts', () => {
    const report = validateDocHtml(serializeDoc(loadDocFromTex(tex, host(), 'untitled.tex')))
    expect(report.findings.filter((f) => f.level === 'error')).toEqual([])
    expect(report.ok).toBe(true)
  })

  /* the CLI writes the same starter from its own (stdlib-only) copy; this is
   * the test that keeps "one scaffold" true across the two languages */
  it('is byte-identical to the one `dia new --doc` writes (lockstep)', () => {
    const probe = spawnSync('python3', ['--version'])
    if (probe.status !== 0) return // no python here — the mirror runs in service CI
    const r = spawnSync('python3', ['-c', [
      'import sys',
      `sys.path.insert(0, ${JSON.stringify(join(repo, 'service'))})`,
      'from dia_service.scaffold import doc_tex',
      'sys.stdout.write(doc_tex(sys.argv[1]))',
    ].join('\n'), 'A New Paper'], { encoding: 'utf-8' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe(tex)
  })
})

describe('the deck scaffold', () => {
  it('is profile-valid as written', () => {
    const report = validateDeckHtml(deckScaffoldHtml('Untitled'))
    expect(report.findings.filter((f) => f.level === 'error')).toEqual([])
    expect(report.slideCount).toBe(2)
  })

  it('stays valid through a load and a save', () => {
    const deck = loadDeck(deckScaffoldHtml('Untitled'), host(), 'untitled.html')
    const report = validateDeckHtml(serializeDeck(deck))
    expect(report.findings.filter((f) => f.level === 'error')).toEqual([])
    expect(report.slideCount).toBe(2)
  })

  it('escapes a title that carries markup', () => {
    const html = deckScaffoldHtml('a <b> & c')
    expect(html).toContain('<title>a &lt;b&gt; &amp; c</title>')
    expect(html).toContain('>a &lt;b&gt; &amp; c</h1>')
  })

  it('is byte-identical to the one `dia new` writes (lockstep)', () => {
    const probe = spawnSync('python3', ['--version'])
    if (probe.status !== 0) return // no python here — the mirror runs in service CI
    const r = spawnSync('python3', ['-c', [
      'import sys',
      `sys.path.insert(0, ${JSON.stringify(join(repo, 'service'))})`,
      'from dia_service.scaffold import deck_html',
      'sys.stdout.write(deck_html(sys.argv[1]))',
    ].join('\n'), 'A New Talk'], { encoding: 'utf-8' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe(deckScaffoldHtml('A New Talk'))
  })
})

describe('starting a new file', () => {
  it('loads a document and leaves no deck behind', () => {
    newDeck(host())
    expect(state.deck).not.toBeNull()
    newDocument(host())
    expect(state.doc).not.toBeNull()
    expect(state.deck).toBeNull()
    expect(state.doc?.texName).toBe('untitled.tex')
  })

  it('loads a deck and leaves no document behind', () => {
    newDocument(host())
    newDeck(host())
    expect(state.deck).not.toBeNull()
    expect(state.doc).toBeNull()
    expect(state.deck?.fileName).toBe('untitled.html')
  })

  it('announces the mode swap on the bus', () => {
    const seen: string[] = []
    const off = state.bus.on((e) => seen.push(e.type))
    newDocument(host())
    newDeck(host())
    off()
    expect(seen).toContain('doc-loaded')
    expect(seen).toContain('deck-loaded')
  })

  /* the data-loss case: a session opened through the CLI writes back to that
   * path on every save. A new file that kept it would overwrite the paper
   * the user opened, from a Ctrl+S they think is saving something else. */
  it('drops the CLI session\'s save target, so a save cannot overwrite it', async () => {
    window.location.href = 'http://localhost:5199/?file=/tmp/paper.tex'
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ html: '\\documentclass{article}\n\\begin{document}\nHi.\n\\end{document}\n', mtime: 1 }),
    })))
    const h = host()
    expect(await bootFromCli(h)).toBe(true)
    expect(servicePathOf()).toBe('/tmp/paper.tex')
    newDocument(h)
    expect(servicePathOf()).toBeNull()
  })
})

describe('the unsaved-work guard', () => {
  it('does not ask when there is nothing to lose', () => {
    const ask = vi.fn(() => false)
    vi.stubGlobal('confirm', ask)
    expect(confirmReplace(false, 'Start a new document?')).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })

  it('asks when the file is dirty, and names the act', () => {
    const ask = vi.fn((_message: string) => true)
    vi.stubGlobal('confirm', ask)
    expect(confirmReplace(true, 'Start a new document?')).toBe(true)
    expect(ask.mock.calls[0][0]).toContain('Start a new document?')
    expect(ask.mock.calls[0][0]).toContain('unsaved changes')
  })

  it('a refused prompt refuses the replacement', () => {
    vi.stubGlobal('confirm', vi.fn(() => false))
    expect(confirmReplace(true, 'Open another file?')).toBe(false)
  })

  it('refuses rather than discards where there is no dialog to ask with', () => {
    vi.stubGlobal('confirm', undefined)
    expect(confirmReplace(true, 'Open another file?')).toBe(false)
  })
})
