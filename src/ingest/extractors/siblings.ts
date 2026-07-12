/* Generic structural repetition: body-level (or shallow) siblings sharing
 * tag+class rendered at viewport scale (≥40% of the viewport).
 * - 3+ siblings qualify when their LARGEST member is viewport-scale: decks
 *   that show one slide at a time hide the rest (display:none → zero area),
 *   so the median would reject exactly the decks this exists to catch.
 * - exactly 2 qualify only when both are laid out and stacked vertically
 *   without overlap (a two-page deck, not a two-column layout).
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

    // collect qualifying groups at every depth (≤3), then pick the one with
    // the most members — a shallow pair of page wrappers must not shadow the
    // twelve real slides one level down. Ties go to the shallower group.
    let best: { g: HTMLElement[]; depth: number } | null = null
    const queue: Array<{ el: HTMLElement; depth: number }> = [{ el: doc.body, depth: 0 }]
    while (queue.length > 0) {
      const { el, depth } = queue.shift()!
      for (const g of groupSiblings(el).values()) {
        if (g.length < 2) continue
        if (g.length === 2 && !stackedVertically(g[0], g[1])) continue
        const areas = g
          .map((n) => { const r = n.getBoundingClientRect(); return r.width * r.height })
          .sort((a, b) => a - b)
        const gate = g.length >= 3 ? areas[areas.length - 1] : areas[Math.floor(areas.length / 2)]
        if (gate < minArea) continue
        if (!best || g.length > best.g.length) best = { g, depth }
      }
      if (depth < 3) {
        for (const c of el.children) {
          if (!SKIP_TAGS.has(c.tagName.toUpperCase())) queue.push({ el: c as HTMLElement, depth: depth + 1 })
        }
      }
    }
    return best?.g ?? null
  },
}

/** Group an element's children by tag + class set, folding state-class
 * variants: a child whose classes strictly contain another group's classes
 * is the same kind of element wearing a state class — deck runtimes mark
 * the current slide with "on"/"active"/"current", which must not split the
 * slide group. Members keep document order. */
function groupSiblings(el: HTMLElement): Map<string, HTMLElement[]> {
  type Group = { classes: string[]; els: HTMLElement[] }
  const byTag = new Map<string, Group[]>()
  for (const c of el.children) {
    const tag = c.tagName.toUpperCase()
    if (SKIP_TAGS.has(tag)) continue
    const classes = [...(c as HTMLElement).classList].sort()
    let bucket = byTag.get(tag)
    if (!bucket) byTag.set(tag, (bucket = []))
    // exact match, else fold into the base group this one extends, else new
    let group = bucket.find((g) => sameSet(g.classes, classes))
    if (!group) group = bucket.find((g) => isSubset(g.classes, classes))
    if (group) group.els.push(c as HTMLElement)
    else bucket.push({ classes, els: [c as HTMLElement] })
  }
  // second pass: a base group appearing after its variant (base ⊂ variant)
  const out = new Map<string, HTMLElement[]>()
  for (const [tag, bucket] of byTag) {
    for (let i = bucket.length - 1; i >= 0; i--) {
      const base = bucket.find((g) => g !== bucket[i] && isSubset(g.classes, bucket[i].classes))
      if (base) {
        base.els.push(...bucket[i].els)
        base.els.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
        bucket.splice(i, 1)
      }
    }
    for (const g of bucket) out.set(`${tag}|${g.classes.join(' ')}`, g.els)
  }
  return out
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/** every class in `sub` appears in `sup` (proper or equal subset) */
function isSubset(sub: string[], sup: string[]): boolean {
  return sub.every((x) => sup.includes(x))
}

/** page flow (one below the other), not a side-by-side split */
function stackedVertically(a: HTMLElement, b: HTMLElement): boolean {
  const ra = a.getBoundingClientRect()
  const rb = b.getBoundingClientRect()
  return ra.bottom <= rb.top + 1 || rb.bottom <= ra.top + 1
}
