/* CONVERT — step 3 of ingest: map each extracted slide into the dialect.
 * Role mapping (title/kicker/body/figure/columns), islands for the
 * unmappable, script stripping (content was already executed), and a
 * programmatic text-preservation check: every visible source text node must
 * reappear in the converted slide. Confidence is structural and honest:
 * mappedTextChars / totalTextChars × 0.9 when islands remain. */

import temml from 'temml'
import { defaultThemeCss } from '../model/parse'
import type { RegionNote, ImportReport } from '../types'
import { STAMP, norm, type ElementSample, type ExtractedSlide, type Extraction } from './extract'
import { liftSimpleSvg, roundedRectPath } from './svglift'
import { renderNodeShape } from '../scene/route'
import { renderChart } from '../scene/chart'

export interface SlideConversion {
  html: string
  notes: RegionNote[]
  confidence: number
  warnings: string[]
  islands: number
  accepted?: boolean
  /** pixel-verified score from the fidelity pass, 0..1; null when the slide
   * would not rasterize; undefined before the pass runs */
  fidelity?: number | null
  /** service repair rounds already spent on this slide */
  repairRounds?: number
}

interface PendingNote {
  node: Element | null
  kind: RegionNote['kind']
  note: string
}

interface Ctx {
  titleEl: Element | null
  kickerEl: Element | null
  notes: PendingNote[]
  islands: number
  /** the slide's rendered rect — CSS-shape geometry is expressed relative to it */
  slideRect: { x: number; y: number; w: number; h: number }
  /** the slide's design (layout) width — cqw fractions are computed against it */
  layoutW: number
  /** the slide's content width (layout minus padding) — cqw resolves here */
  contentW: number
  sample(el: Element): ElementSample | undefined
  /** literal color -> var(--dia-*) when it matches a harvested token, so
   * imported content retints coherently with the deck token picker */
  tokenColor(c: string): string | null
}

const DROP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'TITLE', 'BASE'])
const UNMAPPABLE = new Set(['IFRAME', 'CANVAS', 'VIDEO', 'AUDIO', 'EMBED', 'OBJECT', 'FORM', 'INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'])
const CONTAINER = new Set(['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'ASIDE', 'FIGURE', 'NAV'])
const CHROME_SEL = '.controls, .progress, .slide-number, .backgrounds, .speaker-notes, .remark-toolbar, .remark-notes-area, .navigate-left, .navigate-right, .impress-progress'

/* ---------------- public API ---------------- */

export function convertSlides(ex: Extraction): SlideConversion[] {
  return ex.slides.map((s, i) => convertSlide(s, i, ex.scalePx, ex.designW, ex.tokens))
}

/** normalized-color -> var(--dia-*) for the harvested color tokens */
function tokenColorMap(tokens: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>()
  for (const name of ['--dia-accent', '--dia-ink', '--dia-ink-soft', '--dia-paper', '--dia-rule']) {
    const n = normColor(tokens[name] ?? '')
    if (n && !map.has(n)) map.set(n, `var(${name})`)
  }
  return map
}

/** canonical "r,g,b" (alpha 1 only) from hex or rgb()/rgba() */
function normColor(c: string): string | null {
  const hex = /^#([0-9a-f]{6})$/i.exec(c.trim())
  if (hex) {
    const v = parseInt(hex[1], 16)
    return `${(v >> 16) & 255},${(v >> 8) & 255},${v & 255}`
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*(1|1\.0*)\s*)?\)$/.exec(c.trim())
  return rgb ? `${rgb[1]},${rgb[2]},${rgb[3]}` : null
}

/** role → default scale step (must match the role rules in the theme) */
const ROLE_STEP: Array<[string, number]> = [
  ['dia-title', 5], ['dia-kicker', 1], ['dia-caption', 1], ['dia-body', 2],
]

/** Set an inline style, surviving CSSOM parsers that reject modern units
 * (happy-dom drops cqw values silently) — the attribute is the artifact
 * that ships, so write it directly when the API eats the value. */
function setStyleSafe(el: HTMLElement, prop: string, value: string): void {
  el.style.setProperty(prop, value)
  if (el.style.getPropertyValue(prop) !== '') return
  const prev = el.getAttribute('style') ?? ''
  const sep = prev && !prev.trim().endsWith(';') ? '; ' : ''
  el.setAttribute('style', `${prev}${sep}${prop}: ${value};`)
}

/** The role rules quantize every title/body to ONE step, but sources vary
 * per element (a hero wordmark vs a section title). Rebind elements whose
 * SOURCE size sits nearer a different harvested step — inline token
 * references, so the deck stays proportional and in-grammar. */
function rebindSizes(section: HTMLElement, sample: Ctx['sample'], scalePx: number[], designW: number): void {
  if (!scalePx.some((v) => v > 0)) return
  for (const el of section.querySelectorAll<HTMLElement>(`[${STAMP}]`)) {
    const s = sample(el)
    if (!s || s.ownChars === 0 || s.fontSizePx <= 0) continue
    const role = ROLE_STEP.find(([cls]) => el.closest(`.${cls}`))
    if (!role) continue
    const defaultStep = role[1]
    const defPx = scalePx[defaultStep - 1]
    // only rebind when the role default genuinely misrepresents the source
    if (defPx > 0 && Math.abs(defPx - s.fontSizePx) / s.fontSizePx <= 0.15) continue
    let nearest = 0
    for (let i = 1; i < scalePx.length; i++) {
      if (Math.abs(scalePx[i] - s.fontSizePx) < Math.abs(scalePx[nearest] - s.fontSizePx)) nearest = i
    }
    if (Math.abs(scalePx[nearest] - s.fontSizePx) / s.fontSizePx > 0.15 && designW > 0) {
      // no step comes close (e.g. a hero wordmark) — exact proportional size
      setStyleSafe(el, 'font-size', `${Math.round((s.fontSizePx / designW) * 10000) / 100}cqw`)
    } else if (nearest + 1 !== defaultStep) {
      el.style.fontSize = `var(--dia-scale-${nearest + 1})`
    }
  }
}

export function convertSlide(
  slide: ExtractedSlide, index: number, scalePx: number[] = [], designW = 0,
  tokens: Record<string, string> = {},
): SlideConversion {
  const parsed = new DOMParser().parseFromString(slide.html, 'text/html')
  const srcRoot: HTMLElement = parsed.body.hasAttribute(STAMP)
    ? parsed.body
    : (parsed.body.firstElementChild as HTMLElement | null) ?? parsed.body

  const tokenColors = tokenColorMap(tokens)
  const ctx: Ctx = {
    titleEl: null,
    kickerEl: null,
    notes: [],
    islands: 0,
    slideRect: slide.rect,
    layoutW: slide.layoutW || slide.rect.w,
    contentW: Math.max((slide.layoutW || slide.rect.w) - 2 * slide.padPx, (slide.layoutW || slide.rect.w) * 0.5),
    sample(el: Element): ElementSample | undefined {
      const idx = el.getAttribute(STAMP)
      return idx === null ? undefined : slide.samples[Number(idx)]
    },
    tokenColor(c: string): string | null {
      const n = normColor(c)
      return n ? tokenColors.get(n) ?? null : null
    },
  }
  ctx.titleEl = pickTitle(srcRoot, ctx)
  ctx.kickerEl = pickKicker(srcRoot, ctx)

  const section = document.createElement('section')
  section.className = 'dia-slide'
  // the source's slide transition carries: reveal-style data-transition
  // (and friends) maps onto the dialect's enter vocabulary
  const transition = inferTransition(srcRoot)
  if (transition) section.setAttribute('data-dia-transition', transition)
  section.append(...convertContainerChildren(srcRoot, ctx))
  rebindSizes(section, ctx.sample, scalePx, designW)
  applyTypography(section, ctx)
  applyInk(section, ctx, tokens)
  applyListMarkers(section, ctx)
  applyBuildSteps(section, ctx, slide)
  applyVerticalRhythm(section, srcRoot, ctx, slide)
  if (slide.hasLoopingAnimation) {
    ctx.notes.push({
      node: null, kind: 'low-structure',
      note: 'looping animation frozen at its settle frame',
    })
  }

  return finalize(section, slide, index, ctx.notes, ctx.islands)
}

/** whole-slide island: the reviewer keeps the original subtree verbatim */
export function islandEntireSlide(slide: ExtractedSlide, index: number): SlideConversion {
  const section = document.createElement('section')
  section.className = 'dia-slide'
  const wrap = document.createElement('div')
  wrap.className = 'dia-island'
  wrap.setAttribute('data-dia-island', '')
  wrap.innerHTML = slide.sourceHtml
  section.appendChild(wrap)
  const notes: PendingNote[] = [
    { node: wrap, kind: 'island', note: 'entire slide preserved verbatim at reviewer request' },
  ]
  return finalize(section, slide, index, notes, 1)
}

/** validate a service-translated slide: normalize the root, strip scripts,
 * re-run the text-preservation check against the source text set */
export function revalidateSlide(slide: ExtractedSlide, index: number, html: string): SlideConversion {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const returned = parsed.querySelector<HTMLElement>('section.dia-slide')
  const section = document.createElement('section')
  section.className = 'dia-slide'
  section.innerHTML = (returned ?? parsed.body).innerHTML
  for (const s of section.querySelectorAll('script, noscript')) s.remove()
  const islandEls = [...section.querySelectorAll('[data-dia-island]')]
  const notes: PendingNote[] = islandEls.map((el) => ({
    node: el, kind: 'island' as const, note: 'island returned by the dia service',
  }))
  return finalize(section, slide, index, notes, islandEls.length)
}

export function buildReport(
  ex: Extraction,
  sourceName: string,
  conversions: SlideConversion[],
): ImportReport {
  const measured = conversions.some((c) => c.fidelity !== undefined)
  return {
    sourceName,
    slideCount: conversions.length,
    confidence: conversions.map((c) => c.confidence),
    fidelity: measured ? conversions.map((c) => c.fidelity ?? null) : undefined,
    regions: conversions.flatMap((c) => c.notes),
    tokens: ex.tokens,
    warnings: [
      ...ex.warnings,
      ...conversions.flatMap((c) => c.warnings),
      'confidence = mapped text chars / total text chars, ×0.9 where islands remain — structural, not visual',
      measured
        ? 'fidelity = 1 − differing-pixel fraction, original vs converted raster at 384×216 (null = slide would not rasterize)'
        : 'fidelity pass did not run — visual match unverified',
    ],
  }
}

export function tokensToCss(tokens: Record<string, string>): string {
  const lines = Object.entries(tokens).map(([k, v]) => `  ${k}: ${v};`).join('\n')
  return `:root {\n${lines}\n}`
}

/** Assemble the final dialect document — same shape serialize.ts produces:
 * doctype, data-dia-version="1", <style id="dia-theme"> (extracted tokens +
 * the slide/role rules from defaultThemeCss keyed to those tokens), slides,
 * empty dia-runtime script. When originals are given (per-slide
 * self-contained source pages), they ride in the head as an INERT
 * text/x-dia-original data block, so the imported deck permanently carries
 * the reference implementation and content of what it was converted from —
 * for later repairs, lifts, and human comparison. Positioned before the
 * theme style to match where serialize.ts re-emits head extras, keeping the
 * round-trip byte-stable. */
export function assembleDeck(
  slides: string[], tokens: Record<string, string>, title: string, originals: string[] = [],
): string {
  const base = defaultThemeCss()
  const roleRules = base.slice(base.indexOf('}') + 1).trim()
  const originalsBlock = originals.length
    ? `<script type="text/x-dia-original" id="dia-originals">${
      JSON.stringify({ version: 1, slides: originals }).replace(/</g, '\\u003c')
    }</script>\n`
    : ''
  return `<!doctype html>
<html lang="en" data-dia-version="1">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${originalsBlock}<style id="dia-theme">
${tokensToCss(tokens)}
${roleRules}
</style>
</head>
<body>
${slides.join('\n\n')}
<script id="dia-runtime">
</script>
</body>
</html>
`
}

/** read back the reference originals embedded by assembleDeck (null when the
 * deck was not imported or the block is unreadable) */
export function readEmbeddedOriginals(doc: Document): string[] | null {
  const el = doc.querySelector('script#dia-originals[type="text/x-dia-original"]')
  if (!el) return null
  try {
    const parsed = JSON.parse(el.textContent ?? '') as { slides?: unknown }
    return Array.isArray(parsed.slides) && parsed.slides.every((s) => typeof s === 'string')
      ? parsed.slides as string[]
      : null
  } catch {
    return null
  }
}

/** role leading defaults, mirroring defaultThemeCss in model/parse.ts —
 * .dia-title { line-height: 1.14 }, .dia-body { line-height: 1.55 } */
const ROLE_LEADING: Array<[string, number]> = [['dia-title', 1.14], ['dia-body', 1.55]]

/** Role rules impose ONE typographic voice per role; sources vary. Carry the
 * MEASURED deviations inline — transform, tracking, leading — so a converted
 * slide keeps the source's typography, not the theme's guess. Kickers are
 * exempt: the dia-kicker rule already uppercases and tracks. */
function applyTypography(section: HTMLElement, ctx: Ctx): void {
  for (const el of section.querySelectorAll<HTMLElement>(`[${STAMP}]`)) {
    const s = ctx.sample(el)
    if (!s || s.ownChars === 0) continue
    const isKicker = el.closest('.dia-kicker') !== null
    if (!isKicker && s.textTransform === 'uppercase') {
      el.style.textTransform = 'uppercase'
    }
    // computed letter-spacing is px ('normal' parses NaN); carry as em so it
    // survives the proportional (cqw) font sizing
    const ls = parseFloat(s.letterSpacing)
    if (!isKicker && Number.isFinite(ls) && s.fontSizePx > 0 && Math.abs(ls) / s.fontSizePx > 0.02) {
      el.style.letterSpacing = `${Math.round((ls / s.fontSizePx) * 1000) / 1000}em`
    }
    const role = ROLE_LEADING.find(([cls]) => el.closest(`.${cls}`))
    if (role && s.lineHeight > 0 && s.fontSizePx > 0) {
      const ratio = s.lineHeight / s.fontSizePx
      if (Math.abs(ratio - role[1]) / role[1] > 0.15) {
        el.style.lineHeight = String(Math.round(ratio * 100) / 100)
      }
    }
  }
}

/** Builds are meaning the pixel score can't see: staggered entrance delays
 * (0.2s, 0.4s, …) are the deck saying "reveal in this order". Distinct
 * positive delays become data-dia-step groups the dialect runtime replays.
 * One delay is an entrance flourish, not a build; more than nine distinct
 * delays is an animation soup — both leave the slide static. */
function applyBuildSteps(section: HTMLElement, ctx: Ctx, slide: ExtractedSlide): void {
  const delays = new Set<number>()
  for (const s of Object.values(slide.samples)) {
    if (s.stepDelayMs !== undefined && s.stepDelayMs > 0) delays.add(s.stepDelayMs)
  }
  if (delays.size < 2 || delays.size > 9) return
  const order = [...delays].sort((a, b) => a - b)
  for (const el of section.querySelectorAll<HTMLElement>(`[${STAMP}]`)) {
    const s = ctx.sample(el)
    if (s?.stepDelayMs === undefined || s.stepDelayMs <= 0) continue
    el.setAttribute('data-dia-step', String(order.indexOf(s.stepDelayMs) + 1))
  }
}

/** Vertical placement is design, not accident: most decks CENTER a slide's
 * content block while a top-stacked conversion pins it under the padding —
 * the single largest geometric error the honest fidelity metric exposed.
 * Measure the source content's top/bottom gaps; when they say "centered",
 * the converted slide centers the same way. */
/** role → what its theme rule paints: ink token, face token, weight
 * (parse.ts role rules — .dia-title is 700, everything else 400) */
const ROLE_TYPE: Array<[cls: string, ink: string, face: string, weight: number]> = [
  ['dia-kicker', '--dia-accent', '--dia-face-label', 400],
  ['dia-caption', '--dia-ink-soft', '--dia-face-label', 400],
  ['dia-title', '--dia-ink', '--dia-face-display', 700],
  ['dia-body', '--dia-ink-soft', '--dia-face-body', 400],
]

/** channel triple for exact/near comparison; null for anything non-opaque */
function rgbOf(c: string): [number, number, number] | null {
  const n = normColor(c)
  if (!n) return null
  const [r, g, b] = n.split(',').map(Number)
  return [r, g, b]
}

function nearColor(a: string, b: string): boolean {
  const ca = rgbOf(a)
  const cb = rgbOf(b)
  if (!ca || !cb) return false
  return Math.max(Math.abs(ca[0] - cb[0]), Math.abs(ca[1] - cb[1]), Math.abs(ca[2] - cb[2])) <= 8
}

/** the family that actually renders: first entry, unquoted, lowercased */
function primaryFamily(stack: string): string {
  return (stack.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '').toLowerCase()
}

/** Carry each block's MEASURED typesetting — color, family, weight, slant —
 * wherever the role's theme rule would mispaint it. The old behavior kept
 * only run-level accent colors: the block itself silently took the role
 * default, so body text matching the deck's primary ink rendered soft,
 * non-token colors vanished, and a light-weight or italic or off-face block
 * flattened to the role's look. Values matching a harvested token bind as
 * var(--dia-*) so the theme picker retints/refaces them; the rest carry
 * literally. (Size is rebindSizes; tracking/case/leading is applyTypography.) */
function applyInk(section: HTMLElement, ctx: Ctx, tokens: Record<string, string>): void {
  // without harvested tokens there is no honest baseline to deviate from
  if (!tokens['--dia-ink']) return
  const faceTokens = ['--dia-face-display', '--dia-face-body', '--dia-face-label']
    .map((name) => [name, primaryFamily(tokens[name] ?? '')] as const)
    .filter(([, fam]) => fam !== '')
  for (const el of section.querySelectorAll<HTMLElement>(`[${STAMP}]`)) {
    const s = ctx.sample(el)
    if (!s || s.ownChars === 0) continue
    const role = ROLE_TYPE.find(([cls]) => el.closest(`.${cls}`))
    if (!role) continue
    const [, inkToken, faceToken, roleWeight] = role

    if (s.color && !el.style.color && !nearColor(s.color, tokens[inkToken] ?? '')) {
      el.style.color = ctx.tokenColor(s.color) ?? s.color
    }

    if (s.fontFamily && !el.style.fontFamily) {
      const fam = primaryFamily(s.fontFamily)
      const roleFam = primaryFamily(tokens[faceToken] ?? '')
      if (fam && fam !== roleFam) {
        const match = faceTokens.find(([, f]) => f === fam)
        el.style.fontFamily = match ? `var(${match[0]})` : s.fontFamily
      }
    }

    // weight deviations ≥150 are design (a thin display title, an all-bold
    // stanza); smaller deltas are face-rendering noise
    if (s.fontWeight && Math.abs(s.fontWeight - roleWeight) >= 150 && !el.style.fontWeight) {
      el.style.fontWeight = String(s.fontWeight)
    }

    if (s.fontStyle && /^(italic|oblique)/.test(s.fontStyle) && !el.style.fontStyle) {
      el.style.fontStyle = 'italic'
    }
  }
}

/** LIST MARKERS — a detection ladder, honest at each rung.
 *
 * Extraction materializes css-drawn bullets (::before content) as tagged
 * spans; source lists also carry real icon markers (svg/img first children).
 * The ladder decides how much SEMANTICS each list earns:
 *   1. uniform text glyph  → one --dia-marker token on the list (retheme-able
 *      deck-wide; ink binds to var(--dia-*) when it matches a token)
 *   2. per-item glyph variants (✓/✗/…) → .dia-marker slots per item — the
 *      variation is MEANING, kept faithfully but nameable and restylable
 *   3. icon markers (svg/img sized like a glyph) → wrapped in .dia-marker
 *      slots; the theme's hanging grid handles alignment
 * Anything else keeps today's literal carry. */
function applyListMarkers(section: HTMLElement, ctx: Ctx): void {
  for (const list of section.querySelectorAll<HTMLElement>('ul, ol')) {
    const items = [...list.children].filter((c): c is HTMLElement => c.tagName === 'LI')
    if (items.length === 0) continue
    const pseudo = items.map((li) => {
      const first = li.firstElementChild
      return first instanceof HTMLSpanElement && first.classList.contains('dia-pseudo-marker')
        ? first : null
    })
    if (pseudo.every((m): m is HTMLSpanElement => m !== null)) {
      const texts = pseudo.map((m) => (m.textContent ?? '').trim())
      const colors = pseudo.map((m) => m.style.color)
      const uniform = texts.every((t) => t === texts[0]) && colors.every((c) => c === colors[0])
      if (uniform && texts[0].length > 0 && texts[0].length <= 3) {
        for (const m of pseudo) m.remove()
        list.style.setProperty('--dia-marker', `"${texts[0].replace(/"/g, '')}"`)
        const ink = colors[0] ? ctx.tokenColor(colors[0]) ?? colors[0] : ''
        if (ink && ink !== 'var(--dia-accent)') list.style.setProperty('--dia-marker-ink', ink)
        list.style.listStyle = 'none'
        list.style.paddingLeft = '0'
        continue
      }
      // per-item variants — meaning, not styling: keep each, as a slot
      for (const m of pseudo) {
        m.classList.remove('dia-pseudo-marker')
        m.classList.add('dia-marker')
        const ink = m.style.color ? ctx.tokenColor(m.style.color) : null
        if (ink) m.style.color = ink
      }
      list.style.listStyle = 'none'
      list.style.paddingLeft = '0'
      continue
    }
    // icon markers: a leading svg/img at glyph scale becomes a slot
    for (const li of items) {
      const first = li.firstElementChild
      if (!first || first.classList.contains('dia-marker')) continue
      if (!/^(svg|img)$/i.test(first.tagName)) continue
      const s = ctx.sample(first)
      if (s && (s.w > 56 || s.h > 56)) continue // a figure, not a marker
      const slot = document.createElement('span')
      slot.className = 'dia-marker'
      li.insertBefore(slot, first)
      slot.appendChild(first)
      list.style.listStyle = 'none'
      list.style.paddingLeft = '0'
    }
  }
  // leftover materialized pseudo spans (kickers, decorations, non-list
  // ::before) stay as content — drop the recognition tag, keep the span
  for (const rest of section.querySelectorAll('.dia-pseudo-marker')) {
    rest.classList.remove('dia-pseudo-marker')
    if (rest.getAttribute('class') === '') rest.removeAttribute('class')
  }
}

function applyVerticalRhythm(
  section: HTMLElement, srcRoot: HTMLElement, ctx: Ctx,
  slide: ExtractedSlide,
): void {
  const rect = slide.rect
  if (rect.h < 10) return
  let minY = Infinity
  let maxY = -Infinity
  for (const el of srcRoot.querySelectorAll(`[${STAMP}]`)) {
    const s = ctx.sample(el)
    if (!s || s.w < 2 || s.h < 2) continue
    if (s.position === 'fixed') continue
    const isMedia = /^(IMG|SVG|CANVAS|VIDEO|FIGURE)$/.test(el.tagName.toUpperCase())
    if (s.ownChars === 0 && !isMedia) continue // containers don't define the content box
    minY = Math.min(minY, s.y)
    maxY = Math.max(maxY, s.y + s.h)
  }
  if (!Number.isFinite(minY) || maxY <= minY) return
  const topGap = minY - rect.y
  const bottomGap = rect.y + rect.h - maxY

  const boxes = [...section.children]
    .map((el) => ({ el: el as HTMLElement, s: ctx.sample(el) }))
    .filter((b): b is { el: HTMLElement; s: ElementSample } =>
      !!b.s && b.s.w >= 2 && b.s.h >= 2 && b.s.position !== 'fixed')
  // vertical margins in cqw resolve against the slide's width — the same
  // proportional unit rebindSizes uses, stable across deck sizes
  const layoutW = slide.layoutW || rect.w
  const cqw = (px: number): string => `${Math.round((px / layoutW) * 10000) / 100}cqw`

  /* ---- THE GAP GRAPH: layout reconstruction from measured distances ----
   *
   * The children plus the container's two edges form a distance sequence:
   *   topSlack · block · (gap · block)* · bottomSlack
   * Every distance the theme's flow rhythm would not reproduce is DESIGN
   * and must survive. Two encodings, chosen by what a distance relates:
   *
   *   fixed (cqw margin)   spacing between CONTENT — exact, proportional
   *   elastic (auto margin) slack shared with container EDGES — reflows
   *                         (a footer stays ON the bottom edge when text
   *                         wraps taller; a centered group stays centered)
   *
   * Footer, centered, low statement, and even distribution are not cases —
   * they all derive from edge anchoring:
   *   top+bottom anchored → the gaps ARE the free space: comparable gaps
   *     split it as autos (even spread / pinned footer); dominant designed
   *     gaps stay fixed and the largest absorbs reflow
   *   top anchored only  → every gap fixed (exact; the open bottom absorbs)
   *   bottom anchored only → gaps fixed, top slack elastic (content rides
   *     the bottom edge)
   *   neither anchored   → gaps fixed; balanced edges → both elastic
   *     (centered group with exact internal rhythm); unbalanced → exact
   *     top offset, open bottom absorbs
   */
  // anchored = the content hugs that edge beyond its own padding; the
  // threshold is deliberately tight — misreading a centered hero as
  // top-anchored pins it to the top and costs real fidelity
  const EDGE = Math.max(rect.h * 0.03, slide.padPx * 0.3)
  const FLOW_MAX = rect.h * 0.04 // below this, the theme's own rhythm is fine
  const SLOT_MIN = rect.h * 0.06 // above this, a gap can share edge slack

  const topSlack = Math.max(0, topGap - slide.padPx)
  const bottomSlack = Math.max(0, bottomGap - slide.padPx)
  const topAnchored = topSlack < EDGE
  const bottomAnchored = bottomSlack < EDGE

  // no measurable direct children (content nested beyond the stamped
  // wrappers): the only safe move is centering the whole section
  if (boxes.length === 0) {
    if (!topAnchored && !bottomAnchored &&
        Math.abs(topSlack - bottomSlack) < Math.max(topSlack, bottomSlack) * 0.6) {
      section.style.display = 'flex'
      section.style.flexDirection = 'column'
      section.style.justifyContent = 'center'
    }
    return
  }

  interface Gap { i: number; px: number }
  const gaps: Gap[] = []
  for (let i = 1; i < boxes.length; i++) {
    const px = boxes[i].s.y - (boxes[i - 1].s.y + boxes[i - 1].s.h)
    // out-of-order or overlapping samples (overlays, columns) say nothing
    // about flow spacing — skip rather than invent a margin
    if (px >= FLOW_MAX && px <= rect.h * 0.9) gaps.push({ i, px })
  }

  const fixed = (g: Gap): void => setStyleSafe(boxes[g.i].el, 'margin-top', cqw(g.px))
  let usedAuto = false
  const auto = (el: HTMLElement, side: 'margin-top' | 'margin-bottom' = 'margin-top'): void => {
    el.style.setProperty(side, 'auto')
    usedAuto = true
  }

  if (topAnchored && bottomAnchored) {
    // content spans the full height — the big gaps ARE the free space
    const slots = gaps.filter((g) => g.px >= SLOT_MIN)
    const rest = gaps.filter((g) => g.px < SLOT_MIN)
    for (const g of rest) fixed(g)
    if (slots.length > 0) {
      const sizes = slots.map((g) => g.px)
      const comparable = Math.max(...sizes) / Math.min(...sizes) < 2
      if (comparable) for (const g of slots) auto(boxes[g.i].el) // even spread / pinned footer
      else {
        // designed, unequal gaps: exact except the largest, which absorbs reflow
        const largest = slots.reduce((a, b) => (b.px > a.px ? b : a))
        for (const g of slots) g === largest ? auto(boxes[g.i].el) : fixed(g)
      }
    }
  } else if (topAnchored) {
    for (const g of gaps) fixed(g) // exact everywhere; the open bottom absorbs
  } else if (bottomAnchored) {
    for (const g of gaps) fixed(g)
    auto(boxes[0].el) // content rides the bottom edge, slack above is elastic
  } else {
    for (const g of gaps) fixed(g)
    const balanced = Math.abs(topSlack - bottomSlack) < Math.max(topSlack, bottomSlack) * 0.6
    if (balanced) {
      // centered group with exact internal rhythm
      auto(boxes[0].el)
      auto(boxes[boxes.length - 1].el, 'margin-bottom')
    } else if (boxes.length > 0) {
      // a deliberate off-center placement keeps its exact top offset
      setStyleSafe(boxes[0].el, 'margin-top', cqw(topSlack))
    }
  }
  if (usedAuto) {
    section.style.display = 'flex'
    section.style.flexDirection = 'column'
  }

  /* ---- horizontal: the same distances, on the other axis ---- */
  const contentW = layoutW - 2 * slide.padPx
  for (const b of boxes) {
    if (b.el.style.marginLeft || b.el.style.marginRight) continue
    const left = b.s.x - (rect.x + slide.padPx)
    const right = rect.x + rect.w - slide.padPx - (b.s.x + b.s.w)
    // only blocks the source drew meaningfully narrower than the content
    // column carry horizontal placement — full-width blocks stay fluid
    if (b.s.w > contentW * 0.85 || contentW <= 0) continue
    if (left > rect.w * 0.05 && Math.abs(left - right) < Math.max(left, right) * 0.4) {
      // centered narrow block: elastic margins + its designed measure
      b.el.style.marginLeft = 'auto'
      b.el.style.marginRight = 'auto'
      setStyleSafe(b.el, 'max-width', cqw(b.s.w))
    } else if (left > rect.w * 0.05) {
      setStyleSafe(b.el, 'margin-left', cqw(left))
    }
  }
}

/* ---------------- role picks ---------------- */

/** largest text block wins; headings win near-ties */
function pickTitle(srcRoot: HTMLElement, ctx: Ctx): Element | null {
  let best: Element | null = null
  let bestSize = 0
  for (const el of textBearing(srcRoot, ctx)) {
    const s = ctx.sample(el)!
    if (s.fontSizePx > bestSize + 0.5) { best = el; bestSize = s.fontSizePx }
    else if (Math.abs(s.fontSizePx - bestSize) <= 0.5 && best && !isHeading(best) && isHeading(el)) best = el
  }
  return best ?? srcRoot.querySelector('h1, h2')
}

/** short (<60 chars) uppercase / letter-spaced / small element above the title */
function pickKicker(srcRoot: HTMLElement, ctx: Ctx): Element | null {
  if (!ctx.titleEl) return null
  const ts = ctx.sample(ctx.titleEl)
  if (!ts) return null
  for (const el of textBearing(srcRoot, ctx)) {
    if (el === ctx.titleEl) continue
    const s = ctx.sample(el)!
    if (s.ownText.length >= 60) continue
    if (s.y >= ts.y) continue
    if (s.fontSizePx >= ts.fontSizePx) continue
    const spaced = s.letterSpacing !== 'normal' && parseFloat(s.letterSpacing) > 0
    if (s.textTransform === 'uppercase' || spaced || s.fontSizePx <= ts.fontSizePx * 0.5) return el
  }
  return null
}

function textBearing(srcRoot: HTMLElement, ctx: Ctx): Element[] {
  const out: Element[] = []
  for (const el of [srcRoot, ...srcRoot.querySelectorAll(`[${STAMP}]`)]) {
    const s = ctx.sample(el)
    if (s && s.ownChars > 0) out.push(el)
  }
  return out
}

function isHeading(el: Element): boolean {
  return /^H[1-6]$/.test(el.tagName.toUpperCase())
}

/* ---------------- node conversion ---------------- */

function convertContainerChildren(el: Element, ctx: Ctx): Node[] {
  const kids = [...el.children].filter((c) => !DROP.has(c.tagName.toUpperCase()))
  const cols = detectColumns(kids, ctx)
  if (cols) {
    const wrap = div('dia-columns')
    // measured widths become fr weights, so a 5-card pipeline with narrow
    // arrow separators (or a 40/60 split) keeps the SOURCE's proportions —
    // equal columns would inflate the separators and shrink the cards
    const widths = cols.map((c) => Math.max(1, Math.round(ctx.sample(c)?.w ?? 1)))
    const uniform = widths.every((w) => Math.abs(w - widths[0]) / widths[0] < 0.05)
    if (!uniform) wrap.style.gridTemplateColumns = widths.map((w) => `${w}fr`).join(' ')
    else if (cols.length !== 2) wrap.style.gridTemplateColumns = `repeat(${cols.length}, 1fr)`
    for (const col of cols) {
      const stack = div('dia-stack')
      stack.append(...convertNode(col, ctx))
      wrap.appendChild(stack)
    }
    return [wrap]
  }

  // ORDER-PRESERVING walk of childNodes. Mixed content is common in real
  // decks — a block child, then direct text interleaved with <em>/<b> runs.
  // Recursing per ELEMENT child rips the runs out of their sentences and
  // orphans the direct text; instead, consecutive inline content (text
  // nodes + inline elements) stays together as ONE flow block, in place.
  const out: Node[] = []
  let seg: ChildNode[] = []
  const flush = (): void => {
    if (seg.length === 0) return
    const nodes = seg
    seg = []
    if (!nodes.some((n) => norm(n.textContent ?? ''))) return // whitespace only
    out.push(inlineSegment(el, nodes, ctx))
  }
  for (const n of el.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) { seg.push(n as ChildNode); continue }
    if (!(n instanceof Element)) continue
    const tag = n.tagName.toUpperCase()
    if (DROP.has(tag)) continue
    // math renders as inline spans but must NOT join a text run — it
    // converts whole, as a .dia-math (see mathNode)
    if (n.matches(MATH_ROOTS)) { flush(); out.push(mathNode(n, ctx)); continue }
    if (INLINE.has(tag)) { seg.push(n); continue }
    flush()
    out.push(...convertNode(n, ctx))
  }
  flush()
  return out
}

/** one run of consecutive inline content — a sentence with its emphasis
 * runs — kept whole as a single flow block; runs keep their computed
 * accent colors and weights, exactly like inlineLeaf */
function inlineSegment(container: Element, nodes: ChildNode[], ctx: Ctx): HTMLElement {
  const node = div('dia-body')
  const srcRuns: Element[] = []
  for (const n of nodes) {
    node.appendChild(n.cloneNode(true))
    if (n instanceof Element) srcRuns.push(n, ...n.querySelectorAll('*'))
  }
  const outRuns = [...node.querySelectorAll('*')]
  const parentColor = ctx.sample(container)?.color
  for (let i = 0; i < srcRuns.length && i < outRuns.length; i++) {
    const s = ctx.sample(srcRuns[i])
    if (!s) continue
    const o = outRuns[i] as HTMLElement
    if (s.color && s.color !== parentColor) o.style.color = ctx.tokenColor(s.color) ?? s.color
    if (s.fontWeight >= 600 && !/^(STRONG|B)$/.test(o.tagName)) o.style.fontWeight = '600'
  }
  for (const junk of node.querySelectorAll('script, style, noscript')) junk.remove()
  stripStamps(node)
  // the segment inherits its CONTAINER's stamp: the post-passes (size
  // rebinding, typography carry, build steps) look elements up by stamp,
  // and a segment without one is invisible to all of them — the source
  // kicker's uppercase/tracking silently vanished this way
  const stamp = container.getAttribute(STAMP)
  if (stamp) node.setAttribute(STAMP, stamp)
  return node
}

/** map a source framework's slide-transition vocabulary onto the dialect's.
 * reveal.js puts data-transition on the section (possibly "in-spec out-spec");
 * anything zoom/convex/slide-flavored becomes 'slide', fades stay fades. */
function inferTransition(srcRoot: Element): string | null {
  const holder = srcRoot.closest('[data-transition]') ?? srcRoot.querySelector(':scope[data-transition], [data-transition]')
  const raw = (srcRoot.getAttribute('data-transition') ?? holder?.getAttribute('data-transition'))?.toLowerCase()
  if (!raw) return srcRoot.hasAttribute('data-auto-animate') ? 'fade' : null
  const first = raw.split(/[\s-]/)[0] // "slide-in fade-out" → judge the entrance
  if (first === 'none') return 'none'
  if (first === 'fade' || first === 'crossfade') return 'fade'
  if (['slide', 'convex', 'concave', 'zoom', 'cube', 'page'].includes(first)) return 'slide'
  return null
}

/* ---------- math recovery ----------
 * KaTeX/MathJax render math as positioned spans that convert to MANGLED
 * text; the TeX source usually rides along (KaTeX embeds an annotation,
 * MathJax keeps script[type="math/tex"]). Recover the source, re-render
 * to native MathML, and emit the dialect's .dia-math — imported formulas
 * become as editable as authored ones. Raw <math> passes through. */

const MATH_ROOTS = 'math, .katex-display, .katex, mjx-container, .MathJax'

function mathTexOf(el: Element): string | null {
  const ann = el.querySelector('annotation[encoding="application/x-tex"]')
  if (ann?.textContent?.trim()) return ann.textContent.trim()
  const script = el.querySelector('script[type^="math/tex"]') ?? (el.matches('script[type^="math/tex"]') ? el : null)
  if (script?.textContent?.trim()) return script.textContent.trim()
  return null
}

function buildMathEl(el: Element): HTMLElement {
  const tex = mathTexOf(el)
  const display = el.matches('.katex-display, mjx-container[display="true"], math[display="block"]') ||
    !!el.querySelector(':scope math[display="block"]')
  const out = document.createElement(display ? 'div' : 'span')
  out.className = 'dia-math'
  if (tex) {
    out.setAttribute('data-dia-tex', tex)
    try {
      out.innerHTML = temml.renderToString(tex, { displayMode: display, throwOnError: true })
    } catch { /* fall through to the source MathML */ }
  }
  if (!out.firstChild) {
    const mml = el.tagName.toLowerCase() === 'math' ? el : el.querySelector('math')
    if (mml) out.appendChild(mml.cloneNode(true))
    else out.textContent = norm(el.textContent ?? '')
  }
  return out
}

function mathNode(el: Element, ctx: Ctx): HTMLElement {
  const out = buildMathEl(el)
  ctx.notes.push({
    node: out, kind: 'low-structure',
    note: out.hasAttribute('data-dia-tex')
      ? 'math recovered — TeX source preserved on the element'
      : 'math carried as MathML (no TeX source found)',
  })
  return out
}

function convertNode(el: Element, ctx: Ctx): Node[] {
  const tag = el.tagName.toUpperCase()
  if (DROP.has(tag)) return [] // scripts stripped — rendered content already captured
  if (el.matches(MATH_ROOTS)) return [mathNode(el, ctx)]
  if (el.matches(CHROME_SEL)) {
    ctx.notes.push({
      node: null,
      kind: 'stripped-chrome',
      note: `framework navigation chrome removed (${describe(el)}) — the dialect runtime replaces it`,
    })
    return []
  }
  if (tag === 'IMG') return [figure(el, ctx)]
  // chart lift hints (pptx front-end, or any source that carries them):
  // the DATA maps 1:1 onto the dialect chart grammar — emit a real
  // token-bound dia-chart instead of freezing a picture
  if (tag === 'SVG' && el.getAttribute('data-chart') && el.getAttribute('data-values')) {
    return [chartNode(el, ctx)]
  }
  if (tag === 'SVG') return [svgNode(el, ctx)]
  // speaker notes are already dialect — keep them whole
  if (tag === 'ASIDE' && el.classList.contains('dia-notes')) {
    const notes = document.createElement('aside')
    notes.className = 'dia-notes'
    notes.innerHTML = el.innerHTML
    notes.removeAttribute('style')
    return [notes]
  }
  if (UNMAPPABLE.has(tag)) {
    return [island(el, ctx, `<${tag.toLowerCase()}> may carry live behavior we cannot verify`)]
  }
  const shape = cssShape(el, ctx)
  if (shape) return [shape]
  if (el === ctx.titleEl) return [roleNode(el, 'dia-title', isHeading(el) ? el.tagName.toLowerCase() : 'h1')]
  if (el === ctx.kickerEl) return [roleNode(el, 'dia-kicker', 'div')]
  if (tag === 'UL' || tag === 'OL') return [structuredBody(el)]
  if (tag === 'TABLE' || tag === 'DL') return [structuredBody(el)]
  if (tag === 'P' || tag === 'BLOCKQUOTE' || tag === 'PRE') return [roleNode(el, 'dia-body', el.tagName.toLowerCase())]
  if (isHeading(el)) return [roleNode(el, 'dia-body', el.tagName.toLowerCase())]
  if (CONTAINER.has(tag)) {
    if (isAbsoluteSoup(el, ctx)) return [island(el, ctx, 'position:absolute layout — geometry kept as-is')]
    // a container whose children are ALL inline runs is a SENTENCE, not a
    // layout container — recursing per-child would shred it into blocks
    // ("…loses [resolution] — and [which] items." → three stacked lines)
    if (isInlineLeaf(el)) return [inlineLeaf(el, ctx)]
    return convertContainerChildren(el, ctx)
  }
  const s = ctx.sample(el)
  if ((s && s.ownChars > 0) || norm(el.textContent ?? '')) return [roleNode(el, 'dia-body', 'div')]
  return []
}

/** ≥2 rendered rects side by side → columns. The cap tolerates real rows
 * (a 5-step pipeline with 4 arrow separators is 9 children). */
function detectColumns(kids: Element[], ctx: Ctx): Element[] | null {
  if (kids.length < 2 || kids.length > 12) return null
  const rects = kids.map((k) => ctx.sample(k))
  if (rects.some((r) => !r || r.w < 2 || r.h < 2)) return null
  const sorted = kids
    .map((k, i) => ({ k, r: rects[i]! }))
    .sort((a, b) => a.r.x - b.r.x)
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1].r
    const b = sorted[i].r
    if (b.x < a.x + a.w * 0.7) return null
    const overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
    if (overlap < 0.4 * Math.min(a.h, b.h)) return null
  }
  return sorted.map((s) => s.k)
}

function isAbsoluteSoup(el: Element, ctx: Ctx): boolean {
  const kids = [...el.children].filter((c) => !DROP.has(c.tagName.toUpperCase()))
  if (kids.length < 2) return false
  const abs = kids.filter((k) => {
    const s = ctx.sample(k)
    return s && (s.position === 'absolute' || s.position === 'fixed')
  })
  return abs.length / kids.length >= 0.5
}

function figure(img: Element, ctx: Ctx): HTMLElement {
  const fig = div('dia-figure')
  const im = document.createElement('img')
  for (const a of ['src', 'alt', 'width', 'height']) {
    const v = img.getAttribute(a)
    if (v !== null) im.setAttribute(a, v)
  }
  const s = ctx.sample(img)
  if (s && s.objectFit && s.objectFit !== 'fill') im.style.objectFit = s.objectFit
  fitMedia(im)
  sizeToSource(im, ctx.sample(img), ctx)
  fig.appendChild(im)
  return fig
}

/** Figures keep their SOURCE size fraction: an image that filled 42% of the
 * original slide renders at 42cqw — cqw resolves against the slide
 * container even inside nested columns, and max-width:100% still guards
 * narrower cells. Without this, media collapses to intrinsic size or
 * balloons to its container: the second geometric error the honest metric
 * exposed. */
function sizeToSource(el: HTMLElement | SVGElement, s: ElementSample | undefined, ctx: Ctx): void {
  if (!s || s.w < 2 || ctx.contentW <= 0) return
  const frac = (s.w / ctx.contentW) * 100
  if (frac < 4 || frac > 120) return
  el.style.width = `${Math.round(Math.min(frac, 100) * 100) / 100}cqw`
}

/** Kept media carries fixed design-space pixel sizes (attrs sized for the
 * source's 1280px stage); rendered in a narrower converted layout with
 * overflow:hidden it CLIPS. Scale down to fit, never up, aspect held. */
function fitMedia(el: HTMLElement | SVGElement): void {
  el.style.maxWidth = '100%'
  el.style.height = 'auto'
}

/** a source svg carrying dia-chart data hints → a dialect chart, derived
 * fresh through the real renderer so it re-themes with the deck */
function chartNode(el: Element, ctx: Ctx): Element {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'dia-chart')
  svg.setAttribute('viewBox', '0 0 430 300')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', el.getAttribute('aria-label') ?? 'chart')
  for (const a of ['data-chart', 'data-values', 'data-max', 'data-unit']) {
    const v = el.getAttribute(a)
    if (v !== null) svg.setAttribute(a, v)
  }
  renderChart(svg)
  const fig = document.createElement('figure')
  fig.className = 'dia-figure'
  // keep the source frame's footprint — an unsized figure svg fills the
  // slide and clips
  const srcW = parseFloat(el.getAttribute('width') ?? '')
  fig.setAttribute('style', `margin: 0; width: ${Number.isFinite(srcW) && srcW > 40 ? Math.round(srcW) : 460}px; max-width: 100%;`)
  fig.appendChild(svg)
  ctx.notes.push({ node: fig, kind: 'lifted-svg', note: 'chart lifted to data — edit the values, the rendering re-derives' })
  return fig
}

function svgNode(el: Element, ctx: Ctx): Element {
  const lifted = el.hasAttribute('data-dia-node') || el.querySelector('[data-dia-node]') !== null
  const clone = document.importNode(el, true) as SVGSVGElement
  stripStamps(clone)
  // a viewBox makes the svg scalable; synthesize one from the fixed size
  if (!clone.hasAttribute('viewBox')) {
    const w = parseFloat(clone.getAttribute('width') ?? '')
    const h = parseFloat(clone.getAttribute('height') ?? '')
    if (w > 0 && h > 0) clone.setAttribute('viewBox', `0 0 ${w} ${h}`)
  }
  fitMedia(clone)
  sizeToSource(clone, ctx.sample(el), ctx)
  if (lifted) {
    ctx.notes.push({ node: clone, kind: 'lifted-svg', note: 'scene svg with dia nodes — kept as an editable scene' })
    return clone
  }
  // ANIMATED svgs stay verbatim: SMIL children are the animation itself,
  // and extraction injected the css @keyframes inside the svg — lifting
  // would rebuild shapes and silently kill the motion
  if (clone.querySelector('animate, animateTransform, animateMotion, set, style.dia-anim-keyframes, [style*="animation-name"]')) {
    const fig = div('dia-figure')
    fig.appendChild(clone)
    ctx.notes.push({ node: fig, kind: 'low-structure', note: 'animated svg — kept verbatim, animation preserved' })
    return fig
  }
  // deterministic promotion: provably-exact shapes become editable scene
  // nodes in place; text/edges stay verbatim (the LLM lift adds semantics)
  const n = liftSimpleSvg(clone, (c) => ctx.tokenColor(c))
  if (n > 0) {
    ctx.notes.push({
      node: clone,
      kind: 'lifted-svg',
      note: `${n} shape${n > 1 ? 's' : ''} lifted into an editable scene — edge/label semantics via the dia service`,
    })
    return clone
  }
  const fig = div('dia-figure')
  fig.appendChild(clone)
  ctx.notes.push({ node: fig, kind: 'low-structure', note: 'static svg — semantic lift available with the dia service' })
  return fig
}

/** CSS-drawn decorative shape → one-node scene svg, exactly reproduced.
 * Only the provably exact cases convert: an absolutely-positioned leaf with
 * no text, a solid uniform background/border, no gradient, no transform,
 * and a simple border-radius. Geometry is expressed in slide-relative
 * percentages so it survives any render scale. Everything else keeps the
 * current behavior (the pixel loop reports what was lost). */
function cssShape(el: Element, ctx: Ctx): Element | null {
  const s = ctx.sample(el)
  if (!s || el.children.length > 0 || s.ownChars > 0) return null
  if (s.position !== 'absolute' && s.position !== 'fixed') return null
  if (s.transform && s.transform !== 'none') return null
  if (s.bgImage && s.bgImage !== 'none') return null
  const filled = !isTransparentColor(s.background)
  const stroked = s.borderW > 0
  if (!filled && !stroked) return null
  if (stroked && (s.borderStyle !== 'solid' || !s.borderUniform)) return null
  if (s.w < 2 || s.h < 2) return null
  const radius = parseRadius(s.radius, s.w, s.h)
  if (radius === null) return null

  // CSS paints the border inside the box edge; SVG centers strokes on the
  // outline — inset by half the border so the outer edges coincide
  const inset = stroked ? s.borderW / 2 : 0
  const g: { x: number; y: number; w: number; h: number } = {
    x: inset, y: inset, w: s.w - 2 * inset, h: s.h - 2 * inset,
  }
  const r = Math.max(0, radius - inset)
  let shape: 'rect' | 'ellipse' | 'pill' | 'path'
  let path: string | undefined
  if (radius === Infinity || r >= Math.min(g.w, g.h) / 2 - 0.01) {
    // fully rounded: a circle/ellipse when radius saturates both axes,
    // a pill when only the short axis saturates
    if (radius === Infinity) shape = 'ellipse'
    else if (g.h <= g.w) shape = 'pill'
    else { shape = 'path'; path = roundedRectPath((g.w / 2) * (100 / g.w), (g.w / 2) * (100 / g.h)) }
  } else if (r <= 0.01) {
    shape = 'rect'
  } else {
    shape = 'path'
    path = roundedRectPath(r * (100 / g.w), r * (100 / g.h))
  }

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGSVGElement
  svg.setAttribute('class', 'dia-scene')
  svg.setAttribute('viewBox', `0 0 ${Math.round(s.w * 100) / 100} ${Math.round(s.h * 100) / 100}`)
  const sr = ctx.slideRect
  const pct = (v: number, of: number) => `${Math.round((v / of) * 10000) / 100}%`
  svg.setAttribute('style',
    `position:absolute; left:${pct(s.x - sr.x, sr.w)}; top:${pct(s.y - sr.y, sr.h)}; ` +
    `width:${pct(s.w, sr.w)}; height:${pct(s.h, sr.h)};`)
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'g') as SVGGElement
  node.setAttribute('data-dia-node', 'd1')
  node.setAttribute('data-shape', shape)
  if (path) node.setAttribute('data-path', path)
  node.setAttribute('data-x', String(Math.round(g.x * 100) / 100))
  node.setAttribute('data-y', String(Math.round(g.y * 100) / 100))
  node.setAttribute('data-w', String(Math.round(g.w * 100) / 100))
  node.setAttribute('data-h', String(Math.round(g.h * 100) / 100))
  node.setAttribute('style',
    `--dia-node-fill: ${filled ? ctx.tokenColor(s.background) ?? s.background : 'none'}; ` +
    `--dia-node-stroke: ${stroked ? ctx.tokenColor(s.borderColor) ?? s.borderColor : 'none'}; ` +
    `--dia-node-stroke-w: ${stroked ? s.borderW : 1}`)
  svg.appendChild(node)
  renderNodeShape(node)
  ctx.notes.push({
    node: svg, kind: 'lifted-svg',
    note: 'css-drawn shape reproduced as an editable scene node',
  })
  return svg
}

function isTransparentColor(c: string): boolean {
  return !c || c === 'transparent' || /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\)$/.test(c)
}

/** single-value border-radius → px (Infinity for the 50% ellipse case);
 * null = compound/mixed radius we won't reproduce */
function parseRadius(radius: string, w: number, h: number): number | null {
  const v = (radius ?? '').trim()
  if (!v || v === '0px') return 0
  if (/^\d+(\.\d+)?%$/.test(v)) {
    const p = parseFloat(v)
    if (p >= 50) return Infinity
    // percentage radii are per-axis (elliptical corners) — exact only when square
    return w === h ? (p / 100) * w : null
  }
  if (/^\d+(\.\d+)?px$/.test(v)) return parseFloat(v)
  return null
}

/** the unmappable: original subtree preserved verbatim inside a marked island
 * (stamps stripped; scripts stripped everywhere — the rendered state is the content) */
function island(el: Element, ctx: Ctx, reason: string): HTMLElement {
  const wrap = div('dia-island')
  wrap.setAttribute('data-dia-island', '')
  const clone = document.importNode(el, true)
  stripStamps(clone)
  for (const s of clone.querySelectorAll('script, noscript')) s.remove()
  wrap.appendChild(clone)
  ctx.islands++
  ctx.notes.push({ node: wrap, kind: 'island', note: `preserved verbatim — ${reason}` })
  return wrap
}

function roleNode(el: Element, cls: string, tag: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = cls
  node.innerHTML = cleanInnerHtml(el)
  keepStamp(el, node) // rebindSizes reads the source sample; finalize strips
  return node
}

function keepStamp(from: Element, to: HTMLElement): void {
  const stamp = from.getAttribute(STAMP)
  if (stamp) to.setAttribute(STAMP, stamp)
}

/** lists/tables keep their structure, restyled as body */
function structuredBody(el: Element): HTMLElement {
  const node = document.createElement(el.tagName.toLowerCase())
  node.className = 'dia-body'
  keepStamp(el, node)
  node.innerHTML = cleanInnerHtml(el)
  return node
}

/** inline formatting that keeps an element a text LEAF, never a container */
const INLINE = new Set([
  'SPAN', 'A', 'EM', 'I', 'STRONG', 'B', 'U', 'S', 'CODE', 'MARK',
  'SMALL', 'SUB', 'SUP', 'BR', 'ABBR', 'KBD', 'WBR',
])

function isInlineLeaf(el: Element): boolean {
  if (!norm(el.textContent ?? '')) return false
  const kids = [...el.querySelectorAll('*')]
  return kids.length > 0 && kids.every((c) => INLINE.has(c.tagName.toUpperCase()))
}

/** a sentence with inline runs — kept whole, runs recolored from their
 * COMPUTED source color when it differs from the parent (accent words) */
function inlineLeaf(el: Element, ctx: Ctx): HTMLElement {
  const node = roleNode(el, 'dia-body', 'div')
  const parentColor = ctx.sample(el)?.color
  const srcRuns = [...el.querySelectorAll('*')]
  const outRuns = [...node.querySelectorAll('*')]
  for (let i = 0; i < srcRuns.length && i < outRuns.length; i++) {
    const s = ctx.sample(srcRuns[i])
    if (!s) continue
    const out = outRuns[i] as HTMLElement
    if (s.color && s.color !== parentColor) out.style.color = ctx.tokenColor(s.color) ?? s.color
    if (s.fontWeight >= 600 && !/^(STRONG|B)$/.test(out.tagName)) out.style.fontWeight = '600'
  }
  return node
}

function cleanInnerHtml(el: Element): string {
  const clone = el.cloneNode(true) as Element
  // rendered math INSIDE a text block: the span forest becomes .dia-math
  // here too, so no path can carry mangled formula glyphs into the deck
  for (const m of [...clone.querySelectorAll(MATH_ROOTS)]) {
    if (!clone.contains(m)) continue // nested renderer wrappers: outermost won
    m.replaceWith(buildMathEl(m))
  }
  for (const s of clone.querySelectorAll('script, style, noscript')) s.remove()
  stripStamps(clone)
  return clone.innerHTML
}

function stripStamps(el: Element): void {
  el.removeAttribute(STAMP)
  for (const n of el.querySelectorAll(`[${STAMP}]`)) n.removeAttribute(STAMP)
}

function div(cls: string): HTMLDivElement {
  const d = document.createElement('div')
  d.className = cls
  return d
}

function describe(el: Element): string {
  const cls = el.classList[0] ? `.${el.classList[0]}` : ''
  return `${el.tagName.toLowerCase()}${cls}`
}

/* ---------------- verification + finish ---------------- */

/** TEXT IS SACRED: verify every visible source text survived conversion,
 * derive honest structural confidence, resolve region-note locators. */
function finalize(
  section: HTMLElement,
  slide: ExtractedSlide,
  index: number,
  notes: PendingNote[],
  islands: number,
): SlideConversion {
  stripStamps(section)
  const convText = norm(section.textContent ?? '')
  let mapped = 0
  let total = 0
  const warnings: string[] = []
  for (const t of slide.texts) {
    total += t.length
    if (convText.includes(t)) mapped += t.length
    else warnings.push(`slide ${index + 1}: source text missing after conversion — "${t.slice(0, 60)}${t.length > 60 ? '…' : ''}"`)
  }
  // ORDER matters as much as presence: a dismembered sentence keeps every
  // word and still reads as nonsense. Source texts must appear in source
  // order (advisory — deliberate visual reordering can trip it too).
  let cursor = 0
  let disordered = 0
  for (const t of slide.texts) {
    const at = convText.indexOf(t, cursor)
    if (at >= 0) cursor = at + t.length
    else if (convText.includes(t)) disordered++
  }
  if (disordered > 0) {
    warnings.push(`slide ${index + 1}: ${disordered} text fragment${disordered > 1 ? 's' : ''} out of source order — sentence structure may be broken`)
  }
  const confidence = Math.round((total > 0 ? mapped / total : 1) * (islands > 0 ? 0.9 : 1) * 1000) / 1000

  const regionNotes: RegionNote[] = notes.map((n) => ({
    slideIndex: index,
    locator: n.node && section.contains(n.node) ? locatorFor(n.node, section) : 'section.dia-slide',
    kind: n.kind,
    note: n.note,
  }))

  return { html: section.outerHTML, notes: regionNotes, confidence, warnings, islands }
}

/** css-path-ish locator within the converted slide */
function locatorFor(node: Element, root: Element): string {
  const parts: string[] = []
  let cur: Element | null = node
  while (cur && cur !== root) {
    const cls = cur.classList[0] ? `.${cur.classList[0]}` : ''
    let nth = ''
    const parent: Element | null = cur.parentElement
    if (parent) {
      const same = [...parent.children].filter((c) => c.tagName === cur!.tagName)
      if (same.length > 1) nth = `:nth-of-type(${same.indexOf(cur) + 1})`
    }
    parts.unshift(`${cur.tagName.toLowerCase()}${cls}${nth}`)
    cur = parent
  }
  return ['section.dia-slide', ...parts].join(' > ')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
