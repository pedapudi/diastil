// @vitest-environment node
/* LaTeX corpus replay — the parser-quality ratchet.
 *
 * Real papers under corpus/tex/ (see its README for provenance/licenses).
 * Two kinds of assertion:
 *   1. invariants that hold FOREVER for any input: parse never throws,
 *      spans are sane, stitching reproduces the source byte-identically —
 *      on every fixture AND on random slices of them (fuzz);
 *   2. ratcheted floors: how much of each document parses into real
 *      structure rather than islands. Floors only move up; lowering one
 *      requires a deliberate commit with a reason in the diff. */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseLatex, spansSane, stitch } from './parse'
import { scanInputPaths } from './project'
import type { LxBlock } from './parse'

const here = dirname(fileURLToPath(import.meta.url))
const texDir = join(here, '..', '..', 'corpus', 'tex')

/** fixtures are flat main.tex files, or per-paper dirs <name>/<name>.tex
 * with the paper's vendored support assets (styles, figures) beside it */
const fixtures = existsSync(texDir)
  ? readdirSync(texDir, { withFileTypes: true })
      .map((e) => (e.isDirectory() ? join(e.name, `${e.name}.tex`) : e.name))
      .filter((f) => f.endsWith('.tex'))
      .filter((f) => existsSync(join(texDir, f)))
      .sort()
  : []

/** islandRatio floor per fixture: at least (1 - floor) of body bytes must
 * map to real structure. Computed from the current parser; only move UP. */
const ISLAND_CEILINGS: Record<string, number> = {
  // measured 2026-08-03 after multicolumn/wrapper/theorem expansion:
  // 0.0002 / 0 / 0 / 0 / 0.048 / 0.022 — what remains is tikzpicture,
  // CJK, longtable: honest islands the compiled mirror shows typeset
  'bloom.tex': 0.005,
  'cot/cot.tex': 0.005,
  'flan/flan.tex': 0.005,
  'llama/llama.tex': 0.005,
  'palm.tex': 0.06,
  'palm2.tex': 0.03,
  // measured 2026-08-07, corpus breadth (issue #8) — thesis (book class,
  // \chapter now a real section level 0) and theorems (amsthm) land at 0:
  // nothing they use falls outside the parser's vocabulary. biblatex lands
  // at 0 too — \autocite/\parencite/\textcite (and their sentence-case
  // companions, newly recognized) all parse as cite nodes.
  'thesis/thesis.tex': 0.001,
  // measured 2026-08-07, issue #20: \frame joins WRAPPER_ENVS via
  // WRAPPER_OPTIONAL_BRACE_ARGS (matchOptionalBraceArg in parse.ts) — its
  // title is taken only when it opens on \begin{frame}'s own line, doesn't
  // itself start with a layout declaration (\centering, …), and stays a
  // single paragraph; any one failing leaves the group as body content, so
  // a bare `{...}` opening a titleless frame is never swallowed. All 9
  // frames land as real wrapper blocks; nothing at the top level islands.
  'beamer/beamer.tex': 0,
  'biblatex/biblatex.tex': 0.001,
  'theorems/theorems.tex': 0.001,
  // measured 2026-08-09, multi-file (\input) support. 0.000 is not a
  // compliment here: an `\input{chapters/intro}` parses as a PARA holding
  // an island inline, so these block-level numbers read perfectly green
  // whether or not the chapter was ever opened. That blind spot is exactly
  // why single-file-only shipped this long — the real ratchet for this
  // fixture is 'every \input resolves' below.
  'multifile/multifile.tex': 0.005,
}

/** minimum recognized structural blocks (sections+paras+lists+floats+math+…) */
const STRUCTURE_FLOORS: Record<string, number> = {
  // measured 2026-08-03: 440 / 234 / 245 / 151 / 403 / 481
  'bloom.tex': 435,
  'cot/cot.tex': 230,
  'flan/flan.tex': 240,
  'llama/llama.tex': 148,
  'palm.tex': 398,
  'palm2.tex': 475,
  // measured 2026-08-07, corpus breadth (issue #8): 51 / 17 / 22
  'thesis/thesis.tex': 51,
  // measured 2026-08-07, issue #20: 3 \section + 9 \frame wrapper blocks
  // (up from 3 — see ISLAND_CEILINGS above)
  'beamer/beamer.tex': 12,
  'biblatex/biblatex.tex': 17,
  'theorems/theorems.tex': 22,
  // measured 2026-08-09: the main file alone — abstract, 3 \input paras,
  // conclusion, bibliography furniture. The chapters' own blocks are
  // counted by the per-file replay below, not here.
  'multifile/multifile.tex': 8,
}

function bodyBlocks(blocks: LxBlock[]): LxBlock[] {
  return blocks.filter((b) => b.kind !== 'preamble' && b.kind !== 'postamble')
}

function islandRatio(src: string, blocks: LxBlock[]): number {
  const body = bodyBlocks(blocks)
  const total = body.reduce((n, b) => n + (b.span.end - b.span.start), 0)
  if (total === 0) return 1
  const island = body.reduce((n, b) => n + (b.kind === 'island' ? b.span.end - b.span.start : 0), 0)
  return island / total
}

describe('tex corpus', () => {
  it.skipIf(fixtures.length > 0)('no tex fixtures yet — see corpus/tex/README.md', () => {
    expect(fixtures.length).toBe(0)
  })

  for (const file of fixtures) {
    describe(file, () => {
      const src = readFileSync(join(texDir, file), 'utf-8')
      const doc = parseLatex(src)

      it('spans are sane and stitching is byte-identical — forever', () => {
        expect(spansSane(doc)).toBe(true)
        expect(stitch(doc)).toBe(src)
      })

      it('finds the document frame', () => {
        expect(doc.blocks[0].kind).toBe('preamble')
        expect(doc.blocks.at(-1)!.kind).toBe('postamble')
      })

      it('island ratio holds the ratchet', () => {
        const ratio = islandRatio(src, doc.blocks)
        const ceiling = ISLAND_CEILINGS[file]
        expect(ceiling, `add an ISLAND_CEILINGS entry for ${file} (measured ${ratio.toFixed(3)})`).toBeDefined()
        expect(ratio, `island ratio ${ratio.toFixed(3)} > ceiling ${ceiling}`).toBeLessThanOrEqual(ceiling)
      })

      it('recognizes enough real structure', () => {
        const structural = bodyBlocks(doc.blocks).filter((b) => b.kind !== 'island').length
        const floor = STRUCTURE_FLOORS[file]
        expect(floor, `add a STRUCTURE_FLOORS entry for ${file} (measured ${structural})`).toBeDefined()
        expect(structural).toBeGreaterThanOrEqual(floor)
      })
    })
  }

  /* Every \input a fixture names must be a file that is actually there and
   * that parses under the same invariants as a main file. This is the
   * ratchet the island/structure floors above CANNOT be: they read a
   * multi-file document as perfectly structured whether or not a single
   * chapter was ever opened, which is how "diastil cannot open a thesis"
   * survived a green corpus for as long as it did. */
  for (const file of fixtures) {
    const src = readFileSync(join(texDir, file), 'utf-8')
    const inputs = scanInputPaths(src)
    if (inputs.length === 0) continue
    describe(`${file} (project)`, () => {
      const root = dirname(join(texDir, file))
      it('every \\input resolves to a file that is really there', () => {
        for (const path of inputs) {
          expect(existsSync(join(root, path)), `${file} inputs ${path}`).toBe(true)
        }
      })

      it('each included file holds the span invariants too', () => {
        for (const path of inputs) {
          const text = readFileSync(join(root, path), 'utf-8')
          const doc = parseLatex(text)
          expect(spansSane(doc), `${path} spans`).toBe(true)
          expect(stitch(doc) === text, `${path} stitches`).toBe(true)
          // an included chapter is body-only: no \begin{document} frame,
          // and real structure rather than one big island
          expect(doc.blocks.some((b) => b.kind === 'section'), `${path} sections`).toBe(true)
        }
      })
    })
  }

  it.skipIf(fixtures.length === 0)('fuzz: random slices never throw, always stitch', () => {
    // deterministic LCG so a failure reproduces
    let seed = 0x2f6e2b1
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    for (const file of fixtures) {
      const src = readFileSync(join(texDir, file), 'utf-8')
      for (let k = 0; k < 25; k++) {
        const a = Math.floor(rand() * src.length)
        const b = Math.floor(rand() * src.length)
        const slice = src.slice(Math.min(a, b), Math.max(a, b))
        const doc = parseLatex(slice)
        expect(spansSane(doc), `${file} slice [${Math.min(a, b)}, ${Math.max(a, b)})`).toBe(true)
        expect(stitch(doc) === slice, `${file} slice [${Math.min(a, b)}, ${Math.max(a, b)}) stitches`).toBe(true)
      }
    }
  })
})
