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
const RASTER_TIMEOUT_MS = 3000

/** slides scoring below this are offered an automatic service repair round */
export const REPAIR_THRESHOLD = 0.85

export interface FidelityScore {
  /** 1 − differing fraction over CONTENT pixels, 0..1 */
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

/** Pixel-diff two same-size rasters, scored over CONTENT pixels.
 *
 * A slide is mostly background; scoring over ALL pixels lets a
 * background-dominated slide read 0.9 while its content is destroyed —
 * on a dark deck, a five-card pipeline collapsing into one giant clipped
 * figure still "matches" on ~90% of pixels because black matches black.
 * The denominator is therefore the pixels that differ from the background
 * in EITHER raster; blank-ish slides fall back to the total so near-empty
 * originals don't divide by noise. */
export function diffBitmaps(a: ImageData, b: ImageData): FidelityScore {
  const w = Math.min(a.width, b.width)
  const h = Math.min(a.height, b.height)
  const total = w * h
  const [bgR, bgG, bgB] = estimateBackground(a)

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
      if (aContent || bContent) content++
      else continue // matching background — never a diff
      if (!neighborMatch(a, b, x, y) || !neighborMatch(b, a, x, y)) diff++
    }
  }
  const denom = content >= total * 0.005 ? content : total
  const score = Math.round(Math.max(0, 1 - diff / denom) * 1000) / 1000
  return { score, diffPixels: diff, totalPixels: total, contentPixels: content }
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

function cloneWithComputedStyles(el: Element, win: Window): Element {
  const clone = el.cloneNode(true) as Element
  const srcWalk = collectElements(el)
  const cloneWalk = collectElements(clone)
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
