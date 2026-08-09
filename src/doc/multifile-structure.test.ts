/* The seam between structural editing and multi-file projects.
 *
 * Both landed at once and neither side could test the other: structural ops
 * were written against doc.source, and a chapter's blocks bind their spans in
 * that chapter's own DocSource. Patching one by the other's offsets would
 * rewrite the main file at a chapter's coordinates, so the rule is that a
 * structural op works in the file its block lives in, and refuses a region
 * that would straddle two. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { state } from '../state'
import { loadDocFromTex, exportTexFiles as exportList } from '../model/doc'
import type { Doc } from '../model/doc'
import { insertBlockOp, removeBlockOp, moveBlockOp, neighbourBlock } from '../model/ops'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..', 'corpus', 'tex', 'multifile')
const CHAPTERS = ['chapters/intro.tex', 'chapters/method.tex', 'chapters/results.tex']

function mount() {
  const main = readFileSync(join(root, 'multifile.tex'), 'utf-8')
  const files: Record<string, string> = {}
  for (const rel of CHAPTERS) files[rel] = readFileSync(join(root, rel), 'utf-8')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const doc = loadDocFromTex(main, host, 'multifile.tex', files)
  state.deck = null
  state.doc = doc
  state.resetLog()
  return { doc, host, files, main }
}

/** exportTexFiles returns a LIST; key it by path for these assertions */
function exportTexFiles(doc: Doc): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of exportList(doc)) out[f.path] = f.text
  return out
}

/** every top-level block, paired with the project file that owns its bytes */
function owned(doc: ReturnType<typeof mount>['doc']) {
  return ([...doc.article.children] as HTMLElement[])
    .map((el) => ({ el, file: doc.project.fileOfId(el.getAttribute('data-dia-id') ?? '') }))
    .filter((o) => o.file !== null)
}

beforeEach(() => {
  state.doc = null
  state.resetLog()
})

describe('structural edits in an \\input\'d chapter', () => {
  it('the fixture really does put most blocks in chapters', () => {
    const { doc, host } = mount()
    const all = owned(doc)
    const inChapters = all.filter((o) => o.file !== 'multifile.tex')
    // if this ever drops to zero the rest of this file proves nothing
    expect(inChapters.length).toBeGreaterThan(5)
    expect(all.length).toBeGreaterThan(inChapters.length)
    host.remove()
  })

  it('removing a chapter block edits THAT chapter and no other file', () => {
    const { doc, host } = mount()
    const target = owned(doc).find((o) => o.file === 'chapters/method.tex' && o.el.tagName === 'P')!
    expect(target).toBeTruthy()
    const gone = (target.el.textContent ?? '').slice(0, 24)
    const before = exportTexFiles(doc)

    const op = removeBlockOp(doc, target.el, 'Delete block')
    expect(op, 'a chapter block must be removable').not.toBeNull()
    state.apply(op!)
    const after = exportTexFiles(doc)

    expect(after['chapters/method.tex']).not.toContain(gone)
    for (const other of ['multifile.tex', 'chapters/intro.tex', 'chapters/results.tex']) {
      expect(after[other], `${other} must not move`).toBe(before[other])
    }
  })

  it('undo restores the chapter byte-exactly', () => {
    const { doc } = mount()
    const target = owned(doc).find((o) => o.file === 'chapters/intro.tex' && o.el.tagName === 'P')!
    const before = exportTexFiles(doc)
    state.apply(removeBlockOp(doc, target.el, 'Delete block')!)
    expect(exportTexFiles(doc)['chapters/intro.tex']).not.toBe(before['chapters/intro.tex'])
    state.undo()
    expect(exportTexFiles(doc)).toEqual(before)
  })

  it('a move inside one chapter relocates only that chapter', () => {
    const { doc } = mount()
    const cands = owned(doc).filter((o) => o.file === 'chapters/intro.tex')
    const from = cands.find((o) => {
      const n = neighbourBlock(doc, o.el, 1)
      return n !== null && doc.project.fileOfId(n.getAttribute('data-dia-id') ?? '') === 'chapters/intro.tex'
    })!
    expect(from, 'need two adjacent blocks in one chapter').toBeTruthy()
    const before = exportTexFiles(doc)
    const op = moveBlockOp(doc, from.el, 1, 'Move down')
    expect(op).not.toBeNull()
    state.apply(op!)
    const after = exportTexFiles(doc)
    expect(after['chapters/intro.tex']).not.toBe(before['chapters/intro.tex'])
    // same bytes, reordered — a move relocates, it does not re-emit
    expect(after['chapters/intro.tex'].length).toBe(before['chapters/intro.tex'].length)
    expect(after['multifile.tex']).toBe(before['multifile.tex'])
  })

  it('a region that would straddle two files is refused, not guessed', () => {
    const { doc } = mount()
    const all = owned(doc)
    const seam = all.find((o, i) => i > 0 && all[i - 1].file !== o.file && o.file !== null)
    expect(seam, 'the fixture must have a chapter boundary').toBeTruthy()
    const before = exportTexFiles(doc)
    // moving across the boundary has no contiguous region to own
    const op = moveBlockOp(doc, seam!.el, -1, 'Move up')
    expect(op).toBeNull()
    expect(exportTexFiles(doc)).toEqual(before)
  })

  it('an inserted block joins the file its neighbour lives in', () => {
    const { doc } = mount()
    const ref = owned(doc).find((o) => o.file === 'chapters/results.tex' && o.el.tagName === 'P')!
    const before = exportTexFiles(doc)
    const el = document.createElement('p')
    el.setAttribute('data-dia-id', 'newblock')
    el.textContent = 'A freshly written paragraph.'
    const op = insertBlockOp(doc, el, 'A freshly written paragraph.', ref.el, 'after', 'Add paragraph')
    expect(op).not.toBeNull()
    state.apply(op!)
    const after = exportTexFiles(doc)
    expect(after['chapters/results.tex']).toContain('A freshly written paragraph.')
    expect(after['multifile.tex']).toBe(before['multifile.tex'])
    expect(after['chapters/intro.tex']).toBe(before['chapters/intro.tex'])
  })
})
