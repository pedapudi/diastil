/* EXTRACT — step 2 of ingest: deterministic slide detection, computed-style
 * harvest, and token clustering from the executed document. No model.
 *
 * Every element inside a detected slide is stamped with a data-dia-x index so
 * convert.ts can look up its rendered rect + computed style after the slide's
 * outerHTML is re-parsed. Stamps are stripped from all outputs. */

import type { ExecuteResult } from './execute'
import { EXEC_H, EXEC_W } from './execute'

export const STAMP = 'data-dia-x'

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'])

export interface ElementSample {
  x: number
  y: number
  w: number
  h: number
  fontSizePx: number
  fontFamily: string
  color: string
  fontWeight: number
  letterSpacing: string
  textTransform: string
  position: string
  objectFit: string
  /** length of the element's own (direct) text, whitespace-normalized */
  ownChars: number
  ownText: string
}

export interface ExtractedSlide {
  index: number
  /** live element inside the executed iframe (valid until the iframe reloads) */
  source: HTMLElement
  /** rendered outerHTML, stamped with data-dia-x for sample lookup */
  html: string
  /** stamp-free, script-free subtree — service input / island source */
  sourceHtml: string
  /** self-contained single-slide page (source styles inlined) */
  originalHtml: string
  rect: { x: number; y: number; w: number; h: number }
  bg: string
  samples: Record<number, ElementSample>
  /** every visible text node, whitespace-normalized — the text-sacred set */
  texts: string[]
  padPx: number
  gaps: number[]
}

export interface Extraction {
  slides: ExtractedSlide[]
  tokens: Record<string, string>
  warnings: string[]
  method: string
}

/* ---------------- slide detection ---------------- */

/* Detection lives in the extractor plugin registry (extractors/); re-exported
 * here so extraction consumers keep one import surface. */
import { findSlideRoots } from './extractors/index'
export { findSlideRoots }

/* ---------------- extraction ---------------- */

export function extractSlides(exec: ExecuteResult): Extraction {
  const doc = exec.doc
  const win = doc.defaultView
  if (!win) throw new Error('ingest: executed document has no window — cannot harvest computed styles')

  const { roots, method } = findSlideRoots(doc)
  const warnings = [...exec.warnings]
  if (method === 'body') {
    warnings.push('no slide structure detected — the whole body was imported as one slide')
  }

  const counter = { n: 0 }
  const slides = roots.map((root, i) => harvestSlide(root, i, doc, win, counter))
  const tokens = harvestTokens(slides)
  return { slides, tokens, warnings, method }
}

function harvestSlide(
  root: HTMLElement,
  index: number,
  doc: Document,
  win: Window,
  counter: { n: number },
): ExtractedSlide {
  // one-visible-at-a-time decks hide non-current slides; reveal this one
  // for the duration of sampling so geometry and computed styles are real
  const unforce = forceVisible(root)
  try {
    return harvestVisibleSlide(root, index, doc, win, counter)
  } finally {
    unforce?.()
  }
}

/** temporarily force a hidden slide root to lay out; returns the restore fn */
export function forceVisible(root: HTMLElement): (() => void) | null {
  if (root.getBoundingClientRect().width > 1) return null
  const prevDisplay = root.style.display
  const prevVisibility = root.style.visibility
  root.style.display = 'block'
  root.style.visibility = 'visible'
  return () => {
    root.style.display = prevDisplay
    root.style.visibility = prevVisibility
  }
}

function harvestVisibleSlide(
  root: HTMLElement,
  index: number,
  doc: Document,
  win: Window,
  counter: { n: number },
): ExtractedSlide {
  const samples: Record<number, ElementSample> = {}
  const gaps: number[] = []

  const all: Element[] = [root, ...root.querySelectorAll('*')]
  for (const el of all) {
    if (SKIP_TAGS.has(el.tagName.toUpperCase())) continue
    const idx = counter.n++
    el.setAttribute(STAMP, String(idx))
    const cs = win.getComputedStyle(el)
    const r = el.getBoundingClientRect()
    const ownText = directText(el)
    samples[idx] = {
      x: r.left + win.scrollX,
      y: r.top + win.scrollY,
      w: r.width,
      h: r.height,
      fontSizePx: parseFloat(cs.fontSize) || 0,
      fontFamily: cs.fontFamily,
      color: cs.color,
      fontWeight: parseFloat(cs.fontWeight) || 400,
      letterSpacing: cs.letterSpacing,
      textTransform: cs.textTransform,
      position: cs.position,
      objectFit: cs.objectFit,
      ownChars: ownText.length,
      ownText,
    }
    if ((cs.display === 'flex' || cs.display === 'grid' || cs.display.includes('flex') || cs.display.includes('grid'))) {
      const g = parseFloat(cs.columnGap)
      if (g > 0) gaps.push(g)
    }
  }

  const rootCs = win.getComputedStyle(root)
  const r = root.getBoundingClientRect()

  return {
    index,
    source: root,
    html: root.outerHTML,
    sourceHtml: cleanSubtree(root),
    originalHtml: buildOriginalPage(doc, root),
    rect: { x: r.left + win.scrollX, y: r.top + win.scrollY, w: r.width, h: r.height },
    bg: effectiveBg(root, win),
    samples,
    texts: collectTexts(root, win),
    padPx: parseFloat(rootCs.paddingLeft) || 0,
    gaps,
  }
}

/** direct (own) text of an element, normalized */
function directText(el: Element): string {
  let out = ''
  for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) out += n.textContent ?? ''
  return norm(out)
}

export function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** every visible, non-script text node under root — the text-sacred set */
function collectTexts(root: HTMLElement, win: Window): string[] {
  const out: string[] = []
  const hiddenCache = new Map<Element, boolean>()
  const hidden = (el: Element): boolean => {
    const cached = hiddenCache.get(el)
    if (cached !== undefined) return cached
    let value = false
    const cs = win.getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') value = true
    else if (el.parentElement && el.parentElement !== root.parentElement) value = hidden(el.parentElement)
    hiddenCache.set(el, value)
    return value
  }
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = (n as Text).parentElement
    if (!parent) continue
    if (parent.closest('script, style, noscript, template')) continue
    if (hidden(parent)) continue
    const t = norm(n.textContent ?? '')
    if (t) out.push(t)
  }
  return out
}

function effectiveBg(el: Element, win: Window): string {
  let cur: Element | null = el
  while (cur) {
    const bg = win.getComputedStyle(cur).backgroundColor
    const rgba = parseColor(bg)
    if (rgba && rgba[3] > 0.02) return bg
    cur = cur.parentElement
  }
  return 'rgb(255, 255, 255)'
}

/** stamp-free, script-free clone of the subtree (body roots become a div) */
function cleanSubtree(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement
  for (const s of clone.querySelectorAll('script, noscript')) s.remove()
  for (const el of [clone, ...clone.querySelectorAll(`[${STAMP}]`)]) el.removeAttribute(STAMP)
  if (clone.tagName === 'BODY') {
    const div = root.ownerDocument.createElement('div')
    div.innerHTML = clone.innerHTML
    return div.outerHTML
  }
  return clone.outerHTML
}

/** a self-contained page rendering just this slide, with the source's CSS */
function buildOriginalPage(doc: Document, root: HTMLElement): string {
  const css = [...doc.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n')
  const links = [...doc.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.outerHTML).join('\n')
  const bodyClass = doc.body?.className ? ` class="${doc.body.className.replace(/"/g, '&quot;')}"` : ''
  const inner = cleanSubtree(root)
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
${links}
<style>
${css}
</style>
</head>
<body${bodyClass}>
${inner}
</body>
</html>
`
}

/* ---------------- tokens ---------------- */

function harvestTokens(slides: ExtractedSlide[]): Record<string, string> {
  const charsBySize = new Map<number, number>()
  const charsByColor = new Map<string, number>()
  const charsByFamily = new Map<string, number>()
  const bgCount = new Map<string, number>()
  let displayFace = ''
  let displaySize = 0
  let monoFace = ''

  for (const slide of slides) {
    bgCount.set(slide.bg, (bgCount.get(slide.bg) ?? 0) + 1)
    for (const s of Object.values(slide.samples)) {
      if (s.ownChars === 0) continue
      const size = Math.round(s.fontSizePx)
      if (size > 0) charsBySize.set(size, (charsBySize.get(size) ?? 0) + s.ownChars)
      charsByColor.set(s.color, (charsByColor.get(s.color) ?? 0) + s.ownChars)
      charsByFamily.set(s.fontFamily, (charsByFamily.get(s.fontFamily) ?? 0) + s.ownChars)
      if (s.fontSizePx > displaySize) { displaySize = s.fontSizePx; displayFace = s.fontFamily }
      if (!monoFace && /mono|courier|consolas|menlo/i.test(s.fontFamily)) monoFace = s.fontFamily
    }
  }

  const clusters = clusterSizes(charsBySize)
  const scale = buildScale(clusters)

  const ink = argmax(charsByColor) ?? 'rgb(23, 36, 43)'
  const paper = argmax(bgCount) ?? 'rgb(251, 250, 246)'
  const accent = pickAccent(charsByColor, ink, paper)
  const bodyFace = argmax(charsByFamily) ?? 'Georgia, "Times New Roman", serif'

  const pads = slides.map((s) => s.padPx).filter((p) => p > 0).sort((a, b) => a - b)
  const pad = pads.length > 0 ? pads[Math.floor(pads.length / 2)] : 48
  const allGaps = slides.flatMap((s) => s.gaps).sort((a, b) => a - b)
  const gap = allGaps.length > 0 ? allGaps[Math.floor(allGaps.length / 2)] : 24

  const tokens: Record<string, string> = {
    '--dia-paper': paper,
    '--dia-ink': ink,
    '--dia-ink-soft': blend(ink, paper, 0.3),
    '--dia-accent': accent,
    '--dia-rule': blend(ink, paper, 0.82),
    '--dia-face-display': displayFace || bodyFace,
    '--dia-face-body': bodyFace,
    '--dia-face-label': monoFace || 'ui-monospace, "SF Mono", Menlo, monospace',
  }
  scale.forEach((px, i) => { tokens[`--dia-scale-${i + 1}`] = `${px}px` })
  tokens['--dia-gap'] = `${Math.round(gap)}px`
  tokens['--dia-pad'] = `${Math.round(pad)}px`
  return tokens
}

/** round to 1px (done at collection), merge clusters within 1.5px, weight by chars */
function clusterSizes(counts: Map<number, number>): Array<{ px: number; chars: number }> {
  const entries = [...counts.entries()].sort((a, b) => a[0] - b[0])
  const clusters: Array<{ px: number; chars: number }> = []
  for (const [px, chars] of entries) {
    const last = clusters[clusters.length - 1]
    if (last && px - last.px <= 1.5) {
      const total = last.chars + chars
      last.px = (last.px * last.chars + px * chars) / total
      last.chars = total
    } else {
      clusters.push({ px, chars })
    }
  }
  return clusters
}

/** Map ascending clusters onto --dia-scale-1..7, padded/truncated sensibly.
 * Role-anchored: the char-dominant cluster (body text) lands on scale-2 and
 * the largest cluster on scale-5, because defaultThemeCss keys .dia-body to
 * scale-2 and .dia-title to scale-5 — so converted roles keep source sizes.
 * Missing slots interpolate geometrically; extra mid clusters truncate. */
function buildScale(clusters: Array<{ px: number; chars: number }>): number[] {
  if (clusters.length === 0) return [12, 14, 18, 22, 30, 38, 48]
  const asc = [...clusters].sort((a, b) => a.px - b.px)
  const body = asc.reduce((m, c) => (c.chars > m.chars ? c : m), asc[0])
  const top = asc[asc.length - 1]
  const geo = (a: number, b: number) => Math.sqrt(a * b)

  const s = new Array<number>(7).fill(0)
  s[1] = body.px
  s[4] = top.px > body.px ? top.px : body.px * 1.8
  const below = asc.filter((c) => c.px < body.px)
  s[0] = below.length > 0 ? below[below.length - 1].px : Math.max(9, body.px * 0.8)
  const mid = asc.filter((c) => c.px > body.px && c.px < s[4])
  if (mid.length >= 2) { s[2] = mid[0].px; s[3] = mid[mid.length - 1].px }
  else if (mid.length === 1) { s[2] = mid[0].px; s[3] = geo(mid[0].px, s[4]) }
  else { s[2] = geo(s[1], s[4]); s[3] = geo(geo(s[1], s[4]), s[4]) }
  const above = asc.filter((c) => c.px > s[4])
  s[5] = above[0]?.px ?? s[4] * 1.25
  s[6] = above[1]?.px ?? (above[0]?.px ?? s[4] * 1.25) * 1.25

  for (let i = 1; i < 7; i++) if (s[i] <= s[i - 1]) s[i] = s[i - 1] + 1
  return s.map((v) => Math.round(v * 10) / 10)
}

function argmax<K>(m: Map<K, number>): K | null {
  let best: K | null = null
  let n = -1
  for (const [k, v] of m) if (v > n) { n = v; best = k }
  return best
}

/** most-saturated distinct color (HSL s > 35%, not ink/paper) */
function pickAccent(charsByColor: Map<string, number>, ink: string, paper: string): string {
  let best = ''
  let bestSat = 0.35
  for (const c of charsByColor.keys()) {
    if (c === ink || c === paper) continue
    const rgba = parseColor(c)
    if (!rgba) continue
    const sat = saturation(rgba)
    if (sat > bestSat) { bestSat = sat; best = c }
  }
  return best || '#b4552d'
}

/* ---------------- color math ---------------- */

function parseColor(c: string): [number, number, number, number] | null {
  const m = c.match(/rgba?\(([^)]+)\)/)
  if (!m) return null
  const p = m[1].split(',').map((v) => parseFloat(v))
  if (p.length < 3 || p.some((v) => Number.isNaN(v))) return null
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]
}

function saturation([r, g, b]: [number, number, number, number]): number {
  const mx = Math.max(r, g, b) / 255
  const mn = Math.min(r, g, b) / 255
  const d = mx - mn
  if (d === 0) return 0
  const l = (mx + mn) / 2
  return d / (1 - Math.abs(2 * l - 1))
}

/** linear blend of a toward b by t, returns rgb() */
function blend(a: string, b: string, t: number): string {
  const ca = parseColor(a)
  const cb = parseColor(b)
  if (!ca || !cb) return a
  const mix = (i: number) => Math.round(ca[i] + (cb[i] - ca[i]) * t)
  return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`
}
