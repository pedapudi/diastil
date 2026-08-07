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
