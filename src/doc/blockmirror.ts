/* The compiled mirror: the native view's resting state IS the real render.
 *
 * Every top-level block that the engine typeset shows its own cropped region
 * of the compiled PDF — paragraphs, headings, lists, math, figures, tables,
 * tikz islands alike. The browser cannot set TeX, so it stops pretending to:
 * what you look at is what the engine made. Double-click a block and the
 * crop steps aside, the HTML form returns, and every WYSIWYG affordance the
 * document view ever had (in-place editing, selection, comments, copilot
 * ops) works exactly as before. Commit, and the auto-compile puts the real
 * render back a second later.
 *
 * The mirror is DERIVED, never truth. Four consequences shape this file:
 *
 *  - every injected node carries `dia-editor-artifact`, so cleanOuter and
 *    serializeDoc strip it. A mirrored block must still emit its exact
 *    source bytes (blockmirror.test.ts holds that line).
 *  - a crop outlives only the source it was made from: each one records its
 *    block's source slice, and any op that changes that slice drops it.
 *    Comparing slices rather than op targets means a copilot batch, an undo
 *    and a hand edit are all covered by one rule.
 *  - the block's own markup is never touched. The HTML form is hidden by a
 *    stylesheet rule keyed on `:has(> .de-mirror)`, not by an attribute, a
 *    class or an inline style — nothing to strip, nothing to leak.
 *  - nothing here is on the critical path. No synctex, no rasterizer, a 404
 *    from a daemon that predates the endpoints, a compile that failed — the
 *    crops simply do not appear and the document renders as HTML, which is
 *    what it did before this file existed.
 *
 * The crop math is kept pure where it can be (regionForLines, xGroupsOf,
 * inkRunsOf, selectRunsFor, linePitch, textLines, mainRowBand) so it can be
 * argued with in tests. What makes it hard is that synctex records ONE BOX
 * per source line: a 200pt-tall picture reports one y at its foot, a
 * paragraph's second source line reports whichever inner box happened to be
 * innermost mid-column, and nothing says how tall anything is. So three
 * other witnesses are called. The page's leading, read off the record
 * spacing, says where one line ends and the next begins. The markup says
 * whether a block is lines of type at all, which is the one thing synctex
 * can never tell us.
 *
 * And the horizontal window — which column, how wide — is read off THE
 * PIXELS. The page bitmap is decoded at crop time anyway, so the ink itself
 * can say where the text stands: project the band's ink onto x, split it at
 * the blank gutters, and keep the runs the block's own boxes fall inside.
 * Two statistical models of the page geometry were tried before this and
 * both hallucinated columns on real papers — the modal line width first,
 * then the exact-x peaks, which read a table's cell grid as a column and
 * handed the blocks around it slivers, mid-column truncations and duplicate
 * crops at two different scales. Ink cannot do that: a run between two blank
 * gutters IS a column, a wrapfigure IS a narrower run beside it, and a
 * table's cell grid falls inside one window instead of inventing two. It
 * also gives every crop ONE scale, because every window is measured against
 * the same thing — the widest ink any of the document's pages holds. */

import type { Doc } from '../model/doc'
import { setsNoType } from '../latex/parse'
import { state } from '../state'
import { SERVICE_BASE } from '../service/client'
import { autoCompileOn, lastCompileJobId, onCompileState, texAvailable } from '../editor/doccompile'
import { docEditableFor, isEditingText, startEdit } from '../editor/textedit'
import { clearPageCache, getPageBitmap, pagesInfo, Y_TOP_DOWN, type PageBitmap } from './pdfpages'

/** one synctex record: a source line, the page it landed on, the y of its
 * baseline and (from daemons that report them) the x of its left edge and
 * the width of its box — all in points, per the map's declared semantics */
export interface SynctexRecord {
  line: number
  page: number
  y: number
  x?: number
  w?: number
}

/** a horizontal window on the page, in points from the left paper edge */
export interface XBand {
  xMin: number
  xMax: number
}

/** a page-relative band to crop, always in points down from the page top.
 * `anchors` are the block's own baselines inside it — the band is a guess,
 * the anchors are facts, and the ink trim uses them to tell the block's
 * output from a neighbour's that shares the band. A band carrying an x
 * window is cropped to it exactly (no horizontal trim): that is what keeps
 * every block in a column at one scale. */
export interface MirrorRegion extends Partial<XBand> {
  page: number
  yMin: number
  yMax: number
  anchors: number[]
  /** this edge was cut BETWEEN two lines of type, so it is already exact and
   * the ink trim must leave it alone. Prose is the reason: consecutive
   * paragraphs leave no blank between them, so "trim to the run of ink the
   * anchors fall in" would hand every paragraph the whole column. */
  keepTop?: boolean
  keepBottom?: boolean
}

/* slack around a record's baseline, in points, when the neighbour is far
 * enough away that something the records do not describe sits in between */
const PAD = 8
/* a neighbouring baseline this close, measured in line pitches, is simply
 * the line before or after ours — so the edge between us is a fact, not a
 * guess. Two-and-a-bit pitches, because synctex reports one record per
 * SOURCE line and a source line that wrapped puts its neighbour two
 * typeset lines away. */
const TIGHT_PITCHES = 2.6
/* where to cut between two baselines, in pitches: clear of the previous
 * line's descenders, and clear of the next line's ascenders. Both are
 * measured from the NEIGHBOUR's baseline, so they have to cover the
 * neighbour's ink, not ours — a section heading sets larger type than the
 * body pitch it is measured in, and cutting 0.65 of a pitch above its
 * baseline left a sliver of its capitals on the block before it. */
const UNDER_PREV = 0.3
const OVER_NEXT = 0.85
/* how much of our own line sits above its baseline, and below it */
const ASCENT = 0.85
const DESCENT = 0.3
/* the width of an average glyph as a fraction of the font size — good
 * enough to turn a character count into a line count */
const GLYPH = 0.46
/* and slack on that count, because the DOM's text is not always all of the
 * text (a \ref renders as one character and typesets as three) */
const LINE_SLACK = 1.15
/* how far above the first record to look when nothing is typeset above it
 * on that page — half a page, so a tall figure survives and a runaway
 * region cannot swallow the whole sheet */
const LOOKBACK = 400
/* below the last record only descenders and rules remain */
const LOOKAHEAD = 90
/* an ink-vs-paper channel-sum threshold: anti-aliased grey counts as ink,
 * paper texture and JPEG-ish noise do not. Exported (not just internal) so
 * scripts/capture-mirror-fixture.mjs — which decodes PNGs outside the DOM,
 * so it cannot import pageInkOf itself — can say out loud that its own ink
 * scan is this same threshold, not a guess that might drift from it. */
export const INK = 24
/* points of paper kept around the trimmed ink */
const TRIM_PAD = 6
/* blank points that separate one thing from another, measured DOWN a
 * column rather than across it. The numbers are tighter than they look: on
 * llama.tex's page 5 the blank between two lines of one paragraph is 6.3pt,
 * between a table and the rule above it 4.8pt, and between the paragraph
 * and the float below it 12.2pt — so a float is told from the prose above
 * it by two points, and the 24 this once was swept the prose into the
 * float's crop. What saves the wider gaps a block does contain (11.5pt from
 * a table to its caption) is that both sides of them are ANCHORED, and
 * mainRowBand spans from the first anchored run to the last. */
const GUTTER = 10
/* a record this far outside a window may still be a line of it — a quoted
 * paragraph or a list is set a few points in and is still the column */
const COLUMN_TOL = 24
/* boxes of one block further apart in x than this cannot be lines of one
 * column: no measure indents a line by half a column, and the two candidate
 * groups are merged again anyway when their ink turns out to be one run */
const GROUP_GAP = 60
/* how far apart two UNMEASURED strays may sit and still be lines of one
 * column: inner boxes land anywhere in the measure, so this is a column's
 * worth rather than an indent's */
const LEFTOVER_GAP = 120
/* blank points that separate one run of ink from the next. A gutter is
 * wider than this (an ACL page leaves 17), a word space and the gaps inside
 * a table's cell grid are narrower */
const INK_GAP = 10
/* paper kept either side of an ink window */
const WINDOW_PAD = 6
/* how far right of a block's leftmost box its column may plausibly reach —
 * used only to pick the neighbours that bracket the PROVISIONAL band, the
 * one whose rows the ink is projected over */
const REACH = 240
/* how far past its own baselines a block's ink is projected when nothing
 * else says where to stop. A gutter is blank down the whole page; the gap
 * after a section number (measured on llama.tex: 11pt, against a 14pt
 * gutter — no threshold tells those two apart) is blank only on the
 * heading's own rows, so reaching the lines around it fills the second in
 * and leaves the first alone. Two gutters' worth reaches them at any
 * leading, which is the point: the leading is not known reliably yet here
 * (a page's two columns interleave their baselines). */
const CONTEXT = 48
/* and how far past its own rows a block reaches when those rows turn out
 * to hold nothing but a section number. Generous, because by then the
 * alternative is a crop of the number alone: the skip a class leaves under
 * a heading is 13pt on llama.tex and 17.4 on cot.tex, and the paragraph it
 * has to reach may set its first line short. Only a window narrower than a
 * quarter of the page ever asks for this. */
const NARROW_REACH = CONTEXT
/* rows of the page decoded at a time when reading its ink: a hidpi letter
 * page is 33MB of RGBA, and none of it needs to be resident at once */
const INK_STRIPE = 256

const MIRROR_TITLE = 'the compiled render — double-click to edit this block'

/* ---------- the vertical crop math (pure) ---------- */

/** The page and y-band for a block spanning source lines [fromLine, toLine].
 *
 * Records inside the range give the band's core. Because those y values are
 * baselines, the band is then widened to the nearest record OUTSIDE the
 * range on each side — everything typeset between the previous line and the
 * next one belongs to this block. A block spanning a page break mirrors its
 * first page's portion. Returns null when synctex knows nothing about these
 * lines (a preamble-only island, a macro definition, a block the engine
 * never typeset).
 *
 * How the edge is cut turns on `linesOfType` — whether this block sets
 * TEXT. A paragraph's ink reaches exactly one ascent above its first
 * baseline and one descender below its last, which is knowledge synctex
 * does not carry (it reports a baseline, not a box) and the DOM does: a
 * <p> is lines, a <figure> is not. Told that, the edges are cut between
 * lines and are exact (keepTop/keepBottom), which is the only way to crop
 * prose — consecutive paragraphs leave no blank for an ink trim to find.
 *
 * Told nothing, the edges are deliberately generous — a picture reports one
 * y at its FOOT and may be 200pt tall — and the ink trim decides.
 *
 * Pass records already narrowed to one column when the page has more than
 * one: the neighbour that brackets a paragraph is the line above it in ITS
 * column, never whatever happens to sit at that height in the next one. */
export function regionForLines(
  records: SynctexRecord[],
  fromLine: number,
  toLine: number,
  opts: { pad?: number; hPt?: number; pitch?: number; linesOfType?: boolean; maxLines?: number; page?: number } = {},
): MirrorRegion | null {
  const pad = opts.pad ?? PAD
  const pitch = opts.pitch && opts.pitch > 0 ? opts.pitch : 0
  const inRange = records.filter((r) => r.line >= fromLine && r.line <= toLine)
  if (inRange.length === 0) return null

  // a segmented caller names the page; a single-rect caller gets the page
  // the block's first line landed on
  let page: number
  if (opts.page !== undefined) {
    page = opts.page
    if (!inRange.some((r) => r.page === page)) return null
  } else {
    page = inRange[0].page
    let first = inRange[0].line
    for (const r of inRange) {
      if (r.line < first || (r.line === first && r.page < page)) { first = r.line; page = r.page }
    }
  }

  // A source line that opened no box of its own reports the box that was
  // already OPEN — which is the one the line above is set in. `\begin
  // {itemize}` is the everyday case: it reports the column box at the last
  // line of the paragraph before it, and a list bracketed from there draws
  // that paragraph into its own crop. The signature is exact: same
  // baseline as an earlier line, and our box wraps that line's. (Same
  // baseline alone would not do — a two-column page sets both columns on
  // one grid, so a caption in column two shares its baseline with a line
  // in column one and owes it nothing.)
  const earlier = records.filter((r) => r.page === page && r.line < fromLine)
  const onPage = inRange.filter((r) => r.page === page)
  const core = onPage.filter((r) => !wrapsEarlier(r, earlier))

  let lo = Infinity
  let hi = -Infinity
  for (const r of core.length > 0 ? core : onPage) {
    lo = Math.min(lo, r.y)
    hi = Math.max(hi, r.y)
  }

  let above: number | null = null
  let below: number | null = null
  for (const r of records) {
    if (r.page !== page) continue
    if (r.line >= fromLine && r.line <= toLine) continue
    if (r.y < lo) above = above === null ? r.y : Math.max(above, r.y)
    if (r.y > hi) below = below === null ? r.y : Math.min(below, r.y)
  }

  const solid = opts.linesOfType === true && pitch > 0
  const tight = pitch * TIGHT_PITCHES
  // an edge is exact only when there is a NEIGHBOUR to be exact against.
  // With nothing below — the last block of a column — the foot is a guess
  // about where the type stopped, and calling it exact hung up to 70pt of
  // the page's bottom margin under a paragraph. Let the ink trim have it.
  const keepTop = above !== null && (solid || (pitch > 0 && lo - above <= tight))
  const keepBottom = below !== null && (solid || (pitch > 0 && below - hi <= tight))
  // the foot never reaches into the next line's ascenders, tight or not:
  // being generous downward only ever meant "the records do not describe
  // everything down there", never "show me the line below"
  const clear = pitch > 0 ? Math.max(pad, pitch * OVER_NEXT) : pad

  let yMin: number
  if (solid) {
    // one ascent above our own first baseline, never past the line above
    const mine = lo - pitch * ASCENT
    yMin = above === null ? mine : Math.max(above + pitch * UNDER_PREV, mine)
  } else {
    yMin = above === null ? lo - LOOKBACK
      : keepTop ? Math.max(above + pitch * UNDER_PREV, lo - pitch * ASCENT)
        : Math.min(above + pad, lo)
  }

  let yMax: number
  if (solid) {
    // synctex records the FIRST box of a source line, so a source line long
    // enough to wrap puts typeset lines below our last record. How many is
    // not in the records at all — but the block's own text says roughly how
    // many lines it needs, and it can never need fewer than its records
    // already span.
    const spanned = Math.round((hi - lo) / pitch) + 1
    const wanted = opts.maxLines ?? 1
    // a block of prose gets a line of slack on the estimate, because
    // clipping a sentence is worse than a strip of paper; a one-line block
    // (a heading) gets none, because the strip below it is someone else's
    // first line
    const lines = Math.max(spanned, wanted) + (wanted > 1 ? 1 : 0)
    const mine = lo + (lines - 0.5) * pitch
    yMax = below === null ? mine : Math.min(below - clear, mine)
    // never inside our own last line: its descenders are ours to show
    yMax = Math.max(yMax, hi + pitch * DESCENT)
  } else {
    yMax = below === null ? hi + LOOKAHEAD
      : keepBottom ? below - clear
        : Math.max(below - clear, hi)
  }
  yMin = Math.max(0, yMin)
  if (opts.hPt) yMax = Math.min(opts.hPt, yMax)
  if (yMax <= yMin) return null
  return {
    page,
    yMin,
    yMax,
    // EVERY baseline the block reported, not just its first and last: the
    // trim spans the runs its anchors land in, and a table's caption is a
    // run of its own that only its own baseline reaches. The outer two
    // cannot stand for the rest — the last of them is often the box an
    // `\end{...}` line reports, a line below the block's last ink.
    anchors: [...new Set((core.length > 0 ? core : onPage).map((r) => r.y))].sort((a, b) => a - b),
    ...(keepTop ? { keepTop } : {}),
    ...(keepBottom ? { keepBottom } : {}),
  }
}

/** Drop every record that reports a box its source line merely CLOSED.
 *
 * Synctex gives one box per source line: the innermost box that line
 * opened. A line that opened none of its own — `\begin{itemize}`, the text
 * after a display, `\end{table}` — reports whatever was already open, which
 * is the COLUMN box, standing at the previous line's baseline. Left in, it
 * makes the block look like it set type up there: a list crops the
 * paragraph above it, a paragraph after an equation grows a second segment
 * showing two lines of somebody else's prose. Both were on the page the
 * user reported.
 *
 * Cleaned once, before anything reads the records, so the segments and the
 * bands agree about what a block set. */
export function withoutWrappers(records: SynctexRecord[]): SynctexRecord[] {
  const rows = new Map<string, SynctexRecord[]>()
  for (const r of records) {
    const key = `${r.page}|${Math.round(r.y * 100)}`
    const held = rows.get(key)
    if (held) held.push(r)
    else rows.set(key, [r])
  }
  return records.filter((r) => !wrapsEarlier(r, rows.get(`${r.page}|${Math.round(r.y * 100)}`) ?? []))
}

/** is this record the box an earlier source line's type sits in — the one
 * our line merely closed, rather than any ink of our own? */
function wrapsEarlier(r: SynctexRecord, peers: SynctexRecord[]): boolean {
  if (typeof r.x !== 'number' || typeof r.w !== 'number' || !(r.w > 0)) return false
  const x = r.x
  const w = r.w
  return peers.some((e) => e.line < r.line &&
    Math.abs(e.y - r.y) < 0.05 && typeof e.x === 'number' && e.x >= x && e.x <= x + w)
}

/** The page's leading, in points: how far apart two consecutive lines of
 * type sit.
 *
 * A LOW percentile of the gaps between baselines, not the median. Synctex
 * reports one record per SOURCE line, and a source line is usually a whole
 * sentence that wrapped, so the typical gap between records is two or three
 * lines and the median would overstate the leading by that much — which
 * matters, because the leading is what says how far a line's ascenders
 * reach above its baseline. The smallest gaps that repeat are single lines,
 * and that is what this reads. Falls back to a plausible 12pt when there is
 * nothing to measure. */
export function linePitch(ys: number[], fallback = 12): number {
  const sorted = [...new Set(ys.filter((y) => Number.isFinite(y)))].sort((a, b) => a - b)
  const gaps: number[] = []
  for (let i = 1; i < sorted.length; i++) {
    const g = sorted[i] - sorted[i - 1]
    // under 3pt is two boxes on the same line; over 40pt is not leading
    if (g > 3 && g < 40) gaps.push(g)
  }
  if (gaps.length === 0) return fallback
  gaps.sort((a, b) => a - b)
  return gaps[Math.floor(gaps.length * 0.25)]
}

/** Restate a region in points down from the page top. The daemon declares
 * its convention; anything that is not top-down is mirrored through the
 * page height (which also swaps the two edges). x is untouched — every
 * convention measures it rightward from the left paper edge. */
export function toTopDown(region: MirrorRegion, hPt: number, ySemantics: string): MirrorRegion {
  if (ySemantics === Y_TOP_DOWN || !hPt) return region
  return {
    ...region,
    yMin: Math.max(0, hPt - region.yMax),
    yMax: Math.min(hPt, hPt - region.yMin),
    anchors: region.anchors.map((y) => hPt - y),
    keepTop: region.keepBottom, // the flip swaps which edge is which
    keepBottom: region.keepTop,
  }
}

/* ---------- grouping a block's boxes (pure) ---------- */

/** Split x positions into the clusters they were set in.
 *
 * Sorted, de-duplicated, and cut wherever consecutive positions sit further
 * apart than any indent could put them. This is a CANDIDATE split, not a
 * column model: a paragraph that crossed a column break yields two clusters
 * (one per column) and so does a paragraph whose inner boxes happen to
 * straggle across its own column — the ink decides which is which, and the
 * second kind is merged back into one segment when both clusters turn out
 * to stand in the same run of ink. */
export function xGroupsOf(xs: number[], gap = GROUP_GAP): number[][] {
  const sorted = [...new Set(xs.filter((x) => Number.isFinite(x)))].sort((a, b) => a - b)
  const groups: number[][] = []
  for (const x of sorted) {
    const last = groups[groups.length - 1]
    if (last && x - last[last.length - 1] <= gap) last.push(x)
    else groups.push([x])
  }
  return groups
}

/** one candidate crop: a block's records on one page, in one x cluster.
 * `xs` are the WITNESS positions — the boxes the engine measured — and they
 * alone say which run of ink this segment stands in. */
export interface Segment {
  page: number
  records: SynctexRecord[]
  xs: number[]
}

/** A block's typeset output, split into the segments it may need one crop
 * each for: by page, then by the x clusters of the boxes it set there.
 *
 * The witness positions are the records carrying a WIDTH. Synctex reports
 * one box per source line — the innermost box that line opened — so a line
 * whose innermost box was an inline formula or a `\ref` reports a position
 * mid-column, and (measured on llama.tex) a line can report a box in the
 * NEXT column entirely, hundreds of points from where its type stands. A
 * measured box is the line's own text; those strays are not, and letting
 * them pick the window is what produced crops spanning both columns with a
 * blank gutter down the middle. They still ride along inside the cluster
 * they fall in, because their y is evidence about how far the block
 * reaches. */
export function segmentsFor(records: SynctexRecord[], from: number, to: number): Segment[] {
  const mine = records.filter((r) => r.line >= from && r.line <= to)
  if (mine.length === 0) return []

  const byPage = new Map<number, SynctexRecord[]>()
  for (const r of mine) {
    const held = byPage.get(r.page)
    if (held) held.push(r)
    else byPage.set(r.page, [r])
  }

  const out: Segment[] = []
  for (const [page, recs] of byPage) {
    const measured = recs.filter(hasX).filter((r) => typeof r.w === 'number' && r.w > 0)
    const witness = measured.length > 0 ? measured : recs.filter(hasX)
    // no x at all (an older daemon): one segment, and the caller crops the
    // full width as island previews always did
    if (witness.length === 0) { out.push({ page, records: recs, xs: [] }); continue }

    const groups = xGroupsOf(witness.map((r) => r.x))
    const buckets = groups.map((): SynctexRecord[] => [])
    const leftovers: Array<SynctexRecord & { x: number }> = []
    for (const r of recs) {
      if (!hasX(r)) { buckets[0].push(r); continue } // no x: it brackets from wherever
      const i = groupOf(groups, r.x)
      if (i >= 0) buckets[i].push(r)
      else leftovers.push(r)
    }
    groups.forEach((xs, i) => {
      if (buckets[i].length > 0) out.push({ page, records: buckets[i], xs })
    })
    // Unmeasured boxes no witness group reaches are NOT all strays: a
    // paragraph that continues in another column reports only inner boxes
    // there (x90 and x181 on llama.tex p10 for a column-one opening; a lone
    // x511 hyperlink box for a column-two continuation), and dropping them
    // cropped the paragraph mid-word. Two clustered leftovers are lines. A
    // lone one is a line unless somebody ELSE's record stands at its exact
    // baseline in its column — then it is that line's still-open box, the
    // one thing a stray ever is. The cluster gap is half a column, not
    // GROUP_GAP: inner boxes land anywhere in the measure.
    const stray = (r: SynctexRecord & { x: number }): boolean =>
      records.some((o) => (o.line < from || o.line > to) && o.page === page
        && typeof o.x === 'number' && Math.abs(o.x - r.x) <= LEFTOVER_GAP
        && Math.abs(o.y - r.y) < 3)
    leftovers.sort((a, b) => a.x - b.x)
    let cluster: Array<SynctexRecord & { x: number }> = []
    const flush = (): void => {
      if (cluster.length >= 2 || (cluster.length === 1 && !stray(cluster[0]))) {
        out.push({ page, records: cluster, xs: [...new Set(cluster.map((r) => r.x))] })
      }
      cluster = []
    }
    for (const r of leftovers) {
      if (cluster.length > 0 && r.x - cluster[cluster.length - 1].x > LEFTOVER_GAP) flush()
      cluster.push(r)
    }
    flush()
  }
  return out.sort((a, b) => a.page - b.page || (a.xs[0] ?? 0) - (b.xs[0] ?? 0))
}

function hasX(r: SynctexRecord): r is SynctexRecord & { x: number } {
  return typeof r.x === 'number' && Number.isFinite(r.x)
}

/** Does every box of this block stand ABOVE the previous block's boxes in
 * the column both share? Text flows down a column, so a later source line
 * can never be typeset above an earlier one there — a block whose records
 * claim otherwise is holding the box of a paragraph it merely closed. The
 * one llama.tex sets on page 10: `$$…$$` at the end of a paragraph that
 * opened after ANOTHER display reports that paragraph's box, whose top is
 * 165pt above where the equation stands — and no same-baseline peer exists
 * for withoutWrappers to catch it by, because the opening line's own record
 * went to the previous column. Columns are told apart by x extent; pages
 * where the blocks do not share a column say nothing. True only when at
 * least one page brings the two into the same column. */
export function liesAbovePrev(segs: Segment[], prevSegs: Segment[], ySemantics: string): boolean {
  const extent = (records: SynctexRecord[]): XBand | null => {
    let lo = Infinity
    let hi = -Infinity
    for (const r of records) {
      if (!hasX(r)) continue
      lo = Math.min(lo, r.x)
      hi = Math.max(hi, r.x + (typeof r.w === 'number' && r.w > 0 ? r.w : 0))
    }
    return lo <= hi ? { xMin: lo, xMax: hi } : null
  }
  const topDown = ySemantics === Y_TOP_DOWN
  let shared = false
  for (const s of segs) {
    const sBand = extent(s.records)
    if (!sBand) continue
    for (const p of prevSegs) {
      if (p.page !== s.page) continue
      const pBand = extent(p.records)
      if (!pBand || sBand.xMin > pBand.xMax || pBand.xMin > sBand.xMax) continue
      shared = true
      const ys = s.records.map((r) => r.y)
      const prevYs = p.records.map((r) => r.y)
      const clears = topDown
        ? Math.max(...ys) < Math.min(...prevYs) - 4
        : Math.min(...ys) > Math.max(...prevYs) + 4
      if (!clears) return false
    }
  }
  return shared
}

/** the cluster an x belongs to: the one it falls in or within reach of,
 * else none at all — a box a column away is evidence about that column */
function groupOf(groups: number[][], x: number): number {
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]
    if (x >= g[0] - GROUP_GAP && x <= g[g.length - 1] + GROUP_GAP) return i
  }
  return -1
}

/* ---------- the ink window (pure) ---------- */

/** Ink projected onto x, split into runs.
 *
 * `projection[i]` is how much ink stands in the i-th slice of the page over
 * the rows in question; `blankGap` empty slices in a row end one run and
 * start another. What the runs mean is decided by the page, not by us: on a
 * two-column page they are the columns, beside a wrapfigure they are the
 * narrowed measure and the figure, inside a table they are whatever the
 * cell grid leaves blank — which is why the caller takes the whole extent
 * from the first run it owns to the last, rather than the runs themselves. */
export function inkRunsOf(projection: number[], blankGap: number): Array<[number, number]> {
  const runs: Array<[number, number]> = []
  for (let i = 0; i < projection.length; i++) {
    if (!(projection[i] > 0)) continue
    const last = runs[runs.length - 1]
    if (last && i - last[1] <= blankGap) last[1] = i
    else runs.push([i, i])
  }
  return runs
}

/** The extent of the runs a block stands in: from the start of the first
 * run one of its boxes falls inside to the end of the last.
 *
 * Everything between two owned runs comes along — a table's cells are one
 * picture, not five. A block whose boxes fall on no run at all (a centred
 * figure whose record sits back at the column margin) takes the nearest
 * run, which is the one it made. */
export function selectRunsFor(
  runs: Array<[number, number]>,
  xs: number[],
  tol = 2,
): [number, number] | null {
  if (runs.length === 0) return null
  if (xs.length === 0) return [runs[0][0], runs[runs.length - 1][1]]
  const hit = runs.filter(([a, b]) => xs.some((x) => x >= a - tol && x <= b + tol))
  if (hit.length > 0) return [hit[0][0], hit[hit.length - 1][1]]

  let best = runs[0]
  let near = Infinity
  for (const run of runs) {
    for (const x of xs) {
      const d = x < run[0] ? run[0] - x : x > run[1] ? x - run[1] : 0
      if (d < near) { near = d; best = run }
    }
  }
  return [best[0], best[1]]
}

/** the shared width of two bands, as a fraction of the narrower one */
function overlapShare(a: XBand, b: XBand): number {
  const shared = Math.min(a.xMax, b.xMax) - Math.max(a.xMin, b.xMin)
  if (shared <= 0) return 0
  const narrow = Math.min(a.xMax - a.xMin, b.xMax - b.xMin)
  return narrow > 0 ? shared / narrow : 0
}

/** records whose x falls inside a band — what "the line above this one"
 * means once a page has more than one column. Records with no x are kept: a
 * daemon that reports x for some boxes and not others must not lose the
 * bracketing neighbours it does know about. */
export function inBand(records: SynctexRecord[], band: XBand, tol = COLUMN_TOL): SynctexRecord[] {
  return records.filter((r) => {
    if (!hasX(r)) return true
    return r.x >= band.xMin - tol && r.x <= band.xMax
  })
}

/* ---------- reading a page's ink ---------- */

/** A page's ink, as one byte per (device row, POINT of page width).
 *
 * A point of x resolution, not a device pixel: the runs are separated by
 * ten points and padded by six, so nothing finer than a point can change an
 * answer, and quantizing there turns a 33MB image into a couple of
 * megabytes that every block on the page can project from cheaply. Rows
 * stay in device pixels because that is what the crop is cut in. */
export interface PageInk {
  cells: Uint8Array
  /** point columns — the length of a projection */
  cols: number
  rows: number
  /** device rows per point */
  scale: number
  wPt: number
  hPt: number
  /** the leftmost and rightmost point of the page holding any ink: the
   * measure this page's crops are scaled against */
  extent: XBand | null
}

/** Read the page's ink. Null when the canvas cannot be read (no 2d context
 * in a test DOM, a tainted image) — the caller then crops full width. */
export function pageInkOf(bitmap: PageBitmap): PageInk | null {
  const w = bitmap.image.width
  const h = bitmap.image.height
  const cols = Math.max(1, Math.ceil(bitmap.wPt))
  if (!(w > 0) || !(h > 0) || !(bitmap.scale > 0)) return null
  const strip = document.createElement('canvas')
  strip.width = w
  strip.height = Math.min(h, INK_STRIPE)
  const ctx = strip.getContext('2d')
  if (!ctx) return null

  const cells = new Uint8Array(cols * h)
  let paper: [number, number, number] | null = null
  let left = cols
  let right = -1
  for (let y0 = 0; y0 < h; y0 += INK_STRIPE) {
    const rows = Math.min(INK_STRIPE, h - y0)
    ctx.clearRect(0, 0, w, strip.height)
    ctx.drawImage(bitmap.image, 0, y0, w, rows, 0, 0, w, rows)
    let data: Uint8ClampedArray
    try {
      data = ctx.getImageData(0, 0, w, rows).data
    } catch {
      return null
    }
    // the paper colour, read off the page's own top-left corner
    if (!paper) paper = [data[0], data[1], data[2]]
    for (let y = 0; y < rows; y++) {
      const row = y * w * 4
      const out = (y0 + y) * cols
      for (let x = 0; x < w; x++) {
        const i = row + x * 4
        const d = Math.abs(data[i] - paper[0]) + Math.abs(data[i + 1] - paper[1])
          + Math.abs(data[i + 2] - paper[2])
        if (d <= INK) continue
        const c = Math.min(cols - 1, Math.floor(x / bitmap.scale))
        cells[out + c] = 1
        if (c < left) left = c
        if (c > right) right = c
      }
    }
  }
  return {
    cells,
    cols,
    rows: h,
    scale: bitmap.scale,
    wPt: bitmap.wPt,
    hPt: bitmap.hPt,
    extent: right >= left ? { xMin: left, xMax: right + 1 } : null,
  }
}

/** how much ink each point of the page's width holds over a band of rows */
export function projectInk(ink: PageInk, topPx: number, bottomPx: number): number[] {
  const out = new Array<number>(ink.cols).fill(0)
  const from = Math.max(0, Math.min(ink.rows - 1, Math.floor(topPx)))
  const to = Math.max(from + 1, Math.min(ink.rows, Math.ceil(bottomPx)))
  for (let y = from; y < to; y++) {
    const row = y * ink.cols
    for (let c = 0; c < ink.cols; c++) if (ink.cells[row + c]) out[c]++
  }
  return out
}

/* ---------- targets ---------- */

/** every top-level block worth mirroring: all of them, in flow order, minus
 * the derived header (not source-backed — its edits are preamble edits) and
 * the markers the layout hides anyway. A block with no synctex records of
 * its own is dropped later, by the pass, because only synctex knows that. */
export function mirrorTargets(article: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = []
  for (const child of article.children) {
    if (!(child instanceof HTMLElement)) continue
    if (child.matches('header.dia-doc-header, .dia-label, .dia-maketitle')) continue
    out.push(child)
  }
  return out
}

/** The 1-based line range a block's source TEXT covers.
 *
 * The span's own edges are not it. A block's slice begins at the newline
 * that ended the block before it and runs through the blank lines that
 * separate it from the next, so `lineOf(span.start)` names the PREVIOUS
 * line — and a paragraph asking for the line its section heading sits on
 * gets a crop with the heading in it. Trim to the real characters first. */
export function lineRangeOf(doc: Doc, block: HTMLElement): { from: number; to: number } | null {
  const id = block.getAttribute('data-dia-id')
  if (!id) return null
  const span = doc.source.spanOf(id)
  if (!span || span.end <= span.start) return null
  const text = doc.source.text
  let start = span.start
  let end = span.end
  while (start < end && /\s/.test(text[start])) start++
  while (end > start && /\s/.test(text[end - 1])) end--
  if (end <= start) return null
  return { from: doc.source.lineOf(start), to: doc.source.lineOf(end - 1) }
}

/* ---------- the overlay ---------- */

interface Shown {
  /** the block's source bytes when the crop was made; any change to them
   * makes the picture a lie */
  slice: string
  /** one url per segment, in reading order */
  urls: string[]
  /** each segment's window width in points, so the crop can be re-scaled
   * without being re-cut when a later page turns out to hold wider ink */
  widths: number[]
  /** every input the pixels depend on — an identical key over a fresh
   * compile is the same crop, and re-cutting it would only cost a decode */
  key: string
}

const shown = new Map<HTMLElement, Shown>()
/** blocks wearing the "recompiling…" marker: edited, waiting for the crop */
const stale = new Set<HTMLElement>()
/** blocks the user opened, and the source they held when opened. An opened
 * block has already given up its crop, so `shown` no longer speaks for it —
 * but it is exactly the block most likely to be edited next, and it still
 * owes the reader a word about the render catching up. */
const opened = new Map<HTMLElement, string>()

/** is this block showing its compiled crop rather than its HTML form? */
export function isMirrored(block: HTMLElement): boolean {
  return shown.has(block)
}

/** insert (or replace) the one crop on a block. `widthPct` states how much
 * of the page's text measure the crop covers, so a single-column block in a
 * two-column paper stays that width instead of being blown up to fill.
 * `widthPt` is the same fact before it was divided — kept so the pass can
 * re-scale a hanging crop when the measure it divided by grows. */
export function attachMirror(
  doc: Doc,
  block: HTMLElement,
  parts: Array<{ url: string; widthPct?: number; widthPt?: number }>,
  opts: { key?: string } = {},
): HTMLElement | null {
  if (parts.length === 0) return null
  const id = block.getAttribute('data-dia-id')
  const slice = id ? doc.source.sliceOf(id) : null
  if (slice === null) return null
  detach(block)
  unmarkStale(block)

  // a span, not a div: the crop is a child of the block it mirrors, and half
  // of those blocks are <p> — a div in there is markup no parser would take
  // back if the block ever round-tripped through a string
  const wrap = document.createElement('span')
  wrap.className = 'dia-editor-artifact de-mirror'
  // theme matching is a blend, not a recolor: on light paper the page's
  // white multiplies away; on dark paper the picture is inverted (hue
  // preserved) and screened so its black page melts into the theme
  if (paperIsDark(doc)) wrap.classList.add('de-dark')
  wrap.title = MIRROR_TITLE

  // one image per (page, column) segment: a paragraph that ran off the foot
  // of a column continues in the next picture, exactly as it does in print
  for (const part of parts) {
    const seg = document.createElement('span')
    seg.className = 'de-mirror-part'
    if (part.widthPct && part.widthPct < 99) seg.style.width = `${part.widthPct.toFixed(2)}%`
    const img = document.createElement('img')
    img.src = part.url
    img.alt = 'the compiled render of this block'
    seg.appendChild(img)
    wrap.appendChild(seg)
  }

  // opening a block is a double-click on its picture: reveal the HTML form
  // first, then hand the caret to the ordinary editing path
  wrap.addEventListener('dblclick', (e) => {
    e.preventDefault()
    e.stopPropagation()
    openBlock(block, e.clientX, e.clientY)
  })

  block.prepend(wrap)
  shown.set(block, {
    slice,
    urls: parts.map((p) => p.url),
    widths: parts.map((p) => p.widthPt ?? 0),
    key: opts.key ?? '',
  })
  return wrap
}

/** Re-state every hanging crop's width against a new measure.
 *
 * The measure is the widest ink the document's pages hold, and the pass
 * only learns it a page at a time — so the first crops of a pass are
 * divided by a measure that may still grow. Rather than hold every crop
 * back until the last page is decoded (the reader would stare at HTML), the
 * pass re-divides what is already hanging. The pixels are untouched; only
 * the CSS width changes, which is the whole of the scale. */
function rescaleMirrors(measure: number): void {
  if (!(measure > 0)) return
  for (const [block, entry] of shown) {
    if (entry.widths.every((pt) => pt <= 0)) continue
    const segs = block.querySelectorAll<HTMLElement>('.de-mirror > .de-mirror-part')
    segs.forEach((seg, i) => {
      const pt = entry.widths[i] ?? 0
      if (pt <= 0) return
      const pct = pctOf(pt, measure)
      seg.style.width = pct < 99 ? `${pct.toFixed(2)}%` : ''
    })
  }
}

/** a window's share of the document's measure, as a percentage */
function pctOf(widthPt: number, measure: number): number {
  if (!(widthPt > 0) || !(measure > 0)) return 100
  return Math.max(10, Math.min(100, (widthPt / measure) * 100))
}

/** Open a mirrored block for editing: the crop steps aside, the HTML form
 * returns, and the caret lands on the leaf under the pointer. */
export function openBlock(block: HTMLElement, clientX?: number, clientY?: number): void {
  const doc = state.doc
  if (!doc) return
  const slice = doc.source.sliceOf(block.getAttribute('data-dia-id') ?? '')
  detach(block)
  if (slice !== null) opened.set(block, slice)
  if (isEditingText()) return
  const leaf = leafAt(doc, block, clientX, clientY)
  if (leaf) startEdit(leaf)
}

/** the editable leaf a click at these coordinates means, once the HTML form
 * is back. elementFromPoint is asked first (crop and form occupy roughly the
 * same band, so the point still points at about the right sentence); a miss
 * falls back to the block's first editable leaf. */
function leafAt(doc: Doc, block: HTMLElement, x?: number, y?: number): HTMLElement | null {
  if (typeof x === 'number' && typeof y === 'number') {
    const root = doc.root as ShadowRoot & { elementFromPoint?: (x: number, y: number) => Element | null }
    const hit = root.elementFromPoint?.(x, y) ?? null
    if (hit instanceof HTMLElement && block.contains(hit)) {
      const editable = docEditableFor(doc.article, hit)
      if (editable) return editable
    }
  }
  const own = docEditableFor(doc.article, block)
  if (own) return own
  for (const el of block.querySelectorAll<HTMLElement>('*')) {
    const editable = docEditableFor(doc.article, el)
    if (editable) return editable
  }
  return null
}

/** drop crops whose block was edited, moved out of the document, or whose
 * source span was invalidated. An edited block reverts to its HTML form at
 * once and says the render is catching up. */
export function pruneMirrors(): void {
  const doc = state.doc
  for (const [block, entry] of [...shown]) {
    const id = block.getAttribute('data-dia-id')
    const slice = doc && id ? doc.source.sliceOf(id) : null
    if (!doc || !block.isConnected || slice !== entry.slice) {
      detach(block)
      if (doc && block.isConnected && slice !== null) markStale(block)
    }
  }
  for (const [block, was] of [...opened]) {
    const id = block.getAttribute('data-dia-id')
    const slice = doc && id ? doc.source.sliceOf(id) : null
    if (!doc || !block.isConnected) { opened.delete(block); continue }
    if (slice === was) continue
    opened.delete(block)
    if (slice !== null) markStale(block)
  }
}

export function clearMirrors(): void {
  for (const block of [...shown.keys()]) detach(block)
  for (const block of [...aside.keys()]) { if (block.isConnected) clearAside(block); else aside.delete(block) }
  opened.clear()
  clearStale()
}

/** rasterize for the actual display: a fixed dpi is blurry on any hidpi
 * screen because the crop is downscaled to the article width in CSS pixels
 * while the panel shows devicePixelRatio× that many device pixels */
function mirrorDpi(): number {
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
  return Math.min(300, Math.round(130 * Math.max(1, dpr)))
}

/** is the document's paper dark? decides the crop blend (see attachMirror) */
function paperIsDark(doc: Doc): boolean {
  const bg = getComputedStyle(doc.article).backgroundColor
  const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  if (!m) return false
  return 0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3]) < 128
}

function detach(block: HTMLElement): void {
  for (const el of [...block.children]) {
    if (el.classList.contains('de-mirror')) el.remove()
  }
  const entry = shown.get(block)
  for (const url of entry?.urls ?? []) {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url)
  }
  shown.delete(block)
}

/* ---------- the staleness marker ---------- */

/** Say that a block's render is behind its text — but only when one is
 * actually coming. With no engine, with auto-compile off, or with the
 * mirror off, an edited block is simply an HTML block again, and claiming
 * otherwise would be a promise nothing is going to keep. */
function markStale(block: HTMLElement): void {
  if (!enabled || !texAvailable() || !autoCompileOn()) return
  if (stale.has(block)) return
  const tag = document.createElement('span')
  tag.className = 'dia-editor-artifact de-stale'
  tag.textContent = 'recompiling…'
  block.prepend(tag)
  stale.add(block)
}

function unmarkStale(block: HTMLElement): void {
  for (const el of [...block.children]) {
    if (el.classList.contains('de-stale')) el.remove()
  }
  stale.delete(block)
}

function clearStale(): void {
  for (const block of [...stale]) unmarkStale(block)
}

/* ---------- the mirror switch ---------- */

/* per session: 'show html' in the tex chip's menu. Off means the native view
 * is the HTML rendering it always was — the escape hatch for anyone who
 * wants to see what the dialect made of their source. */
let enabled = true

export function mirrorOn(): boolean { return enabled }

export function setMirrorOn(on: boolean): void {
  if (enabled === on) return
  enabled = on
  if (!on) { clearMirrors(); return }
  const jobId = lastCompileJobId()
  if (jobId) void refreshMirrors(jobId)
}

/* ---------- the pass ---------- */

let installed = false
let shownJob: string | null = null
let pass = 0

/** Wire the mirror to the compile controller and the op stream. Idempotent —
 * the shell calls it once. */
export function installBlockMirror(): void {
  if (installed) return
  installed = true

  onCompileState((s) => {
    // a failed compile is not going to produce the crop an edited block is
    // waiting for; the chip carries the news, the markers stop claiming it
    if (s.status === 'failed') { clearStale(); return }
    if (s.status !== 'ok') return
    const jobId = lastCompileJobId()
    if (!jobId || jobId === shownJob) return
    void refreshMirrors(jobId)
  })

  state.bus.on((e) => {
    switch (e.type) {
      case 'doc-loaded':
        clearMirrors()
        clearPageCache()
        clearInkCache()
        shownJob = null
        pass++
        break
      case 'blocks-changed':
        // a whole-source commit re-renders blocks: every crop is stale, and
        // the job that made them describes a document that is gone
        clearMirrors()
        shownJob = null
        pass++
        break
      case 'op':
      case 'undo':
      case 'redo':
        pruneMirrors()
        break
    }
  })
}

/** one crop of one block: a page, the records that stand in one run of the
 * page's ink, and the window that run gave them */
interface Placed {
  page: number
  records: SynctexRecord[]
  xs: number[]
  /** null only when the page's ink could not be read at all */
  window: XBand | null
  merged: boolean
}

interface Part { url: string; widthPt: number }

/** one crop already cut this pass: the rows it showed, so a later block
 * growing its top upward knows where the page stops being its own */
export interface Claim { xMin: number; xMax: number; yMin?: number; yMax: number }

/** what every cut of one pass shares */
export interface Pass {
  jobId: string
  dpi: number
  ySemantics: string
  byPage: Map<number, SynctexRecord[]>
  /** the widest ink any page decoded so far holds, in points — the one
   * measure every crop in the document is divided by */
  measure: number
  /** what earlier cuts have already shown, per page, in top-down points */
  claims: Map<number, Claim[]>
  /** how a page's ink is resolved and a placed crop turned into pixels —
   * real bitmaps in the browser, captured ink in a fixture replay */
  pages: PageSource
  /** is this still the pass the document is waiting for? */
  live: () => boolean
}

/* two windows sharing this much of the narrower one are one thing seen
 * twice — a table's cell groups, a paragraph whose inner boxes straggled */
const MERGE_SHARE = 0.3

/** true for a record whose SOURCE line sets no type of its own — blank or a
 * comment — so its box is always some real line's left open, never this
 * one's own. One after a display truncated the paragraph above it (a false
 * "below"); one before a paragraph hid its first line (a false "above").
 * Filtered before anything else reads the records (see refreshMirrors). */
export function isPhantomRecord(r: SynctexRecord, sourceLines: string[]): boolean {
  const line = sourceLines[r.line - 1]
  if (line === undefined) return false
  const t = line.trim()
  return t === '' || t.startsWith('%')
}

/** group records by the page they landed on, in first-seen order — the
 * per-document map every cut's placement is bracketed against */
export function groupByPage(records: SynctexRecord[]): Map<number, SynctexRecord[]> {
  const byPage = new Map<number, SynctexRecord[]>()
  for (const r of records) {
    const held = byPage.get(r.page)
    if (held) held.push(r)
    else byPage.set(r.page, [r])
  }
  return byPage
}

/** rebuild every crop from a finished job's artifacts */
export async function refreshMirrors(jobId: string): Promise<void> {
  const doc = state.doc
  if (!doc || !enabled) return
  const mine = ++pass

  const srcLines = doc.source.text.split('\n')
  const records = withoutWrappers((await fetchSynctex(jobId)).filter((r) => !isPhantomRecord(r, srcLines)))
  if (records.length === 0 || mine !== pass || state.doc !== doc) return
  const info = await pagesInfo(jobId)
  if (mine !== pass || state.doc !== doc) return
  shownJob = jobId

  const dpi = mirrorDpi()
  const run: Pass = {
    jobId,
    dpi,
    ySemantics: info?.ySemantics ?? Y_TOP_DOWN,
    byPage: groupByPage(records),
    measure: 0,
    claims: new Map(),
    pages: makeLivePageSource(jobId, dpi),
    live: () => mine === pass && state.doc === doc,
  }
  await cutDocument(doc, records, run)
}

/* the source a beamer frame block starts with, whatever markup a parser
 * wraps it in (a dia-tex-island today; sniffed on the SOURCE rather than a
 * class so it does not care) */
const FRAME_START = /^\\begin\{frame\}/

/** Cut every block's crops for one pass, given records and a page source
 * that is already resolved — no daemon fetch, no compile job, nothing
 * browser-only left in it but the DOM the crops attach to (which happy-dom
 * renders fine; it just cannot decode an `<img>`'s pixels). Exported so a
 * fixture replay can drive the exact placement/band/grow/snap/trim pipeline
 * against captured synctex+ink instead of a live compile — see
 * blockmirror.fixture.test.ts. */
export async function cutDocument(doc: Doc, records: SynctexRecord[], run: Pass): Promise<void> {
  // WHICH pages a block landed on is pure and cheap; WHERE on them it
  // stands is not knowable until the page is decoded. So the segments are
  // worked out for the whole document first and the pass then walks them in
  // an order that decodes each page once (see cutOrder) — a document is
  // dozens of pages and a page bitmap is tens of megabytes, so revisiting
  // one is the difference between a pass and a crashed tab.
  const marks = new Map<number, string>()
  const entries: Array<{ block: HTMLElement; range: { from: number; to: number }; segments: Segment[] }> = []
  for (const block of mirrorTargets(doc.article)) {
    clearAside(block)
    if (isOpenForEdit(block)) continue // a block being typed in owns itself
    const range = lineRangeOf(doc, block)
    if (!range) continue
    entries.push({ block, range, segments: segmentsFor(records, range.from, range.to) })
  }
  const cuts: Cut[] = []
  const orphans: Orphan[] = []
  for (let i = 0; i < entries.length; i++) {
    const { block, range, segments } = entries[i]
    const slice = doc.source.sliceOf(block.getAttribute('data-dia-id') ?? '') ?? ''
    // a beamer frame: synctex gives its own source line almost nothing to
    // place (14 records for a 13-page beamer.tex, measured) — but each
    // record it DOES report lands at the frame's own left margin (x=0), not
    // a real column position, which is nothing the ordinary per-record crop
    // can bracket (bandFor's inBand keeps zero tolerance for every other
    // paper's sake, so it drops a x=0 box on the floor rather than guess).
    // What those same records DO say correctly is which PDF page each one
    // is on — one record per overlay step, because beamer ships one page
    // per \pause/<n->/\onslide split and \end{frame}'s line gets a fresh box
    // at every shipout (measured on beamer.tex: a lone \pause produced 2
    // records/pages, three `<n->` items plus a \onslide<4-> produced 4). So
    // a frame skips segment-level placement
    // entirely and crops the WHOLE of every page its own records name, the
    // way bibliographyPages already bypasses line attribution for
    // references — cheap to get right because the page list falls out of
    // segmentsFor for free, and cutBlock's fullPages branch already exists.
    if (FRAME_START.test(slice.trimStart())) {
      const pages = [...new Set(segments.map((s) => s.page))].sort((a, b) => a - b)
      if (pages.length > 0) {
        cuts.push({ block, segments: [], range, fullPages: pages, key: `frame|${pages.join(',')}|${run.dpi}` })
        continue
      }
      // no synctex attribution at all for this frame — not measured in the
      // beamer.tex corpus fixture (every frame there gets at least one
      // record), but nothing guarantees every frame always will. Falls
      // through to the ordinary classification below, which marks it
      // quietly rather than showing nothing at all.
    }
    if (segments.length === 0) {
      if (/\\bibliography\{|\\printbibliography/.test(slice)) {
        const prevPage = bibliographyPrevPage(records, range)
        let prevIsFiller = false
        if (prevPage > 0) {
          const src = await run.pages.ink(prevPage)
          if (!run.live()) return
          if (src?.ink) prevIsFiller = isFillerPage(src.ink)
        }
        const pages = bibliographyPages(records, range, prevIsFiller)
        if (pages.length > 0) {
          cuts.push({ block, segments: [], range, fullPages: pages,
            key: `bib|${pages.join(',')}|${run.dpi}` })
          continue
        }
      }
      orphans.push({ block, range })
      continue
    }
    // a `\paragraph` heading is typeset run-in, INSIDE the first line of
    // the block after it — two crops of that line is the reader seeing
    // double, and the next block's is the one that shows the whole line
    const next = entries[i + 1]
    if (block.matches('h4.dia-sec, h5.dia-sec') && next && next.segments.length > 0
      && next.range.from <= range.to) {
      orphans.push({ block, range, sharedWith: next.block })
      continue
    }
    let prev: typeof entries[number] | undefined
    for (let j = i - 1; j >= 0; j--) {
      if (entries[j].segments.length > 0) { prev = entries[j]; break }
    }
    if (prev && !block.matches('figure, table') && !prev.block.matches('figure, table')
      && liesAbovePrev(segments, prev.segments, run.ySemantics)) {
      orphans.push({ block, range, sharedWith: prev.block })
      continue
    }
    cuts.push({ block, segments, range, key: keyFor(segments, run, marks) })
  }

  // crops are replaced in place rather than cleared first: a recompile
  // should refresh the page, not blank it for a second
  const fresh = new Set<HTMLElement>()
  for (const cut of cutOrder(cuts)) {
    const { block, key } = cut
    const held = shown.get(block)
    const slice = doc.source.sliceOf(block.getAttribute('data-dia-id') ?? '')
    // identical inputs, identical pixels: keep the picture that is already
    // hanging rather than pay a page decode and a re-encode for it — but
    // its rows are still claimed, or a later block would grow into them
    if (held && held.key === key && held.slice === slice) {
      for (const c of heldClaims.get(block) ?? []) {
        const list = run.claims.get(c.page)
        if (list) list.push(c)
        else run.claims.set(c.page, [c])
      }
      fresh.add(block)
      continue
    }

    const before = run.measure
    const parts = await cutBlock(run, cut)
    if (parts === null || !run.live()) return
    // records but no ink (a \clearpage points at a blank page top) is the
    // same fate as no records at all: let the classifier place it
    if (parts.length === 0) { orphans.push({ block, range: cut.range }); continue }
    if (isOpenForEdit(block)) { revokeAll(parts); continue }
    const shaped = parts.map((p) => ({ ...p, widthPct: pctOf(p.widthPt, run.measure) }))
    if (attachMirror(doc, block, shaped, { key })) {
      fresh.add(block)
      opened.delete(block) // its render caught up; it is a crop again
    }
    // a page holding wider ink than anything before it restates every crop
    // already hanging: one document, one scale, at every moment of the pass
    if (run.measure > before) rescaleMirrors(run.measure)
  }
  // a block this compile has nothing to show for keeps no picture from the
  // last one
  for (const block of [...shown.keys()]) if (!fresh.has(block)) detach(block)
  classifyOrphans(doc, orphans, fresh)
  spaceMirrors(doc, run)
  clearStale()
}

/** The gap the PAGE puts between two consecutive crops, as a percentage of
 * the document measure. CSS vertical margins in % resolve against the
 * container width — the same base the crops' widthPct scales by — so the
 * measured spacing holds at any zoom. Null (use the default gap) across
 * pages, across columns, around blocks with nothing measured, and for
 * anything implausible (overlap, more than a float separation). */
export function measuredGapPct(
  prev: Array<Claim & { page: number }> | undefined,
  next: Array<Claim & { page: number }> | undefined,
  measure: number,
): number | null {
  if (!prev?.length || !next?.length || !(measure > 0)) return null
  const a = prev[prev.length - 1]
  const b = next[0]
  if (a.page !== b.page || typeof b.yMin !== 'number') return null
  if (Math.min(a.xMax, b.xMax) - Math.max(a.xMin, b.xMin) <= WINDOW_PAD * 2) return null
  const gap = b.yMin - a.yMax
  if (gap < 0 || gap > 60) return null
  return (gap / measure) * 100
}

/** TeX's vertical rhythm, carried into the flow: every uniform CSS gap the
 * editor would show between crops is replaced by the distance the page
 * actually left there. Blocks without a crop (stale, marked, hidden) keep
 * the chain — a hidden block's ink lives inside its neighbour's crop. */
function spaceMirrors(doc: Doc, run: Pass): void {
  let prev: Array<Claim & { page: number }> | undefined
  for (const block of mirrorTargets(doc.article)) {
    const mirror = block.querySelector(':scope > .de-mirror')
    if (!(mirror instanceof HTMLElement)) continue
    const claims = heldClaims.get(block)
    if (!claims?.length) { mirror.style.marginTop = ''; prev = undefined; continue }
    const pct = measuredGapPct(prev, claims, run.measure)
    mirror.style.marginTop = pct === null ? '' : `${pct.toFixed(3)}%`
    prev = claims
  }
}

interface Orphan {
  block: HTMLElement
  range: { from: number; to: number }
  /** the neighbour whose crop already shows this block's ink — hide the
   * double as long as that neighbour actually mirrored */
  sharedWith?: HTMLElement
}

/** What to do with a block the compile typeset nothing for, decided AFTER
 * the pass so neighbours' mirror state is known:
 *  - a block whose ink is inside a named neighbour's crop (a run-in
 *    heading, a display whose records were the previous paragraph's box)
 *    hides as long as that neighbour mirrored;
 *  - layout-only source (\clearpage, \appendix…) sets nothing — hide it;
 *  - in a beamer deck, \section (and \subsection) also sets nothing: it
 *    only feeds the navigation bar / \tableofcontents, never a slide, and
 *    unlike \clearpage that is not something setsNoType/isLayoutOnlySlice
 *    can tell from the raw slice alone — in an article or book \section
 *    very much DOES ink a heading, so hiding it needs the document class,
 *    not just the command name — hide it;
 *  - a block sharing its source line with the previous one (display math
 *    after text on one line) is inside that crop for the same reason —
 *    and display math is inside the paragraph it interrupts even when the
 *    line count says they merely touch;
 *  - a run-in heading (\paragraph) with no records at all is typeset
 *    INSIDE the next block's first line, so its crop shows the words;
 *  - anything else keeps its HTML form, quietly marked so the reader can
 *    tell "not in the compiled render" from "waiting for the compiler". */
function classifyOrphans(doc: Doc, orphans: Orphan[], mirrored: Set<HTMLElement>): void {
  for (const { block, range, sharedWith } of orphans) {
    if (!block.isConnected) continue
    if (sharedWith && mirrored.has(sharedWith)) { putAside(block, 'hidden'); continue }
    const slice = doc.source.sliceOf(block.getAttribute('data-dia-id') ?? '') ?? ''
    if (isLayoutOnlySlice(slice) || setsNoType(slice) || isInklessSectionMarker(slice, doc.docclass)) {
      putAside(block, 'hidden')
      continue
    }

    const prev = block.previousElementSibling
    if (prev instanceof HTMLElement && mirrored.has(prev)) {
      const prevRange = lineRangeOf(doc, prev)
      const room = block.matches('.dia-math') ? 1 : 0
      if (prevRange && prevRange.to + room >= range.from) { putAside(block, 'hidden'); continue }
    }
    const next = block.nextElementSibling
    if (block.matches('h4.dia-sec, h5.dia-sec') && next instanceof HTMLElement && mirrored.has(next)) {
      const nextRange = lineRangeOf(doc, next)
      if (nextRange && nextRange.from - range.to <= 2) { putAside(block, 'hidden'); continue }
    }
    putAside(block, 'marked')
  }
}

const aside = new Map<HTMLElement, 'hidden' | 'marked'>()

function putAside(block: HTMLElement, how: 'hidden' | 'marked'): void {
  clearAside(block)
  const tag = document.createElement('span')
  tag.className = `dia-editor-artifact ${how === 'hidden' ? 'de-mirror-hidden' : 'de-unmirrored'}`
  if (how === 'marked') tag.title = 'not present in the compiled render — shown as authored'
  block.prepend(tag)
  aside.set(block, how)
}

function clearAside(block: HTMLElement): void {
  for (const el of block.querySelectorAll(':scope > .de-mirror-hidden, :scope > .de-unmirrored')) el.remove()
  aside.delete(block)
}

/** Where cutBlock gets a page's ink, and turns a placed crop into pixels.
 *
 * `ink` resolves once per page — the browser decodes a bitmap and reads its
 * ink, a fixture replay hands back ink captured earlier (see
 * blockmirror.fixture.test.ts) — and carries the page's own wPt/hPt, so
 * nothing downstream needs the bitmap at all except to draw it. `rasterize`
 * is the ONLY step that ever touches real pixels; null propagates exactly as
 * a blank cropBand always did — no part, no claim, the classifier decides
 * what the block shows instead. A fixture replay skips rasterizing (there
 * are no pixels to draw) and returns a crop for every shape the coarse ink
 * says is non-blank, which is what lets it pin the placement/band/grow/snap/
 * trim math without ever exercising cropBand's own pixel-level trim (that
 * one needs a real canvas, which happy-dom does not have either — see the
 * early-return guards in the `cropBand` tests below). */
export interface PageSource {
  ink(page: number): Promise<{ ink: PageInk | null; wPt: number; hPt: number } | null>
  rasterize(page: number, shape: MirrorRegion, claimed?: { yMin: number; yMax: number }): Promise<string | null>
}

/** the browser's PageSource: a daemon-rendered bitmap per page, decoded once
 * into ink (cached two pages deep — see inkCache) and cropped again at
 * rasterize time, which is always a cache hit against the same bitmap. */
function makeLivePageSource(jobId: string, dpi: number): PageSource {
  return {
    async ink(page) {
      const bitmap = await getPageBitmap(jobId, page, { dpi })
      if (!bitmap) return null
      return { ink: inkFor(jobId, dpi, page, bitmap), wPt: bitmap.wPt, hPt: bitmap.hPt }
    },
    async rasterize(page, shape, claimed) {
      const bitmap = await getPageBitmap(jobId, page, { dpi })
      if (!bitmap) return null
      const canvas = cropBand(bitmap, shape, claimed)
      if (!canvas) return null
      return canvasUrl(canvas)
    },
  }
}

/** Cut one block's crops, a page at a time: resolve the page's ink, place
 * the block's segments in it, rasterize each one. Null means the pass was
 * overtaken while awaiting — whatever it had made is already released. */
async function cutBlock(run: Pass, cut: Cut): Promise<Part[] | null> {
  const parts: Part[] = []
  const abort = (): null => { revokeAll(parts); return null }

  // a bibliography: whole pages, no records to place, no line budget — the
  // first page starts below the last line of the block before it
  if (cut.fullPages) {
    for (const page of cut.fullPages) {
      const src = await run.pages.ink(page)
      if (!run.live()) return abort()
      if (!src) continue
      const { ink, wPt, hPt } = src
      if (!ink?.extent) continue
      run.measure = Math.max(run.measure, ink.extent.xMax - ink.extent.xMin)
      const before = (run.byPage.get(page) ?? [])
        .filter((r) => r.line < cut.range.from)
        .map((r) => r.y)
      // the next section may resume on the last references page — its
      // records cap the crop from below just as the body's cap it above
      const after = (run.byPage.get(page) ?? [])
        .filter((r) => r.line > cut.range.to)
        .map((r) => r.y)
      const region = toTopDown({
        page,
        yMin: before.length ? Math.max(...before) + 6 : 0,
        yMax: after.length ? Math.max(0, Math.min(...after) - 6) : hPt,
        anchors: [],
      }, hPt, run.ySemantics)
      const shape: MirrorRegion = dropFolio(ink, {
        ...region,
        xMin: Math.max(0, ink.extent.xMin - 6),
        xMax: Math.min(wPt, ink.extent.xMax + 6),
      })
      if (!hasInk(ink, shape)) continue
      const url = await run.pages.rasterize(page, shape)
      if (!run.live()) { if (url) revoke(url); return abort() }
      if (url === null) continue
      parts.push({ url, widthPt: (shape.xMax ?? 0) - (shape.xMin ?? 0) })
    }
    return parts
  }

  const opts = { typed: linesOfType(cut.block), chars: (cut.block.textContent ?? '').trim().length }
  let shownLines = 0
  const myClaims: Array<Claim & { page: number }> = []
  let sated = false

  for (const page of [...new Set(cut.segments.map((s) => s.page))]) {
    if (sated) break
    const src = await run.pages.ink(page)
    if (!run.live()) return abort()
    if (!src) continue
    const { ink, wPt, hPt } = src
    if (ink?.extent) run.measure = Math.max(run.measure, ink.extent.xMax - ink.extent.xMin)
    const onPage = run.byPage.get(page) ?? []
    const segs = cut.segments.filter((s) => s.page === page)

    for (const placed of placeSegments(ink, onPage, segs, cut.range, run.ySemantics)) {
      const band = bandFor(ink, onPage, placed, cut.range, { ...opts, shownLines, hPt })
      if (!band) continue
      const top = toTopDown(band.region, hPt, run.ySemantics)
      let shape = ink ? snapEdges(ink, top) : top
      // A prose crop opens one ascent above its first RECORD — and the
      // typeset line above that may still be the block's own: a paragraph
      // resuming in the next column, or one whose long opening source line
      // wrapped, set lines synctex never pinned. Contiguous ink up the
      // column is the block's own until a real blank (a float, a margin, a
      // heading skip) or a row an earlier crop already showed. Never for a
      // heading: it has no wrapped continuation to recover, and a
      // page-break blank record would send it climbing into the paragraph
      // above it.
      let grown = 0
      if (ink && opts.typed && !cut.block.matches('h1,h2,h3,h4,h5,h6')) {
        const wider = growTop(ink, shape, claimFloor(run.claims.get(page), shape))
        grown = shape.yMin - wider.yMin
        shape = wider
      }
      // A blank rectangle is not a picture of anything. Synctex hands one
      // out for every line a page break fell on — such a line owns the PAGE
      // box of the page it left behind, 800pt down in its bottom margin —
      // and the reader saw them as gaps where a heading should be.
      if (ink && !hasInk(ink, shape)) continue
      const claimed = { yMin: shape.yMin, yMax: shape.yMax }
      const url = await run.pages.rasterize(page, shape, claimed)
      if (!run.live()) { if (url) revoke(url); return abort() }
      if (url === null) continue
      parts.push({ url, widthPt: placed.window ? placed.window.xMax - placed.window.xMin : 0 })
      if (typeof shape.xMin === 'number' && typeof shape.xMax === 'number') {
        const claim = { xMin: shape.xMin, xMax: shape.xMax, yMin: claimed.yMin, yMax: claimed.yMax, page }
        myClaims.push(claim)
        const held = run.claims.get(page)
        if (held) held.push(claim)
        else run.claims.set(page, [claim])
      }

      // enough: when the crops so far already cover the lines this block's
      // text can fill (with slack), anything later is not a continuation —
      // it is a footnote or a whatsit synctex attributed to our source
      // line, and stacking it under the block reads as noise
      shownLines += Math.max(1, Math.round((band.region.yMax - band.region.yMin + grown) / Math.max(band.lead, 8)))
      if (shownLines >= textLines(opts.chars, band.width, band.lead) * 1.4 + 2) { sated = true; break }
    }
  }
  heldClaims.set(cut.block, myClaims)
  return parts
}

/** a mirrored block's claimed rows from the last cut — page plus rectangle
 * in top-down points, after grow/snap/trim. Exported so a fixture replay can
 * assert crop rectangles against pinned goldens without reaching into the
 * module's own cache. */
export function claimsFor(block: HTMLElement): Array<Claim & { page: number }> | undefined {
  return heldClaims.get(block)
}

/** each mirrored block's claims, kept so a cache hit — the crop is already
 * hanging, nothing is re-cut — still tells the pass what those rows were */
const heldClaims = new WeakMap<HTMLElement, Array<Claim & { page: number }>>()

/** How far up the column this crop's ink actually reaches: from the top the
 * records gave, walk upward while the ink stays contiguous (blanks under a
 * GUTTER are line gaps), stopping at `floorPt` — the bottom of whatever an
 * earlier crop on this page already showed. Top-down points. */
function growTop(ink: PageInk, region: MirrorRegion, floorPt: number): MirrorRegion {
  if (typeof region.xMin !== 'number' || typeof region.xMax !== 'number') return region
  const lo = Math.max(0, Math.floor(region.xMin))
  const hi = Math.min(ink.cols - 1, Math.ceil(region.xMax))
  const inked = (y: number): boolean => {
    const row = y * ink.cols
    for (let c = lo; c <= hi; c++) if (ink.cells[row + c]) return true
    return false
  }
  const gapLimit = Math.round(GUTTER * ink.scale)
  const floor = Math.max(0, Math.ceil(floorPt * ink.scale))
  const top = Math.round(region.yMin * ink.scale)
  let best = top
  let gap = 0
  for (let y = top - 1; y >= floor && gap <= gapLimit; y--) {
    if (inked(y)) { best = y; gap = 0 }
    else gap++
  }
  if (best >= top) return region
  // a breath of paper over the topmost ink, but never into the claim
  const eased = Math.max(floor, best - Math.round(2 * ink.scale))
  return { ...region, yMin: eased / ink.scale }
}

/** the lowest row an earlier crop has already shown above this one — the
 * hard stop for growTop, so two crops never show the same line. Overlap in
 * x must be real: two adjacent columns' windows TOUCH at their pads, and a
 * neighbour column's crop says nothing about ours. */
export function claimFloor(claims: Claim[] | undefined, region: MirrorRegion): number {
  if (!claims || typeof region.xMin !== 'number' || typeof region.xMax !== 'number') return 0
  let floor = 0
  for (const c of claims) {
    if (Math.min(c.xMax, region.xMax) - Math.max(c.xMin, region.xMin) <= WINDOW_PAD * 2) continue
    if (c.yMax <= region.yMax) floor = Math.max(floor, c.yMax + 1)
  }
  return floor
}

/** Where a page's ink puts each of a block's segments — and which of them
 * were the same thing all along.
 *
 * A block scatters boxes: a table reports a cluster per cell column, a
 * paragraph reports inner boxes halfway across its own measure, and the
 * x-gap split hands both of those back as several segments. Their WINDOWS
 * are what says otherwise, because all of them resolve to the same run of
 * ink — so the segments are placed, merged where their windows overlap, and
 * the merged ones placed again over the rows all of it covers. */
function placeSegments(
  ink: PageInk | null,
  onPage: SynctexRecord[],
  segs: Segment[],
  range: { from: number; to: number },
  ySemantics: string,
): Placed[] {
  const placed: Placed[] = segs.map((s) => ({
    page: s.page,
    records: s.records,
    xs: s.xs,
    window: ink ? windowFor(ink, onPage, s, range, ySemantics) : null,
    merged: false,
  }))

  let merged = mergeWindows(placed)
  for (let i = 0; i < 2 && merged.length > 1; i++) {
    // a union can overlap a window neither of its halves did
    const again = mergeWindows(merged)
    if (again.length === merged.length) break
    merged = again
  }
  for (const p of merged) {
    if (!p.merged || !ink) continue
    const window = windowFor(ink, onPage, { page: p.page, records: p.records, xs: p.xs }, range, ySemantics)
    if (window) p.window = window
  }
  return merged.sort((a, b) => (a.window?.xMin ?? 0) - (b.window?.xMin ?? 0))
}

function mergeWindows(placed: Placed[]): Placed[] {
  const out: Placed[] = []
  for (const p of placed) {
    const hit = p.window
      ? out.find((o) => o.window !== null && overlapShare(o.window, p.window as XBand) >= MERGE_SHARE)
      : undefined
    if (!hit || !hit.window || !p.window) { out.push({ ...p }); continue }
    hit.records = hit.records.concat(p.records)
    hit.xs = hit.xs.concat(p.xs)
    hit.window = {
      xMin: Math.min(hit.window.xMin, p.window.xMin),
      xMax: Math.max(hit.window.xMax, p.window.xMax),
    }
    hit.merged = true
  }
  return out
}

/** The horizontal window one segment gets: the extent of the ink runs its
 * measured boxes stand in.
 *
 * Which rows to read the ink over is the same question backwards — the
 * rows are the block's once the window is known, and the window is the
 * block's once the rows are — so it is asked twice. The first answer is
 * taken over a PROVISIONAL band, the generous one the records bracket
 * (which on page 1 of a paper reaches up through an author block set right
 * across the gutter, and reads both columns as one run). Trimming that band
 * to the run of rows the block's own baselines stand in — the same ink trim
 * the crop itself ends with — and asking again is what corrects it. */
function windowFor(
  ink: PageInk,
  onPage: SynctexRecord[],
  seg: Segment,
  range: { from: number; to: number },
  ySemantics: string,
): XBand | null {
  if (seg.xs.length === 0) return null
  const lo = Math.min(...seg.xs)
  const hi = Math.max(...seg.xs)
  const near = inBand(onPage, { xMin: lo - COLUMN_TOL, xMax: Math.max(hi, lo + REACH) })
  // the GENEROUS bracket, and no line count: everything the records leave
  // room for is worth projecting, and nothing here is cut to it. No pitch
  // either — it cannot be read reliably before the column is known, since
  // a page's two columns interleave their baselines — and no pitch is what
  // asks regionForLines for its widest answer.
  const prov = regionForLines(near, range.from, range.to, { page: seg.page, hPt: ink.hPt })
  const ys = seg.records.map((r) => r.y)
  const band = toTopDown({
    page: seg.page,
    yMin: Math.min(prov?.yMin ?? Infinity, Math.min(...ys) - CONTEXT),
    yMax: Math.max(prov?.yMax ?? -Infinity, Math.max(...ys) + CONTEXT),
    anchors: ys,
  }, ink.hPt, ySemantics)

  const top = band.yMin * ink.scale
  const bottom = band.yMax * ink.scale
  const first = windowOf(ink, top, bottom, seg.xs)
  if (!first) return null

  // the rows our baselines stand in, seen through that first window. This
  // is what drops the author block a page-1 bracket reaches up into, and
  // with it the reading of two columns as one.
  const rows = ownRows(ink, first, top, bottom, band.anchors.map((y) => y * ink.scale))
  if (!rows) return first
  const own = windowOf(ink, rows.top, rows.bottom, seg.xs) ?? first
  if (!tooNarrow(ink, own)) return own

  // A run this narrow is not a column: it is a section NUMBER, cut off
  // from its own title by the 11pt of paper `\section` puts there — which
  // no threshold tells from the 14pt gutter beside it, both measured on
  // llama.tex. The lines around it are what fill that blank in, and
  // nothing else has to look at them: this is the one case where a block's
  // own rows do not show the shape of what it stands in.
  const reach = NARROW_REACH * ink.scale
  const wide = windowOf(ink, rows.top - reach, rows.bottom + reach, seg.xs) ?? own
  if (!tooNarrow(ink, wide)) return wide
  // still narrow: nothing stands NEAR this block at all (a `\section` set
  // alone inside a figure* on an otherwise-open page). The title is the
  // run just past the number's own blank — chain runs across gaps under a
  // gutter's width, over the block's own rows only.
  return windowJoined(ink, rows.top, rows.bottom, seg.xs) ?? wide
}

/* a heading number's gap to its own title (11pt on llama.tex) against the
 * narrowest gutter beside it (17pt): runs nearer than this are one thing */
const TITLE_GAP = 14

/** the window of the selected runs JOINED with any neighbouring run within
 * TITLE_GAP — the last resort for a heading with nothing else on its rows */
function windowJoined(ink: PageInk, topPx: number, bottomPx: number, xs: number[]): XBand | null {
  const runs = inkRunsOf(projectInk(ink, topPx, bottomPx), INK_GAP)
  const pick = selectRunsFor(runs, xs)
  if (!pick) return null
  let [lo, hi] = pick
  let changed = true
  while (changed) {
    changed = false
    for (const [a, b] of runs) {
      if (b >= lo - TITLE_GAP && b < lo) { lo = a; changed = true }
      if (a <= hi + TITLE_GAP && a > hi) { hi = b; changed = true }
    }
  }
  return {
    xMin: Math.max(0, lo - WINDOW_PAD),
    xMax: Math.min(ink.wPt, hi + 1 + WINDOW_PAD),
  }
}

/** is this window too narrow to be the column a block was set in? A
 * quarter of the page's own ink: every real measure clears it (a
 * three-column layout leaves each column a third), and the things that do
 * not are single words the crop should be showing in their column. */
function tooNarrow(ink: PageInk, window: XBand): boolean {
  if (!ink.extent) return false
  return window.xMax - window.xMin < (ink.extent.xMax - ink.extent.xMin) / 4
}

/** the window the ink over these rows gives a block standing at `xs` */
function windowOf(ink: PageInk, topPx: number, bottomPx: number, xs: number[]): XBand | null {
  const pick = selectRunsFor(inkRunsOf(projectInk(ink, topPx, bottomPx), INK_GAP), xs)
  if (!pick) return null
  return {
    xMin: Math.max(0, pick[0] - WINDOW_PAD),
    xMax: Math.min(ink.wPt, pick[1] + 1 + WINDOW_PAD),
  }
}

/** Never cut through a line of type.
 *
 * Both edges of a band are guesses made in LEADINGS — how far a line's ink
 * reaches above and below the baseline the records report — and a leading
 * is the wrong ruler for the larger type of a heading or for a page whose
 * columns interleave their baselines. When an edge lands inside a run of
 * ink, the ink itself settles it: the run is ours if one of our baselines
 * stands in it, and then the edge moves out past it; otherwise the edge
 * moves back to the paper above (or below) it, and the neighbour's half
 * line that used to hang off the crop is gone.
 *
 * Top-down points, like everything the crop is cut in. */
function snapEdges(ink: PageInk, region: MirrorRegion): MirrorRegion {
  if (typeof region.xMin !== 'number' || typeof region.xMax !== 'number') return region
  const lo = Math.max(0, Math.floor(region.xMin))
  const hi = Math.min(ink.cols - 1, Math.ceil(region.xMax))
  const inked = (y: number): boolean => {
    if (y < 0 || y >= ink.rows) return false
    const row = y * ink.cols
    for (let c = lo; c <= hi; c++) if (ink.cells[row + c]) return true
    return false
  }
  const limit = Math.round(GUTTER * 2 * ink.scale)
  const anchors = region.anchors.map((y) => y * ink.scale)
  // Slack is ASYMMETRIC. Below a run: a baseline sits at the foot of its
  // glyphs and some classes report it a descender's depth under them —
  // measured at 2.7pt under a NeurIPS section heading, which a tighter
  // tolerance read as somebody else's ink and cut the heading away. Above
  // a run: a baseline is NEVER above its own line's ink (glyphs always
  // ascend past it), so an anchor over the run's top is the line above
  // claiming the line below — our last baseline 3.6pt over the next
  // paragraph's ink top absorbed its whole first line on ambit p22.
  const tol = Math.max(2, (GUTTER * ink.scale) / 2)
  const topTol = Math.max(2, Math.round(2 * ink.scale))
  const ours = (from: number, to: number): boolean =>
    anchors.some((a) => a >= from - topTol && a <= to + tol)

  let yMin = region.yMin
  let yMax = region.yMax
  const head = Math.round(yMin * ink.scale)
  if (inked(head)) {
    let start = head
    let end = head
    while (start > 0 && end - start < limit && inked(start - 1)) start--
    while (end + 1 < ink.rows && end - start < limit && inked(end + 1)) end++
    yMin = ours(start, end) ? Math.min(yMin, start / ink.scale) : (end + 1) / ink.scale
  }
  const foot = Math.round(yMax * ink.scale) - 1
  if (inked(foot)) {
    let start = foot
    let end = foot
    while (start > 0 && end - start < limit && inked(start - 1)) start--
    while (end + 1 < ink.rows && end - start < limit && inked(end + 1)) end++
    yMax = ours(start, end) ? Math.max(yMax, (end + 1) / ink.scale) : start / ink.scale
  }
  return yMax - yMin > 1 ? { ...region, yMin, yMax } : region
}

/** Trim a page number off a full-page crop's foot: a short, thin run of
 * ink standing alone past a wide blank is the folio, not the text — shown
 * mid-scroll between flowing blocks it reads as a stray "13". Only the
 * LAST run is a candidate, and only when the gap above it is far larger
 * than any leading. */
export function dropFolio(ink: PageInk, region: MirrorRegion): MirrorRegion {
  const lo = Math.max(0, Math.floor(region.xMin ?? 0))
  const hi = Math.min(ink.cols - 1, Math.ceil(region.xMax ?? ink.cols))
  const from = Math.max(0, Math.floor(region.yMin * ink.scale))
  const to = Math.min(ink.rows, Math.ceil(region.yMax * ink.scale))
  const inked = (y: number): boolean => {
    const row = y * ink.cols
    for (let c = lo; c <= hi; c++) if (ink.cells[row + c]) return true
    return false
  }
  // last run of ink and the blank above it
  let last = -1
  for (let y = to - 1; y >= from; y--) if (inked(y)) { last = y; break }
  if (last < 0) return region
  let start = last
  while (start > from && inked(start - 1)) start--
  let blankTop = start
  while (blankTop > from && !inked(blankTop - 1)) blankTop--
  const gap = (start - blankTop) / ink.scale
  const height = (last - start + 1) / ink.scale
  if (gap < 24 || height > 12) return region
  // thin and isolated: measure its width — a folio is a couple of digits
  let inkLo = hi
  let inkHi = lo
  for (let y = start; y <= last; y++) {
    const row = y * ink.cols
    for (let c = lo; c <= hi; c++) if (ink.cells[row + c]) { inkLo = Math.min(inkLo, c); inkHi = Math.max(inkHi, c) }
  }
  if (inkHi - inkLo > 40) return region
  return { ...region, yMax: Math.max(region.yMin, (blankTop + 1) / ink.scale) }
}

/** does this region hold any ink at all? */
function hasInk(ink: PageInk, region: MirrorRegion): boolean {
  const lo = Math.max(0, Math.floor(region.xMin ?? 0))
  const hi = Math.min(ink.cols - 1, Math.ceil(region.xMax ?? ink.cols))
  const from = Math.max(0, Math.floor(region.yMin * ink.scale))
  const to = Math.min(ink.rows, Math.ceil(region.yMax * ink.scale))
  for (let y = from; y < to; y++) {
    const row = y * ink.cols
    for (let c = lo; c <= hi; c++) if (ink.cells[row + c]) return true
  }
  return false
}

/* a page whose ink runs shorter (top to bottom) than this is content-free —
 * measured on thesis.tex: the running header \cleardoublepage leaves on a
 * blank filler page is one line, 7.75pt tall (rows 112-126 at 1.806 device
 * px/pt); the shortest REAL page in that same document (a chapter's last,
 * mostly-empty page) still runs 567pt. Nothing in between was measured, so
 * the threshold sits an order of magnitude above the header and well below
 * any real page — a two-line caption alone would clear it. */
const FILLER_INK_HEIGHT = 40

/** Is this page typeset content-free below (or beside) its running header —
 * the near-blank filler `\cleardoublepage` inserts to force the next chapter
 * onto an odd page? A `\backmatter`/`\appendix` skip still leaves a synctex
 * record on that filler page (the header is set there, and it carries the
 * triggering line's box), which is what lets a page with no real neighbour
 * content masquerade as one — see bibliographyPages. Null ink (nothing
 * decoded, or nothing could be) answers "no" rather than guess, the same
 * conservative default the rest of this file uses when a witness is
 * missing. */
export function isFillerPage(ink: PageInk | null): boolean {
  if (!ink) return false
  const inkedRow = (y: number): boolean => {
    const row = y * ink.cols
    for (let c = 0; c < ink.cols; c++) if (ink.cells[row + c]) return true
    return false
  }
  let top = -1
  for (let y = 0; y < ink.rows; y++) { if (inkedRow(y)) { top = y; break } }
  if (top < 0) return true // no ink at all: also content-free
  let bottom = top
  for (let y = ink.rows - 1; y >= top; y--) { if (inkedRow(y)) { bottom = y; break } }
  return (bottom - top) / ink.scale < FILLER_INK_HEIGHT
}

/** the run of rows, seen through one window, that the block's baselines
 * stand in — the vertical half of the same ink trim cropBand ends with */
function ownRows(
  ink: PageInk,
  window: XBand,
  topPx: number,
  bottomPx: number,
  anchorsPx: number[],
): RowBand | null {
  const from = Math.max(0, Math.min(ink.rows - 1, Math.floor(topPx)))
  const to = Math.max(from + 1, Math.min(ink.rows, Math.ceil(bottomPx)))
  const lo = Math.max(0, Math.floor(window.xMin))
  const hi = Math.min(ink.cols - 1, Math.ceil(window.xMax))
  const rowInk: boolean[] = new Array(to - from).fill(false)
  for (let y = from; y < to; y++) {
    const row = y * ink.cols
    for (let c = lo; c <= hi; c++) {
      if (ink.cells[row + c]) { rowInk[y - from] = true; break }
    }
  }
  const band = mainRowBand(rowInk, Math.round(GUTTER * ink.scale), anchorsPx.map((y) => y - from))
  return band ? { top: band.top + from, bottom: band.bottom + from } : null
}

/** The y-band for a placed segment, bracketed by the records inside ITS
 * window: the line above a paragraph is the one above it in its own column,
 * and now the column is a fact rather than a guess. */
function bandFor(
  ink: PageInk | null,
  onPage: SynctexRecord[],
  placed: Placed,
  range: { from: number; to: number },
  opts: { typed: boolean; chars: number; shownLines: number; hPt: number },
): { region: MirrorRegion; lead: number; width: number } | null {
  const own = placed.window ? inBand(onPage, placed.window, 0) : onPage
  const lead = linePitch(own.map((r) => r.y))
  // without a window (the page's ink could not be read) the crop is the
  // sheet, tightened by the ink trim — the island-preview shape
  const width = placed.window
    ? placed.window.xMax - placed.window.xMin
    : (ink?.wPt ?? opts.hPt) * 0.7
  const region = regionForLines(own, range.from, range.to, {
    pitch: lead,
    page: placed.page,
    hPt: opts.hPt,
    linesOfType: opts.typed,
    // a segment gets only the lines the block has LEFT to show — handing
    // every segment the full budget let a column tail run on into the
    // page's footnotes
    // a fifth of slack on the estimate: textContent undercounts what the
    // engine sets (a \citep key against its typeset authors-and-year), and
    // clipping the last wrapped line of a paragraph is worse than a strip
    // of the gap below it — the below-neighbour still caps the foot
    maxLines: Math.max(1, Math.ceil(textLines(opts.chars, width, lead) * 1.2) - opts.shownLines),
  })
  if (!region) return null
  return {
    region: placed.window ? { ...region, ...placed.window } : region,
    lead,
    width,
  }
}

/** Everything a block's pixels depend on, as one short string.
 *
 * Not just the block's own boxes: what brackets a crop is its NEIGHBOURS'
 * records, and what its window is cut from is the whole page's ink. So the
 * mark is taken over every record of every page the block landed on —
 * coarse (one moved paragraph re-cuts its page) but never wrong, and the
 * page it re-cuts was going to be decoded for that paragraph anyway. */
function keyFor(segments: Segment[], run: Pass, marks: Map<number, string>): string {
  const pages = [...new Set(segments.map((s) => s.page))]
  return `${run.dpi}|` + pages.map((page) => {
    let mark = marks.get(page)
    if (mark === undefined) {
      mark = markOf(run.byPage.get(page) ?? [])
      marks.set(page, mark)
    }
    return `${page}:${mark}`
  }).join('|')
}

function markOf(records: SynctexRecord[]): string {
  let h = 2166136261
  for (const r of records) {
    const s = `${r.line},${r.y},${r.x ?? ''},${r.w ?? ''};`
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
  }
  return `${records.length}.${(h >>> 0).toString(36)}`
}

/* the page ink two pages deep: the pass walks page by page, and a block
 * that spans a page break asks for the one before it again */
const inkCache: Array<{ key: string; ink: PageInk | null }> = []

function inkFor(jobId: string, dpi: number, page: number, bitmap: PageBitmap): PageInk | null {
  const key = `${jobId} ${page} ${dpi}`
  const hit = inkCache.find((e) => e.key === key)
  if (hit) return hit.ink
  const ink = pageInkOf(bitmap)
  inkCache.unshift({ key, ink })
  inkCache.length = Math.min(inkCache.length, 2)
  return ink
}

function clearInkCache(): void {
  inkCache.length = 0
}

function revoke(url: string): void {
  if (url.startsWith('blob:')) URL.revokeObjectURL(url)
}

function revokeAll(parts: Part[]): void {
  for (const p of parts) revoke(p.url)
}

/* shapes that set nothing but lines of text — and the things that, found
 * inside one, mean it sets something taller as well */
/* an abstract and a `center`/`quote` wrap are text too, but they are set to
 * a measure of their OWN — narrower than the column, by however much the
 * class decided — so a line count taken against the column would under-read
 * them and clip. They keep the generous bracket and the ink trim, which the
 * blank space around them makes reliable. */
const TYPE_SHAPES = 'p, h1.dia-sec, h2.dia-sec, h3.dia-sec, h4.dia-sec, h5.dia-sec, ul, ol, dl'
// block-shaped only: an INLINE island (a \looseness=-1, an unknown macro
// mid-sentence) is still a line of type — counting it broke the tight
// prose bracket for essentially every real paragraph
const NOT_TYPE = 'figure, table, img, svg, pre, div.dia-math, div.dia-tex-island, .dia-graphic-slot'

/** does this block set lines of type and nothing else? The crop math needs
 * to know how far a block's ink reaches above its first baseline, and
 * synctex cannot say — but the markup can. */
export function linesOfType(block: HTMLElement): boolean {
  if (!block.matches(TYPE_SHAPES)) return false
  return block.querySelector(NOT_TYPE) === null
}

/** Roughly how many typeset lines this much text needs at this measure.
 *
 * A crude estimate on purpose — it is a CEILING on how far a block's crop
 * may reach, not a layout. Without it a one-line heading whose next record
 * is a paragraph away claims every line in between, because nothing in
 * synctex says a heading is one line tall. */
export function textLines(chars: number, columnPt: number, lead: number): number {
  if (!(columnPt > 0) || !(lead > 0)) return 1
  const perLine = Math.max(20, columnPt / (GLYPH * (lead / 1.2)))
  return Math.max(1, Math.ceil((chars * LINE_SLACK) / perLine))
}

/** a block the user is typing in right now */
function isOpenForEdit(block: HTMLElement): boolean {
  return block.hasAttribute('contenteditable') || block.querySelector('[contenteditable]') !== null
}

/** the highest page any content strictly before this block's source lines
 * reached — the `prev` half of bibliographyPages' own scan, pulled out so a
 * caller can decode THAT page's ink and ask isFillerPage about it before
 * bibliographyPages decides the full range, without running the scan twice. */
export function bibliographyPrevPage(records: SynctexRecord[], range: { from: number; to: number }): number {
  let prev = 0
  for (const r of records) if (r.line < range.from) prev = Math.max(prev, r.page)
  return prev
}

/** The pages a \bibliography command typeset: from the page its preceding
 * line last touched through the page before the following content resumes.
 * Nothing else can say — the entries' boxes carry the .bbl FILE's synctex
 * tag, which the daemon rightly filters out. Exported for tests.
 *
 * `prevIsFiller` says the `prev` page itself is a content-free filler (see
 * isFillerPage) — which a `\cleardoublepage` leaves behind with nothing on
 * it but a running header, and that header still carries the triggering
 * line's synctex record, so `prev` can land there with no real neighbour
 * content at all (measured: thesis.tex's `\backmatter`, forced by `twoside`,
 * does this to page 14). When it does, the naive `next` boundary is usually
 * the SAME kind of artifact seen from the other side: whatever forces the
 * next block onto its own fresh page (thesis.tex's `\chapter` after
 * `\appendix`) leaves a closing box at the FOOT of the page the bibliography
 * itself is typeset on (measured: page 15, the references' own page) —
 * indistinguishable from real content by page number alone. Trusting it as
 * a hard boundary crops the filler page and misses the references entirely,
 * so a filler `prev` widens a degenerate one-page range by one more page,
 * pulling in whatever is actually typeset right after the filler. Wrong
 * when it turns out nothing real is there, but hasInk() (cutBlock) drops an
 * empty page from the crop for free either way, so widening can never cut
 * into a neighbour's content it shouldn't. */
export function bibliographyPages(
  records: SynctexRecord[],
  range: { from: number; to: number },
  prevIsFiller = false,
): number[] {
  const prev = bibliographyPrevPage(records, range)
  if (prev === 0) return []
  let next = Infinity
  for (const r of records) if (r.line > range.to) next = Math.min(next, r.page)
  if (next === Infinity) next = prev + 9 // refs at the end of the document
  if (prevIsFiller && next === prev + 1) next = prev + 2
  // references may START on the page the body ends on and the next section
  // may start on the page they end on — the shared pages are still theirs
  // (the crop clips to what stands between the neighbours' records)
  const pages: number[] = []
  for (let p = prev; (p < next || p === prev) && pages.length < 8; p++) pages.push(p)
  return pages
}

/** A source slice that typesets NOTHING of its own — page breaks, layout
 * switches, counters. Shown as raw mono between compiled crops it reads as
 * a defect; hidden, nothing the reader could miss is lost. */
const LAYOUT_ONLY = /^(?:\s|%[^\n]*|\\(?:clearpage|cleardoublepage|newpage|appendix|onecolumn|twocolumn|noindent|bigskip|medskip|smallskip|par)\b|\\(?:pagenumbering|bibliographystyle|label|vspace\*?|hspace\*?|setcounter\{[^}]*\})\{[^}]*\})+$/
export function isLayoutOnlySlice(slice: string): boolean {
  return LAYOUT_ONLY.test(slice.trim())
}

/* a slice holding nothing but a \section/\subsection/\subsubsection command
 * (starred or not) and — the everyday pairing — the \label right after it */
const SECTION_MARKER = /^\\(?:sub)*section\*?\{(?:[^{}]|\{[^{}]*\})*\}\s*(?:\\label\{[^}]*\}\s*)?$/

/** Does this slice hold nothing but a \section/\subsection whose CLASS says
 * it inks no slide — beamer's own, which feeds only the navigation bar and
 * \tableofcontents (measured: zero synctex records for any of beamer.tex's
 * three)? The command name alone cannot say this: an article's or book's
 * \section very much sets a real heading, so setsNoType/isLayoutOnlySlice
 * (which read the slice text only) correctly leave it visible — the
 * document class is the one input neither of them has. */
export function isInklessSectionMarker(slice: string, docclass: string | undefined): boolean {
  return docclass === 'beamer' && SECTION_MARKER.test(slice.trim())
}

interface Cut {
  block: HTMLElement
  segments: Segment[]
  range: { from: number; to: number }
  key: string
  /** a \bibliography block: crop these whole pages instead of segments —
   * the .bbl's boxes carry another synctex tag, so the reference pages hold
   * no records for OUR lines and the section would otherwise vanish */
  fullPages?: number[]
}

/** The order to cut in: pages ranked by how close their nearest block is to
 * what the reader is looking at, and every block of a page cut while that
 * page is decoded. Priority alone would thrash the bitmap cache — the block
 * beside you and the one after it can be pages apart in a document with
 * floats — and page order alone would leave the reader staring at HTML
 * while page 1 of 40 renders. */
export function cutOrder(cuts: Cut[]): Cut[] {
  // a bibliography cut carries no segments; its pages rank by its first
  const firstPage = (c: Cut): number => c.segments[0]?.page ?? c.fullPages?.[0] ?? 0
  const rank = new Map<number, number>()
  cuts.forEach((cut, i) => {
    const page = firstPage(cut)
    const d = viewportDistance(cut.block, i)
    const held = rank.get(page)
    if (held === undefined || d < held) rank.set(page, d)
  })
  const pages = [...rank.keys()].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0))
  const order = new Map(pages.map((p, i) => [p, i]))
  return [...cuts].sort((a, b) =>
    (order.get(firstPage(a)) ?? 0) - (order.get(firstPage(b)) ?? 0))
}

/** how far a block is from the middle of the viewport; without a layout
 * engine (tests, a hidden view) flow order is the best guess there is */
function viewportDistance(block: HTMLElement, index: number): number {
  if (typeof window === 'undefined' || !window.innerHeight) return index
  try {
    const r = block.getBoundingClientRect()
    if (r.height > 0) return Math.abs(r.top + r.height / 2 - window.innerHeight / 2)
  } catch { /* no layout engine */ }
  return index
}

export async function fetchSynctex(jobId: string): Promise<SynctexRecord[]> {
  let res: Response
  try {
    res = await fetch(`${SERVICE_BASE}/compile/${encodeURIComponent(jobId)}/synctex`)
  } catch {
    return []
  }
  if (!res.ok) return []
  let raw: unknown
  try {
    raw = await res.json()
  } catch {
    return []
  }
  const lines = (raw as { lines?: unknown } | null)?.lines
  if (!Array.isArray(lines)) return []
  return lines.map(normalizeRecord).filter((r): r is SynctexRecord => r !== null)
}

export function normalizeRecord(raw: unknown): SynctexRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.line !== 'number' || typeof r.page !== 'number' || typeof r.y !== 'number') return null
  if (!Number.isFinite(r.line) || !Number.isFinite(r.page) || !Number.isFinite(r.y)) return null
  const out: SynctexRecord = { line: Math.trunc(r.line), page: Math.trunc(r.page), y: r.y }
  // x/w arrive only from daemons that report them; an older one simply
  // leaves the crop full width
  if (typeof r.x === 'number' && Number.isFinite(r.x)) out.x = r.x
  if (typeof r.w === 'number' && Number.isFinite(r.w) && r.w > 0) out.w = r.w
  return out
}

/* ---------- rasterizing the band ---------- */

/** Crop the page to the band, then shrink to the block's own ink inside it.
 *
 * The vertical trim is what makes a bracketed region presentable: the band
 * is deliberately generous (baselines, not boxes) and what it over-reaches
 * into is either paper or the neighbours' text. A band with no ink at all
 * returns null — better no crop than a blank rectangle claiming to be a
 * paragraph.
 *
 * Horizontally there are two rules. With an x window (a column) the crop
 * takes it exactly: every block in that column is then cut to the same width
 * and displayed at the same scale, which is the whole point of a mirror.
 * Without one — an older daemon, no x in the records — the sheet is the
 * window and the ink trim tightens it, which is what island previews always
 * did. */
export function cropBand(
  bitmap: PageBitmap,
  region: MirrorRegion,
  shown?: { yMin: number; yMax: number },
): HTMLCanvasElement | null {
  const h = bitmap.image.height
  const w = bitmap.image.width
  const top = Math.max(0, Math.min(h - 1, Math.round(region.yMin * bitmap.scale)))
  const bottom = Math.max(top + 1, Math.min(h, Math.round(region.yMax * bitmap.scale)))
  // report what the crop finally showed — the ink trim below narrows it
  const report = (yPx: number, hPx: number): void => {
    if (!shown) return
    shown.yMin = (top + yPx) / bitmap.scale
    shown.yMax = (top + yPx + hPx) / bitmap.scale
  }
  report(0, bottom - top)
  const window = typeof region.xMin === 'number' && typeof region.xMax === 'number'
    ? { xMin: region.xMin, xMax: region.xMax }
    : null
  const left = window ? Math.max(0, Math.min(w - 1, Math.round(window.xMin * bitmap.scale))) : 0
  const right = window
    ? Math.max(left + 1, Math.min(w, Math.round(window.xMax * bitmap.scale)))
    : w

  const band = document.createElement('canvas')
  band.width = right - left
  band.height = bottom - top
  const ctx = band.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(bitmap.image, left, top, band.width, band.height, 0, 0, band.width, band.height)

  // every edge already exact: there is nothing for a pixel scan to decide,
  // and skipping it is what keeps a whole-document pass affordable — this
  // is the common case, because most blocks are prose
  if (window !== null && region.keepTop && region.keepBottom) return band

  const anchors = region.anchors.map((y) => (y - region.yMin) * bitmap.scale)
  const box = inkBox(ctx, band.width, band.height, anchors, bitmap.scale, {
    keepWidth: window !== null,
    keepTop: region.keepTop === true,
    keepBottom: region.keepBottom === true,
  })
  if (!box) return null
  report(box.y, box.h)
  if (box.x === 0 && box.y === 0 && box.w === band.width && box.h === band.height) return band

  const out = document.createElement('canvas')
  out.width = box.w
  out.height = box.h
  const octx = out.getContext('2d')
  if (!octx) return band
  octx.drawImage(band, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h)
  return out
}

interface Box { x: number; y: number; w: number; h: number }

export interface RowBand { top: number; bottom: number }

/** Which rows of a band belong to the block, given where its baselines fell.
 *
 * Rows of ink separated by less than `gutter` are one thing (a chart and
 * its axis labels, a figure and its caption); a wider gap means a different
 * thing. The block owns the run its baselines land in — that is what makes
 * this better than "trim the whitespace": a band that over-reaches into the
 * paragraph above keeps the paragraph's ink, and only the anchors know it
 * is not ours. With no anchors to go on, the tallest run wins. */
export function mainRowBand(rowInk: boolean[], gutter: number, anchors: number[]): RowBand | null {
  const runs: RowBand[] = []
  for (let y = 0; y < rowInk.length; y++) {
    if (!rowInk[y]) continue
    const last = runs[runs.length - 1]
    if (last && y - last.bottom <= gutter) last.bottom = y
    else runs.push({ top: y, bottom: y })
  }
  if (runs.length === 0) return null

  // Slack is ASYMMETRIC. Below a run, a baseline may hang well off the
  // ink it belongs to: an \includegraphics baseline hangs the box depth
  // below the picture — measured 5.4pt under the llama.tex loss curves,
  // against half a gutter (5pt) of allowance, which cropped the figure to
  // its caption. A full gutter of slack still cannot reach the next block:
  // anything nearer than a gutter is the same run by construction. ABOVE a
  // run a baseline never stands — glyphs always ascend past it — so the
  // top side gets only measurement noise, or the line above claims the
  // line below.
  const tol = Math.max(2, gutter)
  const topTol = Math.max(2, Math.round(gutter / 5))
  const hit = runs.filter((r) => anchors.some((a) => a >= r.top - topTol && a <= r.bottom + tol))
  if (hit.length > 0) return { top: hit[0].top, bottom: hit[hit.length - 1].bottom }

  let best = runs[0]
  for (const r of runs) if (r.bottom - r.top > best.bottom - best.top) best = r
  return best
}

function inkBox(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  anchors: number[],
  scale: number,
  keep: { keepWidth: boolean; keepTop: boolean; keepBottom: boolean },
): Box | null {
  let data: Uint8ClampedArray
  try {
    data = ctx.getImageData(0, 0, w, h).data
  } catch {
    return { x: 0, y: 0, w, h } // tainted canvas: keep the untrimmed band
  }
  // the paper colour, read off the band's own corner
  const pr = data[0], pg = data[1], pb = data[2]
  const inked = (i: number): boolean =>
    Math.abs(data[i] - pr) + Math.abs(data[i + 1] - pg) + Math.abs(data[i + 2] - pb) > INK

  const rowInk: boolean[] = new Array(h).fill(false)
  for (let y = 0; y < h; y++) {
    const row = y * w * 4
    for (let x = 0; x < w; x++) {
      if (inked(row + x * 4)) { rowInk[y] = true; break }
    }
  }
  const rows = mainRowBand(rowInk, Math.round(GUTTER * scale), anchors)
  if (!rows) return null
  // an edge cut between two baselines is exact; the trim may only pull in
  // the edges that were guesses
  const padPx = Math.round(TRIM_PAD * scale)
  const y = keep.keepTop ? 0 : Math.max(0, rows.top - padPx)
  const foot = keep.keepBottom ? h : Math.min(h, rows.bottom + padPx + 1)
  const height = foot - y
  if (keep.keepWidth) return { x: 0, y, w, h: height }

  let minX = w, maxX = -1
  for (let yy = rows.top; yy <= rows.bottom; yy++) {
    const row = yy * w * 4
    for (let x = 0; x < minX; x++) if (inked(row + x * 4)) { minX = x; break }
    for (let x = w - 1; x > maxX; x--) if (inked(row + x * 4)) { maxX = x; break }
  }
  if (maxX < 0) return null

  const x = Math.max(0, minX - padPx)
  return { x, y, w: Math.min(w, maxX + padPx + 1) - x, h: height }
}

function canvasUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob !== 'function') { resolve(canvas.toDataURL('image/png')); return }
    canvas.toBlob((blob) => {
      resolve(blob ? URL.createObjectURL(blob) : canvas.toDataURL('image/png'))
    }, 'image/png')
  })
}
