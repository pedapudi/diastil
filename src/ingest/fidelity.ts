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

/** Rasterize a rendered element (styles resolved in ITS OWN document) to
 * ImageData at sample size. Returns null when rasterization fails. */
export async function rasterizeRegion(el: HTMLElement): Promise<ImageData | null> {
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
  canvas.width = SAMPLE_W
  canvas.height = SAMPLE_H
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, SAMPLE_W, SAMPLE_H)
  try {
    ctx.drawImage(img, 0, 0, SAMPLE_W, SAMPLE_H)
    return ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H)
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
function cloneWithComputedStyles(el: HTMLElement, win: Window): HTMLElement {
  const clone = el.cloneNode(true) as HTMLElement
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
