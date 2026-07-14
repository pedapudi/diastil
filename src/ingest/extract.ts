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
  fontStyle: string
  letterSpacing: string
  textTransform: string
  position: string
  objectFit: string
  /** paint facts for CSS-drawn decorative shapes (convert reproduces the
   * exact ones as scene svg; the rest stay with their containers) */
  background: string
  bgImage: string
  borderW: number
  borderColor: string
  borderStyle: string
  /** all four sides share width/style/color */
  borderUniform: boolean
  radius: string
  transform: string
  /** computed line-height in px (0 when 'normal') — leading is typography
   * the role rules guess at; the measured value corrects them */
  lineHeight: number
  /** entrance-animation delay in ms, recorded pre-settle — staggered delays
   * are the deck saying "reveal in this order" (mapped to data-dia-step) */
  stepDelayMs?: number
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
  /** layout (untransformed) width — the width the slide's px sizes were
   * designed against; decks that scale a fixed stage transform the rect
   * but not the computed font sizes */
  layoutW: number
  bg: string
  samples: Record<number, ElementSample>
  /** every visible text node, whitespace-normalized — the text-sacred set */
  texts: string[]
  padPx: number
  gaps: number[]
  /** the slide runs an infinite animation that settling froze mid-motion —
   * conversion notes it so the loss is visible, never silent */
  hasLoopingAnimation?: boolean
}

export interface Extraction {
  slides: ExtractedSlide[]
  tokens: Record<string, string>
  /** harvested scale step values in px (index 0 = --dia-scale-1), kept for
   * per-element size rebinding after tokens go proportional */
  scalePx: number[]
  /** the median slide layout width the px sizes were designed against */
  designW: number
  warnings: string[]
  method: string
}

/* ---------------- slide detection ---------------- */

/* Detection lives in the extractor plugin registry (extractors/); re-exported
 * here so extraction consumers keep one import surface. */
import { findSlideRoots } from './extractors/index'
import { settleAnimations } from './fidelity'
import { DeckNavigator } from './navigate'
export { findSlideRoots }

/* ---------------- extraction ---------------- */

export async function extractSlides(
  exec: ExecuteResult,
  onProgress?: (index: number, total: number) => void,
): Promise<Extraction> {
  const doc = exec.doc
  const win = doc.defaultView
  if (!win) throw new Error('ingest: executed document has no window — cannot harvest computed styles')

  const { roots, method } = findSlideRoots(doc)
  const warnings = [...exec.warnings]
  if (method === 'body') {
    warnings.push('no slide structure detected — the whole body was imported as one slide')
  }

  // one-at-a-time decks: sample every slide in its ACTIVATED state — a
  // slide presented by its own runtime (split layouts applied, reveals
  // played, figures drawn) is the ground truth; a style-forced slide is a
  // pre-activation approximation that corrupts geometry, samples, and the
  // embedded reference originals downstream
  const nav = new DeckNavigator(doc, roots)
  const counter = { n: 0 }
  const slides: ExtractedSlide[] = []
  let forcedSlides = 0
  for (let i = 0; i < roots.length; i++) {
    onProgress?.(i, roots.length)
    if (nav.oneAtATime()) {
      const presented = await nav.show(i)
      if (!presented) forcedSlides++
    }
    slides.push(harvestSlide(roots[i], i, doc, win, counter))
  }
  if (forcedSlides > 0) {
    warnings.push(
      `${forcedSlides} slide${forcedSlides > 1 ? 's' : ''} sampled without runtime activation ` +
      '(deck navigation not detected) — layout and reveal state may be approximate')
  }
  const tokens = harvestTokens(slides)
  const scalePx = Array.from({ length: 7 }, (_, i) =>
    parseFloat(tokens[`--dia-scale-${i + 1}`] ?? '') || 0)
  const designW = makeTypeProportional(tokens, slides)
  return { slides, tokens, scalePx, designW, warnings, method }
}

/** Harvested px sizes only match the source at ITS slide width — a 120px
 * title is 9% of a 1280px design but 12% of a 980px render. Size tokens
 * become container-relative (cqw against the median layout width), so the
 * converted deck keeps the original's PROPORTIONS at any render width. */
function makeTypeProportional(tokens: Record<string, string>, slides: ExtractedSlide[]): number {
  const widths = slides.map((s) => s.layoutW).filter((w) => w > 100).sort((a, b) => a - b)
  const designW = widths[Math.floor(widths.length / 2)]
  if (!designW) return 0

  // two container-query facts shape the units here:
  // - cqw resolves against the container's CONTENT box, so font ratios must
  //   divide by the design width MINUS the padding;
  // - the container's own padding cannot query itself (cqw would fall back
  //   to the viewport), so padding is a percentage — % padding resolves
  //   against the containing block, i.e. the slide's full width.
  const padPx = parseFloat(tokens['--dia-pad'] ?? '') || 0
  const contentW = Math.max(designW - 2 * padPx, designW * 0.5)
  for (const [name, value] of Object.entries(tokens)) {
    const px = /^([\d.]+)px$/.exec(value)
    if (!px) continue
    if (name === '--dia-pad') {
      tokens[name] = `${Math.round((parseFloat(px[1]) / designW) * 10000) / 100}%`
    } else if (/^--dia-(scale-\d|gap)$/.test(name)) {
      tokens[name] = `${Math.round((parseFloat(px[1]) / contentW) * 10000) / 100}cqw`
    }
  }
  return contentW
}

function harvestSlide(
  root: HTMLElement,
  index: number,
  doc: Document,
  win: Window,
  counter: { n: number },
): ExtractedSlide {
  // builds are MEANING, not decoration: staggered entrance delays are the
  // deck saying "reveal in this order". Census them BEFORE settling erases
  // the animation state — settle then freezes the end frame for sampling.
  const census = censusAnimations(root, win)
  // activation restarts entrance animations; sampling mid-fade freezes
  // opacity/transform at a transient frame — settle to the end state first
  settleAnimations(root)
  // one-visible-at-a-time decks hide non-current slides; reveal this one
  // for the duration of sampling so geometry and computed styles are real
  const unforce = forceVisible(root)
  try {
    return harvestVisibleSlide(root, index, doc, win, counter, census)
  } finally {
    unforce?.()
  }
}

interface AnimationCensus {
  /** element → smallest entrance delay in ms (positive delays only) */
  delays: Map<Element, number>
  /** an infinite animation runs somewhere in the subtree */
  looping: boolean
}

/** Read every animation's delay/iterations off the LIVE subtree. Web
 * Animations API first (covers script-driven animations too); computed
 * animation-* styles as the fallback for engines without getAnimations. */
function censusAnimations(root: HTMLElement, win: Window): AnimationCensus {
  const delays = new Map<Element, number>()
  let looping = false
  try {
    const target = root as HTMLElement & { getAnimations?: (o: { subtree: boolean }) => Animation[] }
    for (const anim of target.getAnimations?.({ subtree: true }) ?? []) {
      const effect = anim.effect as KeyframeEffect | null
      const el = effect?.target
      if (!el || !root.contains(el)) continue
      let timing: ComputedEffectTiming
      try { timing = effect.getComputedTiming() } catch { continue }
      if (timing.iterations === Infinity) { looping = true; continue }
      const delay = timing.delay ?? 0
      if (delay > 0) {
        const prev = delays.get(el)
        if (prev === undefined || delay < prev) delays.set(el, delay)
      }
    }
  } catch { /* getAnimations unavailable — computed styles below still work */ }
  for (const el of [root, ...root.querySelectorAll('*')]) {
    if (delays.has(el) || SKIP_TAGS.has(el.tagName.toUpperCase())) continue
    const cs = win.getComputedStyle(el)
    if (!cs.animationName || cs.animationName === 'none') continue
    if (/infinite/.test(cs.animationIterationCount)) { looping = true; continue }
    const delay = parseFloat(cs.animationDelay) * 1000 // computed value is seconds
    if (Number.isFinite(delay) && delay > 0) delays.set(el, delay)
  }
  return { delays, looping }
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
  census: AnimationCensus,
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
      fontStyle: cs.fontStyle,
      letterSpacing: cs.letterSpacing,
      textTransform: cs.textTransform,
      position: cs.position,
      objectFit: cs.objectFit,
      background: cs.backgroundColor,
      bgImage: cs.backgroundImage,
      borderW: parseFloat(cs.borderTopWidth) || 0,
      borderColor: cs.borderTopColor,
      borderStyle: cs.borderTopStyle,
      borderUniform:
        cs.borderTopWidth === cs.borderBottomWidth && cs.borderTopWidth === cs.borderLeftWidth &&
        cs.borderTopWidth === cs.borderRightWidth && cs.borderTopStyle === cs.borderBottomStyle &&
        cs.borderTopStyle === cs.borderLeftStyle && cs.borderTopStyle === cs.borderRightStyle &&
        cs.borderTopColor === cs.borderBottomColor && cs.borderTopColor === cs.borderLeftColor &&
        cs.borderTopColor === cs.borderRightColor,
      radius: cs.borderRadius,
      transform: cs.transform,
      lineHeight: parseFloat(cs.lineHeight) || 0,
      stepDelayMs: census.delays.get(el),
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
    html: snapshotClone(root).outerHTML,
    sourceHtml: cleanSubtree(root),
    originalHtml: buildOriginalPage(doc, root),
    rect: { x: r.left + win.scrollX, y: r.top + win.scrollY, w: r.width, h: r.height },
    layoutW: root.offsetWidth || r.width,
    bg: effectiveBg(root, win),
    samples,
    texts: collectTexts(root, win),
    padPx: parseFloat(rootCs.paddingLeft) || 0,
    gaps,
    hasLoopingAnimation: census.looping || undefined,
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

/** layout props pinned onto the clone ROOT so a runtime-less page (the
 * embedded reference original, the service's source excerpt) lays out the
 * slide exactly as its ACTIVATED state did — decks routinely gate
 * display:grid/flex on a runtime-toggled current-slide class */
const ROOT_LAYOUT_PROPS = [
  'display', 'height',
  'grid-template-columns', 'grid-template-rows', 'grid-template-areas', 'grid-auto-flow',
  'column-gap', 'row-gap', 'align-items', 'justify-content', 'flex-direction', 'flex-wrap',
]

/** stamp-free, script-free clone of the subtree (body roots become a div) */
function cleanSubtree(root: HTMLElement): string {
  const clone = snapshotClone(root)
  const win = root.ownerDocument.defaultView
  if (win && root.getBoundingClientRect().width > 1) {
    const cs = win.getComputedStyle(root)
    if (/grid|flex/.test(cs.display)) {
      for (const p of ROOT_LAYOUT_PROPS) {
        const v = cs.getPropertyValue(p)
        if (v && v !== 'none' && v !== 'normal' && v !== 'auto') clone.style.setProperty(p, v)
      }
    }
  }
  for (const s of clone.querySelectorAll('script, noscript')) s.remove()
  for (const el of [clone, ...clone.querySelectorAll(`[${STAMP}]`)]) el.removeAttribute(STAMP)
  if (clone.tagName === 'BODY') {
    const div = root.ownerDocument.createElement('div')
    div.innerHTML = clone.innerHTML
    return div.outerHTML
  }
  return clone.outerHTML
}

/* svg paint carried by the SOURCE's stylesheets vanishes when conversion
 * strips that css — a diagram whose strokes came from `.x path { stroke }`
 * rules renders invisible (or default-black). Inline the computed paint
 * onto each svg element so verbatim svgs are self-contained. */
const SVG_DEFAULTS: Array<[string, string]> = [
  ['fill', 'rgb(0, 0, 0)'], ['stroke', 'none'], ['stroke-width', '1px'],
  ['stroke-dasharray', 'none'], ['stroke-linecap', 'butt'], ['stroke-linejoin', 'miter'],
]
/* opacity is inlined UNCONDITIONALLY: decks gate reveal animations on a
 * runtime-toggled class whose BASE rule is `opacity: 0` — a snapshot that
 * only records non-default values leaves the shown state implicit, and the
 * runtime-less reference page then renders those elements invisible. */
const SVG_ALWAYS: string[] = ['opacity', 'fill-opacity', 'stroke-opacity']

function inlineSvgPaint(liveRoot: HTMLElement, clone: HTMLElement): void {
  const win = liveRoot.ownerDocument.defaultView
  if (!win) return
  const live = liveRoot.querySelectorAll('svg, svg *')
  const out = clone.querySelectorAll('svg, svg *')
  // css animations found on svg content: animation-name → the svg clone
  // that must carry its @keyframes (SMIL needs nothing — it is markup)
  const animsBySvg = new Map<SVGSVGElement, Set<string>>()
  for (let i = 0; i < live.length && i < out.length; i++) {
    const cs = win.getComputedStyle(live[i])
    const el = out[i] as SVGElement
    for (const [prop, def] of SVG_DEFAULTS) {
      const v = cs.getPropertyValue(prop)
      if (v && v !== def) el.style.setProperty(prop, v)
    }
    for (const prop of SVG_ALWAYS) {
      const v = cs.getPropertyValue(prop)
      if (v) el.style.setProperty(prop, v)
    }
    if (live[i].tagName === 'text' || live[i].tagName === 'tspan') {
      el.style.setProperty('font-family', cs.fontFamily)
      el.style.setProperty('font-size', cs.fontSize)
      if (cs.fontWeight !== '400') el.style.setProperty('font-weight', cs.fontWeight)
      if (cs.textAnchor !== 'start') el.style.setProperty('text-anchor', cs.textAnchor)
    }
    // a css animation is PART of the artwork — carry the longhands inline
    // and remember the names, so the @keyframes can ride inside the svg
    if (cs.animationName !== 'none' && parseFloat(cs.animationDuration) > 0) {
      el.style.setProperty('animation-name', cs.animationName)
      el.style.setProperty('animation-duration', cs.animationDuration)
      el.style.setProperty('animation-timing-function', cs.animationTimingFunction)
      if (cs.animationDelay !== '0s') el.style.setProperty('animation-delay', cs.animationDelay)
      el.style.setProperty('animation-iteration-count', cs.animationIterationCount)
      if (cs.animationDirection !== 'normal') el.style.setProperty('animation-direction', cs.animationDirection)
      if (cs.animationFillMode !== 'none') el.style.setProperty('animation-fill-mode', cs.animationFillMode)
      const host = el.closest('svg') as SVGSVGElement | null
      if (host) {
        const names = animsBySvg.get(host) ?? new Set<string>()
        for (const name of cs.animationName.split(',')) names.add(name.trim())
        animsBySvg.set(host, names)
      }
    }
  }
  // inject the matching @keyframes INSIDE each animated svg — the svg is
  // then self-contained and the animation survives conversion and save
  for (const [svg, names] of animsBySvg) {
    const css = keyframesCss(liveRoot.ownerDocument, names)
    if (!css) continue
    const style = liveRoot.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'style')
    style.setAttribute('class', 'dia-anim-keyframes')
    style.textContent = css
    svg.insertBefore(style, svg.firstChild)
  }
}

/** serialize the @keyframes rules for the given animation names from the
 * source document's (same-origin srcdoc) stylesheets */
function keyframesCss(doc: Document, names: Set<string>): string {
  const found: string[] = []
  // duck-typed, NOT instanceof: the rules come from the execution IFRAME's
  // realm, whose CSSKeyframesRule is a different constructor than ours
  const visit = (rules: CSSRuleList | undefined): void => {
    for (const rule of rules ?? []) {
      const kf = rule as CSSKeyframesRule
      if (typeof kf.name === 'string' && rule.cssText.trimStart().startsWith('@keyframes')) {
        if (names.has(kf.name)) found.push(rule.cssText)
        continue
      }
      const grouped = rule as CSSGroupingRule
      if (grouped.cssRules) visit(grouped.cssRules)
    }
  }
  for (const sheet of doc.styleSheets) {
    try { visit((sheet as CSSStyleSheet).cssRules) } catch { /* cross-origin sheet */ }
  }
  return found.join('\n')
}

/* svgs routinely reference defs that live ELSEWHERE in the source document —
 * a shared hidden svg carrying arrow markers, gradients, symbols. A slide
 * subtree extracted on its own loses them: lines keep drawing but their
 * arrowheads (markers), gradient fills, and <use> targets vanish. Resolve
 * every url(#id) / href="#id" the subtree uses and inline clones of the
 * missing definitions into the subtree's first svg. */
const DEF_REF_ATTRS = ['marker-start', 'marker-mid', 'marker-end', 'fill', 'stroke', 'filter', 'clip-path', 'mask']

function inlineExternalDefs(liveRoot: HTMLElement, clone: HTMLElement): void {
  const doc = liveRoot.ownerDocument
  const ids = new Set<string>()
  const takeUrlRefs = (value: string | null): void => {
    for (const m of (value ?? '').matchAll(/url\(["']?#([^"')]+)["']?\)/g)) ids.add(m[1])
  }
  for (const el of [clone, ...clone.querySelectorAll('*')]) {
    for (const a of DEF_REF_ATTRS) takeUrlRefs(el.getAttribute(a))
    takeUrlRefs(el.getAttribute('style'))
    if (el.tagName.toLowerCase() === 'use') {
      const href = el.getAttribute('href') ?? el.getAttribute('xlink:href') ?? ''
      if (href.startsWith('#')) ids.add(href.slice(1))
    }
  }
  const missing = [...ids].filter((id) => {
    try { return !clone.querySelector(`#${CSS.escape(id)}`) } catch { return false }
  })
  if (missing.length === 0) return
  const defs = missing
    .map((id) => doc.getElementById(id))
    .filter((el): el is HTMLElement => el !== null)
  if (defs.length === 0) return
  const host = clone.querySelector('svg')
  if (!host) return
  let defsEl = host.querySelector(':scope > defs')
  if (!defsEl) {
    defsEl = doc.createElementNS('http://www.w3.org/2000/svg', 'defs')
    host.prepend(defsEl)
  }
  for (const d of defs) defsEl.appendChild(d.cloneNode(true))
}

/** Deep-clone with canvas BITMAPS preserved: a cloned <canvas> is blank
 * (the drawing surface never copies), so JS-rendered figures — including
 * animations, frozen at their settle-time frame — would vanish. Each canvas
 * becomes an <img> carrying the pixels (kept as-is when tainted). */
function snapshotClone(root: HTMLElement): HTMLElement {
  const clone = root.cloneNode(true) as HTMLElement
  inlineSvgPaint(root, clone)
  inlineExternalDefs(root, clone)
  const liveCanvases = root.querySelectorAll('canvas')
  const cloneCanvases = clone.querySelectorAll('canvas')
  for (let i = 0; i < liveCanvases.length && i < cloneCanvases.length; i++) {
    const live = liveCanvases[i]
    try {
      const url = live.toDataURL('image/png')
      const img = root.ownerDocument.createElement('img')
      img.src = url
      img.setAttribute('alt', 'figure (canvas snapshot)')
      const from = cloneCanvases[i]
      for (const a of from.attributes) {
        if (a.name !== 'width' && a.name !== 'height') img.setAttribute(a.name, a.value)
      }
      // freeze the rendered size so layout holds without the canvas element,
      // but let it SHRINK to fit narrower layouts (aspect held) — a fixed
      // pixel size would clip under the converted deck's overflow:hidden
      const r = live.getBoundingClientRect()
      if (r.width > 0) {
        const prior = img.getAttribute('style')
        img.setAttribute('style',
          `${prior ? prior + '; ' : ''}width: ${Math.round(r.width)}px; max-width: 100%; height: auto; aspect-ratio: ${Math.round(r.width)} / ${Math.round(r.height)}`)
      }
      from.replaceWith(img)
    } catch {
      /* tainted canvas (cross-origin pixels) — keep the element as-is */
    }
  }
  return clone
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

  // faces are ROLE-cohort measurements, not one global argmax: display text
  // (the largest cohort) routinely uses a different family than body copy,
  // and the smallest cohort (captions/labels) often a third — a single
  // family for all three erases the source's typographic voice
  const bodyFamilies = new Map<string, number>()
  const labelFamilies = new Map<string, number>()
  let smallest = Infinity
  for (const slide of slides) {
    for (const s of Object.values(slide.samples)) {
      if (s.ownChars === 0 || s.fontSizePx <= 0) continue
      if (s.fontSizePx < displaySize * 0.75) smallest = Math.min(smallest, s.fontSizePx)
    }
  }
  for (const slide of slides) {
    for (const s of Object.values(slide.samples)) {
      if (s.ownChars === 0 || s.fontSizePx <= 0) continue
      if (s.fontSizePx < displaySize * 0.75) {
        bodyFamilies.set(s.fontFamily, (bodyFamilies.get(s.fontFamily) ?? 0) + s.ownChars)
      }
      if (Math.abs(s.fontSizePx - smallest) <= 1.5) {
        labelFamilies.set(s.fontFamily, (labelFamilies.get(s.fontFamily) ?? 0) + s.ownChars)
      }
    }
  }
  const bodyFace = argmax(bodyFamilies) ?? argmax(charsByFamily) ?? 'Georgia, "Times New Roman", serif'
  // the label face only earns its token when the smallest cohort genuinely
  // uses a DIFFERENT family — otherwise the mono fallback chain stands
  const labelFace = argmax(labelFamilies)

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
    '--dia-face-label':
      (labelFace && labelFace !== bodyFace ? labelFace : monoFace) ||
      monoFace || 'ui-monospace, "SF Mono", Menlo, monospace',
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
