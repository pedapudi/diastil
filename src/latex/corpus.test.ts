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
 *      requires a deliberate commit with a reason in the diff.
 *
 * The island ratchet is measured TWICE, on purpose. islandRatio reads only
 * top-level body blocks — the document's spine. rawTexRatio reads the whole
 * tree, and is the number that actually tracks what a reader sees. */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseLatex, setsNoType, spansSane, stitch } from './parse'
import { scanInputPaths } from './project'
import type { LxBlock, LxInline, PreambleMeta } from './parse'

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

/** rawTexRatio ceiling per fixture — the fraction of body bytes the reading
 * surface paints as raw mono TeX instead of typeset content. Only move DOWN.
 *
 * Why a second ratchet. ISLAND_CEILINGS counts only TOP-LEVEL body blocks, so
 * two whole dimensions of islanding are invisible to it: an island nested
 * inside a wrapper/float/list, and an island inline inside a paragraph.
 * Measured 2026-08-09, those dominate. Splitting each fixture's raw island
 * bytes into (top-level blocks / nested blocks / inline nodes), as a fraction
 * of body bytes:
 *
 *   beamer    0.0000 / 0.3609 / 0.0285      thesis    0.0000 / 0.0396 / 0.0213
 *   cot       0.0000 / 0.2409 / 0.1412      llama     0.0000 / 0.0061 / 0.0251
 *   flan      0.0000 / 0.0855 / 0.0741      palm2     0.0217 / 0.0026 / 0.0185
 *   bloom     0.0002 / 0.0087 / 0.0850      biblatex  0.0000 / 0.0000 / 0.0065
 *   palm      0.0480 / 0.0000 / 0.0512      theorems  0.0000 / 0.0000 / 0.0019
 *   multifile 0.0000 / 0.0000 / 0.1692
 *
 * The left column is the only one the old ratchet sees. beamer reading 0.000
 * while 36% of the deck is islands nested one level down is exactly the shape
 * of blindness that let `\input` ship broken behind a green corpus: an
 * `\input{chapters/intro}` is a PARA holding an island INLINE, so it scores
 * perfectly whether or not the chapter was ever opened. (That beamer row is
 * the ORIGINAL measurement, kept because it is why this ratchet exists — the
 * gap it names has since been closed; see the fixture's own note below.)
 *
 * Why THIS numerator and not raw bytes. An island is not automatically a
 * defect — it is the parser honestly refusing to guess, and render.ts is
 * built to show that well. So the metric counts only islands render.ts would
 * actually paint: it drops `dia-tex-quiet` (setsNoType furniture and bare
 * calls to preamble macros whose bodies set no type — CSS hides these, they
 * were never on the page) and `dia-tex-macro` (a bare call to a known text
 * macro, shown as its expansion with the source tucked away), and drops
 * \maketitle blocks, which render.ts maps to the derived header. Counting
 * those would punish the parser for correctly classifying furniture, and
 * would not move when a real regression made the surface worse. Concretely:
 * llama is 0.0312 raw but 0.0102 shown, because two thirds of its islands
 * are \notsotiny/\footnotesize/\tbf switches nobody ever sees.
 *
 * Cross-checked 2026-08-09 by rendering every fixture through renderDoc() in
 * happy-dom and summing the text of .dia-tex-island elements by class: agrees
 * with the numbers below on all 11 fixtures. If this walk and render.ts ever
 * drift, that check is how to find it — it cannot live here, since this file
 * runs in the node environment and render.ts needs a DOM. */
const RAW_TEX_CEILINGS: Record<string, number> = {
  // measured 2026-08-09, first measurement of the deep metric. Values are
  // the measurement rounded up in the 4th decimal — no slack, same as the
  // entries above. Where the bytes come from, and whether it is a gap:
  //
  // beamer: was 0.375, of which 0.361 was three environments —
  // columns/block/alertblock — islanded whole by `unknown environment`
  // while holding the deck's ORDINARY PROSE ("A training recipe that induces
  // block sparsity \emph{during}…"). Re-measured 2026-08-09 at 0.1088 after
  // they joined WRAPPER_ENVS beside \frame (columns/column/block/alertblock/
  // exampleblock; column's {width} is a required arg like minipage's, the
  // block family's title an OPTIONAL one like frame's) and \pause joined
  // NO_TYPE_BARE. What is left is honest: 0.099 of it is one tikzpicture,
  // unrepresentable as structure and shown typeset by the compiled mirror,
  // and the rest is \titlepage / \tableofcontents / a bare \onslide, plus
  // the 8 bytes of `\model{}` in one frame's TITLE — newly counted because
  // that title is newly PAINTED (see the wrapper branch in blockBytes).
  // Trading 8 counted bytes for nine visible slide headings is the deal.
  'beamer/beamer.tex': 0.1117,
  // cot: two different things summed. 0.241 is tikzpicture inside floats —
  // honest, unrepresentable as structure, and the compiled mirror shows it
  // typeset (same call as the ISLAND_CEILINGS note above). The other 0.110
  // is the paper's own argument-taking \newcommands: \hl{...} wraps whole
  // sentences of prose ("There are 15 trees originally. Then there were 21
  // …") and the island swallows the argument with the command. Softer gap
  // than beamer's, same direction.
  'cot/cot.tex': 0.3513,
  'flan/flan.tex': 0.1276,
  'bloom.tex': 0.0895,
  'palm.tex': 0.0848,
  'palm2.tex': 0.0407,
  'thesis/thesis.tex': 0.0503,
  'llama/llama.tex': 0.0103,
  'biblatex/biblatex.tex': 0.0042,
  'theorems/theorems.tex': 0.0004,
  // multifile: 0.121 of a 727-byte main file is three \input lines and a
  // \bibliography. Small file, so the ratio is loud; the real guard for this
  // fixture is still 'every \input resolves' below.
  'multifile/multifile.tex': 0.1211,
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

/** render.ts's isMaketitleSlice, mirrored: a block that is \maketitle plus at
 * most commands that set no type maps to the derived header, not to an
 * island. Not exported from render.ts, and importing render.ts here would
 * drag in a DOM this node-environment file does not have. */
function isMaketitleSlice(raw: string): boolean {
  const s = raw.trim()
  return /\\maketitle\b/.test(s) && setsNoType(s.replace(/\\maketitle\b/, ''))
}

/** Fraction of body bytes the reading surface shows as raw TeX — islands at
 * any depth, minus the ones render.ts renders quiet or expanded. See
 * RAW_TEX_CEILINGS above for why the numerator is defined this way. */
function rawTexRatio(src: string, blocks: LxBlock[]): number {
  const meta: PreambleMeta = blocks[0]?.kind === 'preamble' ? blocks[0].meta : {}
  const quiet = new Set(meta.quietMacros ?? [])
  const named = new Set(Object.keys(meta.textMacros ?? {}))

  /** does render.ts paint this island's source, or hide/replace it? */
  function shown(raw: string): boolean {
    if (setsNoType(raw)) return false
    const bare = /^\\([a-zA-Z]+)\s*(?:\{\})?$/.exec(raw.trim())
    return bare === null || !(quiet.has(bare[1]) || named.has(bare[1]))
  }

  function inlineBytes(ns: LxInline[]): number {
    let n = 0
    for (const x of ns) {
      if (x.kind === 'island') {
        if (shown(src.slice(x.span.start, x.span.end))) n += x.span.end - x.span.start
      } else if (x.kind === 'style' || x.kind === 'footnote') n += inlineBytes(x.inner)
      else if (x.kind === 'url' && x.inner) n += inlineBytes(x.inner)
    }
    return n
  }

  /* every container the parser can nest a block inside must be descended
   * here — a kind missed below reads as perfectly covered, which is the bug
   * this whole ratchet exists to prevent */
  function blockBytes(bs: LxBlock[]): number {
    let n = 0
    for (const b of bs) {
      if (b.kind === 'island' || b.kind === 'para') {
        // only these two reach render.ts's \maketitle branch, and slicing
        // every block's source just to ask would copy the whole corpus
        const raw = src.slice(b.span.start, b.span.end)
        if (isMaketitleSlice(raw)) continue
        if (b.kind === 'island') {
          if (shown(raw)) n += b.span.end - b.span.start
          continue
        }
      }
      if (b.kind === 'section' || b.kind === 'para') n += inlineBytes(b.inline)
      // a titled wrapper's heading is PAINTED (render.ts p.dia-wrap-title),
      // so an island inside it is on the surface like any other
      else if (b.kind === 'wrapper') n += inlineBytes(b.title ?? []) + blockBytes(b.body)
      else if (b.kind === 'abstract') n += blockBytes(b.body)
      else if (b.kind === 'float') {
        if (b.caption) n += inlineBytes(b.caption)
        n += blockBytes(b.body)
      } else if (b.kind === 'list') {
        for (const item of b.items) {
          if (item.term) n += inlineBytes(item.term)
          n += blockBytes(item.blocks)
        }
      } else if (b.kind === 'tabular') {
        for (const row of b.rows) for (const cell of row.cells) n += inlineBytes(cell.inline)
      }
    }
    return n
  }

  const body = bodyBlocks(blocks)
  const total = body.reduce((n, b) => n + (b.span.end - b.span.start), 0)
  if (total === 0) return 1
  return blockBytes(body) / total
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

      it('raw-tex ratio holds the deep ratchet', () => {
        const ratio = rawTexRatio(src, doc.blocks)
        const ceiling = RAW_TEX_CEILINGS[file]
        expect(ceiling, `add a RAW_TEX_CEILINGS entry for ${file} (measured ${ratio.toFixed(4)})`).toBeDefined()
        expect(ratio, `raw-tex ratio ${ratio.toFixed(4)} > ceiling ${ceiling}`).toBeLessThanOrEqual(ceiling)
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
