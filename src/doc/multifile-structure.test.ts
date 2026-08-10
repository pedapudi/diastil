/* The seam between structural editing and multi-file projects.
 *
 * Both landed at once and neither side could test the other: structural ops
 * were written against doc.source, and a chapter's blocks bind their spans in
 * that chapter's own DocSource. Patching one by the other's offsets would
 * rewrite the main file at a chapter's coordinates, so the rule is that a
 * structural op works in the file its block lives in.
 *
 * A MOVE is the one edit that legitimately spans two files — the block
 * leaves one and joins the other — and the second half of this file is
 * about it: the bytes go, the bytes arrive, the id follows, and undo puts
 * every file back exactly. Edits that would REWRITE across the boundary
 * (a join) are still refused. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { state } from '../state'
import { loadDocFromTex, exportTexFiles as exportList } from '../model/doc'
import type { Doc } from '../model/doc'
import { insertBlockOp, joinBlocksOp, removeBlockOp, moveBlockOp, neighbourBlock, setText } from '../model/ops'
import { commitSourceEdit, docBlocks, lateDocOp, syncedDocOp } from './sync'

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

  it('a JOIN across the boundary is still refused, not guessed', () => {
    const { doc } = mount()
    const all = owned(doc)
    const at = all.findIndex((o, i) => i > 0 && all[i - 1].file !== o.file)
    expect(at, 'the fixture must have a chapter boundary').toBeGreaterThan(0)
    const before = exportTexFiles(doc)
    // a join re-emits the two blocks as one, and there is no answer to
    // which file the merged prose belongs in
    const op = joinBlocksOp(doc, all[at - 1].el, all[at].el, 'merged', 'Join blocks')
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

  it('an inserted chapter block is OWNED by that chapter, so its next edit lands there', () => {
    const { doc } = mount()
    const ref = owned(doc).find((o) => o.file === 'chapters/results.tex' && o.el.tagName === 'P')!
    const el = document.createElement('p')
    el.setAttribute('data-dia-id', 'newblock')
    el.textContent = 'A freshly written paragraph.'
    state.apply(insertBlockOp(doc, el, 'A freshly written paragraph.', ref.el, 'after', 'Add paragraph')!)
    // the binding used to be set on the chapter's DocSource alone, leaving
    // the owner map with no entry: the block then answered the MAIN file,
    // whose span map had never heard of it, and every later edit to it
    // reached no source at all — on screen, in no file
    expect(doc.project.fileOfId('newblock')).toBe('chapters/results.tex')
    const before = exportTexFiles(doc)
    state.apply(syncedDocOp(doc, el, [setText(el, 'Edited after insertion.')], 'Edit text'))
    const after = exportTexFiles(doc)
    expect(after['chapters/results.tex']).toContain('Edited after insertion.')
    expect(after['multifile.tex']).toBe(before['multifile.tex'])
  })
})

/* ---------- a block that changes file ---------- */

/** the seams: every place two adjacent blocks live in different files */
function seams(doc: Doc): number[] {
  const all = owned(doc)
  const out: number[] = []
  for (let i = 1; i < all.length; i++) if (all[i - 1].file !== all[i].file) out.push(i)
  return out
}

/** the article as (tag, text) pairs — what a reader sees, in order */
function shape(doc: Doc): string[] {
  return ([...doc.article.children] as HTMLElement[]).map((el) => `${el.tagName}:${(el.textContent ?? '').trim()}`)
}

describe('moving a block across a file boundary', () => {
  it('the block leaves one file and joins the other', () => {
    const { doc } = mount()
    const all = owned(doc)
    const at = all.findIndex((o, i) => i > 0 && all[i - 1].file === 'chapters/intro.tex'
      && o.file === 'chapters/method.tex')
    const moving = all[at - 1]
    const text = (moving.el.textContent ?? '').slice(0, 30)
    const before = exportTexFiles(doc)

    const op = moveBlockOp(doc, moving.el, 1, 'Move down')
    expect(op, 'a block at a chapter boundary must be movable across it').not.toBeNull()
    state.apply(op!)
    const after = exportTexFiles(doc)

    expect(after['chapters/intro.tex']).not.toContain(text)
    expect(after['chapters/method.tex']).toContain(text)
    // exactly two files move; the rest of the project is not touched
    for (const other of ['multifile.tex', 'chapters/results.tex']) {
      expect(after[other], `${other} must not move`).toBe(before[other])
    }
  })

  it('the block keeps its own bytes — a move relocates, it does not re-emit', () => {
    const { doc } = mount()
    const all = owned(doc)
    const at = all.findIndex((o, i) => i > 0 && all[i - 1].file === 'chapters/method.tex'
      && o.file === 'chapters/results.tex')
    const moving = all[at - 1]
    const id = moving.el.getAttribute('data-dia-id') as string
    const was = doc.project.sourceOfId(id)?.sliceOf(id) as string
    state.apply(moveBlockOp(doc, moving.el, 1, 'Move down')!)
    expect(exportTexFiles(doc)['chapters/results.tex']).toContain(was.trim())
  })

  it('the id follows the bytes: the next edit writes the NEW file', () => {
    const { doc } = mount()
    const all = owned(doc)
    const at = all.findIndex((o, i) => i > 0 && all[i - 1].file === 'chapters/intro.tex'
      && o.file === 'chapters/method.tex')
    const moving = all[at - 1]
    const id = moving.el.getAttribute('data-dia-id') as string
    state.apply(moveBlockOp(doc, moving.el, 1, 'Move down')!)
    expect(doc.project.fileOfId(id)).toBe('chapters/method.tex')

    const before = exportTexFiles(doc)
    state.apply(syncedDocOp(doc, moving.el, [setText(moving.el, 'Rewritten after the move.')], 'Edit text'))
    const after = exportTexFiles(doc)
    // the whole point of rebinding: an edit to the moved block patches the
    // file it moved INTO. Bound in the old file it would patch bytes that
    // had moved out from under it — the thesis-corrupting failure.
    expect(after['chapters/method.tex']).toContain('Rewritten after the move.')
    expect(after['chapters/intro.tex']).toBe(before['chapters/intro.tex'])
    expect(after['multifile.tex']).toBe(before['multifile.tex'])
  })

  it('a recompose finds the block in its new file, not the old one', () => {
    const { doc } = mount()
    const all = owned(doc)
    const at = all.findIndex((o, i) => i > 0 && all[i - 1].file === 'chapters/intro.tex'
      && o.file === 'chapters/method.tex')
    const moving = all[at - 1]
    const id = moving.el.getAttribute('data-dia-id') as string
    state.apply(moveBlockOp(doc, moving.el, 1, 'Move down')!)
    const before = exportTexFiles(doc)

    // a source-view session rebuilds the owner map from scratch; the moved
    // block must not revert to the chapter it left
    commitSourceEdit(doc, doc.source.text + '\n')
    expect(doc.project.fileOfId(id)).toBe('chapters/method.tex')
    for (const c of CHAPTERS) expect(exportTexFiles(doc)[c]).toBe(before[c])
  })

  it('the article after the move is the article a fresh open of those files gives', () => {
    const { doc, host } = mount()
    const all = owned(doc)
    const at = all.findIndex((o, i) => i > 0 && all[i - 1].file === 'chapters/results.tex'
      && o.file === 'multifile.tex')
    state.apply(moveBlockOp(doc, all[at].el, -1, 'Move up')!)
    const after = exportTexFiles(doc)
    const live = shape(doc)
    host.remove()

    // the strongest statement available: the order on screen is the order
    // the edited files themselves compose to. If the insertion had landed
    // on the wrong side of the seam, the next session would show a
    // different document than the one the user just arranged.
    const host2 = document.createElement('div')
    document.body.appendChild(host2)
    const files: Record<string, string> = {}
    for (const c of CHAPTERS) files[c] = after[c]
    const fresh = loadDocFromTex(after['multifile.tex'], host2, 'multifile.tex', files)
    expect(shape(fresh)).toEqual(live)
    host2.remove()
  })

  it('every seam moves both ways, and undo restores every file byte-exactly', () => {
    const probe = mount()
    const where = seams(probe.doc)
    expect(where.length, 'the fixture must have several file boundaries').toBeGreaterThan(2)
    probe.host.remove()

    for (const i of where) {
      // dir 1 moves the block above the seam down across it; dir -1 moves
      // the block below the seam up across it
      for (const dir of [1, -1] as const) {
        const { doc, host } = mount()
        const all = owned(doc)
        const moving = dir > 0 ? all[i - 1] : all[i]
        const from = moving.file as string
        const id = moving.el.getAttribute('data-dia-id') as string
        const was = (doc.project.sourceOfId(id)?.sliceOf(id) as string).trim()
        const before = exportTexFiles(doc)

        const op = moveBlockOp(doc, moving.el, dir, 'Move')
        expect(op, `seam ${i} dir ${dir} must move`).not.toBeNull()
        state.apply(op!)
        const after = exportTexFiles(doc)
        expect(doc.project.fileOfId(id), `seam ${i} dir ${dir} must change file`).not.toBe(from)
        // the block's own bytes are in exactly one file — one copy before,
        // one copy after, never zero (lost) and never two (duplicated)
        expect(Object.values(before).filter((t) => t.includes(was)).length).toBe(1)
        expect(Object.values(after).filter((t) => t.includes(was)).length).toBe(1)

        state.undo()
        expect(exportTexFiles(doc), `seam ${i} dir ${dir} undo`).toEqual(before)
        expect(doc.project.fileOfId(id), `seam ${i} dir ${dir} undo rebinds`).toBe(from)
        host.remove()
      }
    }
  })

  it('a many-hop move crosses two boundaries and leaves the file it passed THROUGH untouched', () => {
    const { doc } = mount()
    const el = docBlocks(doc)[3] // inside chapters/intro.tex
    const id = el.getAttribute('data-dia-id') as string
    const target = 20 // inside chapters/results.tex, two boundaries away
    const before = exportTexFiles(doc)

    // the copilot's move shape (copilot/compile move-el): one hop at a
    // time, each built from the source as the last one left it
    state.apply(lateDocOp(doc, 'Move far', 'copilot', () => {
      const blocks = docBlocks(doc)
      const from = blocks.indexOf(el)
      if (from < 0 || from === target) return null
      return moveBlockOp(doc, el, from < target ? 1 : -1, 'Move far', 'copilot')
    }))

    expect(docBlocks(doc).indexOf(el)).toBe(target)
    expect(doc.project.fileOfId(id)).toBe('chapters/results.tex')
    const after = exportTexFiles(doc)
    // it entered method.tex, swapped down through it, and left again — and
    // the file is byte-identical, which is only true if the arrival seating
    // and the departure removal are exact inverses of each other
    expect(after['chapters/method.tex']).toBe(before['chapters/method.tex'])
    expect(after['multifile.tex']).toBe(before['multifile.tex'])

    state.undo()
    expect(exportTexFiles(doc)).toEqual(before)
    expect(doc.project.fileOfId(id)).toBe('chapters/intro.tex')
    expect(docBlocks(doc).indexOf(el)).toBe(3)
  })

  it('nothing is applied to EITHER file when one side no longer matches', () => {
    const { doc } = mount()
    const all = owned(doc)
    const at = all.findIndex((o, i) => i > 0 && all[i - 1].file === 'chapters/intro.tex'
      && o.file === 'chapters/method.tex')
    const op = moveBlockOp(doc, all[at - 1].el, 1, 'Move down')
    expect(op).not.toBeNull()
    // the destination moves under the op — the half-apply this shape exists
    // to prevent. Two composed region ops would delete the paragraph from
    // intro.tex and then refuse method.tex, and the only surviving copy of
    // its bytes would be inside the op.
    const before = exportTexFiles(doc)
    doc.project.sourceOfPath('chapters/method.tex')!.patch(0, 0, '% moved under the op\n')
    const premise = exportTexFiles(doc)
    op!.apply()
    const after = exportTexFiles(doc)
    expect(after['chapters/intro.tex']).toBe(premise['chapters/intro.tex'])
    expect(after['chapters/intro.tex']).toBe(before['chapters/intro.tex'])
    expect(after['chapters/method.tex']).toBe(premise['chapters/method.tex'])
  })
})

/* ---------- seating, and what stays refused ----------
 * The corpus fixture is a clean paper. These are the shapes it does NOT
 * have — a comment in the gap the block arrives at, an \input the
 * composition deliberately never followed — built small so each says one
 * thing. The byte-exactness proofs above stay on the real project. */

function mountTiny(main: string, files: Record<string, string>) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const doc = loadDocFromTex(main, host, 'main.tex', files)
  state.deck = null
  state.doc = doc
  state.resetLog()
  return { doc, host }
}

const TINY_MAIN = `\\documentclass{article}
\\begin{document}

\\input{a}

\\input{b}

\\end{document}
`

describe('a block arriving in another file is seated there', () => {
  it('a % comment in the destination gap keeps its bytes and does not swallow the block', () => {
    const { doc } = mountTiny(TINY_MAIN, {
      'a.tex': 'Alpha one.\n\n% a note somebody wrote\nAlpha two.\n',
      'b.tex': 'Beta one.\n\nBeta two.\n',
    })
    const all = owned(doc)
    const beta = all.find((o) => o.file === 'b.tex') as { el: HTMLElement; file: string }
    state.apply(moveBlockOp(doc, beta.el, -1, 'Move up')!)
    const a = exportTexFiles(doc)['a.tex']
    // the note is somebody's, not the block's punctuation — it stays put
    expect(a).toContain('% a note somebody wrote')
    // and the arriving block starts a line of its own. Pasted straight onto
    // the comment it would have BECOME the comment: source that still
    // compiles, into a document missing a paragraph the editor is showing.
    expect(a).toMatch(/^Beta one\.$/m)
    expect(a).not.toMatch(/%[^\n]*Beta one/)
  })

  it('a block whose span ends in a trailing comment does not absorb the arrival', () => {
    const { doc } = mountTiny(TINY_MAIN, {
      'a.tex': 'Alpha one.\n\nAlpha two.\n',
      'b.tex': 'Beta one. % trailing note\n\nBeta two.\n',
    })
    const all = owned(doc)
    const alphaTwo = all.filter((o) => o.file === 'a.tex').pop() as { el: HTMLElement; file: string }
    state.apply(moveBlockOp(doc, alphaTwo.el, 1, 'Move down')!)
    const b = exportTexFiles(doc)['b.tex']
    expect(b).toContain('% trailing note')
    expect(b).toMatch(/^Alpha two\.$/m)
  })

  it('emptying a file is allowed, and loses no bytes', () => {
    const { doc } = mountTiny(TINY_MAIN, {
      'a.tex': 'Alpha alone.\n',
      'b.tex': 'Beta one.\n\nBeta two.\n',
    })
    const before = exportTexFiles(doc)
    const solo = owned(doc).find((o) => o.file === 'a.tex') as { el: HTMLElement; file: string }
    state.apply(moveBlockOp(doc, solo.el, 1, 'Move down')!)
    const after = exportTexFiles(doc)
    // a.tex is now blank — the \input becomes an honest "read, and holds no
    // content" island on the next compose, which is a true statement
    expect(after['a.tex'].trim()).toBe('')
    expect(after['b.tex']).toContain('Alpha alone.')
    state.undo()
    expect(exportTexFiles(doc)).toEqual(before)
  })
})

describe('an \\input the composition never followed stays out of reach', () => {
  const NESTED_MAIN = `\\documentclass{article}
\\input{macros}
\\begin{document}

\\input{a}

\\begin{figure}
\\input{fig}
\\end{figure}

\\input{b}

\\end{document}
`

  it('a move around it touches neither the preamble include nor the one in an environment', () => {
    const files = {
      'macros.tex': '\\newcommand{\\x}{x}\n',
      'fig.tex': '\\includegraphics{plot}\n',
      'a.tex': 'Alpha one.\n\nAlpha two.\n',
      'b.tex': 'Beta one.\n\nBeta two.\n',
    }
    const { doc } = mountTiny(NESTED_MAIN, files)
    // neither file contributed a block, so nothing can be moved out of one
    // and there is no block to move INTO one — the refusal needs no code,
    // it is what "not spliced" already means
    expect(owned(doc).some((o) => o.file === 'macros.tex' || o.file === 'fig.tex')).toBe(false)

    const before = exportTexFiles(doc)
    const beta = owned(doc).find((o) => o.file === 'b.tex') as { el: HTMLElement; file: string }
    state.apply(moveBlockOp(doc, beta.el, -1, 'Move up')!)
    const after = exportTexFiles(doc)
    expect(after['macros.tex']).toBe(before['macros.tex'])
    expect(after['fig.tex']).toBe(before['fig.tex'])
    // the block crossed into the FIGURE's file, which is the main one — the
    // \begin{figure} block is main.tex's own bytes, \input and all
    expect(after['main.tex']).toContain('Beta one.')
    state.undo()
    expect(exportTexFiles(doc)).toEqual(before)
  })

  it('a chapter that could not be read has no blocks, so no move can reach it', () => {
    // b.tex is simply absent — the honest degrade (latex/project.ts)
    const { doc } = mountTiny(TINY_MAIN, { 'a.tex': 'Alpha one.\n\nAlpha two.\n' })
    expect(owned(doc).some((o) => o.file === 'b.tex')).toBe(false)
    const before = exportTexFiles(doc)
    const alphaTwo = owned(doc).filter((o) => o.file === 'a.tex').pop() as { el: HTMLElement; file: string }
    // its neighbour below is the unreadable \input's own block, which is
    // main.tex's bytes — a cross-file move into main, not into b.tex
    state.apply(moveBlockOp(doc, alphaTwo.el, 1, 'Move down')!)
    const after = exportTexFiles(doc)
    expect(Object.keys(after)).not.toContain('b.tex')
    expect(after['main.tex']).toContain('Alpha two.')
    state.undo()
    expect(exportTexFiles(doc)).toEqual(before)
  })
})
