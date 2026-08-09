/* Fixture replay for the compiled-mirror crop math — the offline half of
 * the same ratchet philosophy as src/latex/corpus.test.ts.
 *
 * Every mirror fix used to cost 4-6 minutes: rebuild, restart the daemon,
 * recompile a real paper, wait for the pass, inspect in the browser.
 * corpus/fixtures/mirror/*.json (made by scripts/capture-mirror-fixture.mjs
 * from a real daemon compile) freezes two DIFFERENT artifacts of the same
 * compile, and the whole value of this suite is that they are different:
 *
 *   - the synctex BOX TREE — the engine's own rectangles — is what
 *     cutDocument crops from. It is the thing under test.
 *   - each rendered page's INK is the ORACLE. Nothing in production reads
 *     it (see src/doc/pageink.ts). The property it checks is not a golden
 *     and cannot be satisfied by a bug that agrees with itself: EVERY CROP
 *     HOLDS ALL OF ITS BLOCK'S INK AND NONE OF A NEIGHBOUR'S.
 *
 * A handful of named rectangles are pinned as goldens too, so a change that
 * keeps the property but moves a crop still has to be argued for. Each one
 * cites the measurement behind it. */

import { readFileSync, existsSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { state } from '../state'
import { loadDocFromTex, type Doc } from '../model/doc'
import { inkBounds, inkCount, type PageInk } from './pageink'
import {
  claimsFor, cutDocument, lineRangeOf, mirrorTargets, normalizeBoxMap, ownership,
  type Claim, type PageSource, type Pass,
} from './blockmirror'

const here = dirname(fileURLToPath(import.meta.url))
// its own subdirectory: corpus/fixtures/*.json is read wholesale by
// src/ingest/corpus.test.ts as DECK fixtures, which this is not
const fixtureDir = join(here, '..', '..', 'corpus', 'fixtures', 'mirror')
const fixturePath = join(fixtureDir, 'llama.json')

interface FixturePage {
  n: number; wPt: number; hPt: number; cols: number; rows: number; scale: number
  extent: { xMin: number; xMax: number } | null; cellsGz: string; dpi: number
}
interface Fixture {
  paper: string
  synctex: { xSemantics: string; ySemantics: string; boxSemantics?: string; mainTag?: number | null
    lines: unknown[]; boxes?: unknown[]; pages?: unknown[] }
  pages: FixturePage[]
}

function inkFromFixturePage(p: FixturePage): PageInk {
  const cells = new Uint8Array(gunzipSync(Buffer.from(p.cellsGz, 'base64')))
  return { cells, cols: p.cols, rows: p.rows, scale: p.scale, wPt: p.wPt, hPt: p.hPt, extent: p.extent }
}

/** the fixture's PageSource: nothing rasterizes offline (there are no
 * pixels to draw), but a non-null url is returned so every crop the box
 * math places is still recorded as a claim — which is the geometry this
 * suite pins and checks */
const fixturePages: PageSource = { async rasterize() { return 'fixture:crop' } }

const skip = !existsSync(fixturePath)

interface Replay {
  doc: Doc
  ink: Map<number, PageInk>
  run: Pass
}

/** load a fixture's doc and replay cutDocument against its captured box
 * tree, keeping the captured page ink beside it for the oracle */
async function cutFixture(paper: string, texRel: string): Promise<Replay> {
  const fixture = JSON.parse(readFileSync(join(fixtureDir, `${paper}.json`), 'utf-8')) as Fixture
  const tex = readFileSync(join(here, '..', '..', 'corpus', 'tex', texRel), 'utf-8')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const doc = loadDocFromTex(tex, host, texRel.split('/').pop() ?? texRel)
  state.deck = null
  state.doc = doc
  state.resetLog()

  // exactly what fetchBoxes does to a daemon's wire response
  const map = normalizeBoxMap(fixture.synctex)
  const run: Pass = {
    jobId: 'fixture',
    dpi: fixture.pages[0]?.dpi ?? 130,
    ySemantics: fixture.synctex.ySemantics,
    boxes: map.boxes,
    mainTag: map.mainTag,
    dims: new Map(fixture.pages.map((p) => [p.n, { wPt: p.wPt, hPt: p.hPt }])),
    measure: map.measure,
    pages: fixturePages,
    live: () => true,
  }
  await cutDocument(doc, run)
  return { doc, ink: new Map(fixture.pages.map((p) => [p.n, inkFromFixturePage(p)])), run }
}

describe('blockmirror fixture replay', () => {
  it.skipIf(!skip)('no mirror fixture captured yet — see scripts/capture-mirror-fixture.mjs', () => {
    expect(skip).toBe(true)
  })

  describe.skipIf(skip)('llama.tex', runLlamaSuite)
})

/* ---------- the oracle ---------- */

/** How much of a block's own ink its crops hold, and how much ink they hold
 * that belongs to a NEIGHBOUR.
 *
 * "A block's own ink" is not knowable from the pixels alone — that is the
 * whole difficulty this file's production half solves. So the oracle asks
 * the question the other way round, using only geometry the crop itself
 * declares:
 *
 *   - HELD: the ink inside the crop. A crop whose rectangle is almost all
 *     blank paper is a crop of nothing, whatever it was aiming at.
 *   - STOLEN: the ink inside the crop that ANOTHER block's boxes stand in
 *     and this block's do not. That is a neighbour's line showing in this
 *     block's picture, which is the failure every deleted heuristic was
 *     fighting.
 *   - MISSED: the ink of this block's OWN boxes that no crop of it covers.
 *
 * Both wrong answers are measured against the block's boxes, and the boxes
 * are not what produced the pixels — the engine's PDF did. */
function auditBlock(
  replay: Replay,
  block: HTMLElement,
  claims: Claim[],
): { held: number; blank: number; stolen: number; missed: number } {
  const { doc, ink, run } = replay
  const range = lineRangeOf(doc, block)
  const owned = ownership(run)
  const mine = range ? new Set(owned(range.from, range.to)) : new Set<number>()
  // A box of ours that geometrically HOLDS another block's box, whole, is a
  // frame around that block's work and not evidence of our own ink — a
  // framed.sty rule box drawn at one `\end{framed}` reports every other
  // framed environment's `\end` line too. Stated as geometry, so it is the
  // oracle's own reading and not a copy of what production does with it.
  for (const i of [...mine]) {
    const r = boxRect(run.boxes[i])
    const holds = run.boxes.some((box) => {
      if (box.page !== run.boxes[i].page || box.src.length === 0) return false
      if (overlapsMine(run, mine, box)) return false
      const o = boxRect(box)
      return o.xMin >= r.xMin - 1 && o.xMax <= r.xMax + 1 && o.yMin >= r.yMin - 1 && o.yMax <= r.yMax + 1
    })
    if (holds) mine.delete(i)
  }
  let held = 0
  let blank = 0
  let stolen = 0
  for (const claim of claims) {
    const page = ink.get(claim.page)
    if (!page) continue
    const n = inkCount(page, claim)
    held += n
    if (n === 0) blank++
    // a whole-page crop holds every block on the page by design — a beamer
    // slide IS the page, and a bibliography set from a .bbl has nothing on
    // those pages keyed by main.tex at all. Theft is not a question one can
    // ask of it.
    if (claim.whole) continue
    // every box of another block that stands inside this crop
    for (let i = 0; i < run.boxes.length; i++) {
      if (mine.has(i)) continue
      const box = run.boxes[i]
      if (box.page !== claim.page || box.src.length === 0) continue
      const r = boxRect(box)
      // only boxes fully inside the crop count: a partial overlap is the
      // frame this block's own lines are set in, not a neighbour's line
      if (r.xMin < claim.xMin || r.xMax > claim.xMax) continue
      if (r.yMin < claim.yMin || r.yMax > claim.yMax) continue
      if (overlapsMine(run, mine, box)) continue
      stolen += inkCount(page, r)
    }
  }
  // A box of ours that NO crop reaches at all is a run the cut dropped.
  // Overlap rather than containment is the bar on purpose: a box the crop
  // deliberately clipped (an unscaled \includegraphics rectangle, see
  // cropsFor) is still shown, and asking for containment would score the
  // clip as a loss.
  let missed = 0
  for (const i of mine) {
    const box = run.boxes[i]
    const page = ink.get(box.page)
    if (!page) continue
    const r = boxRect(box)
    if (claims.some((c) => c.page === box.page
      && Math.min(c.xMax, r.xMax) - Math.max(c.xMin, r.xMin) > 0
      && Math.min(c.yMax, r.yMax) - Math.max(c.yMin, r.yMin) > 0)) continue
    missed += inkCount(page, r)
  }
  return { held, blank, stolen, missed }
}

function boxRect(box: { x: number; y: number; w: number; h: number; d: number }): {
  xMin: number; xMax: number; yMin: number; yMax: number
} {
  return { xMin: box.x, xMax: box.x + box.w, yMin: box.y - box.h, yMax: box.y + box.d }
}

/** is this box the same piece of typesetting as one of the block's own —
 * an ancestor, a descendant, or a box sharing one of its source lines? A
 * line box holding a run-in `\paragraph` heading is credited to the
 * paragraph, and the heading's own words are inside it; counting that as
 * theft would be counting the mirror's own design against it. */
function overlapsMine(run: Pass, mine: Set<number>, box: { src: Array<[number, number]> }): boolean {
  for (const i of mine) {
    const own = run.boxes[i]
    if (own.src.some(([t, l]) => box.src.some(([t2, l2]) => t === t2 && l === l2))) return true
  }
  return false
}

/* ---------- corpus breadth ---------- */

/** every top-level block of a compiled document must end up MIRRORED (its
 * own crop) or explicitly HIDDEN (classifyOrphans folded it into a
 * neighbour, or it sets no type of its own) — "mirrored+hidden only" is
 * issue #8's own acceptance bar. */
const CORPUS_BREADTH_FIXTURES: Array<{ paper: string; tex: string; knownUnaccounted: number }> = [
  { paper: 'thesis', tex: 'thesis/thesis.tex', knownUnaccounted: 0 },
  { paper: 'beamer', tex: 'beamer/beamer.tex', knownUnaccounted: 0 },
  { paper: 'biblatex', tex: 'biblatex/biblatex.tex', knownUnaccounted: 0 },
  { paper: 'theorems', tex: 'theorems/theorems.tex', knownUnaccounted: 0 },
  { paper: 'llama', tex: 'llama/llama.tex', knownUnaccounted: 0 },
]

describe.skipIf(skip)('corpus breadth (issue #8): every block accounted for', () => {
  for (const { paper, tex, knownUnaccounted } of CORPUS_BREADTH_FIXTURES) {
    it(`${paper}.tex — every block mirrored or hidden, unaccounted count holds (only moves down)`, async () => {
      const { doc } = await cutFixture(paper, tex)
      const targets = mirrorTargets(doc.article)
      const accounted = (b: HTMLElement): boolean =>
        b.querySelector(':scope > .de-mirror') !== null || b.querySelector(':scope > .de-mirror-hidden') !== null
      const unaccounted = targets.filter((b) => !accounted(b))
      expect(
        unaccounted.length,
        `${targets.length} top-level blocks; unaccounted: ${JSON.stringify(unaccounted.map((b) => (b.textContent ?? '').slice(0, 60)))}`,
      ).toBeLessThanOrEqual(knownUnaccounted)
    })
  }
})

describe.skipIf(skip)('the ink oracle: a crop holds its own block and nothing else', () => {
  for (const { paper, tex } of CORPUS_BREADTH_FIXTURES) {
    it(`${paper}.tex — no crop steals a neighbour's line, none is a picture of blank paper`, async () => {
      const replay = await cutFixture(paper, tex)
      const bad: string[] = []
      for (const block of mirrorTargets(replay.doc.article)) {
        const claims = claimsFor(block)
        if (!claims?.length) continue
        const audit = auditBlock(replay, block, claims)
        const label = (block.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 50)
        if (audit.blank > 0) bad.push(`blank crop: ${label}`)
        // a hair of a neighbour's ink is antialiasing at a shared edge; a
        // whole line of it is the failure this oracle exists for. The bar
        // is a share of what the crop legitimately holds.
        if (audit.stolen > Math.max(40, audit.held * 0.02)) {
          bad.push(`steals ${audit.stolen} of ${audit.held}: ${label}`)
        }
        if (audit.missed > Math.max(40, audit.held * 0.05)) {
          bad.push(`misses ${audit.missed} of ${audit.held}: ${label}`)
        }
      }
      expect(bad, bad.join('\n')).toEqual([])
    })
  }
})

/* ---------- named goldens ---------- */

/** issue #22: thesis.tex's References block used to crop the near-blank
 * filler page \backmatter's \cleardoublepage leaves on page 14 (twoside)
 * and miss the references entirely, typeset whole on page 15. It must now
 * mirror — and specifically as ONE picture (page 15's real content; page
 * 14 is still in bibliographyPages' returned range, but isFillerPage drops
 * it, exactly as it always dropped a genuinely blank page). */
it.skipIf(skip)('issue #22: thesis.tex mirrors the References block, not the blank filler page before it', async () => {
  const { doc } = await cutFixture('thesis', 'thesis/thesis.tex')
  const bib = [...doc.article.querySelectorAll<HTMLElement>('p')]
    .find((b) => (b.textContent ?? '').includes('\\bibliography{refs}'))
  if (!bib) throw new Error('fixture replay: no block holds \\bibliography{refs}')
  expect(bib.querySelector(':scope > .de-mirror')).not.toBeNull()
  expect(bib.querySelectorAll('.de-mirror-part').length).toBe(1)
})

/** issue #21: beamer.tex's 9 frames and 3 \section markers used to be
 * entirely unaccounted (12 of 12). Both are handled in full: every frame
 * crops the WHOLE PDF page(s) its own boxes name (a slide IS a page), and
 * \section hides gracefully once the classifier knows the docclass is
 * beamer. */
it.skipIf(skip)('issue #21: beamer.tex mirrors every frame (incl. every overlay page) and hides every \\section', async () => {
  const { doc } = await cutFixture('beamer', 'beamer/beamer.tex')
  // frames render as wrappers since #20; the crop path sniffs the SOURCE,
  // so it did not care — this selector has to keep up with the parser
  const islands = [...doc.article.querySelectorAll<HTMLElement>('div.dia-wrap-frame, div.dia-tex-island')]
    .filter((el) => /^\\begin\{frame\}/.test(doc.source.sliceOf(el.getAttribute('data-dia-id') ?? '') ?? ''))
  expect(islands.length).toBe(9) // 9 \begin{frame}...\end{frame} blocks
  for (const frame of islands) {
    expect(frame.querySelector(':scope > .de-mirror'), (frame.textContent ?? '').slice(0, 40)).not.toBeNull()
  }
  // measured: 1 overlay page each except the two \pause/\onslide frames —
  // "Why On-Device..." (1 pause: 2 pages) and "What Structured Sparsity
  // Buys" (3 \item overlays + 1 \onslide: 4 pages) — 9 frames, 13 pages
  const pictures = islands.map((f) => f.querySelectorAll('.de-mirror-part').length)
  expect(pictures.reduce((a, b) => a + b, 0)).toBe(13)
  expect(pictures).toEqual([1, 1, 2, 4, 1, 1, 1, 1, 1])

  const sections = [...doc.article.querySelectorAll<HTMLElement>('h2.dia-sec')]
  expect(sections.length).toBe(3) // Motivation, Method, Results
  for (const section of sections) {
    expect(section.querySelector(':scope > .de-mirror-hidden'), (section.textContent ?? '')).not.toBeNull()
  }
})

function runLlamaSuite(): void {
  let replay: Replay
  let doc: Doc

  beforeAll(async () => {
    replay = await cutFixture('llama', 'llama/llama.tex')
    doc = replay.doc
  })

  /** the one block in the document whose crop should start with this text —
   * a selector on real content rather than a fragile index, so the goldens
   * below read as "the abstract", not "block 0" */
  function block(selector: string, startsWith: string): HTMLElement {
    // a table's cells stitch into textContent with the whitespace their
    // markup happened to leave between them (tabs, blank alignment padding)
    // — collapsed here so the match is on words, not layout
    const hit = [...doc.article.querySelectorAll<HTMLElement>(selector)]
      .find((b) => (b.textContent ?? '').trim().replace(/\s+/g, ' ').startsWith(startsWith))
    if (!hit) throw new Error(`fixture replay: no ${selector} block starts with ${JSON.stringify(startsWith)}`)
    return hit
  }

  /** a block's crops, rounded to hundredths of a point — the daemon
   * reports two decimals and the pad is an integer, so anything past that
   * is float noise, not geometry */
  function crops(b: HTMLElement): Array<Record<string, number>> {
    return (claimsFor(b) ?? []).map((c) => ({
      page: c.page,
      xMin: round(c.xMin), xMax: round(c.xMax), yMin: round(c.yMin), yMax: round(c.yMax),
    }))
  }

  /** where the INK inside those crops actually is — the oracle's own
   * reading of the same pixels, so a golden can say what it shows */
  function inkOf(b: HTMLElement): Array<Record<string, number | undefined>> {
    return (claimsFor(b) ?? []).map((c) => {
      const bounds = inkBounds(replay.ink.get(c.page) as PageInk, c)
      return bounds === null ? { page: c.page } : {
        page: c.page,
        xMin: round(bounds.xMin), xMax: round(bounds.xMax),
        yMin: round(bounds.yMin), yMax: round(bounds.yMax),
      }
    })
  }

  const round = (n: number): number => Math.round(n * 100) / 100

  it('crops the abstract to one column on page 1, and its footnote separately', () => {
    const b = block('section.dia-abstract', '\\looseness=-1 We introduce')
    // WAS x[64, 295] y[93.92, 383.16] — ONE rectangle starting 120pt higher,
    // which held the paper TITLE, the author list and both affiliations
    // (cropped out of the real page and looked at). The abstract's own boxes
    // start at the word "Abstract" and its last line ends at 380.09.
    // The second crop is the `\footnote` on the abstract's last source line:
    // TeX sets it at the foot of the same column, 380pt below, and the
    // engine's boxes say so. One crop from 214 to 776 would have shown the
    // introduction and two paragraphs of section 1 in between.
    expect(crops(b)).toEqual([
      { page: 1, xMin: 69.13, xMax: 292.22, yMin: 214.13, yMax: 382.09 },
      { page: 1, xMin: 69.13, xMax: 292.22, yMin: 764.02, yMax: 775.91 },
    ])
    expect(inkOf(b)).toEqual([
      { page: 1, xMin: 87, xMax: 274, yMin: 214.79, yMax: 378.28 },
      { page: 1, xMin: 84, xMax: 256, yMin: 763.94, yMax: 772.06 },
    ])
  })

  it('crops a one-line section heading exactly, not into the abstract above it', () => {
    const b = block('h2.dia-sec', 'Introduction')
    // WAS y[383.16, 407.92] — 25pt for a 12pt heading, because the extent
    // was guessed from the distance to the neighbour's baseline. The
    // heading is ONE line box, 393.19 to 401.60, plus the 2pt pad. Its ink
    // runs 391.19-400.05: the numeral ascends past the box's metric height,
    // which is what CROP_PAD is for.
    expect(crops(b)).toEqual([{ page: 1, xMin: 69.13, xMax: 292.22, yMin: 391.19, yMax: 403.6 }])
    expect(inkOf(b)).toEqual([{ page: 1, xMin: 71, xMax: 154, yMin: 391.19, yMax: 400.05 }])
  })

  it('crops the first paragraph of column one, last line included', () => {
    const b = block('p', '\\looseness=-1 Large Languages Models')
    // WAS y[407.92, 602.29], which CUT THE LAST LINE OFF: cropped out of the
    // real page, the old rectangle stops part-way through "models trained on
    // more data." The paragraph's own line boxes run 414.95 to 612.88 and
    // the ink inside the new crop ends at 610.41 — the whole paragraph and
    // nothing after it (the next paragraph's first box starts at 618.95).
    expect(crops(b)).toEqual([{ page: 1, xMin: 69.13, xMax: 292.22, yMin: 412.95, yMax: 614.88 }])
    expect(inkOf(b)).toEqual([{ page: 1, xMin: 70, xMax: 290, yMin: 412.6, yMax: 610.41 }])
  })

  it('splits a paragraph that crosses the column break into two claims, one per column', () => {
    const b = block('p', '\\looseness=-1 The objective of the scali')
    // WAS y[603.40, 785.61] in column one and y[213.68, 309.88] in column
    // two. Column one now stops at 739.54 rather than 785.61: the
    // paragraph's last box on that page ends at 737.54, and the 46pt below
    // it is the page's bottom margin.
    expect(crops(b)).toEqual([
      { page: 1, xMin: 69.13, xMax: 292.22, yMin: 616.95, yMax: 739.54 },
      { page: 1, xMin: 305.29, xMax: 528.38, yMin: 214.98, yMax: 310.37 },
    ])
  })

  it('follows a paragraph across a page break into column one of the next page', () => {
    const b = block('p', 'In the rest of this paper, we present an')
    // WAS y[667.15, 841.89] on page 1 — 841.89 is the PAPER's foot, 68pt
    // below the last line of type, because with no neighbour below it the
    // old foot was a guess. The paragraph's own last box on page 1 ends at
    // 773.91.
    expect(crops(b)).toEqual([
      { page: 1, xMin: 305.29, xMax: 528.38, yMin: 669.29, yMax: 775.91 },
      { page: 2, xMin: 69.13, xMax: 292.22, yMin: 72.71, yMax: 86.5 },
    ])
  })

  it('reads a table set as a figure as one picture, in its own column', () => {
    const b = block('figure.dia-figure', 'Dataset Sampling prop.')
    // WAS y[0, 282.76] — from the very top EDGE of the paper, 74pt of blank
    // margin above the table's first rule. Cropped out of the real page, the
    // new rectangle is exactly the table and its caption.
    expect(crops(b)).toEqual([{ page: 2, xMin: 305.29, xMax: 528.38, yMin: 74.08, yMax: 265.14 }])
    expect(inkOf(b)).toEqual([{ page: 2, xMin: 305, xMax: 526, yMin: 77.13, yMax: 260.55 }])
  })

  it('crops a list to the column it was set in', () => {
    const b = block('ul', 'Zero-shot. We provide a textual descript')
    // WAS x[78, 297] y[580.05, 761.61], which ran 60pt past the list's last
    // item and (cropped out of the real page) showed four lines of the
    // paragraph AFTER it, while starting one line too high — inside the
    // sentence that introduces the list. The list's own boxes run 584.07 to
    // 698.73. xMin is the `\item` bullet's own left edge, 71.61, which hangs
    // to the LEFT of the item text at 84.13: the crop follows the engine's
    // box, not the text measure.
    expect(crops(b)).toEqual([{ page: 4, xMin: 69.61, xMax: 292.22, yMin: 582.07, yMax: 700.73 }])
  })

  it('crops the bibliography as whole pages, not by source line', () => {
    const b = block('p', '\\bibliography{custom}')
    // the .bbl's entries carry the bibliography FILE's synctex tag, so no
    // box on those pages is keyed by anything in main.tex — whole pages
    // are the only honest answer, and the picture count is the golden
    expect(b.querySelectorAll('.de-mirror-part').length).toBe(4)
  })

  it('mirrors most of a real 26-page paper — a coverage ratchet, not just a correctness one', () => {
    const targets = mirrorTargets(doc.article)
    const shown = targets.filter((b) => b.querySelector(':scope > .de-mirror') !== null).length
    // measured 2026-08-07: 150 top-level blocks. Floor only moves up.
    expect(targets.length).toBe(150)
    expect(shown).toBeGreaterThanOrEqual(128)
  })
}
