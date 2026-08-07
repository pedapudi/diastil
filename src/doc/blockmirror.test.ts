/* The compiled mirror. Four things are worth holding down:
 *
 *  1. the crop math, which is a heuristic over baselines and left edges and
 *     therefore the part most likely to be wrong in an interesting way;
 *  2. the byte-exactness invariant — a block wearing a crop must still emit
 *     its exact source bytes, and no crop may reach the file;
 *  3. the staleness rule: a picture of source that no longer exists is a
 *     lie, and must be gone the moment the block is edited;
 *  4. the fallbacks, because most of this file's job is degrading well —
 *     an old daemon with no x, a page with one column, a block synctex
 *     never saw.
 *
 * No network: the daemon paths are exercised in the browser, not here. */

import { beforeEach, describe, expect, it } from 'vitest'
import { state } from '../state'
import { loadDocFromTex, serializeDoc } from '../model/doc'
import { emitBlockTex } from '../latex/emit'
import { commitDocEdit } from './sync'
import { setText } from '../model/ops'
import {
  attachMirror, clearMirrors, cropBand, inBand, inkRunsOf, installBlockMirror,
  isMirrored, lineRangeOf, linePitch, mainRowBand, mirrorTargets, normalizeRecord, openBlock,
  pruneMirrors, regionForLines, segmentsFor, selectRunsFor, textLines, toTopDown, withoutWrappers, xGroupsOf,
  bibliographyPages, isLayoutOnlySlice, liesAbovePrev, claimFloor, dropFolio,
  type SynctexRecord,
} from './blockmirror'

const TEX = `\\documentclass{article}
\\begin{document}

\\section{Charts}

A paragraph before the chart.

\\begin{tikzpicture}
\\draw (0,0) -- (1,1);
\\draw (1,1) -- (2,0);
\\end{tikzpicture}

A paragraph after the chart.

\\begin{figure}
\\includegraphics{plot.pdf}
\\caption{A plot}
\\end{figure}

\\end{document}
`

function mount(tex = TEX) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const doc = loadDocFromTex(tex, host, 'charts.tex')
  state.deck = null
  state.doc = doc
  state.resetLog()
  return doc
}

const PNG = 'data:image/png;base64,iVBORw0KGgo='

beforeEach(() => {
  clearMirrors()
  state.doc = null
  state.deck = null
  state.resetLog()
})

/* ---------- the vertical crop math ---------- */

const RECORDS: SynctexRecord[] = [
  { line: 4, page: 1, y: 100 },  // section
  { line: 6, page: 1, y: 140 },  // paragraph before
  { line: 8, page: 1, y: 380 },  // the tikzpicture's baseline: at its FOOT
  { line: 14, page: 1, y: 420 }, // paragraph after
  { line: 17, page: 2, y: 200 }, // the float, on the next page
]

describe('regionForLines', () => {
  it('brackets a block by the records around it, not by its own baselines', () => {
    const r = regionForLines(RECORDS, 7, 11)
    // a picture whose only record is its foot must still be covered: the
    // band starts just under the previous line, not just above the foot
    expect(r).toEqual({ page: 1, yMin: 148, yMax: 412, anchors: [380] })
  })

  it('runs to the page top when nothing is typeset above it', () => {
    const r = regionForLines([{ line: 8, page: 3, y: 120 }, { line: 20, page: 3, y: 300 }], 7, 11)
    expect(r?.page).toBe(3)
    expect(r?.yMin).toBe(0) // 120 - LOOKBACK, clamped
    expect(r?.yMax).toBe(292)
  })

  it('keeps a lookahead when nothing follows on the page', () => {
    const r = regionForLines([{ line: 8, page: 1, y: 500 }], 8, 8)
    expect(r).toEqual({ page: 1, yMin: 100, yMax: 590, anchors: [500] })
  })

  it('carries every one of the block\'s baselines as anchors for the ink trim', () => {
    // all of them, not just the outer two: each is a run of ink the block
    // owns, and a caption under a table is reachable by no other
    const r = regionForLines(RECORDS, 4, 8)
    expect(r?.anchors).toEqual([100, 140, 380])
  })

  it('clamps the foot to the page height when one is known', () => {
    const r = regionForLines([{ line: 8, page: 1, y: 700 }], 8, 8, { hPt: 720 })
    expect(r?.yMax).toBe(720)
  })

  it('mirrors the first page when a block spans a page break', () => {
    const spanning: SynctexRecord[] = [
      { line: 8, page: 1, y: 600 },
      { line: 9, page: 2, y: 80 },
      { line: 12, page: 2, y: 300 },
    ]
    const r = regionForLines(spanning, 8, 12)
    expect(r?.page).toBe(1)
  })

  it('is null when synctex never saw those lines', () => {
    expect(regionForLines(RECORDS, 40, 50)).toBeNull()
    expect(regionForLines([], 1, 10)).toBeNull()
  })

  it('mirrors a bottom-up map through the page height', () => {
    const flipped = toTopDown({ page: 1, yMin: 100, yMax: 300, anchors: [120, 280] }, 720, 'bottomUpPt')
    expect(flipped).toEqual({ page: 1, yMin: 420, yMax: 620, anchors: [600, 440] })
  })

  it('leaves a top-down map alone, and carries the x window through a flip', () => {
    const same = { page: 1, yMin: 100, yMax: 300, anchors: [120], xMin: 70, xMax: 300 }
    expect(toTopDown(same, 720, 'topDownPt')).toEqual(same)
    const flipped = toTopDown(same, 720, 'bottomUpPt')
    expect(flipped.xMin).toBe(70)
    expect(flipped.xMax).toBe(300)
  })
})

/* ---------- prose bracketing ---------- */

describe('regionForLines on prose', () => {
  /* twelve baselines a pitch apart: three paragraphs of four lines, set
   * solid the way a paper is. Nothing here has a blank run between it, so
   * "trim to the ink" would hand every paragraph the whole column. */
  const SOLID: SynctexRecord[] = Array.from({ length: 12 }, (_, i) => ({
    line: i + 1, page: 1, y: 100 + i * 12,
  }))

  it('cuts between the baselines and says the cut is exact', () => {
    const r = regionForLines(SOLID, 5, 8, { pitch: 12 })!
    // our baselines run 148..184, the neighbours sit at 136 and 196: cut
    // just under the line above and just over the line below
    expect(r.keepTop).toBe(true)
    expect(r.keepBottom).toBe(true)
    expect(r.yMin).toBeCloseTo(139.6, 1)   // 136 + 0.3 pitch: under its descenders
    expect(r.yMax).toBeCloseTo(185.8, 1)   // 196 - 0.85 pitch: over its ascenders
  })

  it('does not clip its own first line when the source line above wrapped', () => {
    // a two-pitch gap above: still the neighbouring line, but ours must
    // keep its ascenders
    const wrapped: SynctexRecord[] = [
      { line: 1, page: 1, y: 100 }, { line: 5, page: 1, y: 124 },
      { line: 6, page: 1, y: 136 },
    ]
    const r = regionForLines(wrapped, 5, 5, { pitch: 12 })!
    expect(r.keepTop).toBe(true)
    expect(r.yMin).toBeCloseTo(113.8, 1) // 124 - 0.85 pitch, not 100 + 0.15
  })

  it('crops prose to its own lines even when the neighbour is far', () => {
    // the case a threshold cannot catch: the last source line of the
    // paragraph above wrapped, so its record is three lines up. Only the
    // markup knows this block is lines of type.
    const gapped: SynctexRecord[] = [
      { line: 1, page: 1, y: 100 }, { line: 9, page: 1, y: 160 },
      { line: 10, page: 1, y: 172 }, { line: 20, page: 1, y: 240 },
    ]
    const loose = regionForLines(gapped, 9, 10, { pitch: 12 })!
    expect(loose.yMin).toBe(108) // generous: 100 + PAD, the line above and all
    const typed = regionForLines(gapped, 9, 10, { pitch: 12, linesOfType: true })!
    expect(typed.yMin).toBeCloseTo(149.8, 1) // one ascent above our own first line
    expect(typed.keepTop).toBe(true)
    expect(typed.keepBottom).toBe(true)
  })

  it('lets a wrapped last source line finish, but not run away', () => {
    const trailing: SynctexRecord[] = [
      { line: 1, page: 1, y: 100 }, { line: 5, page: 1, y: 112 },
      { line: 30, page: 1, y: 400 }, // the next block is a figure, far below
    ]
    // one source line, but the text needs six typeset ones
    const long = regionForLines(trailing, 5, 5, { pitch: 12, linesOfType: true, maxLines: 6 })!
    expect(long.yMax).toBeCloseTo(190, 1) // 112 + 6.5 pitches: six lines and slack

    // one source line holding one line's worth of text claims one line —
    // a heading does not own the paragraph the records put below it
    const short = regionForLines(trailing, 5, 5, { pitch: 12, linesOfType: true, maxLines: 1 })!
    expect(short.yMax).toBeCloseTo(118, 1)
  })

  it('stays generous when the neighbour is far — a picture reports one foot', () => {
    const r = regionForLines(RECORDS, 7, 11, { pitch: 12 })!
    expect(r.keepTop).toBeUndefined()
    expect(r.keepBottom).toBeUndefined()
    expect(r.yMin).toBe(148)
    expect(r.yMax).toBeCloseTo(409.8, 1) // 420 - 0.85 pitch, clear of its ascenders
  })

  it('brackets generously with no pitch to judge by', () => {
    const r = regionForLines(SOLID, 5, 8)!
    expect(r.keepTop).toBeUndefined()
    expect(r.yMin).toBe(144) // 136 + PAD, the old generous bracket
  })
})

describe('textLines', () => {
  it('a heading is one line, a paragraph is many', () => {
    expect(textLines('First Section'.length, 229, 12)).toBe(1)
    expect(textLines(600, 229, 12)).toBeGreaterThan(6)
  })

  it('says one line when there is nothing to measure against', () => {
    expect(textLines(500, 0, 12)).toBe(1)
    expect(textLines(500, 229, 0)).toBe(1)
  })
})

describe('linePitch', () => {
  it('reads the leading off the page, ignoring the odd big jump', () => {
    expect(linePitch([100, 112, 124, 136, 300, 312, 324])).toBe(12)
  })

  it('reads the LEADING, not the average gap: source lines wrap', () => {
    // records two and three typeset lines apart, with real single-line
    // gaps mixed in — the median would say 22, the leading is 11
    expect(linePitch([0, 11, 33, 55, 66, 88, 110, 121])).toBe(11)
  })

  it('falls back when there is no rhythm to read', () => {
    expect(linePitch([])).toBe(12)
    expect(linePitch([100])).toBe(12)
  })
})

/* ---------- grouping a block's boxes ---------- */

/* An ACL-shaped two-column page on US letter: the measure is 219.6pt, the
 * columns start at 72 and at 306, and the boxes synctex actually reports
 * scatter across each column — one per source line, the innermost one that
 * line opened, which is as often an inline formula as a full line. */
function box(line_: number, x: number, w: number, y = 100, page = 1): SynctexRecord {
  return { line: line_, page, y, x, w }
}
function mark(line_: number, x: number, y = 100, page = 1): SynctexRecord {
  return { line: line_, page, y, x }
}

describe('xGroupsOf', () => {
  it('splits the columns and keeps an indent family together', () => {
    // 72 and 87 are one column's margin and its \parindent; 306 is the
    // other column, a third of the paper away
    expect(xGroupsOf([72, 87, 306, 321])).toEqual([[72, 87], [306, 321]])
  })

  it('is one group for a one-column page, however the boxes straggle', () => {
    expect(xGroupsOf([72, 87, 110, 140, 180, 200])).toEqual([[72, 87, 110, 140, 180, 200]])
  })

  it('de-duplicates and sorts, because a column left repeats all day', () => {
    expect(xGroupsOf([306, 72, 306, 72])).toEqual([[72], [306]])
  })

  it('has nothing to say about nothing', () => {
    expect(xGroupsOf([])).toEqual([])
    expect(xGroupsOf([Number.NaN])).toEqual([])
  })
})

describe('segmentsFor', () => {
  it('splits a paragraph that crossed a column break into two segments', () => {
    const recs = [
      box(10, 72, 219.6, 700), box(11, 72, 219.6, 712),
      box(12, 306, 219.6, 100), box(13, 306, 219.6, 112),
    ]
    const segs = segmentsFor(recs, 10, 13)
    expect(segs.length).toBe(2)
    expect(segs[0].xs).toEqual([72])
    expect(segs[1].xs).toEqual([306])
    expect(segs[0].records.map((r) => r.line)).toEqual([10, 11])
  })

  it('splits a page from a page — one crop each', () => {
    const recs = [box(10, 72, 219.6, 700, 1), box(11, 72, 219.6, 100, 2)]
    expect(segmentsFor(recs, 10, 11).map((s) => s.page)).toEqual([1, 2])
  })

  it('reads the clusters off the MEASURED boxes only', () => {
    // line 12's innermost box is an inline formula halfway across the
    // column; it is not evidence of a second column, and it rides along in
    // the cluster it falls in
    const recs = [box(10, 72, 219.6, 100), mark(11, 96, 112), mark(12, 130, 124)]
    const segs = segmentsFor(recs, 10, 12)
    expect(segs.length).toBe(1)
    expect(segs[0].xs).toEqual([72])
    expect(segs[0].records.map((r) => r.line)).toEqual([10, 11, 12])
  })

  it('keeps a lone far box out of the cluster — it is its own candidate', () => {
    // measured on llama.tex page 1: a paragraph set in column one reports
    // one record at x=511 in column two. Letting it into the CLUSTER made
    // the window span both columns with a blank gutter down the middle; as
    // its own segment it resolves to its own column (and on llama.tex it
    // really was one — the paragraph's continuation over there).
    const recs = [box(10, 72, 219.6, 620), box(11, 72, 219.6, 632), mark(12, 511, 251)]
    const segs = segmentsFor(recs, 10, 12)
    expect(segs.length).toBe(2)
    expect(segs[0].xs).toEqual([72])
    expect(segs[0].records.some((r) => r.x === 511)).toBe(false)
    expect(segs[1].records.map((r) => r.line)).toEqual([12])
  })

  it('offers a table\'s cell columns as separate candidates', () => {
    // they are one thing, but only the ink can say so: these clusters are
    // merged again when both resolve to the same run
    const recs = [box(10, 306, 67.5, 100), box(11, 483, 43.4, 100), box(12, 483, 43.4, 114)]
    expect(segmentsFor(recs, 10, 12).map((s) => s.xs)).toEqual([[306], [483]])
  })

  it('has no witness to offer when the daemon reports no x', () => {
    const segs = segmentsFor([{ line: 10, page: 1, y: 100 }], 10, 10)
    expect(segs.length).toBe(1)
    expect(segs[0].xs).toEqual([])
  })

  it('is empty when synctex never saw those lines', () => {
    expect(segmentsFor([box(10, 72, 219.6)], 40, 50)).toEqual([])
    expect(segmentsFor([], 1, 10)).toEqual([])
  })
})

/* ---------- the ink window ---------- */

/** a projection over the page's width, in points: `spans` are inked */
function inked(spans: Array<[number, number]>, width = 612): number[] {
  const out = new Array(width).fill(0)
  for (const [from, to] of spans) for (let x = from; x <= to; x++) out[x] = 3
  return out
}

describe('inkRunsOf', () => {
  it('reads two columns off the gutter between them', () => {
    // the ACL page: type from 71 to 290 and from 307 to 526
    expect(inkRunsOf(inked([[71, 290], [307, 526]]), 10)).toEqual([[71, 290], [307, 526]])
  })

  it('does not cut a column at a word space or a cell gap', () => {
    expect(inkRunsOf(inked([[71, 180], [186, 290]]), 10)).toEqual([[71, 290]])
  })

  it('sees a wrapfigure as its own run beside the narrowed measure', () => {
    expect(inkRunsOf(inked([[71, 300], [340, 520]]), 10)).toEqual([[71, 300], [340, 520]])
  })

  it('finds nothing on blank paper', () => {
    expect(inkRunsOf(new Array(612).fill(0), 10)).toEqual([])
  })
})

describe('selectRunsFor', () => {
  const runs = inkRunsOf(inked([[71, 290], [307, 526]]), 10)

  it('keeps the column the block\'s boxes stand in', () => {
    expect(selectRunsFor(runs, [71.13, 88.2])).toEqual([71, 290])
    expect(selectRunsFor(runs, [307.29, 483.56])).toEqual([307, 526])
  })

  it('spans from the first owned run to the last — a table is one picture', () => {
    const cells = inkRunsOf(inked([[307, 374], [400, 440], [483, 526]]), 10)
    expect(cells.length).toBe(3)
    expect(selectRunsFor(cells, [307.29, 483.56])).toEqual([307, 526])
  })

  it('takes the nearest run when nothing of ours stands on ink', () => {
    // a centred figure whose record sits back at the column margin
    expect(selectRunsFor(inkRunsOf(inked([[140, 260]]), 10), [71.13])).toEqual([140, 260])
  })

  it('takes the whole band when the block has no boxes to place it by', () => {
    expect(selectRunsFor(runs, [])).toEqual([71, 526])
  })

  it('is null on blank paper', () => {
    expect(selectRunsFor([], [71.13])).toBeNull()
  })
})

describe('inBand', () => {
  const recs: SynctexRecord[] = [
    { line: 1, page: 1, y: 100, x: 72 },
    { line: 2, page: 1, y: 110, x: 306 },
    { line: 3, page: 1, y: 120 },
  ]

  it('keeps the column asked for and drops the neighbour', () => {
    // record 3 carries no x — it stays, because it may still bracket
    expect(inBand(recs, { xMin: 66, xMax: 297.6 }).map((r) => r.line)).toEqual([1, 3])
  })
})

/* ---------- the ink trim ---------- */

function rows(spec: Array<[number, number]>, total: number): boolean[] {
  const out = new Array(total).fill(false)
  for (const [from, to] of spec) for (let y = from; y <= to; y++) out[y] = true
  return out
}

describe('mainRowBand', () => {
  /* the real case this exists for: a generous band around a float on page 1
   * of a paper — three lines of the abstract above, the figure and its
   * caption, the running footer below. Only the middle is the block's. */
  const PAGE = rows([[0, 25], [60, 230], [240, 265], [330, 342]], 360)

  it('keeps the run the block\'s baselines landed in, dropping the neighbours', () => {
    expect(mainRowBand(PAGE, 24, [232, 262])).toEqual({ top: 60, bottom: 265 })
  })

  it('joins a float to its caption across a narrow gap', () => {
    expect(mainRowBand(PAGE, 24, [100])).toEqual({ top: 60, bottom: 265 })
  })

  it('takes an anchor that fell just past the ink it belongs to', () => {
    // a baseline sits at the foot of its glyphs, sometimes a pixel below
    expect(mainRowBand(PAGE, 24, [233])).toEqual({ top: 60, bottom: 265 })
  })

  it('spans from the first anchored run to the last', () => {
    expect(mainRowBand(PAGE, 24, [10, 340])).toEqual({ top: 0, bottom: 342 })
  })

  it('falls back to the tallest run when no anchor lands on ink', () => {
    // 300 is in the gap before the footer — the figure run wins anyway
    expect(mainRowBand(PAGE, 24, [300])).toEqual({ top: 60, bottom: 265 })
    expect(mainRowBand(PAGE, 24, [])).toEqual({ top: 60, bottom: 265 })
  })

  it('is null for a band with no ink at all', () => {
    expect(mainRowBand(new Array(50).fill(false), 24, [10])).toBeNull()
  })

  it('never lets a baseline claim a run standing below it', () => {
    // a baseline is never above its own line's ink — an anchor just over
    // the next block's ink top is the line above claiming the line below
    // (ambit p22: 3.6pt over the next paragraph absorbed its first line)
    const page = rows([[60, 230], [280, 300]], 360)
    expect(mainRowBand(page, 24, [232])).toEqual({ top: 60, bottom: 230 })
    // 9px over the run top — the 3.6pt of the measured ambit case
    expect(mainRowBand(page, 24, [271])).toEqual({ top: 60, bottom: 230 })
  })
})

/* ---------- reading the wire ---------- */

describe('normalizeRecord', () => {
  it('takes x and w when the daemon reports them', () => {
    expect(normalizeRecord({ line: 3, page: 1, y: 100, x: 72, w: 234 }))
      .toEqual({ line: 3, page: 1, y: 100, x: 72, w: 234 })
  })

  it('drops x and w a daemon does not report, keeping the record', () => {
    expect(normalizeRecord({ line: 3, page: 1, y: 100 })).toEqual({ line: 3, page: 1, y: 100 })
  })

  it('refuses a record missing the three fields the crop needs', () => {
    expect(normalizeRecord({ line: 3, page: 1 })).toBeNull()
    expect(normalizeRecord({ line: 3, page: 1, y: Infinity })).toBeNull()
    expect(normalizeRecord(null)).toBeNull()
  })
})

/* ---------- targets and line ranges ---------- */

describe('mirrorTargets', () => {
  it('takes every top-level block, prose included — the mirror is the document', () => {
    const doc = mount()
    const targets = mirrorTargets(doc.article)
    expect(targets.some((t) => t.matches('p'))).toBe(true)
    expect(targets.some((t) => t.matches('h2.dia-sec'))).toBe(true)
    expect(targets.some((t) => t.matches('div.dia-tex-island'))).toBe(true)
    expect(targets.some((t) => t.matches('figure.dia-figure'))).toBe(true)
  })

  it('leaves the derived header alone — it is not source-backed', () => {
    const doc = mount('\\documentclass{article}\n\\title{T}\n\\begin{document}\n'
      + '\\maketitle\n\nBody text.\n\n\\end{document}\n')
    expect(mirrorTargets(doc.article).some((t) => t.matches('header.dia-doc-header'))).toBe(false)
  })

  it('names the lines a block\'s TEXT is on, not the blank ones around it', () => {
    // a block's slice starts at the newline that ended the block before it;
    // taken literally, every paragraph would claim the line above it
    const doc = mount()
    const heading = mirrorTargets(doc.article).find((t) => t.matches('h2.dia-sec'))!
    const para = mirrorTargets(doc.article).find((t) =>
      t.matches('p') && (t.textContent ?? '').startsWith('A paragraph before'))!
    const lines = doc.source.text.split('\n')
    const h = lineRangeOf(doc, heading)!
    const pr = lineRangeOf(doc, para)!
    expect(lines[h.from - 1]).toContain('\\section{Charts}')
    expect(lines[pr.from - 1]).toContain('A paragraph before')
    expect(pr.from).toBeGreaterThan(h.to)
  })

  it('maps a block to the source lines it occupies', () => {
    const doc = mount()
    const island = mirrorTargets(doc.article).find((t) => t.matches('div.dia-tex-island'))!
    const range = lineRangeOf(doc, island)!
    const lines = doc.source.text.split('\n')
    expect(lines[range.from - 1]).toContain('\\begin{tikzpicture}')
    expect(lines[range.to - 1]).toContain('\\end{tikzpicture}')
  })
})

/* ---------- planning a crop, from a real document ---------- */

describe('a block\'s segments', () => {
  function paraOf(doc: ReturnType<typeof mount>): HTMLElement {
    return mirrorTargets(doc.article).find((t) => t.matches('p'))!
  }

  /** records covering every source line of the document, as full lines of
   * one column starting at x */
  function column(doc: ReturnType<typeof mount>, x?: number, w?: number): SynctexRecord[] {
    const n = doc.source.text.split('\n').length
    return Array.from({ length: n }, (_, i) => ({
      line: i + 1, page: 1, y: 80 + i * 14,
      ...(x === undefined ? {} : { x }), ...(w === undefined ? {} : { w }),
    }))
  }

  it('gives a paragraph of one column one segment', () => {
    const doc = mount()
    const range = lineRangeOf(doc, paraOf(doc))!
    const segs = segmentsFor(column(doc, 72, 468), range.from, range.to)
    expect(segs.length).toBe(1)
    expect(segs[0].page).toBe(1)
    expect(segs[0].xs).toEqual([72])
  })

  it('still names the page when the daemon reports no widths', () => {
    const doc = mount()
    const range = lineRangeOf(doc, paraOf(doc))!
    const segs = segmentsFor(column(doc, 72), range.from, range.to)
    expect(segs.length).toBe(1)
    expect(segs[0].xs).toEqual([72]) // x with no width still places the block
  })

  it('has nothing for a block synctex never saw', () => {
    const doc = mount()
    const range = lineRangeOf(doc, paraOf(doc))!
    expect(segmentsFor([{ line: 999, page: 1, y: 10 }], range.from, range.to)).toEqual([])
  })

  it('names the lines a block covers, blank lines excluded', () => {
    const doc = mount()
    const island = mirrorTargets(doc.article).find((t) => t.matches('div.dia-tex-island'))!
    const range = lineRangeOf(doc, island)!
    const segs = segmentsFor(column(doc, 72, 468), range.from, range.to)
    expect(segs[0].records.map((r) => r.line)).toEqual(
      Array.from({ length: range.to - range.from + 1 }, (_, i) => range.from + i))
  })
})

/* ---------- the byte-exactness invariant ---------- */

describe('a crop is not part of the document', () => {
  it('leaves the island emitting its exact source bytes', () => {
    const doc = mount()
    const island = mirrorTargets(doc.article).find((t) => t.matches('div.dia-tex-island'))!
    const id = island.getAttribute('data-dia-id')!
    const span = doc.source.spanOf(id)!
    const exact = doc.source.text.slice(span.start, span.end)

    expect(emitBlockTex(island)).toBe(exact)
    attachMirror(doc, island, [{ url: PNG }])
    expect(island.querySelector('.de-mirror')).not.toBeNull()
    expect(emitBlockTex(island)).toBe(exact)
  })

  it('leaves mirrored paragraphs and headings emitting their exact source bytes', () => {
    const doc = mount()
    let checked = 0
    for (const block of mirrorTargets(doc.article)) {
      if (!block.matches('p, h2.dia-sec')) continue
      const span = doc.source.spanOf(block.getAttribute('data-dia-id')!)!
      const exact = doc.source.text.slice(span.start, span.end)
      attachMirror(doc, block, [{ url: PNG, widthPct: 52 }])
      expect(emitBlockTex(block)).toBe(exact)
      checked++
    }
    expect(checked).toBeGreaterThan(1)
  })

  it('leaves a mirrored figure emitting its exact source bytes', () => {
    const doc = mount()
    const figure = mirrorTargets(doc.article).find((t) => t.matches('figure.dia-figure'))!
    const span = doc.source.spanOf(figure.getAttribute('data-dia-id')!)!
    const exact = doc.source.text.slice(span.start, span.end)
    attachMirror(doc, figure, [{ url: PNG }])
    expect(emitBlockTex(figure)).toBe(exact)
  })

  it('never reaches the saved artifact', () => {
    const doc = mount()
    for (const t of mirrorTargets(doc.article)) attachMirror(doc, t, [{ url: PNG }])
    const html = serializeDoc(doc)
    expect(html).not.toContain('de-mirror')
    expect(html).not.toContain('the compiled render')
    expect(html).not.toContain('data:image/png')
    // and the source block is untouched
    expect(html).toContain('tikzpicture')
  })

  it('is invisible to the emitter inside a wrapped environment too', () => {
    // an abstract or a center block rebuilds itself from its CHILDREN, and
    // one of those children is now a picture of the PDF
    const doc = mount('\\documentclass{article}\n\\begin{document}\n\n'
      + '\\begin{center}\nCentred prose.\n\\end{center}\n\n\\end{document}\n')
    const wrap = mirrorTargets(doc.article).find((t) => t.matches('div.dia-wrap'))!
    const span = doc.source.spanOf(wrap.getAttribute('data-dia-id')!)!
    const exact = doc.source.text.slice(span.start, span.end)
    attachMirror(doc, wrap, [{ url: PNG }])
    const inner = wrap.querySelector('p')!
    inner.textContent = 'Rewritten centred prose.'
    expect(emitBlockTex(wrap)).toBe(exact.replace('Centred prose.', 'Rewritten centred prose.'))
  })

  it('touches nothing on the block itself — no class, no style, no attribute', () => {
    const doc = mount()
    const para = mirrorTargets(doc.article).find((t) => t.matches('p'))!
    const before = [...para.attributes].map((a) => `${a.name}=${a.value}`).sort()
    attachMirror(doc, para, [{ url: PNG, widthPct: 50 }])
    expect([...para.attributes].map((a) => `${a.name}=${a.value}`).sort()).toEqual(before)
  })
})

/* ---------- staleness ---------- */

describe('crops clear when their source changes', () => {
  it('drops the edited block\'s crop and keeps the others', () => {
    const doc = mount()
    const island = mirrorTargets(doc.article).find((t) => t.matches('div.dia-tex-island'))!
    const figure = mirrorTargets(doc.article).find((t) => t.matches('figure.dia-figure'))!
    attachMirror(doc, island, [{ url: 'data:,a' }])
    attachMirror(doc, figure, [{ url: 'data:,b' }])

    const pre = island.querySelector('pre')!
    commitDocEdit(doc, island, [setText(pre, '\\begin{tikzpicture}\n\\draw (0,0) -- (3,3);\n\\end{tikzpicture}')], 'edit island')
    pruneMirrors()

    expect(island.querySelector('.de-mirror')).toBeNull()
    expect(isMirrored(island)).toBe(false)
    expect(figure.querySelector('.de-mirror')).not.toBeNull()
    expect(isMirrored(figure)).toBe(true)
  })

  it('an edited paragraph is HTML again at once', () => {
    const doc = mount()
    const para = mirrorTargets(doc.article).find((t) => t.matches('p'))!
    attachMirror(doc, para, [{ url: 'data:,a' }])
    commitDocEdit(doc, para, [setText(para, 'A rewritten paragraph.')], 'edit text')
    pruneMirrors()
    expect(para.querySelector('.de-mirror')).toBeNull()
    expect(para.textContent).toContain('A rewritten paragraph.')
  })

  it('drops everything when the whole source is recommitted', () => {
    installBlockMirror()
    const doc = mount()
    for (const t of mirrorTargets(doc.article)) attachMirror(doc, t, [{ url: 'data:,x' }])
    expect(doc.article.querySelectorAll('.de-mirror').length).toBeGreaterThan(0)

    state.bus.emit({ type: 'blocks-changed' })
    expect(doc.article.querySelectorAll('.de-mirror').length).toBe(0)
  })

  it('drops a crop whose block left the document', () => {
    const doc = mount()
    const island = mirrorTargets(doc.article).find((t) => t.matches('div.dia-tex-island'))!
    attachMirror(doc, island, [{ url: 'data:,a' }])
    island.remove()
    pruneMirrors()
    expect(island.querySelector('.de-mirror')).toBeNull()
  })

  it('replaces rather than stacks when a compile refreshes it', () => {
    const doc = mount()
    const island = mirrorTargets(doc.article).find((t) => t.matches('div.dia-tex-island'))!
    attachMirror(doc, island, [{ url: 'data:,a' }])
    attachMirror(doc, island, [{ url: 'data:,b' }])
    expect(island.querySelectorAll('.de-mirror').length).toBe(1)
    expect(island.querySelector('img')?.getAttribute('src')).toBe('data:,b')
  })

  it('says nothing about recompiling when no compile is coming', () => {
    // the compile state in a test process is offline: an edited block is
    // simply an HTML block again, with no promise attached
    const doc = mount()
    const para = mirrorTargets(doc.article).find((t) => t.matches('p'))!
    attachMirror(doc, para, [{ url: 'data:,a' }])
    commitDocEdit(doc, para, [setText(para, 'Rewritten.')], 'edit text')
    pruneMirrors()
    expect(para.querySelector('.de-stale')).toBeNull()
  })
})

/* ---------- the band ---------- */

describe('cropBand', () => {
  it('returns null for a band with no ink in it', () => {
    // happy-dom has no 2d context; where it does, a blank band is no crop
    const canvas = document.createElement('canvas')
    if (typeof canvas.getContext !== 'function' || !canvas.getContext('2d')) return
    canvas.width = 40
    canvas.height = 40
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 40, 40)
    const region = { page: 1, yMin: 0, yMax: 40, anchors: [20] }
    expect(cropBand({ image: canvas, scale: 1, wPt: 40, hPt: 40 }, region)).toBeNull()
  })

  it('keeps the x window exactly, so every block in a column shares a scale', () => {
    const canvas = document.createElement('canvas')
    if (typeof canvas.getContext !== 'function' || !canvas.getContext('2d')) return
    canvas.width = 200
    canvas.height = 100
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 200, 100)
    // one short mark inside the window: an ink trim would crop tight to it
    ctx.fillStyle = '#000000'
    ctx.fillRect(30, 40, 10, 6)
    const out = cropBand(
      { image: canvas, scale: 1, wPt: 200, hPt: 100 },
      { page: 1, yMin: 0, yMax: 100, anchors: [46], xMin: 20, xMax: 120 },
    )
    expect(out?.width).toBe(100)
  })
})

/* ---------- the recompiling marker ---------- */

describe('the recompiling marker', () => {
  /* it only appears when a compile is actually coming, so the engine has to
   * be announced first — and once it is inside a <p>, it had better be as
   * invisible to the emitter as the crop is */
  const ENGINE = {
    engine: 'tectonic', path: '/usr/bin/tectonic', version: 'tectonic 0.15.0',
    synctex: true, downloadable: false, managed: false, detail: null,
  }

  it('marks a block the user OPENED and then edited', () => {
    // opening hands the crop back before a single keystroke, so the
    // bookkeeping that watches crops no longer speaks for this block
    window.dispatchEvent(new CustomEvent('dia-service-status', { detail: { online: true, tex: ENGINE } }))
    const doc = mount()
    const para = mirrorTargets(doc.article).find((t) => t.matches('p'))!
    attachMirror(doc, para, [{ url: PNG }])
    openBlock(para)
    expect(para.querySelector('.de-mirror')).toBeNull()
    expect(para.querySelector('.de-stale')).toBeNull() // opened, not yet edited

    commitDocEdit(doc, para, [setText(para, 'Rewritten.')], 'edit text')
    pruneMirrors()
    expect(para.querySelector('.de-stale')).not.toBeNull()
    window.dispatchEvent(new CustomEvent('dia-service-status', { detail: { online: false, tex: null } }))
  })

  it('marks an edited block and leaves its bytes alone', () => {
    window.dispatchEvent(new CustomEvent('dia-service-status', { detail: { online: true, tex: ENGINE } }))
    const doc = mount()
    const para = mirrorTargets(doc.article).find((t) => t.matches('p'))!
    const span = doc.source.spanOf(para.getAttribute('data-dia-id')!)!
    const exact = doc.source.text.slice(span.start, span.end)
    attachMirror(doc, para, [{ url: PNG }])

    commitDocEdit(doc, para, [setText(para, 'A rewritten paragraph.')], 'edit text')
    pruneMirrors()
    expect(para.querySelector('.de-stale')).not.toBeNull()
    expect(emitBlockTex(para)).toBe(exact.replace('A paragraph before the chart.', 'A rewritten paragraph.'))
    expect(serializeDoc(doc)).not.toContain('de-stale')

    // and a fresh crop takes the marker away again
    attachMirror(doc, para, [{ url: PNG }])
    expect(para.querySelector('.de-stale')).toBeNull()
    window.dispatchEvent(new CustomEvent('dia-service-status', { detail: { online: false, tex: null } }))
  })
})

/* ---------- real-paper regression (llama.tex, tectonic + real synctex) ----------
 * Two statistical models of this paper's geometry were green on synthetic
 * fixtures and wrong on the paper: the modal line width read its
 * mixed-layout body as one 393pt column, and the exact-x peaks read a
 * table's cell grid on page 5 as columns at 251.99 and 465.48, which is
 * where the slivers, the mid-column truncations and the duplicated
 * paragraphs came from. The records below are a verbatim sample of the
 * daemon's output for corpus/tex/llama/llama.tex, and what they are asked
 * now is what the new pipeline actually asks them: which clusters does this
 * block set, and which run of the page's real ink do they stand in. */

const LLAMA_SAMPLE: SynctexRecord[] = [{"line":116,"page":1,"x":71.13,"y":85.92,"w":455.24},{"line":118,"page":1,"x":71.13,"y":224.4,"w":219.09},{"line":119,"page":1,"x":88.2,"y":245.93},{"line":120,"page":1,"x":140.76,"y":269.93},{"line":121,"page":1,"x":273.15,"y":317.93},{"line":122,"page":1,"x":254.29,"y":374.3,"w":4.0},{"line":123,"page":1,"x":88.2,"y":257.93,"w":184.94},{"line":126,"page":1,"x":71.13,"y":401.46,"w":18.0},{"line":128,"page":1,"x":96.47,"y":422.37},{"line":129,"page":1,"x":290.22,"y":463.17},{"line":130,"page":1,"x":196.58,"y":531.17},{"line":131,"page":1,"x":235.49,"y":558.37},{"line":132,"page":1,"x":71.13,"y":422.37,"w":219.09},{"line":133,"page":1,"x":71.13,"y":626.37,"w":10.95},{"line":134,"page":1,"x":231.63,"y":667.17},{"line":135,"page":1,"x":82.64,"y":707.97},{"line":136,"page":1,"x":511.52,"y":251.6},{"line":137,"page":1,"x":71.13,"y":626.37,"w":219.09},{"line":138,"page":1,"x":307.29,"y":321.44,"w":10.95},{"line":139,"page":1,"x":352.88,"y":375.84},{"line":140,"page":1,"x":322.34,"y":416.64},{"line":141,"page":1,"x":512.05,"y":430.24},{"line":142,"page":1,"x":387.32,"y":471.04},{"line":143,"page":1,"x":307.29,"y":321.44,"w":219.09},{"line":144,"page":1,"x":307.29,"y":527.28,"w":10.95},{"line":145,"page":1,"x":526.38,"y":595.28},{"line":146,"page":1,"x":307.29,"y":527.28,"w":219.09},{"line":147,"page":1,"x":307.29,"y":678.71,"w":10.95},{"line":148,"page":1,"x":385.23,"y":719.51},{"line":149,"page":1,"x":496.43,"y":746.71},{"line":149,"page":2,"x":100.63,"y":82.13},{"line":150,"page":1,"x":307.29,"y":678.71,"w":219.09},{"line":150,"page":2,"x":71.13,"y":82.13,"w":219.09},{"line":152,"page":1,"x":72.27,"y":803.91,"w":454.11},{"line":152,"page":2,"x":71.13,"y":105.98,"w":18.0},{"line":153,"page":2,"x":92.61,"y":126.96},{"line":154,"page":2,"x":84.94,"y":181.36},{"line":156,"page":2,"x":71.13,"y":126.96,"w":219.09},{"line":157,"page":2,"x":71.13,"y":217.42,"w":24.64},{"line":158,"page":2,"x":90.34,"y":234.97},{"line":159,"page":2,"x":106.7,"y":262.17},{"line":160,"page":2,"x":92.78,"y":316.57},{"line":161,"page":2,"x":71.13,"y":234.97,"w":219.09},{"line":163,"page":2,"x":71.13,"y":351.15},{"line":164,"page":2,"x":129.92,"y":391.95},{"line":165,"page":2,"x":191.36,"y":446.35},{"line":166,"page":2,"x":71.13,"y":364.75,"w":219.09},{"line":169,"page":2,"x":71.13,"y":508.13},{"line":170,"page":2,"x":84.94,"y":548.93},{"line":171,"page":2,"x":274.41,"y":562.53},{"line":172,"page":2,"x":71.13,"y":521.73,"w":219.09},{"line":174,"page":2,"x":71.13,"y":665.11},{"line":175,"page":2,"x":252.73,"y":678.71},{"line":176,"page":2,"x":242.94,"y":705.91},{"line":177,"page":2,"x":190.94,"y":760.31},{"line":178,"page":2,"x":71.13,"y":678.71,"w":219.09},{"line":180,"page":2,"x":307.29,"y":294.32},{"line":181,"page":2,"x":491.53,"y":348.72},{"line":182,"page":2,"x":307.29,"y":307.92,"w":219.09},{"line":184,"page":2,"x":416.83,"y":71.13},{"line":188,"page":2,"x":307.29,"y":85.6,"w":67.51},{"line":189,"page":2,"x":483.56,"y":85.6,"w":43.45},{"line":190,"page":2,"x":307.29,"y":104.7,"w":67.51},{"line":191,"page":2,"x":483.56,"y":104.7,"w":43.45},{"line":192,"page":2,"x":483.56,"y":118.3,"w":43.45},{"line":193,"page":2,"x":483.56,"y":131.9,"w":43.45},{"line":194,"page":2,"x":483.56,"y":145.5,"w":43.45},{"line":195,"page":2,"x":483.56,"y":159.1,"w":43.45},{"line":196,"page":2,"x":483.56,"y":172.7,"w":43.45},{"line":197,"page":2,"x":483.56,"y":186.3,"w":43.45},{"line":198,"page":2,"x":307.29,"y":135.37,"w":219.72},{"line":201,"page":2,"x":307.29,"y":211.54,"w":219.09},{"line":202,"page":2,"x":307.29,"y":263.14,"w":219.09},{"line":205,"page":2,"x":307.29,"y":397.22},{"line":206,"page":2,"x":512.05,"y":465.22},{"line":207,"page":2,"x":307.29,"y":410.82,"w":219.09},{"line":209,"page":2,"x":307.29,"y":513.72},{"line":210,"page":2,"x":307.29,"y":527.32,"w":219.09},{"line":212,"page":2,"x":307.29,"y":616.62},{"line":213,"page":2,"x":335.7,"y":671.02},{"line":214,"page":2,"x":307.29,"y":630.22,"w":219.09},{"line":234,"page":2,"x":307.29,"y":733.11},{"line":235,"page":2,"x":513.61,"y":773.91},{"line":236,"page":2,"x":307.29,"y":746.71,"w":219.09},{"line":1031,"page":19,"x":100.99,"y":245.58},{"line":1035,"page":19,"x":100.99,"y":177.43,"w":392.8},{"line":1040,"page":19,"x":100.99,"y":231.83,"w":392.8},{"line":1041,"page":19,"x":100.99,"y":286.23},{"line":1043,"page":19,"x":100.99,"y":286.23,"w":392.8},{"line":1044,"page":19,"x":100.99,"y":245.58},{"line":1054,"page":19,"x":100.99,"y":474.52},{"line":1056,"page":19,"x":100.99,"y":372.37},{"line":1063,"page":19,"x":100.99,"y":372.37,"w":392.8},{"line":1072,"page":19,"x":100.99,"y":686.5},{"line":1073,"page":19,"x":100.99,"y":640.77,"w":392.8},{"line":1074,"page":19,"x":100.99,"y":640.77}]

/** the paper's real ink, at one point per slice: the sample's full-measure
 * boxes are 219.09pt wide and start at 71.13 and 307.29, so the type stands
 * from 71 to 290 and from 307 to 526 with a 17pt gutter between */
function llamaPage(): number[] {
  return inked([[71, 290], [307, 526]], 596)
}

describe('withoutWrappers', () => {
  it('drops the box a \\begin{itemize} line merely closed', () => {
    // llama.tex lines 326-327: the paragraph's inner box, then the list's
    // record — the COLUMN box, at the paragraph's own baseline. Left in, a
    // list crops the paragraph above it.
    const recs: SynctexRecord[] = [
      { line: 326, page: 4, x: 94.09, y: 541.25 },
      { line: 327, page: 4, x: 71.13, y: 541.25, w: 219.09 },
      { line: 328, page: 4, x: 93.03, y: 591.61 },
    ]
    expect(withoutWrappers(recs).map((r) => r.line)).toEqual([326, 328])
  })

  it('keeps a caption sharing a baseline with the other column', () => {
    // a two-column page sets both columns on one grid, so this is the
    // everyday case a y-only rule would throw away
    const recs: SynctexRecord[] = [
      { line: 300, page: 4, x: 71.13, y: 758.31, w: 219.09 },
      { line: 371, page: 4, x: 307.29, y: 758.31, w: 219.09 },
    ]
    expect(withoutWrappers(recs).map((r) => r.line)).toEqual([300, 371])
  })

  it('keeps everything a daemon reports without widths', () => {
    const recs: SynctexRecord[] = [
      { line: 1, page: 1, y: 100, x: 71 },
      { line: 2, page: 1, y: 100, x: 60 },
    ]
    expect(withoutWrappers(recs).length).toBe(2)
  })
})

describe('a real two-column paper', () => {
  it('keeps a far-column continuation as its own segment, never widening the window', () => {
    // lines 132-137 are a paragraph opening in column one at y 422-708;
    // line 136's box (x=511.52, y=251.6) is its continuation at the top of
    // column two. Each gets a segment, each resolves to its own column.
    const segs = segmentsFor(LLAMA_SAMPLE, 132, 137)
    expect(segs.length).toBe(3)
    expect(segs[0].xs).toEqual([71.13])
    expect(segs[0].records.some((r) => r.x === 511.52)).toBe(false)
    expect(segs[2].records.map((r) => r.line)).toEqual([136])
    const runs = inkRunsOf(llamaPage(), 10)
    expect(selectRunsFor(runs, segs[0].xs)).toEqual([71, 290])
    // the mid-column inner box resolves to the same run as the cluster —
    // the placed windows merge back into one crop
    expect(selectRunsFor(runs, segs[1].xs)).toEqual([71, 290])
    expect(selectRunsFor(runs, segs[2].xs)).toEqual([307, 526])
  })

  it('follows a paragraph off the foot of column two onto the next page', () => {
    const segs = segmentsFor(LLAMA_SAMPLE, 149, 150)
    expect(segs.map((s) => s.page)).toEqual([1, 1, 2])
    expect(segs[0].xs).toEqual([307.29]) // column two of page 1…
    expect(segs[2].xs).toEqual([71.13])  // …then column one of page 2
    const runs = inkRunsOf(llamaPage(), 10)
    expect(selectRunsFor(runs, segs[0].xs)).toEqual([307, 526])
    // the lone inner box at x496 stands in the same run as the witness —
    // the placed windows merge back into one crop
    expect(selectRunsFor(runs, segs[1].xs)).toEqual([307, 526])
    expect(selectRunsFor(runs, segs[2].xs)).toEqual([71, 290])
  })

  it('reads a table\'s cell grid as one window, not as columns', () => {
    // page 2's table reports a cluster per cell column (307.29 and 483.56).
    // The peak model called those two columns and cropped the block to a
    // sliver of one; the ink says both stand in the same run.
    const segs = segmentsFor(LLAMA_SAMPLE, 188, 198)
    expect(segs.map((s) => s.xs)).toEqual([[307.29], [483.56]])
    const runs = inkRunsOf(llamaPage(), 10)
    const windows = segs.map((s) => selectRunsFor(runs, s.xs))
    expect(windows[0]).toEqual(windows[1]) // one thing, seen twice
  })

  it('gives the one-column appendix the whole measure it was set to', () => {
    // page 19 insets its measure to 100.99 and sets it 392.8 wide: one
    // column, not two, and not the body's geometry either
    const segs = segmentsFor(LLAMA_SAMPLE, 1031, 1074)
    expect(segs.length).toBe(1)
    expect(segs[0].page).toBe(19)
    expect(segs[0].xs).toEqual([100.99])
    const appendix = inkRunsOf(inked([[100, 493]], 596), 10)
    expect(selectRunsFor(appendix, segs[0].xs)).toEqual([100, 493])
  })
})

/* ---------- unmirrored-block classification ---------- */

describe('bibliographyPages', () => {
  const recs: SynctexRecord[] = [
    { line: 100, page: 11, y: 200 }, { line: 120, page: 12, y: 300 },
    { line: 900, page: 17, y: 100 }, { line: 950, page: 18, y: 100 },
  ]
  it('spans from the last page before the block to the page before the next content', () => {
    expect(bibliographyPages(recs, { from: 894, to: 897 })).toEqual([12, 13, 14, 15, 16])
  })
  it('caps at eight pages and handles a document that ends in references', () => {
    const tail = recs.filter((r) => r.line < 894)
    expect(bibliographyPages(tail, { from: 894, to: 897 })).toEqual([12, 13, 14, 15, 16, 17, 18, 19])
  })
  it('is empty when nothing precedes the block', () => {
    expect(bibliographyPages([], { from: 5, to: 6 })).toEqual([])
  })
  it('keeps the page the body and the next section both touch', () => {
    // cot.tex: references start mid-page 10 and the appendix resumes on 10
    const recs: SynctexRecord[] = [
      { line: 1599, page: 10, y: 105 }, { line: 1604, page: 10, y: 752 },
    ]
    expect(bibliographyPages(recs, { from: 1600, to: 1601 })).toEqual([10])
  })
})

describe('isLayoutOnlySlice', () => {
  it('recognizes page-break and layout command runs', () => {
    expect(isLayoutOnlySlice('\\clearpage')).toBe(true)
    expect(isLayoutOnlySlice('\\newpage')).toBe(true)
    expect(isLayoutOnlySlice('\\clearpage\n\\appendix\n\\onecolumn\n\\pagenumbering{Roman}')).toBe(true)
    expect(isLayoutOnlySlice('\\bigskip \\noindent')).toBe(true)
  })
  it('never hides real content', () => {
    expect(isLayoutOnlySlice('\\clearpage Some words follow.')).toBe(false)
    expect(isLayoutOnlySlice('Prose only.')).toBe(false)
    expect(isLayoutOnlySlice('\\bibliography{custom}')).toBe(false)
  })
})

/* llama.tex page 10, the carbon-footprint section: a paragraph that opens
 * at the FOOT of column one (unmeasured inner boxes at x90 and x181) and
 * continues in column two, and two displays whose synctex records are the
 * boxes of paragraphs they merely closed */
const CF_SAMPLE: SynctexRecord[] = [
  { line: 832, page: 10, x: 71.13, y: 725.8, w: 18.0 },
  { line: 834, page: 10, x: 90.81, y: 746.71 },
  { line: 835, page: 10, x: 181.52, y: 773.91 },
  { line: 836, page: 10, x: 353.53, y: 151.77, w: 4.75 },
  { line: 837, page: 10, x: 374.75, y: 150.13 },
  { line: 838, page: 10, x: 71.13, y: 746.71, w: 219.09 },
  { line: 839, page: 10, x: 435.8, y: 250.6, w: 4.75 },
  { line: 840, page: 10, x: 483.18, y: 276.16 },
  { line: 841, page: 10, x: 453.35, y: 359.4, w: 4.75 },
  { line: 842, page: 10, x: 526.38, y: 357.76 },
  { line: 843, page: 10, x: 307.29, y: 194.56, w: 219.09 },
  { line: 844, page: 10, x: 321.1, y: 429.39 },
  { line: 845, page: 10, x: 350.35, y: 466.21, w: 4.5 },
  { line: 846, page: 10, x: 408.91, y: 470.19 },
]

describe('a paragraph opening at the foot of the previous column', () => {
  it('keeps the unmeasured cluster the witness never saw', () => {
    // lines 834-835 are the paragraph's first lines, set in column one;
    // the only measured box (836) is in column two. Dropping the cluster
    // cropped the paragraph mid-word.
    const segs = segmentsFor(CF_SAMPLE, 834, 837)
    expect(segs.length).toBe(2)
    expect(segs[0].xs).toEqual([90.81, 181.52])
    expect(segs[0].records.map((r) => r.line)).toEqual([834, 835])
    expect(segs[1].xs).toEqual([353.53])
  })
  it('drops a lone box standing at another line\'s baseline', () => {
    // the one thing a stray ever is: the still-open box of somebody
    // else's line, reported at that line's exact baseline
    const recs: SynctexRecord[] = [
      { line: 10, page: 1, x: 71, y: 200, w: 219 },
      { line: 11, page: 1, x: 90, y: 227 },
      { line: 12, page: 1, x: 320, y: 400 },   // lone box in the far column…
      { line: 30, page: 1, x: 315, y: 400.5 }, // …at another line's baseline
    ]
    const segs = segmentsFor(recs, 10, 12)
    expect(segs.length).toBe(1)
    expect(segs[0].records.some((r) => r.line === 12)).toBe(false)
  })
})

describe('dropFolio', () => {
  const inkOf = (runs: Array<[number, number]>, rows: number, cols: number) => {
    const cells = new Uint8Array(cols * rows)
    for (const [a, b] of runs) for (let y = a; y <= b; y++) for (let c = 40; c < 60; c++) cells[y * cols + c] = 1
    return { cells, cols, rows, scale: 1, wPt: cols, hPt: rows, extent: { xMin: 0, xMax: cols } }
  }
  it('trims a lone thin run past a wide blank — the page number', () => {
    // body ink 100-600, folio digits at 760-768
    const ink = inkOf([[100, 600], [760, 768]], 800, 500)
    const out = dropFolio(ink, { page: 1, yMin: 0, yMax: 800, anchors: [] })
    expect(out.yMax).toBeLessThan(700)
  })
  it('keeps a final paragraph that merely sits low', () => {
    // last run is tall (a real paragraph), not a folio
    const ink = inkOf([[100, 600], [660, 700]], 800, 500)
    const out = dropFolio(ink, { page: 1, yMin: 0, yMax: 800, anchors: [] })
    expect(out.yMax).toBe(800)
  })
  it('keeps a short run that is not isolated', () => {
    const ink = inkOf([[100, 600], [610, 616]], 800, 500)
    const out = dropFolio(ink, { page: 1, yMin: 0, yMax: 800, anchors: [] })
    expect(out.yMax).toBe(800)
  })
})

describe('claimFloor', () => {
  const col2 = { page: 10, yMin: 239, yMax: 360, xMin: 299, xMax: 532, anchors: [] }
  it('stops growth at what an earlier crop in the same column showed', () => {
    expect(claimFloor([{ xMin: 299, xMax: 532, yMax: 183.05 }], col2)).toBeCloseTo(184.05)
  })
  it('ignores the neighbouring column, pads touching or not', () => {
    // a column-one crop's padded window reaches x301; the column-two block
    // starts at x299 — they touch, and the touch means nothing
    expect(claimFloor([{ xMin: 64, xMax: 301, yMax: 286.38 }], col2)).toBe(0)
  })
  it('ignores crops below this one and takes the deepest above', () => {
    expect(claimFloor([
      { xMin: 299, xMax: 532, yMax: 500 },
      { xMin: 299, xMax: 532, yMax: 120 },
      { xMin: 299, xMax: 532, yMax: 183 },
    ], col2)).toBe(184)
  })
  it('is zero with nothing claimed', () => {
    expect(claimFloor(undefined, col2)).toBe(0)
    expect(claimFloor([], col2)).toBe(0)
  })
})

describe('liesAbovePrev', () => {
  it('catches a display holding the box of the paragraph it closed', () => {
    // $$tCO2eq$$ at line 843 reports x307 y194 — the top of the paragraph
    // box opened five lines earlier — while the paragraph's own boxes
    // stand at y250-359 in the same column
    const eq = segmentsFor(CF_SAMPLE, 843, 843)
    const para = segmentsFor(CF_SAMPLE, 839, 842)
    expect(liesAbovePrev(eq, para, 'topDownPt')).toBe(true)
  })
  it('lets an honest following paragraph stand', () => {
    const after = segmentsFor(CF_SAMPLE, 844, 846)
    const para = segmentsFor(CF_SAMPLE, 839, 842)
    expect(liesAbovePrev(after, para, 'topDownPt')).toBe(false)
  })
  it('says nothing across columns', () => {
    // the column-one cluster of 834-835 sits below 832's heading but a
    // block in column two shares no column with it
    const eq = segmentsFor(CF_SAMPLE, 843, 843)
    const colOne = segmentsFor(CF_SAMPLE, 834, 835)
    expect(liesAbovePrev(eq, colOne.slice(0, 1), 'topDownPt')).toBe(false)
  })
  it('flips the reading for bottom-up records', () => {
    const eq = segmentsFor(CF_SAMPLE, 843, 843)
    const para = segmentsFor(CF_SAMPLE, 839, 842)
    expect(liesAbovePrev(eq, para, 'bottomUpPt')).toBe(false)
  })
})
