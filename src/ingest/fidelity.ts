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
  /** 1 − differing-pixel fraction, 0..1 */
  score: number
  diffPixels: number
  totalPixels: number
}

/** Rasterize a rendered element (styles resolved in ITS OWN document) onto a
 * canvas of the given size. Returns null when rasterization fails. */
async function rasterizeToCanvas(el: Element, w: number, h: number): Promise<HTMLCanvasElement | null> {
  const win = el.ownerDocument.defaultView
  if (!win) return null
  const rect = el.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return null

  const clone = cloneWithComputedStyles(el, win)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(rect.width)}" height="${Math.round(rect.height)}">` +
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

/** VLM-legible raster: PNG data URL at up to VLM_W wide, aspect preserved.
 * These feed multimodal skill calls (repair rounds, diagram lifts) so the
 * model can SEE the mismatch instead of inferring it from HTML. */
const VLM_W = 768
export async function rasterizeToDataUrl(el: Element): Promise<string | null> {
  const rect = el.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return null
  const w = Math.min(VLM_W, Math.round(rect.width))
  const h = Math.max(1, Math.round((rect.height / rect.width) * w))
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

/** Pixel-diff two same-size rasters. */
export function diffBitmaps(a: ImageData, b: ImageData): FidelityScore {
  const total = Math.min(a.data.length, b.data.length) / 4
  let diff = 0
  for (let i = 0; i < total * 4; i += 4) {
    const d = Math.max(
      Math.abs(a.data[i] - b.data[i]),
      Math.abs(a.data[i + 1] - b.data[i + 1]),
      Math.abs(a.data[i + 2] - b.data[i + 2]),
    )
    if (d > CHANNEL_TOLERANCE) diff++
  }
  return { score: Math.round((1 - diff / total) * 1000) / 1000, diffPixels: diff, totalPixels: total }
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
