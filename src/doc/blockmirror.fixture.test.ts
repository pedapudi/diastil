/* Fixture replay for the compiled-mirror crop math — the offline half of
 * the same ratchet philosophy as src/latex/corpus.test.ts.
 *
 * Every mirror fix used to cost 4-6 minutes: rebuild, restart the daemon,
 * recompile a real paper, wait for the pass, inspect in the browser. The
 * vertical/horizontal crop math (regionForLines, segmentsFor, windowFor,
 * placeSegments, growTop, claimFloor, snapEdges, mainRowBand, dropFolio) was
 * already unit-tested in blockmirror.test.ts against hand-copied synctex —
 * but the PAGE INK half only ever ran live, because reading it needs a
 * canvas happy-dom does not have.
 *
 * corpus/fixtures/mirror/llama.json (made by
 * scripts/capture-mirror-fixture.mjs from a real daemon compile) freezes
 * llama.tex's synctex records and every rendered page's ink — the same
 * quantized cells pageInkOf would have produced, captured by decoding the
 * daemon's own PNGs outside the DOM. This test feeds that fixture straight
 * into cutDocument, the UNCHANGED pipeline a live compile drives, and pins
 * the resulting crop rectangles (claimsFor) as goldens.
 *
 * Goldens move only when a deliberate crop-math change earns new numbers —
 * recapture is `node scripts/capture-mirror-fixture.mjs`, see its header. */

import { readFileSync, existsSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { state } from '../state'
import { loadDocFromTex, type Doc } from '../model/doc'
import {
  cutDocument, claimsFor, groupByPage, isPhantomRecord, mirrorTargets, normalizeRecord, withoutWrappers,
  type PageInk, type PageSource, type Pass, type SynctexRecord,
} from './blockmirror'

const here = dirname(fileURLToPath(import.meta.url))
// its own subdirectory: corpus/fixtures/*.json is read wholesale by
// src/ingest/corpus.test.ts as DECK fixtures, which this is not
const fixturePath = join(here, '..', '..', 'corpus', 'fixtures', 'mirror', 'llama.json')
const texPath = join(here, '..', '..', 'corpus', 'tex', 'llama', 'llama.tex')

interface FixturePage {
  n: number; wPt: number; hPt: number; cols: number; rows: number; scale: number
  extent: { xMin: number; xMax: number } | null; cellsGz: string; dpi: number
}
interface Fixture {
  paper: string
  synctex: { xSemantics: string; ySemantics: string; lines: unknown[] }
  pages: FixturePage[]
}

function inkFromFixturePage(p: FixturePage): PageInk {
  const cells = new Uint8Array(gunzipSync(Buffer.from(p.cellsGz, 'base64')))
  return { cells, cols: p.cols, rows: p.rows, scale: p.scale, wPt: p.wPt, hPt: p.hPt, extent: p.extent }
}

/** the fixture's PageSource: ink comes back from captured cells instead of
 * a decoded bitmap, and nothing ever rasterizes — there are no pixels to
 * draw offline. A non-null url is returned anyway (see PageSource's own
 * comment in blockmirror.ts): that is what lets cutBlock record a claim for
 * every shape the coarse ink says is non-blank, which is the crop math this
 * suite is pinning. What cropBand's own pixel-level ink trim would have
 * done to that rectangle is NOT captured here — that step needs a real
 * canvas, which happy-dom does not have either (see the early-return guards
 * on the cropBand tests in blockmirror.test.ts). */
function fixturePageSource(pagesInk: Map<number, PageInk>): PageSource {
  return {
    async ink(page) {
      const ink = pagesInk.get(page)
      if (!ink) return null
      return { ink, wPt: ink.wPt, hPt: ink.hPt }
    },
    async rasterize() { return 'fixture:crop' },
  }
}

const skip = !existsSync(fixturePath)

describe('blockmirror fixture replay', () => {
  it.skipIf(!skip)('no mirror fixture captured yet — see scripts/capture-mirror-fixture.mjs', () => {
    expect(skip).toBe(true)
  })

  describe.skipIf(skip)('llama.tex', runLlamaSuite)
})

/** load a fixture's doc and replay cutDocument against its captured
 * synctex+ink — the same setup runLlamaSuite's beforeAll does, generalized
 * so the corpus-breadth fixtures (issue #8) can run the coverage check
 * below without hand-copied crop-rectangle goldens per block */
async function cutFixture(paper: string, texRel: string): Promise<Doc> {
  const fixture = JSON.parse(
    readFileSync(join(here, '..', '..', 'corpus', 'fixtures', 'mirror', `${paper}.json`), 'utf-8'),
  ) as Fixture
  const tex = readFileSync(join(here, '..', '..', 'corpus', 'tex', texRel), 'utf-8')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const doc = loadDocFromTex(tex, host, texRel.split('/').pop() ?? texRel)
  state.deck = null
  state.doc = doc
  state.resetLog()

  const rawRecords = fixture.synctex.lines.map(normalizeRecord).filter((r): r is SynctexRecord => r !== null)
  const srcLines = doc.source.text.split('\n')
  const records = withoutWrappers(rawRecords.filter((r) => !isPhantomRecord(r, srcLines)))
  const pagesInk = new Map(fixture.pages.map((p) => [p.n, inkFromFixturePage(p)]))
  const run: Pass = {
    jobId: 'fixture',
    dpi: fixture.pages[0]?.dpi ?? 130,
    ySemantics: fixture.synctex.ySemantics,
    byPage: groupByPage(records),
    measure: 0,
    claims: new Map(),
    pages: fixturePageSource(pagesInk),
    live: () => true,
  }
  await cutDocument(doc, records, run)
  return doc
}

/** every top-level block of a compiled document must end up MIRRORED (its
 * own crop) or explicitly HIDDEN (classifyOrphans folded it into a
 * neighbour, or it sets no type of its own) — "mirrored+hidden only" is
 * issue #8's own acceptance bar. A block classifyOrphans gave up on
 * (`.de-unmirrored`, the quiet-dotted-edge marker) or never touched at all
 * is a gap in the crop math the corpus should have caught.
 *
 * Both fixtures that used to land short of zero (issues #21, #22) are now
 * accounted in full — see the dedicated assertions below for what each fix
 * actually produces (a page count, a picture count), not just this ratchet. */
const CORPUS_BREADTH_FIXTURES: Array<{ paper: string; tex: string; knownUnaccounted: number }> = [
  { paper: 'thesis', tex: 'thesis/thesis.tex', knownUnaccounted: 0 },
  { paper: 'beamer', tex: 'beamer/beamer.tex', knownUnaccounted: 0 },
  { paper: 'biblatex', tex: 'biblatex/biblatex.tex', knownUnaccounted: 0 },
  { paper: 'theorems', tex: 'theorems/theorems.tex', knownUnaccounted: 0 },
]

describe.skipIf(skip)('corpus breadth (issue #8): every block accounted for', () => {
  for (const { paper, tex, knownUnaccounted } of CORPUS_BREADTH_FIXTURES) {
    it(`${paper}.tex — every block mirrored or hidden, unaccounted count holds (only moves down)`, async () => {
      const doc = await cutFixture(paper, tex)
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

/** issue #22: thesis.tex's References block used to crop the near-blank
 * filler page \backmatter's \cleardoublepage leaves on page 14 (twoside)
 * and miss the references entirely, typeset whole on page 15. It must now
 * mirror — and specifically as ONE picture (page 15's real content; page
 * 14 is still in bibliographyPages' returned range, but hasInk drops it,
 * exactly as it always dropped a genuinely blank page). */
it('issue #22: thesis.tex mirrors the References block, not the blank filler page before it', async () => {
  const doc = await cutFixture('thesis', 'thesis/thesis.tex')
  const bib = [...doc.article.querySelectorAll<HTMLElement>('p')]
    .find((b) => (b.textContent ?? '').includes('\\bibliography{refs}'))
  if (!bib) throw new Error('fixture replay: no block holds \\bibliography{refs}')
  expect(bib.querySelector(':scope > .de-mirror')).not.toBeNull()
  expect(bib.querySelectorAll('.de-mirror-part').length).toBe(1)
})

/** issue #21: beamer.tex's 9 frames and 3 \section markers used to be
 * entirely unaccounted (12 of 12) — 14 synctex records for a 13-page deck
 * gave segmentsFor almost nothing to place, and a frame's one record sits
 * at x=0 (the page's own left edge, not a real column), which bandFor's
 * exact-tolerance inBand correctly refuses to bracket for every other
 * paper's sake. Both are now handled in full: every frame crops the WHOLE
 * PDF page(s) its own records name (cause 1's fullPages path — the frame
 * with one \pause and the frame with three `<n->` items plus a \onslide<4->
 * both get every one of their overlay pages), and \section hides gracefully
 * once the classifier knows the docclass is beamer (cause 2). */
it('issue #21: beamer.tex mirrors every frame (incl. every overlay page) and hides every \\section', async () => {
  const doc = await cutFixture('beamer', 'beamer/beamer.tex')
  const islands = [...doc.article.querySelectorAll<HTMLElement>('div.dia-tex-island')]
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
  let doc: Doc

  beforeAll(async () => {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Fixture
    const tex = readFileSync(texPath, 'utf-8')
    const host = document.createElement('div')
    document.body.appendChild(host)
    doc = loadDocFromTex(tex, host, 'llama.tex')
    state.deck = null
    state.doc = doc
    state.resetLog()

    // exactly refreshMirrors' own cleaning pass (isPhantomRecord,
    // withoutWrappers) over records normalized the same way fetchSynctex
    // normalizes a daemon's wire response
    const rawRecords = fixture.synctex.lines.map(normalizeRecord).filter((r): r is SynctexRecord => r !== null)
    const srcLines = doc.source.text.split('\n')
    const records = withoutWrappers(rawRecords.filter((r) => !isPhantomRecord(r, srcLines)))

    const pagesInk = new Map(fixture.pages.map((p) => [p.n, inkFromFixturePage(p)]))
    const run: Pass = {
      jobId: 'fixture',
      dpi: fixture.pages[0]?.dpi ?? 195,
      ySemantics: fixture.synctex.ySemantics,
      byPage: groupByPage(records),
      measure: 0,
      claims: new Map(),
      pages: fixturePageSource(pagesInk),
      live: () => true,
    }
    await cutDocument(doc, records, run)
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

  it('crops the abstract to one column on page 1', () => {
    const b = block('section.dia-abstract', '\\looseness=-1 We introduce')
    expect(claimsFor(b)).toEqual([{ xMin: 64, xMax: 295, yMin: 93.92, yMax: 383.1595, page: 1 }])
  })

  it('crops a one-line section heading exactly, not into the abstract above it', () => {
    const b = block('h2.dia-sec', 'Introduction')
    expect(claimsFor(b)).toEqual([{ xMin: 64, xMax: 295, yMin: 383.1595, yMax: 407.919, page: 1 }])
  })

  it('crops the first paragraph of column one', () => {
    const b = block('p', '\\looseness=-1 Large Languages Models')
    expect(claimsFor(b)).toEqual([{ xMin: 64, xMax: 296, yMin: 407.919, yMax: 602.2919776813392, page: 1 }])
  })

  it('splits a paragraph that crosses the column break into two claims, one per column', () => {
    const b = block('p', '\\looseness=-1 The objective of the scali')
    expect(claimsFor(b)).toEqual([
      { xMin: 64, xMax: 297, yMin: 603.3991320520769, yMax: 785.6095, page: 1 },
      { xMin: 299, xMax: 532, yMin: 213.68079355238686, yMax: 309.88, page: 1 },
    ])
  })

  it('follows a paragraph across a page break into column one of the next page', () => {
    const b = block('p', 'In the rest of this paper, we present an')
    expect(claimsFor(b)).toEqual([
      { xMin: 299, xMax: 532, yMin: 667.15, yMax: 841.89, page: 1 },
      { xMin: 64, xMax: 264, yMin: 64.297, yMax: 88.42399999999999, page: 2 },
    ])
  })

  it('reads a table set as a figure as one picture, in its own column', () => {
    const b = block('figure.dia-figure', 'Dataset Sampling prop.')
    expect(claimsFor(b)).toEqual([{ xMin: 299, xMax: 532, yMin: 0, yMax: 282.76, page: 2 }])
  })

  it('crops a list to the column it was set in', () => {
    const b = block('ul', 'Zero-shot. We provide a textual descript')
    expect(claimsFor(b)).toEqual([{ xMin: 78, xMax: 297, yMin: 580.05, yMax: 761.6100000000004, page: 4 }])
  })

  it('crops the bibliography as whole pages, not synctex segments', () => {
    const b = block('p', '\\bibliography{custom}')
    // the fullPages path never records a per-line claim (see cutBlock) —
    // its crops are whole pages, so the picture count is the golden instead
    expect(claimsFor(b)).toBeUndefined()
    expect(b.querySelectorAll('.de-mirror-part').length).toBe(4)
  })

  it('mirrors most of a real 26-page paper — a coverage ratchet, not just a correctness one', () => {
    const targets = mirrorTargets(doc.article)
    const shown = targets.filter((b) => b.querySelector(':scope > .de-mirror') !== null).length
    // measured 2026-08-07: 150 top-level blocks, 128 mirrored (the rest are
    // run-in headings and layout-only source classifyOrphans correctly
    // folds into a neighbour or hides — see blockmirror.test.ts). Floor
    // only moves up.
    expect(targets.length).toBe(150)
    expect(shown).toBeGreaterThanOrEqual(128)
  })
}
