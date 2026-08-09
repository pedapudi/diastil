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
 *    from a daemon that predates the endpoints, a daemon too old to report
 *    boxes, a compile that failed — the crops simply do not appear and the
 *    document renders as HTML, which is what it did before this file
 *    existed.
 *
 * WHERE THE RECTANGLES COME FROM. The engine computed them. TeX knows the
 * page, the position, the width, the height and the depth of every box it
 * set, and synctex writes all of it down; `parse_synctex`'s `boxes` carries
 * it over the wire, with the source lines whose material stands in each box
 * and the index of the box that encloses it. A block's crop is therefore
 * the UNION of the boxes its own source lines' material stands in — exact,
 * from the engine, in one pass over a list.
 *
 * This file used to be 2396 lines because it was handed one POINT per
 * source line and had to reconstruct rectangles from it. The horizontal
 * window came from decoding the page bitmap and projecting its ink onto x
 * to find the columns; the vertical extent came from line-pitch statistics
 * and a family of constants (ASCENT, DESCENT, GLYPH, PAD, TIGHT_PITCHES,
 * UNDER_PREV, OVER_NEXT); phantom-record filtering, wrapper-box filtering,
 * asymmetric snap tolerances and a page-number trimmer cleaned up after
 * both. Every one of those earned its place against a real failure and
 * every one of them is gone, because the failures were all the same
 * failure: the daemon was throwing the answer away. The ink projection was
 * always better suited to being the TEST ORACLE than the production
 * machinery, and that is where it lives now — see blockmirror.fixture.
 * test.ts, which asserts that a crop holds all of its block's ink and none
 * of a neighbour's.
 *
 * FOUR THINGS THE RECTANGLES ALONE DO NOT SETTLE, each of them answered
 * with more of the engine's own evidence rather than with a threshold:
 * which block a box that spans two of them belongs to (boxOwns), when a
 * box of ours is a FRAME around somebody else's work (withoutFrames), when
 * a crop may not span the line between two of ours (splitAtIntruders), and
 * how much room the enclosing box actually gave a scaled picture
 * (cropsFor's clip). Every one is argued where it stands, against the
 * paper that forced it.
 *
 * And one thing synctex simply cannot say: which SOURCE a page belongs to
 * when the engine typeset it from another file entirely — a `.bbl`'s
 * entries carry the bibliography file's own tag and its own line numbers,
 * which name nothing in main.tex. Those blocks (and a beamer frame, whose
 * page IS the block) crop whole pages instead. That path is the one place
 * a page's own geometry still has to be reasoned about rather than read
 * off a block's boxes — and it reasons about it from the boxes too:
 * pageExtent and isFillerPage read the page's typeset extent off what the
 * engine credited there, which is why the pixel scan that used to trim a
 * page NUMBER off the foot of such a crop is gone. A folio leaves no box
 * behind at all. */

import type { Doc } from '../model/doc'
import { setsNoType } from '../latex/parse'
import { state } from '../state'
import { SERVICE_BASE } from '../service/client'
import { autoCompileOn, lastCompileJobId, onCompileState, texAvailable } from '../editor/doccompile'
import { docEditableFor, isEditingText, startEdit } from '../editor/textedit'
import { clearPageCache, getPageBitmap, pagesInfo, Y_TOP_DOWN, type PageBitmap } from './pdfpages'

/** one synctex point record: a source line, the page it landed on, the y of
 * its baseline and (from daemons that report them) the x of its left edge
 * and the width of its box — all in points, per the map's declared
 * semantics. This is the SCROLL TARGET map, and the PDF panel is what still
 * wants it; the mirror reads `boxes` instead. */
export interface SynctexRecord {
  line: number
  page: number
  y: number
  x?: number
  w?: number
}

/** one box the engine set, as the daemon reports it.
 *
 * `x, y` is TeX's reference point and `w, h, d` the box's width, height and
 * depth, so the box covers `x .. x+w` across and `y-h .. y+d` down the page
 * — the daemon says so out loud in `boxSemantics`, and verifies it against
 * a real compile rather than inferring it.
 *
 * `src` is every `[tag, line]` whose material stands DIRECTLY in this box:
 * `tag` names the input file (main.tex's is `mainTag`), `line` the source
 * line in it. A box that merely frames other boxes reports none.
 *
 * `parent` indexes back into the same array (-1 at a page's outermost box).
 * Containment is what tells a `\item` label — which hangs to the LEFT of
 * the line box it belongs to — from a second column. */
export interface SynctexBox {
  page: number
  x: number
  y: number
  w: number
  h: number
  d: number
  src: Array<[number, number]>
  parent: number
}

/** a rectangle on a page, in points from the paper's top-left */
export interface Rect {
  xMin: number
  xMax: number
  yMin: number
  yMax: number
}

/* Paper kept around a crop, in points.
 *
 * A glyph's outline overshoots the metric box TeX measured it by: llama.
 * tex's paragraph on source lines 163-165 unions to y[343.61, 489.52], and
 * pdftoppm at 150dpi puts that paragraph's ink at y[343.20, 487.68] — 0.41
 * pt of ascender above the box. Two points covers that and the half-pixel
 * the rasterizer rounds by, and is small enough that consecutive crops
 * still read as consecutive paragraphs rather than as cards. */
const CROP_PAD = 2

/* The widest horizontal GAP between two of a block's boxes that still
 * leaves them in one column, in points. Negative: they have to actually
 * OVERLAP, by a point, before the columns alone say they belong together.
 * Boxes that merely touch are left to containment to join — a `\item`
 * label ends where its line box begins, and it is that line's child in the
 * engine's tree, which says so far better than a shared edge would. Real
 * columns are nowhere near either bar: an ACL page leaves 17pt of gutter. */
const COLUMN_GAP = -1

const MIRROR_TITLE = 'the compiled render — double-click to edit this block'

/* ---------- the crop math (pure) ---------- */

/** the rectangle a box covers, in points down and right from the paper's
 * top-left — the `boxSemantics` contract, in one place */
export function rectOf(box: SynctexBox): Rect {
  return { xMin: box.x, xMax: box.x + box.w, yMin: box.y - box.h, yMax: box.y + box.d }
}

/** Whose box is this — does the material in it BEGIN in source lines
 * [from, to] of `tag`?
 *
 * Where it begins, not merely whether it touches: a box is credited with
 * every source line whose material stands in it, and a line box that runs
 * on from an earlier block belongs to that block. llama.tex's `itemize` on
 * lines 327-333 is the case: the paragraph before it ends "…on a total of
 * 20 benchmarks:" and TeX broke that paragraph at `\begin{itemize}`, so the
 * line box holding it is credited to source line 325 AND to 327 — and
 * "touches" put the previous paragraph's last line at the top of the list's
 * picture. The lowest credited line is where the box's material starts, and
 * that is the block whose picture it is. */
export function boxOwns(box: SynctexBox, tag: number | null, from: number, to: number): boolean {
  let first = Infinity
  for (const [t, line] of box.src) {
    if (tag === null || t === tag) first = Math.min(first, line)
  }
  return first >= from && first <= to
}

function union(a: Rect, b: Rect): Rect {
  return {
    xMin: Math.min(a.xMin, b.xMin),
    xMax: Math.max(a.xMax, b.xMax),
    yMin: Math.min(a.yMin, b.yMin),
    yMax: Math.max(a.yMax, b.yMax),
  }
}

/** Group a block's boxes into the crops it needs one picture each for.
 *
 * By page first, then by what the engine says belongs together. Two boxes
 * on one page are one crop when their COLUMNS overlap — text flows down a
 * column, so the only thing that ever splits a block on one page is a
 * column break — or when one CONTAINS the other, which is the case columns
 * alone get wrong: a `\item` label hangs to the left of the line box it
 * belongs to (measured on llama.tex p26: the bullet at x[101.5, 117.9], its
 * item's text at x[122.9, 493.8]) and was cropped as a column of bullets
 * until containment had a say.
 *
 * Then two things the boxes' own rectangles do not settle:
 *
 *  - a crop may not SPAN another block's line. A `\footnote` in llama.tex's
 *    abstract sets its text at the foot of the same column — one crop from
 *    the abstract's first line (y 216) to the footnote (y 776) would have
 *    shown the introduction and two paragraphs of section 1 in between. The
 *    engine says what is in between, so the run is cut there and the
 *    footnote becomes the block's second picture, which is what it is.
 *  - a crop is CLIPPED to the box that encloses it. `\includegraphics`
 *    scales its picture by wrapping the natural-size box in a zero-width
 *    one, and synctex reports the box UNSCALED: llama.tex's loss curves
 *    report x[307.29, 711.09] on a 595pt page, inside a container 219pt
 *    wide. The enclosing box is the engine's own statement of how much
 *    room the thing was given.
 *
 * `all` is the whole box list, because `parent` indexes into it; `mine` are
 * the indices this block owns; `others` are the credited boxes on each page
 * that belong to somebody else. Returns one rectangle per crop, in reading
 * order (page, then left to right). */
export function cropsFor(
  all: SynctexBox[],
  claimed: number[],
  others: (page: number) => number[] = () => [],
): Array<Rect & { page: number }> {
  const mine = withoutFrames(all, claimed, others)
  const owned = new Set(mine)
  // union-find over the block's own boxes
  const parentOf = new Map<number, number>()
  const find = (i: number): number => {
    let r = i
    while (parentOf.get(r) !== undefined && parentOf.get(r) !== r) r = parentOf.get(r) as number
    return r
  }
  const join = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parentOf.set(ra, rb)
  }
  for (const i of mine) parentOf.set(i, i)

  // containment: an ancestor of mine that is also mine is the same crop
  for (const i of mine) {
    let up = all[i].parent
    while (up >= 0) {
      if (owned.has(up)) { join(i, up); break }
      up = all[up].parent
    }
  }
  // and columns, transitively — sort by left edge so one sweep suffices
  const byPage = new Map<number, number[]>()
  for (const i of mine) {
    const held = byPage.get(all[i].page)
    if (held) held.push(i)
    else byPage.set(all[i].page, [i])
  }
  for (const [, idxs] of byPage) {
    idxs.sort((a, b) => all[a].x - all[b].x)
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        const ra = rectOf(all[idxs[a]])
        const rb = rectOf(all[idxs[b]])
        if (rb.xMin - ra.xMax > COLUMN_GAP) break // sorted: no later box reaches back
        join(idxs[a], idxs[b])
      }
    }
  }

  const groups = new Map<number, number[]>()
  for (const i of mine) {
    const key = find(i)
    const held = groups.get(key)
    if (held) held.push(i)
    else groups.set(key, [i])
  }

  const out: Array<Rect & { page: number }> = []
  for (const members of groups.values()) {
    const page = all[members[0]].page
    let span: Rect | null = null
    for (const i of members) span = span === null ? rectOf(all[i]) : union(span, rectOf(all[i]))
    if (span === null) continue
    for (const run of splitAtIntruders(all, members, span, others(page).map((j) => all[j]))) {
      let rect: Rect | null = null
      for (const i of run) rect = rect === null ? rectOf(all[i]) : union(rect, rectOf(all[i]))
      if (rect === null) continue
      const frame = enclosing(all, run)
      out.push({ page, ...(frame ? clip(rect, frame) : rect) })
    }
  }
  return out.sort((a, b) => a.page - b.page || a.xMin - b.xMin || a.yMin - b.yMin)
}

/* how far a box may sit outside a gap and still be counted as standing in
 * it, in points. Half a point: an intruder either sits between two of our
 * lines or it does not, and the only slack wanted is against the hundredth
 * of a point the daemon rounds to. */
const INTRUDER_TOL = 0.5

/** Drop the boxes of ours that are FRAMES around somebody else's work.
 *
 * The daemon already refuses to credit a box whose tree descendants speak
 * for other lines. Geometry catches the rest: `framed.sty` draws its rules
 * as one flat box with nothing nested inside it, and every one of them on
 * llama.tex page 19 is credited to the `\end{framed}` of the LAST framed
 * environment on the page as well as to its own — so the appendix's last
 * dialogue box claimed a 175pt rectangle around the first one's, and its
 * crop ran the length of the page. A box that holds another block's
 * typeset material, whole, is that block's frame and not our ink. Never
 * the last box we have: with nothing left the block would show nothing at
 * all, which is a worse answer than a generous crop. */
function withoutFrames(
  all: SynctexBox[],
  mine: number[],
  others: (page: number) => number[],
): number[] {
  const kept = mine.filter((i) => {
    const r = rectOf(all[i])
    return !others(all[i].page).some((j) => {
      // a box NESTED in ours is our own line's inner work, whatever line it
      // is credited to — a `$…$` inside a paragraph's line box is credited
      // to the source line the formula was typed on, and counting it as an
      // intruder threw that whole line away
      if (encloses(all, i, j)) return false
      const o = rectOf(all[j])
      if (o.xMin < r.xMin - INTRUDER_TOL || o.xMax > r.xMax + INTRUDER_TOL) return false
      return o.yMin >= r.yMin - INTRUDER_TOL && o.yMax <= r.yMax + INTRUDER_TOL
    })
  })
  return kept.length > 0 ? kept : mine
}

/** is box `outer` an ancestor of box `inner` in the engine's own tree? */
export function encloses(all: SynctexBox[], outer: number, inner: number): boolean {
  for (let up = all[inner].parent; up >= 0; up = all[up].parent) if (up === outer) return true
  return false
}

/** cut a group's boxes into runs wherever somebody else's box stands
 * between two of them, in the columns this group occupies */
function splitAtIntruders(
  all: SynctexBox[],
  members: number[],
  span: Rect,
  others: SynctexBox[],
): number[][] {
  const near = others.filter((box) => {
    const r = rectOf(box)
    return Math.min(r.xMax, span.xMax) - Math.max(r.xMin, span.xMin) > 0
  })
  if (near.length === 0) return [members]
  const sorted = [...members].sort((a, b) => rectOf(all[a]).yMin - rectOf(all[b]).yMin)
  const runs: number[][] = []
  let run: number[] = []
  let foot = -Infinity
  for (const i of sorted) {
    const r = rectOf(all[i])
    const intruded = run.length > 0 && near.some((box) => {
      const o = rectOf(box)
      return o.yMin >= foot - INTRUDER_TOL && o.yMax <= r.yMin + INTRUDER_TOL
    })
    if (intruded) { runs.push(run); run = [] }
    run.push(i)
    foot = Math.max(foot, r.yMax)
  }
  if (run.length > 0) runs.push(run)
  return runs
}

/** The box that encloses a whole crop: the lowest common ancestor of its
 * members, or that ancestor's own parent when the ancestor is one of them —
 * a `\item` label hangs outside the line box it belongs to, so the line box
 * cannot be the frame its own crop is clipped to. Zero-extent ancestors are
 * skipped: `\includegraphics` builds its scaling out of them. */
function enclosing(all: SynctexBox[], members: number[]): Rect | null {
  const depth = (i: number): number => {
    let n = 0
    for (let up = all[i].parent; up >= 0; up = all[up].parent) n++
    return n
  }
  let lca = members[0]
  for (const i of members.slice(1)) {
    let a = lca
    let b = i
    let da = depth(a)
    let db = depth(b)
    while (da > db) { a = all[a].parent; da-- }
    while (db > da) { b = all[b].parent; db-- }
    while (a !== b && a >= 0 && b >= 0) { a = all[a].parent; b = all[b].parent }
    if (a < 0 || b < 0) return null
    lca = a
  }
  let frame = members.includes(lca) ? all[lca].parent : lca
  while (frame >= 0 && !(all[frame].w > 0 && all[frame].h + all[frame].d > 0)) frame = all[frame].parent
  return frame >= 0 ? rectOf(all[frame]) : null
}

function clip(rect: Rect, frame: Rect): Rect {
  const out = {
    xMin: Math.max(rect.xMin, frame.xMin),
    xMax: Math.min(rect.xMax, frame.xMax),
    yMin: Math.max(rect.yMin, frame.yMin),
    yMax: Math.min(rect.yMax, frame.yMax),
  }
  // a frame that does not overlap what it supposedly holds says nothing —
  // keep the boxes' own answer rather than a rectangle of nothing
  return out.xMax > out.xMin && out.yMax > out.yMin ? out : rect
}

/** the union of every box the engine credited on one page — the page's own
 * typeset extent, which is what a WHOLE-PAGE crop wants.
 *
 * Not the paper, and not the ink either: the running head is in (it is a
 * box like any other) and the folio is out, because a page number is
 * painted by the output routine and leaves no box behind at all (measured:
 * neither thesis.tex nor llama.tex reports a single box below its text
 * block, on any page). Trimming the page number off a page crop used to
 * take a pixel scan looking for a short isolated run past a wide blank;
 * there is nothing left to trim. */
export function pageExtent(boxes: SynctexBox[]): Rect | null {
  let out: Rect | null = null
  for (const box of boxes) {
    if (box.src.length === 0) continue
    out = out === null ? rectOf(box) : union(out, rectOf(box))
  }
  return out
}

/* A page whose typeset boxes run shorter, top to bottom, than this holds no
 * content — measured on thesis.tex: the running header a `\cleardoublepage`
 * leaves on a blank filler page is one box 7.6pt tall (y[62.9, 70.5]), and
 * the shortest REAL page in that same document runs 570pt (y[162.2,
 * 732.1]). Nothing in between was measured, so the threshold sits an order
 * of magnitude above the header and well below any real page. */
const FILLER_HEIGHT = 40

/** Is this page typeset content-free below (or beside) its running header —
 * the near-blank filler `\cleardoublepage` inserts to force the next chapter
 * onto an odd page? A `\backmatter`/`\appendix` skip still leaves a box on
 * that filler page (the header is set there, and it carries the triggering
 * line's attribution), which is what lets a page with no real content
 * masquerade as one — see bibliographyPages. */
export function isFillerPage(boxes: SynctexBox[]): boolean {
  const extent = pageExtent(boxes)
  return extent === null || extent.yMax - extent.yMin < FILLER_HEIGHT
}

/** Restate a rectangle in points down from the page top. The daemon
 * declares its convention (`ySemantics`); anything that is not top-down is
 * mirrored through the page height, which also swaps the two edges. x is
 * untouched — every convention measures it rightward from the left paper
 * edge. Nothing any engine in ENGINES writes needs this, which is exactly
 * why it stays: an untested guess about an axis silently mirrors every
 * crop, and the daemon saying which axis it used costs one string. */
export function toTopDown<T extends Rect>(rect: T, hPt: number, ySemantics: string): T {
  if (ySemantics === Y_TOP_DOWN || !hPt) return rect
  return { ...rect, yMin: hPt - rect.yMax, yMax: hPt - rect.yMin }
}

/** pad a crop and clip it to the paper */
export function padded(rect: Rect, wPt: number, hPt: number): Rect {
  return {
    xMin: Math.max(0, rect.xMin - CROP_PAD),
    xMax: Math.min(wPt || rect.xMax + CROP_PAD, rect.xMax + CROP_PAD),
    yMin: Math.max(0, rect.yMin - CROP_PAD),
    yMax: Math.min(hPt || rect.yMax + CROP_PAD, rect.yMax + CROP_PAD),
  }
}

/* ---------- targets ---------- */

/** every top-level block worth mirroring: all of them, in flow order, minus
 * the derived header (not source-backed — its edits are preamble edits) and
 * the markers the layout hides anyway. A block with no boxes of its own is
 * dropped later, by the pass, because only synctex knows that. */
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
  /** one url per crop, in reading order */
  urls: string[]
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
 * two-column paper stays that width instead of being blown up to fill. The
 * measure is known before the pass starts now (the daemon reports every
 * page's text block), so a crop is never re-scaled after it hangs — which
 * is what the widths this used to carry were for. */
export function attachMirror(
  doc: Doc,
  block: HTMLElement,
  parts: Array<{ url: string; widthPct?: number }>,
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

  // one image per (page, column) crop: a paragraph that ran off the foot
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
    key: opts.key ?? '',
  })
  return wrap
}

/** a crop's share of the document's measure, as a percentage */
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

interface Part { url: string; widthPt: number }

/** one crop already cut this pass — kept so the measured gap between two
 * blocks can be read off the page they were cut from */
export interface Claim extends Rect {
  page: number
  /** this crop is the whole page's typeset extent, not one block's boxes —
   * a beamer slide, or a bibliography set from another input file. It
   * holds every block that shares the page, by design. */
  whole?: true
}

/** what every cut of one pass shares */
export interface Pass {
  jobId: string
  dpi: number
  ySemantics: string
  /** every box the compile reported, in the daemon's order (so `parent`
   * indexes into it) */
  boxes: SynctexBox[]
  /** the tag of main.tex — the only input whose line numbers the editor's
   * source can be keyed by. Null when the daemon could not name it, and
   * then any tag's lines are taken, which is what a single-file document
   * has always effectively done. */
  mainTag: number | null
  /** page sizes in points, from the PDF (synctex records no paper size) */
  dims: Map<number, { wPt: number; hPt: number }>
  /** the widest text block any page holds, in points — the one measure
   * every crop in the document is divided by */
  measure: number
  /** how a placed crop is turned into pixels — a real bitmap in the
   * browser, nothing at all in a fixture replay */
  pages: PageSource
  /** is this still the pass the document is waiting for? */
  live: () => boolean
}

/** rebuild every crop from a finished job's artifacts */
export async function refreshMirrors(jobId: string): Promise<void> {
  const doc = state.doc
  if (!doc || !enabled) return
  const mine = ++pass

  const map = await fetchBoxes(jobId)
  // no boxes is a daemon that predates them (or a compile synctex knows
  // nothing about): the document stays HTML, exactly as it did before this
  // file existed. Never a marker on every block.
  if (map.boxes.length === 0 || mine !== pass || state.doc !== doc) return
  const info = await pagesInfo(jobId)
  if (mine !== pass || state.doc !== doc) return
  shownJob = jobId

  const dims = new Map((info?.pages ?? []).map((p) => [p.n, { wPt: p.wPt, hPt: p.hPt }]))
  const dpi = mirrorDpi()
  const run: Pass = {
    jobId,
    dpi,
    ySemantics: info?.ySemantics ?? Y_TOP_DOWN,
    boxes: map.boxes,
    mainTag: map.mainTag,
    dims,
    measure: map.measure,
    pages: makeLivePageSource(jobId, dpi),
    live: () => mine === pass && state.doc === doc,
  }
  await cutDocument(doc, run)
}

/* the source a beamer frame block starts with, whatever markup a parser
 * wraps it in (a dia-tex-island today; sniffed on the SOURCE rather than a
 * class so it does not care) */
const FRAME_START = /^\\begin\{frame\}/

/** Cut every block's crops for one pass, given a box map and a page source
 * that is already resolved — no daemon fetch, no compile job, nothing
 * browser-only left in it but the DOM the crops attach to (which happy-dom
 * renders fine; it just cannot decode an `<img>`'s pixels). Exported so a
 * fixture replay can drive the exact placement pipeline against a captured
 * box map instead of a live compile — see blockmirror.fixture.test.ts. */
export async function cutDocument(doc: Doc, run: Pass): Promise<void> {
  // WHICH boxes a block owns is pure and cheap; turning one into pixels is
  // not. So ownership is worked out for the whole document first and the
  // pass then walks the cuts in an order that decodes each page once (see
  // cutOrder) — a document is dozens of pages and a page bitmap is tens of
  // megabytes, so revisiting one is the difference between a pass and a
  // crashed tab.
  const owned = ownership(run)
  const entries: Array<{ block: HTMLElement; range: { from: number; to: number }; mine: number[] }> = []
  for (const block of mirrorTargets(doc.article)) {
    clearAside(block)
    if (isOpenForEdit(block)) continue // a block being typed in owns itself
    const range = lineRangeOf(doc, block)
    if (!range) continue
    entries.push({ block, range, mine: owned(range.from, range.to) })
  }

  const cuts: Cut[] = []
  const orphans: Orphan[] = []
  for (let i = 0; i < entries.length; i++) {
    const { block, range, mine } = entries[i]
    const slice = doc.source.sliceOf(block.getAttribute('data-dia-id') ?? '') ?? ''
    // Source that typesets nothing of its own is classified BEFORE it is
    // cropped, not after failing to be. `\newpage` still gets boxes — the
    // glue it contributes stands in whatever box was open, and on llama.tex
    // page 20 that is a 360pt-tall wrapper it would have cropped whole.
    // What the command MEANS is the only witness here, and the classifier
    // has held it all along.
    if (isLayoutOnlySlice(slice) || setsNoType(slice)
      || isInklessSectionMarker(slice, doc.docclass)) {
      orphans.push({ block, range })
      continue
    }
    // a beamer frame: a slide IS a page, so the crop is the page — every
    // one the frame's own boxes name, because beamer ships one page per
    // \pause/<n->/\onslide split (measured on beamer.tex: a lone \pause
    // produced 2 pages, three `<n->` items plus a \onslide<4-> produced 4).
    // Cropping the frame's boxes instead would cut the slide's furniture
    // (its frametitle rule, its navigation) off a picture whose whole point
    // is to be the slide.
    if (FRAME_START.test(slice.trimStart())) {
      const pages = [...new Set(mine.map((b) => run.boxes[b].page))].sort((a, b) => a - b)
      if (pages.length > 0) {
        cuts.push({ block, rects: [], range, fullPages: pages, key: `frame|${pages.join(',')}|${run.dpi}` })
        continue
      }
      // no attribution at all for this frame — not measured in the
      // beamer.tex corpus fixture (every frame there gets boxes), but
      // nothing guarantees every frame always will. Falls through to the
      // ordinary classification below, which marks it quietly rather than
      // showing nothing at all.
    }
    if (mine.length === 0) {
      // a bibliography: its entries were typeset from the .bbl, which
      // carries that FILE's synctex tag and its own line numbers, so
      // nothing on those pages is keyed by anything in main.tex. Whole
      // pages are the only honest answer.
      if (/\\bibliography\{|\\printbibliography/.test(slice)) {
        const pages = bibliographyPages(run, range)
        if (pages.length > 0) {
          cuts.push({ block, rects: [], range, fullPages: pages,
            key: `bib|${pages.join(',')}|${run.dpi}` })
          continue
        }
      }
      orphans.push({ block, range })
      continue
    }
    // a `\paragraph` heading is typeset run-in, INSIDE the first line of
    // the block after it, and the engine credits that line box to the
    // paragraph's lines, never to the heading's. Two crops of one line is
    // the reader seeing double; the next block's is the one that shows it.
    const next = entries[i + 1]
    if (block.matches('h4.dia-sec, h5.dia-sec') && next && next.mine.length > 0
      && next.range.from <= range.to) {
      orphans.push({ block, range, sharedWith: next.block })
      continue
    }
    // "somebody else's box": credited, and to no source line of ours. A
    // box we own is never in this list by construction, and the run-in
    // heading whose words share our first line box is not either — it
    // shares a source line with us, so it is not an intruder.
    const rects = cropsFor(run.boxes, mine, (page) => boxesOn(run, page)
      .filter((j) => run.boxes[j].src.length > 0
        && !boxOwns(run.boxes[j], run.mainTag, range.from, range.to)))
    cuts.push({ block, rects, range, key: keyFor(rects, run.dpi) })
  }

  // crops are replaced in place rather than cleared first: a recompile
  // should refresh the page, not blank it for a second
  const fresh = new Set<HTMLElement>()
  for (const cut of cutOrder(cuts)) {
    const { block, key } = cut
    const held = shown.get(block)
    const slice = doc.source.sliceOf(block.getAttribute('data-dia-id') ?? '')
    // identical inputs, identical pixels: keep the picture that is already
    // hanging rather than pay a page decode and a re-encode for it
    if (held && held.key === key && held.slice === slice) {
      fresh.add(block)
      continue
    }

    const parts = await cutBlock(run, cut)
    if (parts === null || !run.live()) return
    if (parts.length === 0) { orphans.push({ block, range: cut.range }); continue }
    if (isOpenForEdit(block)) { revokeAll(parts); continue }
    const shaped = parts.map((p) => ({ ...p, widthPct: pctOf(p.widthPt, run.measure) }))
    if (attachMirror(doc, block, shaped, { key })) {
      fresh.add(block)
      opened.delete(block) // its render caught up; it is a crop again
    }
  }
  // a block this compile has nothing to show for keeps no picture from the
  // last one
  for (const block of [...shown.keys()]) if (!fresh.has(block)) detach(block)
  classifyOrphans(doc, orphans, fresh)
  spaceMirrors(doc, run)
  clearStale()
}

/** A lookup from a source-line range to the boxes that hold its material.
 *
 * Built once per pass over an index by line, because a document is hundreds
 * of blocks and a paper is thousands of boxes, and asking every box about
 * every block is the one quadratic in this file that would actually be
 * felt. */
export function ownership(run: Pass): (from: number, to: number) => number[] {
  const byLine = new Map<number, number[]>()
  run.boxes.forEach((box, i) => {
    // indexed by the line its material BEGINS on — see boxOwns
    let first = Infinity
    for (const [tag, line] of box.src) {
      if (run.mainTag !== null && tag !== run.mainTag) continue
      first = Math.min(first, line)
    }
    if (!Number.isFinite(first)) return
    const held = byLine.get(first)
    if (held) held.push(i)
    else byLine.set(first, [i])
  })
  return (from, to) => {
    const out = new Set<number>()
    for (let line = from; line <= to; line++) {
      for (const i of byLine.get(line) ?? []) out.add(i)
    }
    return [...out].sort((a, b) => a - b)
  }
}

/** The gap the PAGE puts between two consecutive crops, as a percentage of
 * the document measure. CSS vertical margins in % resolve against the
 * container width — the same base the crops' widthPct scales by — so the
 * measured spacing holds at any zoom. Null (use the default gap) across
 * pages, across columns, around blocks with nothing measured, and for
 * anything implausible (overlap, more than a float separation). */
export function measuredGapPct(
  prev: Claim[] | undefined,
  next: Claim[] | undefined,
  measure: number,
): number | null {
  if (!prev?.length || !next?.length || !(measure > 0)) return null
  const a = prev[prev.length - 1]
  const b = next[0]
  if (a.page !== b.page) return null
  if (Math.min(a.xMax, b.xMax) - Math.max(a.xMin, b.xMin) <= 2 * CROP_PAD) return null
  const gap = b.yMin - a.yMax
  if (gap < 0 || gap > 60) return null
  return (gap / measure) * 100
}

/** TeX's vertical rhythm, carried into the flow: every uniform CSS gap the
 * editor would show between crops is replaced by the distance the page
 * actually left there. Blocks without a crop (stale, marked, hidden) keep
 * the chain — a hidden block's ink lives inside its neighbour's crop. */
function spaceMirrors(doc: Doc, run: Pass): void {
  let prev: Claim[] | undefined
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
 *    heading) hides as long as that neighbour mirrored;
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
 *  - a run-in heading (\paragraph) with no boxes at all is typeset INSIDE
 *    the next block's first line, so its crop shows the words;
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

/** How a placed crop becomes pixels. The ONLY step that ever touches real
 * ones: null propagates exactly as a blank crop always did — no part, no
 * claim, and the classifier decides what the block shows instead. A fixture
 * replay skips rasterizing (there are no pixels to draw offline) and
 * returns a url anyway, which is what lets it pin the rectangles this file
 * computes without a canvas. */
export interface PageSource {
  rasterize(page: number, rect: Rect): Promise<string | null>
}

/** the browser's PageSource: a daemon-rendered bitmap per page, cropped to
 * the rectangle the boxes gave */
function makeLivePageSource(jobId: string, dpi: number): PageSource {
  return {
    async rasterize(page, rect) {
      const bitmap = await getPageBitmap(jobId, page, { dpi })
      if (!bitmap) return null
      const canvas = cropBand(bitmap, rect)
      if (!canvas) return null
      return canvasUrl(canvas)
    },
  }
}

/** Cut one block's crops. Null means the pass was overtaken while awaiting
 * — whatever it had made is already released. */
async function cutBlock(run: Pass, cut: Cut): Promise<Part[] | null> {
  const parts: Part[] = []
  const abort = (): null => { revokeAll(parts); return null }
  const claims: Claim[] = []

  // a whole-page crop: a beamer slide, or a bibliography whose entries came
  // from another input file entirely
  const rects: Array<Rect & { page: number }> = cut.fullPages
    ? cut.fullPages.flatMap((page) => {
      const on = boxesOn(run, page).map((i) => run.boxes[i])
      const extent = pageExtent(on)
      // a blank filler page has nothing to show, and an empty rectangle is
      // not a picture of anything
      return extent === null || isFillerPage(on) ? [] : [{ page, ...extent }]
    })
    : cut.rects

  for (const rect of rects) {
    const dims = run.dims.get(rect.page) ?? { wPt: 0, hPt: 0 }
    const shape = padded(toTopDown(rect, dims.hPt, run.ySemantics), dims.wPt, dims.hPt)
    if (!(shape.xMax > shape.xMin) || !(shape.yMax > shape.yMin)) continue
    const url = await run.pages.rasterize(rect.page, shape)
    if (!run.live()) { if (url) revoke(url); return abort() }
    if (url === null) continue
    parts.push({ url, widthPt: shape.xMax - shape.xMin })
    claims.push({ ...shape, page: rect.page, ...(cut.fullPages ? { whole: true } : {}) })
  }
  heldClaims.set(cut.block, claims)
  return parts
}

/** a mirrored block's claimed rectangles from the last cut, in top-down
 * points. Exported so a fixture replay can assert crop rectangles against
 * pinned goldens without reaching into the module's own cache. */
export function claimsFor(block: HTMLElement): Claim[] | undefined {
  return heldClaims.get(block)
}

const heldClaims = new WeakMap<HTMLElement, Claim[]>()

/** the indices of every box on one page */
function boxesOn(run: Pass, page: number): number[] {
  let held = pageIndex.get(run)
  if (!held) {
    held = new Map<number, number[]>()
    run.boxes.forEach((box, i) => {
      const list = held?.get(box.page)
      if (list) list.push(i)
      else held?.set(box.page, [i])
    })
    pageIndex.set(run, held)
  }
  return held.get(page) ?? []
}

const pageIndex = new WeakMap<Pass, Map<number, number[]>>()

/** The pages a `\bibliography` command typeset: from the page its preceding
 * line last touched through the page before the following content resumes.
 * Nothing else can say — the entries' boxes carry the .bbl FILE's synctex
 * tag and its line numbers, which name nothing in main.tex.
 *
 * A `\cleardoublepage` leaves a near-blank filler page behind with nothing
 * on it but a running header, and that header still carries the triggering
 * line's attribution, so `prev` can land there with no real content at all
 * (measured: thesis.tex's `\backmatter`, forced by `twoside`, does this to
 * page 14). When it does, the naive `next` boundary is usually the SAME
 * kind of artifact seen from the other side: whatever forces the next block
 * onto its own fresh page leaves a closing box at the FOOT of the page the
 * bibliography itself is typeset on (measured: page 15, the references' own
 * page). Trusting it as a hard boundary crops the filler page and misses
 * the references entirely, so a filler `prev` widens a degenerate one-page
 * range by one more page. Wrong when nothing real is there — but a filler
 * page is dropped from the crop for free either way (see cutBlock), so
 * widening can never cut into a neighbour's content it shouldn't. */
export function bibliographyPages(run: Pass, range: { from: number; to: number }): number[] {
  let prev = 0
  let next = Infinity
  for (const box of run.boxes) {
    for (const [tag, line] of box.src) {
      if (run.mainTag !== null && tag !== run.mainTag) continue
      if (line < range.from) prev = Math.max(prev, box.page)
      if (line > range.to) next = Math.min(next, box.page)
    }
  }
  if (prev === 0) return []
  if (next === Infinity) next = prev + 9 // refs at the end of the document
  if (isFillerPage(boxesOn(run, prev).map((i) => run.boxes[i])) && next === prev + 1) next = prev + 2
  // references may START on the page the body ends on and the next section
  // may start on the page they end on — the shared pages are still theirs
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
 * \tableofcontents (measured: zero synctex boxes for any of beamer.tex's
 * three)? The command name alone cannot say this: an article's or book's
 * \section very much sets a real heading, so setsNoType/isLayoutOnlySlice
 * (which read the slice text only) correctly leave it visible — the
 * document class is the one input neither of them has. */
export function isInklessSectionMarker(slice: string, docclass: string | undefined): boolean {
  return docclass === 'beamer' && SECTION_MARKER.test(slice.trim())
}

interface Cut {
  block: HTMLElement
  rects: Array<Rect & { page: number }>
  range: { from: number; to: number }
  key: string
  /** crop these whole pages instead: a beamer slide, or a bibliography
   * whose entries carry another input file's synctex tag */
  fullPages?: number[]
}

/** Everything a block's pixels depend on, as one short string. The
 * rectangles ARE the dependency now: they came from the engine, so nothing
 * a neighbour did can move them without moving these numbers too. */
function keyFor(rects: Array<Rect & { page: number }>, dpi: number): string {
  return `${dpi}|` + rects
    .map((r) => `${r.page}:${r.xMin},${r.xMax},${r.yMin},${r.yMax}`)
    .join('|')
}

/** The order to cut in: pages ranked by how close their nearest block is to
 * what the reader is looking at, and every block of a page cut while that
 * page is decoded. Priority alone would thrash the bitmap cache — the block
 * beside you and the one after it can be pages apart in a document with
 * floats — and page order alone would leave the reader staring at HTML
 * while page 1 of 40 renders. */
export function cutOrder(cuts: Cut[]): Cut[] {
  const firstPage = (c: Cut): number => c.rects[0]?.page ?? c.fullPages?.[0] ?? 0
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

/** a block the user is typing in right now */
function isOpenForEdit(block: HTMLElement): boolean {
  return block.hasAttribute('contenteditable') || block.querySelector('[contenteditable]') !== null
}

/* ---------- the wire ---------- */

/** the point map, for the PDF panel's scroll targets. Unchanged, and
 * deliberately: a scroll target wants one point per line, and the mirror's
 * box map would be a worse answer to a question that is already answered. */
export async function fetchSynctex(jobId: string): Promise<SynctexRecord[]> {
  const raw = await fetchSynctexMap(jobId)
  const lines = (raw as { lines?: unknown } | null)?.lines
  if (!Array.isArray(lines)) return []
  return lines.map(normalizeRecord).filter((r): r is SynctexRecord => r !== null)
}

/** what the mirror reads: the box tree, the tag main.tex was given, and the
 * document's measure. Everything here degrades to "no crops" rather than to
 * a wrong one — an older daemon reports no `boxes` key at all. */
export interface BoxMap {
  boxes: SynctexBox[]
  mainTag: number | null
  /** the widest text block any page holds, in points */
  measure: number
}

export async function fetchBoxes(jobId: string): Promise<BoxMap> {
  return normalizeBoxMap(await fetchSynctexMap(jobId))
}

export function normalizeBoxMap(raw: unknown): BoxMap {
  const map = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const boxes = Array.isArray(map.boxes)
    ? map.boxes.map(normalizeBox).filter((b): b is SynctexBox => b !== null)
    : []
  // a parent index that did not survive normalization would point at the
  // wrong box, which is worse than pointing at none
  const kept = boxes.length === (Array.isArray(map.boxes) ? map.boxes.length : 0)
  if (!kept) for (const box of boxes) box.parent = -1
  const mainTag = typeof map.mainTag === 'number' && Number.isFinite(map.mainTag)
    ? Math.trunc(map.mainTag)
    : null
  const widths: number[] = []
  if (Array.isArray(map.pages)) {
    for (const p of map.pages) {
      const w = (p as { w?: unknown } | null)?.w
      if (typeof w === 'number' && Number.isFinite(w) && w > 0) widths.push(w)
    }
  }
  return { boxes, mainTag, measure: measureOf(widths) }
}

/** The document's measure: how wide the page sets its text, in points.
 *
 * The MEDIAN of the per-page text blocks, not the widest. Every crop's
 * displayed width is its share of this, so one freak page must not shrink
 * the whole document: llama.tex sets 25 of its 27 pages to a 455.24pt
 * measure and puts one rotated table on a page whose largest box is
 * 732.79pt wide, and dividing by that showed every paragraph at 62% of the
 * width it was set to. */
export function measureOf(widths: number[]): number {
  if (widths.length === 0) return 0
  const sorted = [...widths].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

export function normalizeBox(raw: unknown): SynctexBox | null {
  if (typeof raw !== 'object' || raw === null) return null
  const b = raw as Record<string, unknown>
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null
  const page = num(b.page)
  const x = num(b.x)
  const y = num(b.y)
  const w = num(b.w)
  const h = num(b.h)
  const d = num(b.d)
  if (page === null || x === null || y === null || w === null || h === null || d === null) return null
  const src: Array<[number, number]> = []
  if (Array.isArray(b.src)) {
    for (const pair of b.src) {
      if (!Array.isArray(pair) || pair.length < 2) continue
      const tag = num(pair[0])
      const line = num(pair[1])
      if (tag === null || line === null) continue
      src.push([Math.trunc(tag), Math.trunc(line)])
    }
  }
  const parent = num(b.parent)
  return {
    page: Math.trunc(page),
    x, y, w, h, d,
    src,
    parent: parent === null ? -1 : Math.trunc(parent),
  }
}

export function normalizeRecord(raw: unknown): SynctexRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.line !== 'number' || typeof r.page !== 'number' || typeof r.y !== 'number') return null
  if (!Number.isFinite(r.line) || !Number.isFinite(r.page) || !Number.isFinite(r.y)) return null
  const out: SynctexRecord = { line: Math.trunc(r.line), page: Math.trunc(r.page), y: r.y }
  // x/w arrive only from daemons that report them
  if (typeof r.x === 'number' && Number.isFinite(r.x)) out.x = r.x
  if (typeof r.w === 'number' && Number.isFinite(r.w) && r.w > 0) out.w = r.w
  return out
}

async function fetchSynctexMap(jobId: string): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(`${SERVICE_BASE}/compile/${encodeURIComponent(jobId)}/synctex`)
  } catch {
    return null
  }
  if (!res.ok) return null
  try {
    return await res.json()
  } catch {
    return null
  }
}

/* ---------- rasterizing the crop ---------- */

/** Crop the page bitmap to the rectangle the engine's boxes gave.
 *
 * Nothing else: the rectangle IS the block's typeset extent, so there is
 * no ink scan, no trim and no snap to a run of rows. That whole apparatus
 * existed to recover a shape the daemon had thrown away and now reports.
 * Null only when the crop falls outside the page or the canvas cannot be
 * had. */
export function cropBand(bitmap: PageBitmap, rect: Rect): HTMLCanvasElement | null {
  const h = bitmap.image.height
  const w = bitmap.image.width
  const top = Math.max(0, Math.min(h - 1, Math.round(rect.yMin * bitmap.scale)))
  const bottom = Math.max(top + 1, Math.min(h, Math.round(rect.yMax * bitmap.scale)))
  const left = Math.max(0, Math.min(w - 1, Math.round(rect.xMin * bitmap.scale)))
  const right = Math.max(left + 1, Math.min(w, Math.round(rect.xMax * bitmap.scale)))

  const band = document.createElement('canvas')
  band.width = right - left
  band.height = bottom - top
  const ctx = band.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(bitmap.image, left, top, band.width, band.height, 0, 0, band.width, band.height)
  return band
}

function canvasUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob !== 'function') { resolve(canvas.toDataURL('image/png')); return }
    canvas.toBlob((blob) => {
      resolve(blob ? URL.createObjectURL(blob) : canvas.toDataURL('image/png'))
    }, 'image/png')
  })
}

function revoke(url: string): void {
  if (url.startsWith('blob:')) URL.revokeObjectURL(url)
}

function revokeAll(parts: Part[]): void {
  for (const p of parts) revoke(p.url)
}
