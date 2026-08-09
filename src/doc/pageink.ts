/* A rendered page's ink — the compiled mirror's TEST ORACLE.
 *
 * Nothing in the running editor reads this. It used to: the mirror
 * reconstructed a block's horizontal window by decoding the page bitmap and
 * projecting its ink onto x to find the columns, because the daemon handed
 * it one POINT per source line and it needed a RECTANGLE. The daemon now
 * reports the engine's own boxes, so the reconstruction is gone (see
 * blockmirror.ts's header) — and the ink is exactly what it was always
 * better suited to be: an independent answer, computed a different way from
 * a different artifact, that the crops can be checked against.
 *
 * The property the oracle checks (blockmirror.fixture.test.ts) is not a
 * golden. It is: every crop holds all of its block's ink and none of a
 * neighbour's. That cannot be satisfied by a bug that agrees with itself.
 *
 * `cells` is one byte per (device row, POINT of page width). A point of x
 * resolution, not a device pixel: quantizing there turns a 33MB image into
 * a couple of megabytes and nothing the oracle asks is finer than a point.
 * Rows stay in device pixels because that is what a crop is cut in. */

/** an ink-vs-paper channel-sum threshold: anti-aliased grey counts as ink,
 * paper texture and JPEG-ish noise do not. Exported so
 * scripts/capture-mirror-fixture.mjs — which decodes PNGs outside the DOM,
 * so it cannot import this module — can say out loud that its own ink scan
 * is this same threshold, not a guess that might drift from it. */
export const INK = 24

export interface PageInk {
  cells: Uint8Array
  /** point columns — the width of one row of `cells` */
  cols: number
  rows: number
  /** device rows per point */
  scale: number
  wPt: number
  hPt: number
  /** the leftmost and rightmost point of the page holding any ink */
  extent: { xMin: number; xMax: number } | null
}

/** does any ink stand in this rectangle (points, top-down from the paper's
 * top-left)? */
export function inkIn(ink: PageInk, rect: { xMin: number; xMax: number; yMin: number; yMax: number }): boolean {
  return inkCount(ink, rect) > 0
}

/** how many (row, point) cells of ink stand in this rectangle */
export function inkCount(
  ink: PageInk,
  rect: { xMin: number; xMax: number; yMin: number; yMax: number },
): number {
  const lo = Math.max(0, Math.floor(rect.xMin))
  const hi = Math.min(ink.cols - 1, Math.ceil(rect.xMax) - 1)
  const from = Math.max(0, Math.floor(rect.yMin * ink.scale))
  const to = Math.min(ink.rows, Math.ceil(rect.yMax * ink.scale))
  let n = 0
  for (let y = from; y < to; y++) {
    const row = y * ink.cols
    for (let c = lo; c <= hi; c++) if (ink.cells[row + c]) n++
  }
  return n
}

/** the bounding box of the ink inside a rectangle, in points, or null when
 * the rectangle holds none */
export function inkBounds(
  ink: PageInk,
  rect: { xMin: number; xMax: number; yMin: number; yMax: number },
): { xMin: number; xMax: number; yMin: number; yMax: number } | null {
  const lo = Math.max(0, Math.floor(rect.xMin))
  const hi = Math.min(ink.cols - 1, Math.ceil(rect.xMax) - 1)
  const from = Math.max(0, Math.floor(rect.yMin * ink.scale))
  const to = Math.min(ink.rows, Math.ceil(rect.yMax * ink.scale))
  let xMin = ink.cols
  let xMax = -1
  let yMin = ink.rows
  let yMax = -1
  for (let y = from; y < to; y++) {
    const row = y * ink.cols
    for (let c = lo; c <= hi; c++) {
      if (!ink.cells[row + c]) continue
      if (c < xMin) xMin = c
      if (c > xMax) xMax = c
      if (y < yMin) yMin = y
      if (y > yMax) yMax = y
    }
  }
  if (xMax < 0) return null
  return { xMin, xMax: xMax + 1, yMin: yMin / ink.scale, yMax: (yMax + 1) / ink.scale }
}
