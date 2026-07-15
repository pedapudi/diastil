/* FIDELITY — step 4 of ingest: prove the conversion didn't change how the
 * deck looks. First-party rasterization: clone a rendered region, inline its
 * computed styles, wrap in <svg><foreignObject>, draw to a small canvas, and
 * pixel-diff original vs converted at the same sample size.
 *
 * Honesty notes baked into the scoring:
 * - both sides go through the SAME rasterizer, so its systematic losses
 *   (webfonts and external images do not load inside SVG-as-image,
 *   ::before/::after content is dropped) largely cancel in the diff;
 * - downsampling to the sample grid absorbs anti-aliasing noise, and the
 *   per-channel tolerance absorbs font-fallback hinting differences;
 * - any rasterization failure yields null, never a fake score. */

const SAMPLE_W = 384
const SAMPLE_H = 216
/** per-channel delta below this is "the same pixel" (AA / hinting slack) */
const CHANNEL_TOLERANCE = 40
/* the composite's INK masks use a much tighter threshold: subtle surfaces
 * (a card panel a few shades off the background) must count as ink in BOTH
 * rasters or in NEITHER — a 40/channel cliff made a repaired card read as
 * pure extra ink whenever the original's surface sat just under it while
 * the candidate's sat just over, grading objective improvements DOWN */
const INK_TOLERANCE = 16
const RASTER_TIMEOUT_MS = 3000

/** slides scoring below this are offered an automatic service repair round */
export const REPAIR_THRESHOLD = 0.8

export interface FidelityScore {
  /** visual-consistency verdict, 0..1 — a composite of displacement
   * (truncated chamfer), layout (coarse ink Dice), and appearance
   * (multi-scale blurred color difference); see diffBitmaps */
  score: number
  diffPixels: number
  totalPixels: number
  /** pixels that differ from the background in either raster — the mass the
   * score is weighted over */
  contentPixels: number
}

/** Rasterize a rendered element (styles resolved in ITS OWN document) onto a
 * canvas of the given size. Returns null when rasterization fails. */
async function rasterizeToCanvas(el: Element, w: number, h: number): Promise<HTMLCanvasElement | null> {
  const win = el.ownerDocument.defaultView
  if (!win) return null
  const rect = el.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return null
  // the svg viewport must match the element's LAYOUT size, not its
  // transformed rect: review panes scale slides down with a CSS transform,
  // and a rect-sized viewport would CLIP the full-size clone to its top-left
  // corner — rasterizing a mostly-blank image that scores as background
  const layout = layoutSize(el, rect)

  // entrance animations poison the snapshot: an element mid-fade (or one
  // whose animation restarted on activation) computes opacity 0/transform
  // offsets, the clone freezes those values, and CSS animations never run
  // inside SVG-as-image — the raster comes out blank. Settle every finite
  // animation to its end state first.
  settleAnimations(el)

  const clone = cloneWithComputedStyles(el, win)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(layout.w)}" height="${Math.round(layout.h)}">` +
    `<foreignObject width="100%" height="100%">${new XMLSerializer().serializeToString(clone)}</foreignObject></svg>`

  const img = new Image()
  const loaded = new Promise<boolean>((resolve) => {
    const timer = window.setTimeout(() => resolve(false), RASTER_TIMEOUT_MS)
    img.onload = () => { window.clearTimeout(timer); resolve(true) }
    img.onerror = () => { window.clearTimeout(timer); resolve(false) }
  })
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  if (!(await loaded)) return null

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  // composite over the element's EFFECTIVE background: slides are often
  // transparent with the deck's paper painted on an ancestor — compositing
  // over white would rasterize a dark deck's original as white-on-white
  // and score a faithful conversion near zero
  ctx.fillStyle = effectiveBackground(el, win)
  ctx.fillRect(0, 0, w, h)
  try {
    ctx.drawImage(img, 0, 0, w, h)
    return canvas
  } catch {
    return null
  }
}

/** Rasterize a rendered element to ImageData at sample size. */
export async function rasterizeRegion(el: HTMLElement): Promise<ImageData | null> {
  const canvas = await rasterizeToCanvas(el, SAMPLE_W, SAMPLE_H)
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return null
  try {
    return ctx.getImageData(0, 0, canvas.width, canvas.height)
  } catch {
    return null
  }
}

/** untransformed layout box; svg elements have no offset* so their rect is
 * the best available (cross-realm safe — no instanceof) */
function layoutSize(el: Element, rect: DOMRect): { w: number; h: number } {
  const o = el as { offsetWidth?: number; offsetHeight?: number }
  if (typeof o.offsetWidth === 'number' && o.offsetWidth > 0 && typeof o.offsetHeight === 'number' && o.offsetHeight > 0) {
    return { w: o.offsetWidth, h: o.offsetHeight }
  }
  return { w: rect.width, h: rect.height }
}

/** Close-up of a fraction-coordinate region, rendered at enough resolution
 * for a vision model to READ it (a highlighted chart in a 768px full-slide
 * render is a few dozen pixels; a crop at ≥512px shows its axis labels).
 * The whole element is rasterized at the scale that makes the crop sharp,
 * capped so pathological slivers don't demand gigapixel canvases. */
export async function rasterizeCropDataUrl(
  el: Element, region: { x: number; y: number; w: number; h: number }, minW = 512,
): Promise<string | null> {
  if (region.w <= 0.01 || region.h <= 0.01) return null
  const rect = el.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return null
  const layout = layoutSize(el, rect)
  const fullW = Math.min(2048, Math.max(Math.round(minW / region.w), Math.round(layout.w)))
  const fullH = Math.max(1, Math.round((layout.h / layout.w) * fullW))
  const canvas = await rasterizeToCanvas(el, fullW, fullH)
  if (!canvas) return null
  const cw = Math.max(1, Math.round(region.w * fullW))
  const ch = Math.max(1, Math.round(region.h * fullH))
  const crop = document.createElement('canvas')
  crop.width = cw
  crop.height = ch
  const ctx = crop.getContext('2d')
  if (!ctx) return null
  try {
    ctx.drawImage(canvas, Math.round(region.x * fullW), Math.round(region.y * fullH), cw, ch, 0, 0, cw, ch)
    return crop.toDataURL('image/png')
  } catch {
    return null
  }
}

/** VLM-legible raster: PNG data URL at up to VLM_W wide, aspect preserved.
 * These feed multimodal skill calls (repair rounds, diagram lifts) so the
 * model can SEE the mismatch instead of inferring it from HTML. */
const VLM_W = 768
export async function rasterizeToDataUrl(el: Element): Promise<string | null> {
  const rect = el.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return null
  const layout = layoutSize(el, rect)
  const w = Math.min(VLM_W, Math.round(layout.w))
  const h = Math.max(1, Math.round((layout.h / layout.w) * w))
  const canvas = await rasterizeToCanvas(el, w, h)
  if (!canvas) return null
  try {
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

/** Diff heatmap PNG: matching pixels as dim grayscale of the original,
 * mismatched pixels (per-channel delta over tolerance) in red. Gives a
 * VLM the WHERE of a fidelity miss at a glance. */
export function diffHeatmapDataUrl(a: ImageData, b: ImageData): string | null {
  const w = Math.min(a.width, b.width)
  const h = Math.min(a.height, b.height)
  if (w < 1 || h < 1) return null
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const out = ctx.createImageData(w, h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ia = (y * a.width + x) * 4
      const ib = (y * b.width + x) * 4
      const io = (y * w + x) * 4
      const d = Math.max(
        Math.abs(a.data[ia] - b.data[ib]),
        Math.abs(a.data[ia + 1] - b.data[ib + 1]),
        Math.abs(a.data[ia + 2] - b.data[ib + 2]),
      )
      if (d > CHANNEL_TOLERANCE) {
        out.data[io] = 255; out.data[io + 1] = 40; out.data[io + 2] = 90
      } else {
        const lum = Math.round(
          (0.299 * a.data[ia] + 0.587 * a.data[ia + 1] + 0.114 * a.data[ia + 2]) * 0.35)
        out.data[io] = lum; out.data[io + 1] = lum; out.data[io + 2] = lum
      }
      out.data[io + 3] = 255
    }
  }
  ctx.putImageData(out, 0, 0)
  try {
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

/** Score two rasters for VISUAL CONSISTENCY.
 *
 * The verdict is a composite of three graded, orthogonal properties —
 * not a binary per-pixel match, whose step-function penalty (1px free,
 * 2px catastrophic) made faithfully-converted text collapse to ~0 the
 * moment font metrics moved it a few pixels, while a single big filled
 * shape scored high. Perceived consistency and the score diverged.
 *
 *   displacement — symmetric truncated chamfer distance between the two
 *     ink masks: HOW FAR content moved, saturating at ~4% of height.
 *     A 2px drift costs a little; absent ink costs everything.
 *   layout — Dice overlap of ink mass on a coarse grid: is the
 *     COMPOSITION the same, at the scale a human judges first.
 *   appearance — mean color difference at blur radii 1/3/8px over the
 *     union ink mask (plus a background term): the fine scale keeps the
 *     metric honest about REWRITTEN content, the coarse scales grant
 *     displacement tolerance proportional to scale.
 *
 * The per-pixel classification remains the EXPLANATION layer (heatmap,
 * regions, drift); this composite is the verdict. Pixel counts are still
 * reported for those explanations. */
export function diffBitmaps(a: ImageData, b: ImageData): FidelityScore {
  const c = classifyPixels(a, b)
  const score = visualScore(a, b)
  return { score, diffPixels: c.diff, totalPixels: c.total, contentPixels: c.content }
}

const CHAMFER_MAX_FRAC = 0.04 // displacement saturates at 4% of height
const APP_SCALES: Array<[radius: number, weight: number]> = [[1, 0.5], [3, 0.3], [8, 0.2]]

function visualScore(a: ImageData, b: ImageData): number {
  const w = Math.min(a.width, b.width)
  const h = Math.min(a.height, b.height)
  if (w < 2 || h < 2) return 0
  // content = differs from the raster's OWN background: a retinted-but-
  // faithful conversion keeps its mask; the appearance term sees the tint
  const maskA = inkMask(a, w, h, estimateBackground(a))
  const maskB = inkMask(b, w, h, estimateBackground(b))
  let nA = 0
  let nB = 0
  for (let i = 0; i < w * h; i++) { nA += maskA[i]; nB += maskB[i] }
  if (nA === 0 && nB === 0) return 1 // two blank slides agree
  if (nA === 0 || nB === 0) return 0 // content invented, or destroyed wholesale
  const displacement = chamferSim(maskA, maskB, w, h)
  const layout = layoutSim(maskA, maskB, w, h)
  const appearance = appearanceSim(a, b, maskA, maskB, w, h)
  const score = 0.35 * displacement + 0.3 * layout + 0.35 * appearance
  return Math.round(Math.max(0, Math.min(1, score)) * 1000) / 1000
}

function inkMask(img: ImageData, w: number, h: number, bg: [number, number, number]): Uint8Array {
  const mask = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * img.width + x) * 4
      if (
        Math.abs(img.data[i] - bg[0]) > INK_TOLERANCE ||
        Math.abs(img.data[i + 1] - bg[1]) > INK_TOLERANCE ||
        Math.abs(img.data[i + 2] - bg[2]) > INK_TOLERANCE
      ) mask[y * w + x] = 1
    }
  }
  return mask
}

/** symmetric truncated chamfer similarity: mean distance from each ink
 * pixel to the nearest ink in the OTHER mask, saturated and normalized */
function chamferSim(maskA: Uint8Array, maskB: Uint8Array, w: number, h: number): number {
  const dmax = Math.max(2, h * CHAMFER_MAX_FRAC)
  const dtA = distanceTransform(maskA, w, h)
  const dtB = distanceTransform(maskB, w, h)
  let pa = 0
  let na = 0
  let pb = 0
  let nb = 0
  for (let i = 0; i < w * h; i++) {
    if (maskA[i]) { pa += Math.min(dtB[i], dmax) / dmax; na++ }
    if (maskB[i]) { pb += Math.min(dtA[i], dmax) / dmax; nb++ }
  }
  return 1 - ((na ? pa / na : 1) + (nb ? pb / nb : 1)) / 2
}

/** two-pass 3-4 chamfer distance transform (≈ euclidean px after /3) */
function distanceTransform(mask: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9
  const d = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) d[i] = mask[i] ? 0 : INF
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (x > 0 && d[i - 1] + 3 < d[i]) d[i] = d[i - 1] + 3
      if (y > 0) {
        if (d[i - w] + 3 < d[i]) d[i] = d[i - w] + 3
        if (x > 0 && d[i - w - 1] + 4 < d[i]) d[i] = d[i - w - 1] + 4
        if (x < w - 1 && d[i - w + 1] + 4 < d[i]) d[i] = d[i - w + 1] + 4
      }
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x
      if (x < w - 1 && d[i + 1] + 3 < d[i]) d[i] = d[i + 1] + 3
      if (y < h - 1) {
        if (d[i + w] + 3 < d[i]) d[i] = d[i + w] + 3
        if (x < w - 1 && d[i + w + 1] + 4 < d[i]) d[i] = d[i + w + 1] + 4
        if (x > 0 && d[i + w - 1] + 4 < d[i]) d[i] = d[i + w - 1] + 4
      }
    }
  }
  for (let i = 0; i < w * h; i++) d[i] /= 3
  return d
}

/** continuous Dice coefficient of ink mass on a coarse grid — same
 * composition ⇒ 1, disjoint composition ⇒ 0 */
function layoutSim(maskA: Uint8Array, maskB: Uint8Array, w: number, h: number): number {
  const GX = 16
  const GY = 9
  const cellsA = new Float32Array(GX * GY)
  const cellsB = new Float32Array(GX * GY)
  for (let y = 0; y < h; y++) {
    const gy = Math.min(GY - 1, Math.floor((y / h) * GY))
    for (let x = 0; x < w; x++) {
      const gx = Math.min(GX - 1, Math.floor((x / w) * GX))
      const c = gy * GX + gx
      cellsA[c] += maskA[y * w + x]
      cellsB[c] += maskB[y * w + x]
    }
  }
  let inter = 0
  let total = 0
  for (let c = 0; c < GX * GY; c++) {
    inter += Math.min(cellsA[c], cellsB[c])
    total += cellsA[c] + cellsB[c]
  }
  return total > 0 ? (2 * inter) / total : 1
}

/** multi-scale blurred color difference over the union ink mask, plus a
 * background term — fine scale keeps rewritten content expensive, coarse
 * scales tolerate displacement proportional to radius */
function appearanceSim(
  a: ImageData, b: ImageData, maskA: Uint8Array, maskB: Uint8Array, w: number, h: number,
): number {
  const bgA = estimateBackground(a)
  const bgB = estimateBackground(b)
  let scaled = 0
  for (const [radius, weight] of APP_SCALES) {
    const A = blurRGB(a, w, h, radius)
    const B = blurRGB(b, w, h, radius)
    let sum = 0
    let n = 0
    for (let i = 0; i < w * h; i++) {
      if (!maskA[i] && !maskB[i]) continue
      const j = i * 3
      const d = Math.max(
        Math.abs(A[j] - B[j]), Math.abs(A[j + 1] - B[j + 1]), Math.abs(A[j + 2] - B[j + 2]))
      sum += d / 255
      n++
    }
    scaled += weight * (1 - (n ? sum / n : 0))
  }
  const bgDiff = Math.max(
    Math.abs(bgA[0] - bgB[0]), Math.abs(bgA[1] - bgB[1]), Math.abs(bgA[2] - bgB[2])) / 255
  return 0.85 * scaled + 0.15 * (1 - bgDiff)
}

/** box blur (two-pass running sum), RGB only, cropped to w×h */
function blurRGB(img: ImageData, w: number, h: number, radius: number): Float32Array {
  const src = new Float32Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * img.width + x) * 4
      const j = (y * w + x) * 3
      src[j] = img.data[i]
      src[j + 1] = img.data[i + 1]
      src[j + 2] = img.data[i + 2]
    }
  }
  if (radius < 1) return src
  const tmp = new Float32Array(w * h * 3)
  // horizontal
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0
      let count = 0
      for (let x = -radius; x < w; x++) {
        const add = x + radius
        if (add < w) { sum += src[(y * w + add) * 3 + c]; count++ }
        const sub = x - radius - 1
        if (sub >= 0) { sum -= src[(y * w + sub) * 3 + c]; count-- }
        if (x >= 0) tmp[(y * w + x) * 3 + c] = sum / count
      }
    }
  }
  // vertical
  const out = new Float32Array(w * h * 3)
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0
      let count = 0
      for (let y = -radius; y < h; y++) {
        const add = y + radius
        if (add < h) { sum += tmp[(add * w + x) * 3 + c]; count++ }
        const sub = y - radius - 1
        if (sub >= 0) { sum -= tmp[(sub * w + x) * 3 + c]; count-- }
        if (y >= 0) out[(y * w + x) * 3 + c] = sum / count
      }
    }
  }
  return out
}

/** per-pixel verdicts shared by the score and the region clustering — one
 * implementation so the two can never drift apart */
interface PixelClassification {
  w: number
  h: number
  total: number
  content: number
  diff: number
  /** 1 where the pixel is content (differs from background) in either raster */
  contentMask: Uint8Array
  /** 1 where a content pixel differs beyond the spatial tolerance */
  diffMask: Uint8Array
}

function classifyPixels(a: ImageData, b: ImageData): PixelClassification {
  const w = Math.min(a.width, b.width)
  const h = Math.min(a.height, b.height)
  const total = w * h
  const [bgR, bgG, bgB] = estimateBackground(a)
  const contentMask = new Uint8Array(total)
  const diffMask = new Uint8Array(total)

  // spatial tolerance: thin strokes and glyph edges shift by a pixel
  // between two independent rasterizations; a pixel is MATCHED when any
  // pixel in the other raster's 1-neighborhood matches it. Without this,
  // content weighting punishes sub-pixel offsets as total mismatches.
  const at = (img: ImageData, x: number, y: number): number => (y * img.width + x) * 4
  const neighborMatch = (from: ImageData, to: ImageData, x: number, y: number): boolean => {
    const i = at(from, x, y)
    for (const [dx, dy] of NEIGHBORHOOD) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const j = at(to, nx, ny)
      const d = Math.max(
        Math.abs(from.data[i] - to.data[j]),
        Math.abs(from.data[i + 1] - to.data[j + 1]),
        Math.abs(from.data[i + 2] - to.data[j + 2]),
      )
      if (d <= CHANNEL_TOLERANCE) return true
    }
    return false
  }

  let diff = 0
  let content = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ia = at(a, x, y)
      const ib = at(b, x, y)
      const aContent =
        Math.abs(a.data[ia] - bgR) > CHANNEL_TOLERANCE ||
        Math.abs(a.data[ia + 1] - bgG) > CHANNEL_TOLERANCE ||
        Math.abs(a.data[ia + 2] - bgB) > CHANNEL_TOLERANCE
      const bContent =
        Math.abs(b.data[ib] - bgR) > CHANNEL_TOLERANCE ||
        Math.abs(b.data[ib + 1] - bgG) > CHANNEL_TOLERANCE ||
        Math.abs(b.data[ib + 2] - bgB) > CHANNEL_TOLERANCE
      if (!aContent && !bContent) continue // matching background — never a diff
      content++
      contentMask[y * w + x] = 1
      if (!neighborMatch(a, b, x, y) || !neighborMatch(b, a, x, y)) {
        diff++
        diffMask[y * w + x] = 1
      }
    }
  }
  return { w, h, total, content, diff, contentMask, diffMask }
}

/** a clustered mismatch area, in FRACTIONS of the raster (0..1) so callers
 * can map it onto any coordinate space (slide %, VLM crop, overlay) */
export interface DiffRegion {
  x: number
  y: number
  w: number
  h: number
  /** differing share of the region's content pixels, 0..1 */
  frac: number
}

/** grid granularity for region clustering (12×12 cells over the raster) */
const REGION_GRID = 12
/** a cell is "hot" when its differing pixels beat noise: an absolute floor
 * and a share of the cell's area */
const REGION_MIN_PIXELS = 4
const REGION_MIN_CELL_FRAC = 0.015

/** Cluster differing CONTENT pixels into up to maxRegions bounding boxes —
 * the WHERE of a fidelity miss, for region-targeted repair prompts and the
 * human-facing read-out. Same pixel verdicts as diffBitmaps. */
export function diffRegions(a: ImageData, b: ImageData, maxRegions = 4): DiffRegion[] {
  const c = classifyPixels(a, b)
  if (c.diff === 0) return []
  const cellW = Math.ceil(c.w / REGION_GRID)
  const cellH = Math.ceil(c.h / REGION_GRID)

  // per-cell differing-pixel counts
  const cells = new Float64Array(REGION_GRID * REGION_GRID)
  for (let y = 0; y < c.h; y++) {
    for (let x = 0; x < c.w; x++) {
      if (!c.diffMask[y * c.w + x]) continue
      const gx = Math.min(REGION_GRID - 1, Math.floor(x / cellW))
      const gy = Math.min(REGION_GRID - 1, Math.floor(y / cellH))
      cells[gy * REGION_GRID + gx]++
    }
  }
  const cellArea = cellW * cellH
  const hot = new Uint8Array(cells.length)
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] >= REGION_MIN_PIXELS && cells[i] / cellArea > REGION_MIN_CELL_FRAC) hot[i] = 1
  }

  // 4-connected components of hot cells → bounding boxes, heaviest first
  const visited = new Uint8Array(hot.length)
  const comps: Array<{ minX: number; minY: number; maxX: number; maxY: number; weight: number }> = []
  for (let start = 0; start < hot.length; start++) {
    if (!hot[start] || visited[start]) continue
    const comp = { minX: REGION_GRID, minY: REGION_GRID, maxX: -1, maxY: -1, weight: 0 }
    const stack = [start]
    visited[start] = 1
    while (stack.length > 0) {
      const cur = stack.pop()!
      const cx = cur % REGION_GRID
      const cy = Math.floor(cur / REGION_GRID)
      comp.minX = Math.min(comp.minX, cx)
      comp.minY = Math.min(comp.minY, cy)
      comp.maxX = Math.max(comp.maxX, cx)
      comp.maxY = Math.max(comp.maxY, cy)
      comp.weight += cells[cur]
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cx + dx
        const ny = cy + dy
        if (nx < 0 || ny < 0 || nx >= REGION_GRID || ny >= REGION_GRID) continue
        const ni = ny * REGION_GRID + nx
        if (hot[ni] && !visited[ni]) { visited[ni] = 1; stack.push(ni) }
      }
    }
    comps.push(comp)
  }
  comps.sort((p, q) => q.weight - p.weight)

  const round3 = (v: number): number => Math.round(v * 1000) / 1000
  return comps.slice(0, maxRegions).map((m) => {
    const px = m.minX * cellW
    const py = m.minY * cellH
    const pw = Math.min((m.maxX + 1) * cellW, c.w) - px
    const ph = Math.min((m.maxY + 1) * cellH, c.h) - py
    let content = 0
    let diff = 0
    for (let y = py; y < py + ph; y++) {
      for (let x = px; x < px + pw; x++) {
        const i = y * c.w + x
        if (c.contentMask[i]) content++
        if (c.diffMask[i]) diff++
      }
    }
    return {
      x: round3(px / c.w),
      y: round3(py / c.h),
      w: round3(pw / c.w),
      h: round3(ph / c.h),
      frac: round3(content > 0 ? Math.min(1, diff / content) : 1),
    }
  })
}

/** 3×3 neighborhood, center first (the common case exits immediately) */
const NEIGHBORHOOD: Array<[number, number]> = [
  [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
]

/** the raster's dominant color from a sparse grid — the background of the
 * ORIGINAL side, against which content mass is measured */
function estimateBackground(img: ImageData): [number, number, number] {
  const counts = new Map<number, number>()
  const step = 7 * 4 // every 7th pixel
  for (let i = 0; i < img.data.length; i += step) {
    // quantize to 16-levels per channel so anti-aliasing coalesces
    const key = ((img.data[i] >> 4) << 8) | ((img.data[i + 1] >> 4) << 4) | (img.data[i + 2] >> 4)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let bestKey = 0
  let bestCount = -1
  for (const [k, c] of counts) if (c > bestCount) { bestKey = k; bestCount = c }
  return [
    ((bestKey >> 8) & 15) * 16 + 8,
    ((bestKey >> 4) & 15) * 16 + 8,
    (bestKey & 15) * 16 + 8,
  ]
}

/** Score one slide: original region (executed iframe) vs converted region
 * (converted-deck iframe). Null when either side won't rasterize. */
export async function scoreSlideFidelity(
  originalEl: HTMLElement,
  convertedEl: HTMLElement,
): Promise<FidelityScore | null> {
  const [orig, conv] = await Promise.all([rasterizeRegion(originalEl), rasterizeRegion(convertedEl)])
  if (!orig || !conv) return null
  return diffBitmaps(orig, conv)
}

/** everything one measurement produces, from the SAME pair of rasters —
 * the score, the clustered mismatch regions, and the human/VLM heatmap */
export interface SlideDiff {
  score: FidelityScore
  regions: DiffRegion[]
  /** PNG data URL — red marks differing content, dim grayscale matches */
  heatmapUrl: string | null
  /** vertical displacement as a fraction of height (positive = the
   * candidate's content sits LOWER than the original); null when no single
   * shift explains the mismatch */
  verticalDrift: number | null
}

/** Detailed measurement for the review: score + regions + heatmap computed
 * from one rasterization pass, so all three describe the same pixels. */
export async function scoreSlideFidelityDetailed(
  originalEl: HTMLElement,
  convertedEl: HTMLElement,
): Promise<SlideDiff | null> {
  const [orig, conv] = await Promise.all([rasterizeRegion(originalEl), rasterizeRegion(convertedEl)])
  if (!orig || !conv) return null
  return {
    score: diffBitmaps(orig, conv),
    regions: diffRegions(orig, conv),
    heatmapUrl: diffHeatmapDataUrl(orig, conv),
    verticalDrift: estimateVerticalDrift(orig, conv),
  }
}

/** row-wise content mass against the raster's own background estimate */
function rowProfile(img: ImageData): Float32Array {
  const [bgR, bgG, bgB] = estimateBackground(img)
  const prof = new Float32Array(img.height)
  for (let y = 0; y < img.height; y++) {
    let n = 0
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4
      if (
        Math.abs(img.data[i] - bgR) > INK_TOLERANCE ||
        Math.abs(img.data[i + 1] - bgG) > INK_TOLERANCE ||
        Math.abs(img.data[i + 2] - bgB) > INK_TOLERANCE
      ) n++
    }
    prof[y] = n
  }
  return prof
}

/** The single vertical shift that best aligns the two rasters' row-content
 * profiles, as a fraction of height (positive = candidate content LOWER).
 * A pixel diff counts a displaced block twice — missing here, extra there —
 * but never says "this is a SPACING miss"; this turns that double penalty
 * into an actionable direction for repair. Returns null when either raster
 * is nearly blank, or when no shift beats the unshifted alignment by enough
 * to be the story (structural mismatches, not spacing). */
export function estimateVerticalDrift(a: ImageData, b: ImageData): number | null {
  const h = Math.min(a.height, b.height)
  if (h < 8) return null
  const pa = rowProfile(a)
  const pb = rowProfile(b)
  let massA = 0
  let massB = 0
  for (let y = 0; y < h; y++) { massA += pa[y]; massB += pb[y] }
  if (massA < h || massB < h) return null
  const cost = (k: number): number => {
    let c = 0
    for (let y = 0; y < h; y++) {
      const yb = y + k
      c += Math.abs(pa[y] - (yb >= 0 && yb < h ? pb[yb] : 0))
    }
    return c
  }
  const base = cost(0)
  if (base === 0) return null
  const maxShift = Math.floor(h / 4)
  let bestK = 0
  let bestC = base
  for (let k = -maxShift; k <= maxShift; k++) {
    if (k === 0) continue
    const c = cost(k)
    if (c < bestC) { bestC = c; bestK = k }
  }
  // the shift must explain a real chunk of the profile mismatch
  if (bestK === 0 || bestC > base * 0.7) return null
  return bestK / h
}

/** Deep-clone with every element's computed style inlined, so the clone
 * renders identically without its document's stylesheets (which do not ride
 * along into SVG-as-image). Scripts are dropped. */
/** drive every finite animation in the subtree to its filled end state, so
 * computed styles read the SETTLED presentation, not a mid-flight frame */
export function settleAnimations(el: Element): void {
  const target = el as Element & { getAnimations?: (o: { subtree: boolean }) => Animation[] }
  try {
    for (const anim of target.getAnimations?.({ subtree: true }) ?? []) {
      try {
        const timing = anim.effect?.getComputedTiming()
        if (timing && timing.iterations !== Infinity) anim.finish()
      } catch { /* unfinishable animation — leave it */ }
    }
  } catch { /* getAnimations unavailable — nothing to settle */ }
}

/* Custom bullets, numbering, and decorations live in ::before/::after
 * pseudo-elements — sources set `list-style: none` and draw "▸" markers in
 * CSS. Pseudo content does not survive cloning, so converted lists showed
 * NAKED lines. Materialize each rendered, string-valued pseudo-element as a
 * real span carrying its paint; counters/attr() are skipped (they need the
 * cascade), and the UA's default list markers need nothing — they render
 * from the <ul>/<ol> structure the conversion preserves. */
export function inlinePseudoContent(liveRoot: HTMLElement, clone: HTMLElement): void {
  const win = liveRoot.ownerDocument.defaultView
  if (!win) return
  const live = [liveRoot, ...liveRoot.querySelectorAll('*')]
  const out = [clone, ...clone.querySelectorAll('*')]
  for (let i = 0; i < live.length && i < out.length; i++) {
    if (live[i].closest('svg')) continue // svg has no pseudo content to carry
    for (const which of ['::before', '::after'] as const) {
      const cs = win.getComputedStyle(live[i], which)
      const content = cs.content
      if (!content || content === 'none' || content === 'normal') continue
      const m = /^"([^"]*)"$/.exec(content) ?? /^'([^']*)'$/.exec(content)
      if (!m || m[1] === '') continue
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue
      const span = liveRoot.ownerDocument.createElement('span')
      // the class lets conversion RECOGNIZE materialized pseudo content
      // (list-marker detection); it is unstyled and harmless elsewhere
      span.className = 'dia-pseudo-marker'
      span.textContent = m[1]
      const style: string[] = [`color: ${cs.color}`]
      if (cs.fontWeight !== '400') style.push(`font-weight: ${cs.fontWeight}`)
      if (parseFloat(cs.fontSize) > 0) style.push(`font-size: ${cs.fontSize}`)
      if (parseFloat(cs.marginRight) > 0) style.push(`margin-right: ${cs.marginRight}`)
      if (parseFloat(cs.marginLeft) > 0) style.push(`margin-left: ${cs.marginLeft}`)
      if (cs.position === 'absolute') {
        // hanging markers keep their offset relative to the (positioned) item
        style.push('position: absolute', `left: ${cs.left}`, `top: ${cs.top}`)
      }
      span.setAttribute('style', style.join('; '))
      if (which === '::before') out[i].insertBefore(span, out[i].firstChild)
      else out[i].appendChild(span)
    }
  }
}

function cloneWithComputedStyles(el: Element, win: Window): Element {
  const clone = el.cloneNode(true) as Element
  const srcWalk = collectElements(el)
  const cloneWalk = collectElements(clone)
  // pseudo-element content (custom bullets, numbering) does not survive
  // cloning; materialize it BEFORE style inlining so both the original's
  // live markers and the conversion's materialized spans rasterize alike
  if (el instanceof HTMLElement && clone instanceof HTMLElement) {
    try { inlinePseudoContent(el, clone) } catch { /* measurement still valid without */ }
  }
  for (let i = 0; i < srcWalk.length && i < cloneWalk.length; i++) {
    const src = srcWalk[i]
    const dst = cloneWalk[i]
    if (dst.tagName === 'SCRIPT') continue
    const cs = win.getComputedStyle(src)
    let cssText = ''
    for (let p = 0; p < cs.length; p++) {
      const prop = cs[p]
      cssText += `${prop}:${cs.getPropertyValue(prop)};`
    }
    // the frozen computed values ARE the presentation — declared animations
    // must not re-interpret them in whatever renderer shows this clone
    cssText += 'animation:none;transition:none;'
    dst.setAttribute('style', cssText)
  }
  for (const s of clone.querySelectorAll('script, noscript')) s.remove()
  return clone
}

function collectElements(root: Element): Element[] {
  return [root, ...root.querySelectorAll('*')]
}

/** first non-transparent background color on the element or its ancestors */
function effectiveBackground(el: Element, win: Window): string {
  let cur: Element | null = el
  while (cur) {
    const bg = win.getComputedStyle(cur).backgroundColor
    if (bg && bg !== 'transparent' && !/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\)/.test(bg)) {
      return bg
    }
    cur = cur.parentElement
  }
  return '#ffffff'
}
