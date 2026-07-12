/* Generic structural repetition: body-level (or shallow) siblings sharing
 * tag+class whose median rendered area covers ≥40% of the viewport — 3+
 * siblings always qualify; exactly 2 qualify only when they are stacked
 * vertically without overlap (a two-page deck, not a two-column layout).
 * Catches bespoke `class="slide"` variants and most agent-generated decks.
 * Needs layout, so it only fires on executed documents. */

import { EXEC_W, EXEC_H } from '../execute'
import type { SlideExtractor } from './index'

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'NOSCRIPT', 'TEMPLATE'])

export const siblings: SlideExtractor = {
  name: 'siblings',
  detect(doc) {
    const win = doc.defaultView
    if (!win || !doc.body) return null
    const vw = win.innerWidth || EXEC_W
    const vh = win.innerHeight || EXEC_H
    const minArea = 0.4 * vw * vh
    const queue: Array<{ el: HTMLElement; depth: number }> = [{ el: doc.body, depth: 0 }]
    while (queue.length > 0) {
      const { el, depth } = queue.shift()!
      const groups = new Map<string, HTMLElement[]>()
      for (const c of el.children) {
        if (SKIP_TAGS.has(c.tagName.toUpperCase())) continue
        const key = `${c.tagName}|${c.getAttribute('class') ?? ''}`
        const g = groups.get(key)
        if (g) g.push(c as HTMLElement)
        else groups.set(key, [c as HTMLElement])
      }
      let best: HTMLElement[] | null = null
      for (const g of groups.values()) {
        if (g.length < 2) continue
        if (g.length === 2 && !stackedVertically(g[0], g[1])) continue
        const areas = g
          .map((n) => { const r = n.getBoundingClientRect(); return r.width * r.height })
          .sort((a, b) => a - b)
        if (areas[Math.floor(areas.length / 2)] < minArea) continue
        if (!best || g.length > best.length) best = g
      }
      if (best) return best
      if (depth < 3) {
        for (const c of el.children) {
          if (!SKIP_TAGS.has(c.tagName.toUpperCase())) queue.push({ el: c as HTMLElement, depth: depth + 1 })
        }
      }
    }
    return null
  },
}

/** page flow (one below the other), not a side-by-side split */
function stackedVertically(a: HTMLElement, b: HTMLElement): boolean {
  const ra = a.getBoundingClientRect()
  const rb = b.getBoundingClientRect()
  return ra.bottom <= rb.top + 1 || rb.bottom <= ra.top + 1
}
