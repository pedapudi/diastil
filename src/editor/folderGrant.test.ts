/* Everything here is pure — no showDirectoryPicker, no File, no DOM. That is
 * the split this module is built around: the browser-only half (grantFolderAccess)
 * cannot run under a test runner at all, so the decisions that half makes —
 * what counts as a support file, the size budget, name safety — live in
 * functions that take plain data and are tested directly. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  folderGrantAvailable, grantFolderAccess, acceptNested, descendInto,
  isSupportFile, isTextSupportFile, isValidAssetName, planGrant, summarizeSkips,
  MAX_FILE_BYTES, MAX_GRANT_DEPTH, MAX_TOTAL_BYTES,
  type FileStat,
} from './folderGrant'

describe('isSupportFile', () => {
  it('accepts the LaTeX support extensions', () => {
    for (const name of ['neurips_2022.sty', 'article.cls', 'refs.bst', 'refs.bib', 'refs.bbl']) {
      expect(isSupportFile(name)).toBe(true)
    }
  })
  it('accepts figure image extensions', () => {
    for (const name of ['fig1.png', 'fig2.JPG', 'plot.jpeg', 'diagram.pdf', 'scan.eps', 'anim.gif']) {
      expect(isSupportFile(name)).toBe(true)
    }
  })
  it('accepts a sibling .tex — a chapter is support, not clutter', () => {
    // this used to be a rejection. It was the bug: without the chapters a
    // multi-file document does not render poorly, it fails to compile.
    expect(isSupportFile('chapter1.tex')).toBe(true)
  })
  it('rejects everything else — an archive, a dotfile, a readme', () => {
    for (const name of ['notes.zip', '.DS_Store', 'README.md']) {
      expect(isSupportFile(name)).toBe(false)
    }
  })
  it('is case-insensitive on the extension', () => {
    expect(isSupportFile('FIG.PNG')).toBe(true)
    expect(isSupportFile('STYLE.STY')).toBe(true)
  })
})

describe('isTextSupportFile', () => {
  it('styles/classes/bib/bbl are text; images are not', () => {
    expect(isTextSupportFile('refs.bib')).toBe(true)
    expect(isTextSupportFile('article.cls')).toBe(true)
    expect(isTextSupportFile('fig1.png')).toBe(false)
    expect(isTextSupportFile('diagram.pdf')).toBe(false)
  })
})

describe('isValidAssetName — mirrors the daemon’s _safe_asset_path', () => {
  it('accepts a plain filename', () => {
    expect(isValidAssetName('neurips_2022.sty')).toBe(true)
  })
  it('rejects an absolute path', () => {
    expect(isValidAssetName('/etc/passwd')).toBe(false)
    expect(isValidAssetName('\\Windows\\x')).toBe(false)
  })
  it('rejects a drive letter', () => {
    expect(isValidAssetName('C:\\x.sty')).toBe(false)
  })
  it('rejects traversal segments', () => {
    expect(isValidAssetName('../x.sty')).toBe(false)
    expect(isValidAssetName('a/../b.sty')).toBe(false)
  })
  it('rejects empty or padded names', () => {
    expect(isValidAssetName('')).toBe(false)
    expect(isValidAssetName(' x.sty ')).toBe(false)
  })
  it('rejects overwriting main.tex', () => {
    expect(isValidAssetName('main.tex')).toBe(false)
  })
  it('accepts a name with an embedded (non-leading) colon in the tail', () => {
    // the daemon's own check is on the first three characters only
    expect(isValidAssetName('weird:name.sty')).toBe(true)
  })
})

describe('planGrant', () => {
  function stat(name: string, size: number): FileStat { return { name, size } }

  it('accepts plausible support files under budget', () => {
    const plan = planGrant([stat('neurips_2022.sty', 1000), stat('refs.bib', 500)])
    expect(plan.accepted.map((f) => f.name)).toEqual(['neurips_2022.sty', 'refs.bib'])
    expect(plan.skipped).toEqual([])
  })

  it('skips a file that is not a support type, and says why', () => {
    const plan = planGrant([stat('notes.zip', 100), stat('refs.bib', 100)])
    expect(plan.accepted.map((f) => f.name)).toEqual(['refs.bib'])
    expect(plan.skipped).toEqual([{ name: 'notes.zip', reason: 'type' }])
  })

  it('accepts a nested chapter path — the daemon writes it under the workdir', () => {
    const plan = planGrant([stat('chapters/intro.tex', 100)])
    expect(plan.accepted.map((f) => f.name)).toEqual(['chapters/intro.tex'])
  })

  it('skips a single file over the per-file cap', () => {
    const plan = planGrant([stat('huge.png', MAX_FILE_BYTES + 1), stat('small.png', 10)])
    expect(plan.accepted.map((f) => f.name)).toEqual(['small.png'])
    expect(plan.skipped).toEqual([{ name: 'huge.png', reason: 'too-large' }])
  })

  it('a file exactly at the per-file cap is accepted', () => {
    const plan = planGrant([stat('exact.png', MAX_FILE_BYTES)])
    expect(plan.accepted.map((f) => f.name)).toEqual(['exact.png'])
  })

  it('stops accepting once the running total would exceed the budget, but still fits a later, smaller file', () => {
    // a, b, c fill the budget to within 2000 bytes of the cap; d (a full
    // MAX_FILE_BYTES) cannot fit in what's left and is skipped, but e (1500
    // bytes) still can — order-preserving, not "stop at the first miss"
    const a = MAX_FILE_BYTES
    const b = MAX_FILE_BYTES
    const c = MAX_FILE_BYTES - 2000
    const d = MAX_FILE_BYTES
    const e = 1500
    const plan = planGrant([stat('a.png', a), stat('b.png', b), stat('c.png', c), stat('d.png', d), stat('e.png', e)])
    expect(plan.accepted.map((f) => f.name)).toEqual(['a.png', 'b.png', 'c.png', 'e.png'])
    expect(plan.skipped).toEqual([{ name: 'd.png', reason: 'budget' }])
  })

  it('rejects an unsafe name before even checking its type', () => {
    const plan = planGrant([stat('../escape.sty', 10)])
    expect(plan.accepted).toEqual([])
    expect(plan.skipped).toEqual([{ name: '../escape.sty', reason: 'name' }])
  })

  it('an empty listing plans an empty grant', () => {
    const plan = planGrant([])
    expect(plan).toEqual({ accepted: [], skipped: [] })
  })
})

describe('summarizeSkips', () => {
  it('is empty when nothing was skipped', () => {
    expect(summarizeSkips([])).toBe('')
  })

  it('names the reason and a sample of files, grouped', () => {
    const msg = summarizeSkips([
      { name: 'chapter1.tex', reason: 'type' },
      { name: 'notes.zip', reason: 'type' },
      { name: 'huge.png', reason: 'too-large' },
    ])
    expect(msg).toContain('2 not a LaTeX support file')
    expect(msg).toContain('chapter1.tex')
    expect(msg).toContain('notes.zip')
    expect(msg).toContain('1 too large')
    expect(msg).toContain('huge.png')
  })

  it('truncates a long list of names with an ellipsis rather than dumping them all', () => {
    const skipped = ['a.zip', 'b.zip', 'c.zip', 'd.zip', 'e.zip'].map((name) => ({ name, reason: 'type' as const }))
    const msg = summarizeSkips(skipped)
    expect(msg).toContain('5 not a LaTeX support file')
    expect(msg).toContain('…')
    expect(msg).not.toContain('d.zip')
  })
})

/* ---------- the browser wrapper, driven by a STUBBED picker ----------
 *
 * showDirectoryPicker() itself cannot be exercised here (no such API in a
 * test runner), but everything grantFolderAccess() does with what the API
 * hands back — read files, run them through planGrant, shape the result —
 * has no dependency on the picker being real. A fake FileSystemDirectoryHandle
 * (just an object with a `values()` async iterator, the same shape Chromium's
 * own handle exposes) drives it end to end. */

interface FakeEntry {
  name: string
  kind?: 'file' | 'directory'
  content?: string
  bytes?: Uint8Array
  /** a directory's own entries — the walk may or may not ask for them */
  children?: FakeEntry[]
}

function fakeDir(name: string, entries: FakeEntry[]) {
  return {
    kind: 'directory' as const,
    name,
    async *values() {
      for (const e of entries) {
        if (e.kind === 'directory') {
          yield fakeDir(e.name, e.children ?? [])
          continue
        }
        const file = e.bytes
          ? new File([e.bytes.buffer as ArrayBuffer], e.name)
          : new File([e.content ?? ''], e.name, { type: 'text/plain' })
        yield { kind: 'file' as const, name: e.name, getFile: async () => file }
      }
    },
  }
}

describe('grantFolderAccess', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('folderGrantAvailable is false without the API, true once stubbed', () => {
    expect(folderGrantAvailable()).toBe(false)
    vi.stubGlobal('showDirectoryPicker', vi.fn(async () => fakeDir('x', [])))
    expect(folderGrantAvailable()).toBe(true)
  })

  it('resolves null when the API is unavailable', async () => {
    expect(await grantFolderAccess()).toBeNull()
  })

  it('resolves null when the user cancels the picker, rather than throwing', async () => {
    vi.stubGlobal('showDirectoryPicker', vi.fn(async () => { throw new Error('cancelled') }))
    expect(await grantFolderAccess()).toBeNull()
  })

  it('reads text support files as text and skips a non-support file, reporting why', async () => {
    vi.stubGlobal('showDirectoryPicker', vi.fn(async () => fakeDir('papers', [
      { name: 'neurips_2022.sty', content: '% a style file' },
      { name: 'chapter1.tex', content: 'a chapter' },
      { name: 'notes.zip', content: 'not sent' },
    ])))
    const result = await grantFolderAccess()
    expect(result?.folderName).toBe('papers')
    expect(result?.assets).toEqual({
      'neurips_2022.sty': '% a style file',
      'chapter1.tex': 'a chapter',
    })
    expect(result?.skipped).toEqual([{ name: 'notes.zip', reason: 'type' }])
  })

  it('never ships the open document itself — texSource carries the live copy', async () => {
    vi.stubGlobal('showDirectoryPicker', vi.fn(async () => fakeDir('papers', [
      { name: 'thesis.tex', content: 'stale bytes from disk' },
      { name: 'chapter1.tex', content: 'a chapter' },
    ])))
    const result = await grantFolderAccess([], 'thesis.tex')
    expect(Object.keys(result?.assets ?? {})).toEqual(['chapter1.tex'])
    expect(result?.skipped).toEqual([{ name: 'thesis.tex', reason: 'name' }])
  })

  it('reads a figure as a base64 data URI', async () => {
    vi.stubGlobal('showDirectoryPicker', vi.fn(async () => fakeDir('papers', [
      { name: 'fig1.png', bytes: new Uint8Array([137, 80, 78, 71]) },
    ])))
    const result = await grantFolderAccess()
    expect(result?.assets['fig1.png']).toMatch(/^data:application\/octet-stream;base64,/)
  })

  it('does not descend into subdirectories the document never named', async () => {
    vi.stubGlobal('showDirectoryPicker', vi.fn(async () => fakeDir('papers', [
      { name: 'sub', kind: 'directory', children: [{ name: 'private.tex', content: 'nobody asked' }] },
      { name: 'refs.bib', content: '@article{}' },
    ])))
    const result = await grantFolderAccess()
    expect(Object.keys(result?.assets ?? {})).toEqual(['refs.bib'])
  })

  it('descends for a path the document \\inputs, and reads only that path', async () => {
    vi.stubGlobal('showDirectoryPicker', vi.fn(async () => fakeDir('thesis', [
      { name: 'refs.bib', content: '@article{}' },
      {
        name: 'chapters',
        kind: 'directory',
        children: [
          { name: 'intro.tex', content: 'the intro' },
          // in the same directory, but not named by the document: a
          // wanted directory is a keyhole, not a door
          { name: 'draft-notes.tex', content: 'private' },
        ],
      },
      { name: 'secrets', kind: 'directory', children: [{ name: 'keys.tex', content: 'no' }] },
    ])))
    const result = await grantFolderAccess(['chapters/intro.tex'])
    expect(Object.keys(result?.assets ?? {}).sort()).toEqual(['chapters/intro.tex', 'refs.bib'])
    expect(result?.assets['chapters/intro.tex']).toBe('the intro')
  })

  it('stops at MAX_GRANT_DEPTH even for a named path', async () => {
    const deep = 'a/b/c/d.tex'
    vi.stubGlobal('showDirectoryPicker', vi.fn(async () => fakeDir('root', [{
      name: 'a',
      kind: 'directory',
      children: [{
        name: 'b',
        kind: 'directory',
        children: [{ name: 'c', kind: 'directory', children: [{ name: 'd.tex', content: 'too deep' }] }],
      }],
    }])))
    expect(MAX_GRANT_DEPTH).toBe(3)
    const result = await grantFolderAccess([deep])
    expect(Object.keys(result?.assets ?? {})).toEqual([])
  })
})

describe('descendInto / acceptNested — the walk\'s only way below the top level', () => {
  const wanted = ['chapters/intro.tex', 'parts/two/method.tex']

  it('descends only into a directory some wanted path runs through', () => {
    expect(descendInto('chapters', wanted)).toBe(true)
    expect(descendInto('parts', wanted)).toBe(true)
    expect(descendInto('parts/two', wanted)).toBe(true)
    expect(descendInto('secrets', wanted)).toBe(false)
    // a prefix that is not a path SEGMENT is not a match
    expect(descendInto('chapter', wanted)).toBe(false)
  })

  it('reads a nested file only when it is exactly a path the document named', () => {
    expect(acceptNested('chapters/intro.tex', wanted)).toBe(true)
    expect(acceptNested('chapters/other.tex', wanted)).toBe(false)
    expect(acceptNested('chapters', wanted)).toBe(false)
  })

  it('an empty want list keeps the grant to one level, exactly as before', () => {
    expect(descendInto('chapters', [])).toBe(false)
    expect(acceptNested('chapters/intro.tex', [])).toBe(false)
  })
})
