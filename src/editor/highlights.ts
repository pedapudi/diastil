/* Highlight-for-context: the user shades a region of a slide to tell the
 * model WHERE to look. Regions live as slide fractions (0..1), render as
 * accent overlays for the human, get stamped onto the PNGs a vision model
 * receives, and are described in the prompt text — three views of one fact.
 * Shared by the import review (original/converted panes) and the editor's
 * copilot rail. */

export interface HighlightRegion {
  x: number
  y: number
  w: number
  h: number
}

/** draw the regions onto a PNG data URL: translucent accent fill + border.
 * The note text tells the model what the boxes mean. */
export async function stampHighlights(dataUrl: string, regions: HighlightRegion[]): Promise<string> {
  if (regions.length === 0) return dataUrl
  const img = new Image()
  const ok = await new Promise<boolean>((resolve) => {
    img.onload = () => resolve(true)
    img.onerror = () => resolve(false)
    img.src = dataUrl
  })
  if (!ok) return dataUrl
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return dataUrl
  ctx.drawImage(img, 0, 0)
  for (const r of regions) {
    const x = r.x * canvas.width
    const y = r.y * canvas.height
    const w = r.w * canvas.width
    const h = r.h * canvas.height
    ctx.fillStyle = 'rgba(255, 170, 0, 0.22)'
    ctx.fillRect(x, y, w, h)
    ctx.strokeStyle = 'rgba(255, 140, 0, 0.95)'
    ctx.lineWidth = Math.max(2, canvas.width / 320)
    ctx.strokeRect(x, y, w, h)
  }
  try {
    return canvas.toDataURL('image/png')
  } catch {
    return dataUrl
  }
}

/** one prompt line per region — fractions, origin top-left */
export function describeHighlights(regions: HighlightRegion[], where: string): string {
  if (regions.length === 0) return ''
  const lines = regions.map((r) =>
    `- x=${r.x.toFixed(2)} y=${r.y.toFixed(2)} w=${r.w.toFixed(2)} h=${r.h.toFixed(2)}`)
  return (
    `the reviewer highlighted ${regions.length} region${regions.length > 1 ? 's' : ''} on ${where} ` +
    '(drawn as orange boxes on the attached render; fractions of the slide, origin top-left) — ' +
    'treat them as the focus:\n' + lines.join('\n')
  )
}

/** render regions as overlay boxes inside a host layer (host = the slide's
 * displayed box); clicking a box removes that region via onRemove */
export function renderHighlightBoxes(
  layer: HTMLElement, regions: HighlightRegion[], onRemove: (index: number) => void,
): void {
  layer.textContent = ''
  for (const [i, r] of regions.entries()) {
    const box = document.createElement('div')
    box.className = 'dia-hl-box'
    box.style.left = `${r.x * 100}%`
    box.style.top = `${r.y * 100}%`
    box.style.width = `${r.w * 100}%`
    box.style.height = `${r.h * 100}%`
    box.title = 'highlighted for the model — click to remove'
    box.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); onRemove(i) })
    layer.appendChild(box)
  }
}

/** marquee-drag inside a layer; emits the dragged rect as fractions of the
 * layer box. Ignores sub-1% drags (clicks). Returns an uninstall fn. */
export function installMarquee(
  layer: HTMLElement, onRegion: (r: HighlightRegion) => void,
): () => void {
  const down = (e: PointerEvent): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const box = layer.getBoundingClientRect()
    if (box.width < 2 || box.height < 2) return
    const x0 = (e.clientX - box.x) / box.width
    const y0 = (e.clientY - box.y) / box.height
    const ghost = document.createElement('div')
    ghost.className = 'dia-hl-box is-ghost'
    layer.appendChild(ghost)
    let cur = { x: x0, y: y0, w: 0, h: 0 }
    const move = (ev: PointerEvent): void => {
      const x1 = Math.min(Math.max((ev.clientX - box.x) / box.width, 0), 1)
      const y1 = Math.min(Math.max((ev.clientY - box.y) / box.height, 0), 1)
      cur = {
        x: Math.min(x0, x1), y: Math.min(y0, y1),
        w: Math.abs(x1 - x0), h: Math.abs(y1 - y0),
      }
      ghost.style.left = `${cur.x * 100}%`
      ghost.style.top = `${cur.y * 100}%`
      ghost.style.width = `${cur.w * 100}%`
      ghost.style.height = `${cur.h * 100}%`
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      ghost.remove()
      if (cur.w > 0.01 && cur.h > 0.01) {
        onRegion({
          x: round3(cur.x), y: round3(cur.y), w: round3(cur.w), h: round3(cur.h),
        })
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  layer.addEventListener('pointerdown', down)
  return () => layer.removeEventListener('pointerdown', down)
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}
