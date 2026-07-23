/* PPTX → faithful positioned HTML — the FRONT-END of pptx import.
 *
 * A .pptx is a zip of OOXML parts. This module renders its slides into a
 * self-contained HTML document (absolutely positioned, inline styles,
 * images as data URIs) that then flows through the NORMAL foreign-HTML
 * pipeline: execute → extract → convert → measure → review. Import
 * quality factors cleanly: this file owns "does the original render look
 * like PowerPoint", the pipeline owns "does the dialect match the
 * original" — and the fidelity score measures the second against the
 * first, exactly as with any foreign deck.
 *
 * The subset, chosen by fidelity-per-line: slide size + backgrounds,
 * master/layout placeholder inheritance (geometry AND text styles),
 * theme colors (with lum/tint/shade transforms) and fonts, shapes with
 * preset or custom geometry, gradient/solid/picture fills, text bodies
 * with run properties + bullets + autofit, images with crops and flips,
 * tables, single/multi-series bar·line·pie charts (single-series bar/
 * line/scatter carry dia-chart data hints the converter lifts), groups
 * with child-offset math, speaker notes (→ aside.dia-notes), and hidden
 * slides (skipped). Everything unrecognized degrades to its box. */

import { unzipSync } from 'fflate'

const EMU_PER_PX = 9525 // 914400 EMU/inch ÷ 96 px/inch
const DESIGN_W = 1280

/* ---------- zip + xml plumbing ---------- */

type Parts = Map<string, Uint8Array>

function textOf(parts: Parts, path: string): string | null {
  const bytes = parts.get(path)
  return bytes ? new TextDecoder().decode(bytes) : null
}

function xmlOf(parts: Parts, path: string): Document | null {
  const text = textOf(parts, path)
  if (!text) return null
  // r:* attributes share localName with plain attributes (`id` vs `r:id`
  // on p:sldId) — some XML DOMs drop one of the pair. Neutralize the
  // relationship prefix textually so lookups are plain and portable.
  // Also drop the XML declaration: lxml-based producers (python-pptx,
  // Aspose) write it with single quotes, which some XML DOMs reject —
  // the text is already decoded, so the declaration carries no information.
  const safe = text
    .replace(/^\uFEFF?\s*<\?xml[\s\S]*?\?>/, '')
    .replace(/\br:(id|embed|link|pict|dm|lo|qs|cs)=/g, 'r_$1=')
  const doc = new DOMParser().parseFromString(safe, 'application/xml')
  return doc.querySelector('parsererror') ? null : doc
}

/** a relationship attribute, whatever survived the parser */
function rid(el: Element | null, name: string): string | null {
  if (!el) return null
  return el.getAttribute(`r_${name}`) ?? el.getAttribute(`r:${name}`) ??
    el.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', name)
}

/** children (recursive) by LOCAL name — prefixes vary across producers */
function els(root: Element | Document | null, name: string): Element[] {
  if (!root) return []
  const out: Element[] = []
  const all = (root instanceof Document ? root.documentElement : root)?.getElementsByTagName('*')
  if (!all) return out
  for (const el of all) if (el.localName === name) out.push(el)
  return out
}

/** first DIRECT child by local name */
function child(el: Element | null, name: string): Element | null {
  if (!el) return null
  for (const c of el.children) if (c.localName === name) return c
  return null
}

function children(el: Element | null, name: string): Element[] {
  if (!el) return []
  return [...el.children].filter((c) => c.localName === name)
}

/** resolve a relationship id against a part's .rels */
function relTarget(parts: Parts, partPath: string, rId: string): string | null {
  const dir = partPath.slice(0, partPath.lastIndexOf('/'))
  const relsPath = `${dir}/_rels/${partPath.slice(partPath.lastIndexOf('/') + 1)}.rels`
  const rels = xmlOf(parts, relsPath)
  if (!rels) return null
  for (const r of els(rels, 'Relationship')) {
    if (r.getAttribute('Id') === rId) {
      const target = r.getAttribute('Target') ?? ''
      if (target.startsWith('/')) return target.slice(1)
      // resolve ../ against the part's directory
      const stack = dir.split('/')
      for (const seg of target.split('/')) {
        if (seg === '..') stack.pop()
        else if (seg !== '.') stack.push(seg)
      }
      return stack.join('/')
    }
  }
  return null
}

function relsOfType(parts: Parts, partPath: string, typeSuffix: string): string[] {
  const dir = partPath.slice(0, partPath.lastIndexOf('/'))
  const relsPath = `${dir}/_rels/${partPath.slice(partPath.lastIndexOf('/') + 1)}.rels`
  const rels = xmlOf(parts, relsPath)
  const out: string[] = []
  for (const r of els(rels, 'Relationship')) {
    if ((r.getAttribute('Type') ?? '').endsWith(typeSuffix)) {
      const id = r.getAttribute('Id')
      const t = id ? relTarget(parts, partPath, id) : null
      if (t) out.push(t)
    }
  }
  return out
}

/* ---------- colors ---------- */

interface Ctx {
  parts: Parts
  slidePath: string
  layout: Document | null
  layoutPath: string
  master: Document | null
  masterPath: string
  theme: Document | null
  clrMap: Record<string, string>
  scale: number // px per EMU-px after design-width normalization
  slideW: number
  slideH: number
}

function hex2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return [h, s, l]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const f = (t: number): number => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255]
}

/** theme scheme color hex (no #) for a scheme name */
function themeColor(ctx: Ctx, name: string): string {
  const scheme = els(ctx.theme, 'clrScheme')[0]
  const entry = child(scheme, name)
  if (!entry) return '000000'
  const srgb = child(entry, 'srgbClr')
  if (srgb) return srgb.getAttribute('val') ?? '000000'
  const sys = child(entry, 'sysClr')
  return sys?.getAttribute('lastClr') ?? (name.startsWith('lt') || name === 'bg1' ? 'FFFFFF' : '000000')
}

/** resolve any OOXML color node (srgbClr/schemeClr/sysClr/prstClr) with
 * its child transforms; returns css color or null */
function resolveColorNode(ctx: Ctx, node: Element | null): string | null {
  if (!node) return null
  let hex: string | null = null
  let alpha = 1
  const apply: Array<[string, number]> = []
  const grab = (el: Element): void => {
    for (const t of el.children) {
      const val = Number(t.getAttribute('val') ?? NaN) / 100000
      if (t.localName === 'alpha' && Number.isFinite(val)) alpha = val
      else if (['lumMod', 'lumOff', 'tint', 'shade', 'satMod'].includes(t.localName) && Number.isFinite(val)) {
        apply.push([t.localName, val])
      }
    }
  }
  if (node.localName === 'srgbClr') { hex = node.getAttribute('val'); grab(node) }
  else if (node.localName === 'sysClr') { hex = node.getAttribute('lastClr') ?? 'FFFFFF'; grab(node) }
  else if (node.localName === 'prstClr') { hex = PRESET_COLORS[node.getAttribute('val') ?? ''] ?? '000000'; grab(node) }
  else if (node.localName === 'schemeClr') {
    const raw = node.getAttribute('val') ?? 'tx1'
    const mapped = ctx.clrMap[raw] ?? raw
    hex = themeColor(ctx, mapped)
    grab(node)
  } else return null
  if (!hex) return null
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')
  let r = parseInt(hex.slice(0, 2), 16)
  let g = parseInt(hex.slice(2, 4), 16)
  let b = parseInt(hex.slice(4, 6), 16)
  if (apply.length) {
    let [h, s, l] = rgbToHsl(r, g, b)
    for (const [op, v] of apply) {
      if (op === 'lumMod') l *= v
      else if (op === 'lumOff') l += v
      else if (op === 'tint') l = l * v + (1 - v)
      else if (op === 'shade') l *= v
      else if (op === 'satMod') s = Math.min(1, s * v)
    }
    ;[r, g, b] = hslToRgb(h, Math.max(0, Math.min(1, s)), Math.max(0, Math.min(1, l)))
  }
  const rgbHex = `#${hex2(r)}${hex2(g)}${hex2(b)}`
  return alpha < 1 ? `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Math.round(alpha * 100) / 100})` : rgbHex
}

const PRESET_COLORS: Record<string, string> = {
  black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF',
  yellow: 'FFFF00', gray: '808080', darkGray: 'A9A9A9', lightGray: 'D3D3D3', orange: 'FFA500',
}

/** first color found under a fill-ish parent (solidFill etc.) */
function colorUnder(ctx: Ctx, parent: Element | null): string | null {
  if (!parent) return null
  for (const name of ['srgbClr', 'schemeClr', 'sysClr', 'prstClr']) {
    const n = child(parent, name)
    if (n) return resolveColorNode(ctx, n)
  }
  return null
}

/** css background for an spPr-like element's fill; null = no fill decl */
function fillCss(ctx: Ctx, holder: Element | null, partPath: string): string | null {
  if (!holder) return null
  if (child(holder, 'noFill')) return 'transparent'
  const solid = child(holder, 'solidFill')
  if (solid) return colorUnder(ctx, solid) ?? 'transparent'
  const grad = child(holder, 'gradFill')
  if (grad) {
    const stops = els(grad, 'gs')
      .map((gs) => ({ pos: Number(gs.getAttribute('pos') ?? 0) / 1000, color: colorUnder(ctx, gs) ?? '#888' }))
      .sort((a, b) => a.pos - b.pos)
    const lin = child(grad, 'lin')
    const deg = lin ? Number(lin.getAttribute('ang') ?? 0) / 60000 + 90 : 180
    if (stops.length >= 2) {
      return `linear-gradient(${Math.round(deg)}deg, ${stops.map((s) => `${s.color} ${s.pos}%`).join(', ')})`
    }
    return stops[0]?.color ?? null
  }
  const blip = child(holder, 'blipFill')
  if (blip) {
    const url = blipDataUrl(ctx, blip, partPath)
    if (url) return `url(${url}) center / cover no-repeat`
  }
  return null
}

/* ---------- geometry ---------- */

interface Box { x: number; y: number; w: number; h: number; rot: number; flipH: boolean; flipV: boolean }

/** parent group transform: maps child EMU coords into page px */
interface GroupCtm { offX: number; offY: number; scaleX: number; scaleY: number }

function boxOf(ctx: Ctx, xfrm: Element | null, ctm: GroupCtm): Box | null {
  if (!xfrm) return null
  const off = child(xfrm, 'off')
  const ext = child(xfrm, 'ext')
  if (!off || !ext) return null
  const x = Number(off.getAttribute('x') ?? 0)
  const y = Number(off.getAttribute('y') ?? 0)
  const cx = Number(ext.getAttribute('cx') ?? 0)
  const cy = Number(ext.getAttribute('cy') ?? 0)
  return {
    x: ctm.offX + x * ctm.scaleX,
    y: ctm.offY + y * ctm.scaleY,
    w: cx * ctm.scaleX,
    h: cy * ctm.scaleY,
    rot: Number(xfrm.getAttribute('rot') ?? 0) / 60000,
    flipH: xfrm.getAttribute('flipH') === '1',
    flipV: xfrm.getAttribute('flipV') === '1',
  }
}

function px(ctx: Ctx, emuScaled: number): number {
  return Math.round((emuScaled / EMU_PER_PX) * ctx.scale * 10) / 10
}

function boxStyle(ctx: Ctx, b: Box): string {
  let s = `position: absolute; left: ${px(ctx, b.x)}px; top: ${px(ctx, b.y)}px; ` +
    `width: ${px(ctx, b.w)}px; height: ${px(ctx, b.h)}px;`
  const t: string[] = []
  if (b.rot) t.push(`rotate(${Math.round(b.rot * 10) / 10}deg)`)
  if (b.flipH) t.push('scaleX(-1)')
  if (b.flipV) t.push('scaleY(-1)')
  if (t.length) s += ` transform: ${t.join(' ')};`
  return s
}

/* ---------- placeholders: geometry + style inheritance ---------- */

function phKey(sp: Element): { type: string; idx: string } | null {
  const ph = els(sp, 'ph')[0]
  if (!ph) return null
  return { type: ph.getAttribute('type') ?? 'body', idx: ph.getAttribute('idx') ?? '' }
}

/** find the matching placeholder sp in a layout/master document */
function findPh(doc: Document | null, key: { type: string; idx: string }): Element | null {
  if (!doc) return null
  let byType: Element | null = null
  for (const sp of els(doc, 'sp')) {
    const k = phKey(sp)
    if (!k) continue
    if (k.idx && key.idx && k.idx === key.idx) return sp
    if (k.type === key.type && !byType) byType = sp
    // titles come in flavors — ctrTitle on layouts matches title requests
    if ((key.type === 'title' && k.type === 'ctrTitle') || (key.type === 'ctrTitle' && k.type === 'title')) byType = byType ?? sp
  }
  return byType
}

/* ---------- text ---------- */

interface RunProps {
  size?: number // px
  bold?: boolean
  italic?: boolean
  underline?: boolean
  color?: string
  font?: string
  align?: string
  bullet?: string | null // rendered marker text; null = none
  indentPx?: number
  spaceBeforePx?: number
}

function mergeProps(base: RunProps, over: RunProps): RunProps {
  return { ...base, ...Object.fromEntries(Object.entries(over).filter(([, v]) => v !== undefined)) }
}

/** properties from an a:pPr / lvlNpPr / defPPr element (+ its defRPr) */
function propsOf(ctx: Ctx, p: Element | null): RunProps {
  const out: RunProps = {}
  if (!p) return out
  const algn = p.getAttribute('algn')
  if (algn) out.align = { l: 'left', ctr: 'center', r: 'right', just: 'justify' }[algn] ?? undefined
  const marL = p.getAttribute('marL')
  if (marL !== null) out.indentPx = px(ctx, Number(marL))
  if (child(p, 'buNone')) out.bullet = null
  const buChar = child(p, 'buChar')
  if (buChar) out.bullet = buChar.getAttribute('char') ?? '•'
  if (child(p, 'buAutoNum')) out.bullet = '#'
  const spcBef = child(p, 'spcBef')
  const spcPts = child(spcBef, 'spcPts')
  if (spcPts) out.spaceBeforePx = Number(spcPts.getAttribute('val') ?? 0) / 100 * (96 / 72)
  return mergeProps(out, runPropsOf(ctx, child(p, 'defRPr')))
}

/** properties from an a:rPr / a:defRPr element */
function runPropsOf(ctx: Ctx, r: Element | null): RunProps {
  const out: RunProps = {}
  if (!r) return out
  const sz = r.getAttribute('sz')
  if (sz !== null) out.size = Number(sz) / 100 * (96 / 72)
  const b = r.getAttribute('b')
  if (b !== null) out.bold = b === '1'
  const i = r.getAttribute('i')
  if (i !== null) out.italic = i === '1'
  const u = r.getAttribute('u')
  if (u !== null) out.underline = u !== 'none'
  const fill = child(r, 'solidFill')
  const c = colorUnder(ctx, fill)
  if (c) out.color = c
  const latin = child(r, 'latin')
  if (latin) {
    const face = latin.getAttribute('typeface') ?? ''
    out.font = face.startsWith('+mj') ? themeFont(ctx, 'majorFont')
      : face.startsWith('+mn') ? themeFont(ctx, 'minorFont') : face
  }
  return out
}

function themeFont(ctx: Ctx, which: 'majorFont' | 'minorFont'): string {
  const f = els(ctx.theme, which)[0]
  return child(f, 'latin')?.getAttribute('typeface') || 'Calibri'
}

/** the level style ladder for a placeholder type from master txStyles +
 * layout/master placeholder lstStyle chains */
function levelStyle(ctx: Ctx, sp: Element, lvl: number): RunProps {
  let props: RunProps = {}
  const key = phKey(sp)
  const lvlName = `lvl${lvl + 1}pPr`
  // 1. master txStyles bucket
  if (key && ctx.master) {
    const styles = els(ctx.master, 'txStyles')[0]
    const bucket = key.type === 'title' || key.type === 'ctrTitle'
      ? child(styles, 'titleStyle')
      : key.type === 'body' || key.type === 'subTitle' ? child(styles, 'bodyStyle') : child(styles, 'otherStyle')
    props = mergeProps(props, propsOf(ctx, child(bucket, lvlName) ?? child(bucket, 'lvl1pPr')))
  }
  // 2. master + layout placeholder lstStyle
  if (key) {
    for (const doc of [ctx.master, ctx.layout]) {
      const ph = findPh(doc, key)
      const ls = ph ? els(ph, 'lstStyle')[0] : null
      props = mergeProps(props, propsOf(ctx, child(ls, lvlName) ?? child(ls, 'lvl1pPr')))
    }
  }
  // 3. the shape's own lstStyle
  const own = els(sp, 'lstStyle')[0]
  props = mergeProps(props, propsOf(ctx, child(own, lvlName) ?? child(own, 'lvl1pPr')))
  return props
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function runStyle(p: RunProps): string {
  const bits: string[] = []
  if (p.size) bits.push(`font-size: ${Math.round(p.size * 10) / 10}px`)
  if (p.bold) bits.push('font-weight: bold')
  if (p.italic) bits.push('font-style: italic')
  if (p.underline) bits.push('text-decoration: underline')
  if (p.color) bits.push(`color: ${p.color}`)
  if (p.font) bits.push(`font-family: '${p.font.replace(/['"]/g, '')}', sans-serif`)
  return bits.join('; ')
}

/** render a txBody to html (paragraphs, runs, bullets, autofit, anchor) */
function renderTxBody(ctx: Ctx, sp: Element, tx: Element, defaultColor: string): string {
  const bodyPr = child(tx, 'bodyPr')
  const anchor = bodyPr?.getAttribute('anchor') ?? 't'
  const fit = els(bodyPr, 'normAutofit')[0]
  const fontScale = fit ? Number(fit.getAttribute('fontScale') ?? 100000) / 100000 : 1
  const paras: string[] = []
  let autoNum = 0
  let listOpen = false
  const closeList = (): void => { if (listOpen) { paras.push('</ul>'); listOpen = false } }
  for (const p of children(tx, 'p')) {
    const pPr = child(p, 'pPr')
    const lvl = Number(pPr?.getAttribute('lvl') ?? 0)
    const base = mergeProps({ color: defaultColor, size: 24 }, levelStyle(ctx, sp, lvl))
    const para = mergeProps(base, propsOf(ctx, pPr))
    const spans: string[] = []
    for (const node of p.children) {
      if (node.localName === 'r' || node.localName === 'fld') {
        const rp = mergeProps(para, runPropsOf(ctx, child(node, 'rPr')))
        if (fontScale !== 1 && rp.size) rp.size *= fontScale
        const text = child(node, 't')?.textContent ?? ''
        spans.push(`<span style="${runStyle(rp)}">${esc(text)}</span>`)
      } else if (node.localName === 'br') {
        spans.push('<br>')
      }
    }
    let marker = ''
    if (para.bullet === '#') { autoNum++; marker = `${autoNum}. ` }
    else if (para.bullet) marker = `${para.bullet} `
    const pStyle = [
      'margin: 0',
      para.align ? `text-align: ${para.align}` : '',
      para.spaceBeforePx ? `margin-top: ${Math.round(para.spaceBeforePx)}px` : '',
      'line-height: 1.25',
    ].filter(Boolean).join('; ')
    if (marker && spans.length) {
      // REAL list semantics: consecutive bulleted paragraphs become one
      // <ul> — the converter maps lists to tight dialect lists instead of
      // spreading loose paragraphs across the slide
      if (!listOpen) { paras.push('<ul style="margin: 0; padding: 0; list-style: none;">'); listOpen = true }
      const ms = runStyle({ ...para, size: para.size ? para.size * fontScale : undefined })
      paras.push(`<li style="${pStyle}; padding-left: ${para.indentPx ?? 0}px">` +
        `<span style="${ms}">${esc(marker)}</span>${spans.join('')}</li>`)
    } else {
      closeList()
      const indent = para.indentPx ? `; padding-left: ${para.indentPx}px` : ''
      paras.push(`<p style="${pStyle}${indent}">${spans.join('') || '&nbsp;'}</p>`)
    }
  }
  closeList()
  const justify = anchor === 'ctr' ? 'center' : anchor === 'b' ? 'flex-end' : 'flex-start'
  return `<div style="position: absolute; inset: 0; display: flex; flex-direction: column;` +
    ` justify-content: ${justify}; overflow: hidden; padding: 4px 8px; box-sizing: border-box;">${paras.join('')}</div>`
}

/* ---------- shapes ---------- */

/** css border-radius / inline-svg for preset geometries */
function geometryHtml(ctx: Ctx, sp: Element, b: Box, fill: string | null, stroke: { color: string; w: number } | null): { boxCss: string; svg: string } {
  const prst = els(sp, 'prstGeom')[0]?.getAttribute('prst') ?? (els(sp, 'custGeom')[0] ? 'custom' : 'rect')
  const wpx = px(ctx, b.w)
  const hpx = px(ctx, b.h)
  const strokeCss = stroke ? `stroke: ${stroke.color}; stroke-width: ${stroke.w};` : 'stroke: none;'
  const fillCssV = fill && fill !== 'transparent' && !fill.startsWith('linear-gradient') && !fill.startsWith('url(') ? fill : 'none'
  const poly = (pts: string): string =>
    `<svg style="position:absolute;inset:0;overflow:visible" width="${wpx}" height="${hpx}" viewBox="0 0 ${wpx} ${hpx}" preserveAspectRatio="none">` +
    `<polygon points="${pts}" style="fill: ${fillCssV}; ${strokeCss}"/></svg>`
  switch (prst) {
    case 'roundRect': return { boxCss: `border-radius: ${Math.round(Math.min(wpx, hpx) * 0.15)}px;`, svg: '' }
    case 'ellipse': case 'oval': return { boxCss: 'border-radius: 50%;', svg: '' }
    case 'triangle': return { boxCss: 'background: none !important; border: none !important;', svg: poly(`${wpx / 2},0 ${wpx},${hpx} 0,${hpx}`) }
    case 'rtTriangle': return { boxCss: 'background: none !important; border: none !important;', svg: poly(`0,0 ${wpx},${hpx} 0,${hpx}`) }
    case 'diamond': return { boxCss: 'background: none !important; border: none !important;', svg: poly(`${wpx / 2},0 ${wpx},${hpx / 2} ${wpx / 2},${hpx} 0,${hpx / 2}`) }
    case 'line': case 'straightConnector1': case 'bentConnector3': {
      const sc = stroke ?? { color: '#000', w: 1 }
      return {
        boxCss: 'background: none !important; border: none !important;',
        svg: `<svg style="position:absolute;inset:0;overflow:visible" width="${Math.max(1, wpx)}" height="${Math.max(1, hpx)}">` +
          `<line x1="0" y1="0" x2="${wpx}" y2="${hpx}" style="stroke: ${sc.color}; stroke-width: ${sc.w};"/></svg>`,
      }
    }
    case 'custom': {
      const d = custGeomPath(ctx, sp, wpx, hpx)
      if (d) {
        return {
          boxCss: 'background: none !important; border: none !important;',
          svg: `<svg style="position:absolute;inset:0;overflow:visible" width="${wpx}" height="${hpx}" viewBox="0 0 ${wpx} ${hpx}" preserveAspectRatio="none">` +
            `<path d="${d}" style="fill: ${fillCssV}; ${strokeCss}"/></svg>`,
        }
      }
      return { boxCss: '', svg: '' }
    }
    default: return { boxCss: '', svg: '' }
  }
}

function custGeomPath(ctx: Ctx, sp: Element, wpx: number, hpx: number): string | null {
  const pathEl = els(sp, 'pathLst')[0] ? els(els(sp, 'pathLst')[0], 'path')[0] : null
  if (!pathEl) return null
  const pw = Number(pathEl.getAttribute('w') ?? 0) || 1
  const ph = Number(pathEl.getAttribute('h') ?? 0) || 1
  const sx = wpx / pw
  const sy = hpx / ph
  const pt = (el: Element | null): string => {
    if (!el) return '0,0'
    const x = Number(el.getAttribute('x') ?? 0) * sx
    const y = Number(el.getAttribute('y') ?? 0) * sy
    return `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`
  }
  let d = ''
  for (const cmd of pathEl.children) {
    const pts = children(cmd, 'pt')
    if (cmd.localName === 'moveTo') d += `M${pt(pts[0])} `
    else if (cmd.localName === 'lnTo') d += `L${pt(pts[0])} `
    else if (cmd.localName === 'cubicBezTo') d += `C${pt(pts[0])} ${pt(pts[1])} ${pt(pts[2])} `
    else if (cmd.localName === 'quadBezTo') d += `Q${pt(pts[0])} ${pt(pts[1])} `
    else if (cmd.localName === 'close') d += 'Z '
  }
  return d.trim() || null
}

function strokeOf(ctx: Ctx, spPr: Element | null): { color: string; w: number } | null {
  const ln = child(spPr, 'ln')
  if (!ln || child(ln, 'noFill')) return null
  const color = colorUnder(ctx, child(ln, 'solidFill'))
  if (!color) return null
  const w = Number(ln.getAttribute('w') ?? 9525) / EMU_PER_PX
  return { color, w: Math.max(0.5, Math.round(w * ctx.scale * 10) / 10) }
}

/* ---------- pictures ---------- */

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  bmp: 'image/bmp', svg: 'image/svg+xml', webp: 'image/webp', tiff: 'image/tiff', emf: '', wmf: '',
}

function blipDataUrl(ctx: Ctx, blipFill: Element, partPath: string): string | null {
  const rId = rid(child(blipFill, 'blip'), 'embed')
  if (!rId) return null
  const target = relTarget(ctx.parts, partPath, rId)
  const bytes = target ? ctx.parts.get(target) : null
  if (!bytes) return null
  const ext = (target ?? '').split('.').pop()?.toLowerCase() ?? ''
  const mime = MIME[ext]
  if (!mime) return null // emf/wmf and friends: skip, the box remains
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return `data:${mime};base64,${btoa(bin)}`
}

function renderPic(ctx: Ctx, pic: Element, ctm: GroupCtm): string {
  const b = boxOf(ctx, els(pic, 'xfrm')[0] ?? null, ctm)
  if (!b) return ''
  const blipFill = els(pic, 'blipFill')[0]
  const url = blipFill ? blipDataUrl(ctx, blipFill, ctx.slidePath) : null
  if (!url) return `<div style="${boxStyle(ctx, b)} background: #ddd;"></div>`
  // srcRect crop: offsets are 1000ths of a percent eaten from each edge
  const src = child(blipFill, 'srcRect')
  const wAttr = ` width="${px(ctx, b.w)}" height="${px(ctx, b.h)}"`
  let img = `<img src="${url}"${wAttr} style="width: 100%; height: 100%; object-fit: fill;" alt="">`
  if (src) {
    const l = Number(src.getAttribute('l') ?? 0) / 1000
    const r = Number(src.getAttribute('r') ?? 0) / 1000
    const t = Number(src.getAttribute('t') ?? 0) / 1000
    const bt = Number(src.getAttribute('b') ?? 0) / 1000
    const sw = 100 / Math.max(1e-6, (100 - l - r) / 100)
    const sh = 100 / Math.max(1e-6, (100 - t - bt) / 100)
    img = `<img src="${url}" style="position: absolute; width: ${sw}%; height: ${sh}%;` +
      ` left: ${-l * sw / 100}%; top: ${-t * sh / 100}%;" alt="">`
  }
  return `<div style="${boxStyle(ctx, b)} overflow: hidden;">${img}</div>`
}

/* ---------- tables ---------- */

function renderTable(ctx: Ctx, frame: Element, ctm: GroupCtm): string {
  const b = boxOf(ctx, els(frame, 'xfrm')[0] ?? null, ctm)
  const tbl = els(frame, 'tbl')[0]
  if (!b || !tbl) return ''
  const cols = els(tbl, 'gridCol').map((c) => px(ctx, Number(c.getAttribute('w') ?? 0) * ctm.scaleX))
  const rowsHtml: string[] = []
  for (const tr of els(tbl, 'tr')) {
    const cells: string[] = []
    let ci = 0
    for (const tc of children(tr, 'tc')) {
      if (tc.getAttribute('vMerge') === '1' || tc.getAttribute('hMerge') === '1') { ci++; continue }
      const span = Number(tc.getAttribute('gridSpan') ?? 1)
      const rspan = Number(tc.getAttribute('rowSpan') ?? 1)
      const tcPr = child(tc, 'tcPr')
      const bg = fillCss(ctx, tcPr, ctx.slidePath)
      const tx = child(tc, 'txBody')
      const inner = tx ? renderTxBody(ctx, tc, tx, '#000000') : ''
      cells.push(`<td${span > 1 ? ` colspan="${span}"` : ''}${rspan > 1 ? ` rowspan="${rspan}"` : ''}` +
        ` style="position: relative; border: 1px solid #999; padding: 0; vertical-align: top;` +
        ` ${bg && bg !== 'transparent' ? `background: ${bg};` : ''} width: ${cols[ci] ?? 40}px;` +
        ` height: ${px(ctx, Number(tr.getAttribute('h') ?? 0) * ctm.scaleY)}px;">${inner}</td>`)
      ci += span
    }
    rowsHtml.push(`<tr>${cells.join('')}</tr>`)
  }
  return `<div style="${boxStyle(ctx, b)}"><table style="border-collapse: collapse; width: 100%; height: 100%;` +
    ` font-family: sans-serif;">${rowsHtml.join('')}</table></div>`
}

/* ---------- charts ---------- */

interface ChartData { kind: 'bar' | 'line' | 'scatter' | 'pie'; series: Array<{ name: string; cats: string[]; vals: number[] }> }

function parseChart(parts: Parts, chartPath: string): ChartData | null {
  const doc = xmlOf(parts, chartPath)
  if (!doc) return null
  for (const [tag, kind] of [['barChart', 'bar'], ['lineChart', 'line'], ['scatterChart', 'scatter'], ['pieChart', 'pie']] as const) {
    const holder = els(doc, tag)[0]
    if (!holder) continue
    const series = els(holder, 'ser').map((ser) => {
      const name = els(child(ser, 'tx'), 'v')[0]?.textContent ?? ''
      const catHolder = child(ser, 'cat') ?? child(ser, 'xVal')
      const valHolder = child(ser, 'val') ?? child(ser, 'yVal')
      const pts = (h: Element | null): string[] => els(h, 'pt')
        .sort((a2, b2) => Number(a2.getAttribute('idx')) - Number(b2.getAttribute('idx')))
        .map((p) => els(p, 'v')[0]?.textContent ?? '')
      return { name, cats: pts(catHolder), vals: pts(valHolder).map(Number) }
    }).filter((s) => s.vals.length > 0)
    if (series.length) return { kind, series }
  }
  return null
}

const CHART_FALLBACK_COLORS = ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47']

function renderChartSvg(ctx: Ctx, data: ChartData, wpx: number, hpx: number): string {
  const padL = 34
  const padB = 22
  const plotW = Math.max(10, wpx - padL - 8)
  const plotH = Math.max(10, hpx - padB - 8)
  const allVals = data.series.flatMap((s) => s.vals)
  const vmax = Math.max(1e-9, ...allVals)
  const parts: string[] = [`<line x1="${padL}" y1="${8 + plotH}" x2="${wpx - 8}" y2="${8 + plotH}" stroke="#999"/>`]
  if (data.kind === 'pie') {
    const s = data.series[0]
    const total = s.vals.reduce((a2, b2) => a2 + b2, 0) || 1
    const cx = wpx / 2
    const cy = hpx / 2
    const r = Math.min(wpx, hpx) * 0.4
    let a0 = -Math.PI / 2
    parts.length = 0
    s.vals.forEach((v, k) => {
      const a1 = a0 + (v / total) * 2 * Math.PI
      const large = a1 - a0 > Math.PI ? 1 : 0
      parts.push(`<path d="M${cx},${cy} L${cx + r * Math.cos(a0)},${cy + r * Math.sin(a0)}` +
        ` A${r},${r} 0 ${large} 1 ${cx + r * Math.cos(a1)},${cy + r * Math.sin(a1)} Z"` +
        ` fill="${CHART_FALLBACK_COLORS[k % CHART_FALLBACK_COLORS.length]}"/>`)
      a0 = a1
    })
  } else if (data.kind === 'bar') {
    const n = Math.max(...data.series.map((s) => s.vals.length))
    const band = plotW / Math.max(1, n)
    const bw = band / (data.series.length + 0.5)
    data.series.forEach((s, si) => {
      s.vals.forEach((v, k) => {
        const bh = (v / vmax) * plotH
        parts.push(`<rect x="${padL + band * k + bw * si + band * 0.1}" y="${8 + plotH - bh}"` +
          ` width="${bw}" height="${bh}" fill="${CHART_FALLBACK_COLORS[si % CHART_FALLBACK_COLORS.length]}"/>`)
      })
    })
  } else {
    data.series.forEach((s, si) => {
      const col = CHART_FALLBACK_COLORS[si % CHART_FALLBACK_COLORS.length]
      const pts = s.vals.map((v, k) => `${padL + (plotW * k) / Math.max(1, s.vals.length - 1)},${8 + plotH - (v / vmax) * plotH}`)
      if (data.kind === 'line') parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${col}" stroke-width="2"/>`)
      for (const p of pts) {
        const [x, y] = p.split(',')
        parts.push(`<circle cx="${x}" cy="${y}" r="2.5" fill="${col}"/>`)
      }
    })
  }
  // dia-chart lift hints: single-series bar/line/scatter map 1:1 onto the
  // dialect chart grammar — the converter reads these and emits real
  // dialect charts instead of islanding a picture
  let hints = ''
  const s0 = data.series[0]
  if (data.kind !== 'pie' && data.series.length === 1 && s0.vals.length > 0) {
    const values = s0.vals.map((v, k) => `${(s0.cats[k] ?? String(k)).replace(/[:;,]/g, ' ')}:${v}`).join(', ')
    hints = ` data-chart="${data.kind}" data-values="${esc(values)}"`
  }
  return `<svg${hints} width="${wpx}" height="${hpx}" viewBox="0 0 ${wpx} ${hpx}"` +
    ` style="position: absolute; inset: 0;" font-family="sans-serif" font-size="9">${parts.join('')}</svg>`
}

/* ---------- shape tree ---------- */

function renderShape(ctx: Ctx, sp: Element, ctm: GroupCtm): string {
  const spPr = els(sp, 'spPr')[0] ?? null
  let b = boxOf(ctx, spPr ? els(spPr, 'xfrm')[0] : null, ctm)
  const key = phKey(sp)
  if (!b && key) {
    // placeholder without geometry: inherit from layout, then master
    for (const [doc] of [[ctx.layout], [ctx.master]] as const) {
      const ph = findPh(doc, key)
      const phB = ph ? boxOf(ctx, els(ph, 'xfrm')[0] ?? null, ctm) : null
      if (phB) { b = phB; break }
    }
  }
  if (!b) return ''
  const fill = fillCss(ctx, spPr, ctx.slidePath)
  const stroke = strokeOf(ctx, spPr)
  const geom = geometryHtml(ctx, sp, b, fill, stroke)
  const styleBits = [boxStyle(ctx, b), geom.boxCss]
  if (fill && fill !== 'transparent' && !geom.boxCss.includes('background: none')) styleBits.push(`background: ${fill};`)
  if (stroke && !geom.boxCss.includes('border: none')) styleBits.push(`border: ${stroke.w}px solid ${stroke.color};`)
  const tx = els(sp, 'txBody')[0]
  const text = tx ? renderTxBody(ctx, sp, tx, defaultTextColor(ctx)) : ''
  return `<div style="${styleBits.join(' ')}">${geom.svg}${text}</div>`
}

function defaultTextColor(ctx: Ctx): string {
  return `#${themeColor(ctx, ctx.clrMap['tx1'] ?? 'dk1')}`
}

function renderGroup(ctx: Ctx, grp: Element, ctm: GroupCtm): string {
  const xfrm = els(child(grp, 'grpSpPr'), 'xfrm')[0]
  const off = child(xfrm, 'off')
  const ext = child(xfrm, 'ext')
  const chOff = child(xfrm, 'chOff')
  const chExt = child(xfrm, 'chExt')
  let inner: GroupCtm = ctm
  if (off && ext && chOff && chExt) {
    const ox = Number(off.getAttribute('x') ?? 0)
    const oy = Number(off.getAttribute('y') ?? 0)
    const cw = Number(chExt.getAttribute('cx') ?? 1) || 1
    const chh = Number(chExt.getAttribute('cy') ?? 1) || 1
    const sx = (Number(ext.getAttribute('cx') ?? 0) / cw) * ctm.scaleX
    const sy = (Number(ext.getAttribute('cy') ?? 0) / chh) * ctm.scaleY
    inner = {
      offX: ctm.offX + ox * ctm.scaleX - Number(chOff.getAttribute('x') ?? 0) * sx,
      offY: ctm.offY + oy * ctm.scaleY - Number(chOff.getAttribute('y') ?? 0) * sy,
      scaleX: sx,
      scaleY: sy,
    }
  }
  return renderShapes(ctx, grp, inner)
}

function renderShapes(ctx: Ctx, parent: Element, ctm: GroupCtm): string {
  const out: string[] = []
  for (const el of parent.children) {
    if (el.localName === 'sp') out.push(renderShape(ctx, el, ctm))
    else if (el.localName === 'pic') out.push(renderPic(ctx, el, ctm))
    else if (el.localName === 'grpSp') out.push(renderGroup(ctx, el, ctm))
    else if (el.localName === 'cxnSp') out.push(renderShape(ctx, el, ctm))
    else if (el.localName === 'graphicFrame') {
      if (els(el, 'tbl').length) out.push(renderTable(ctx, el, ctm))
      else {
        const rId = rid(els(el, 'chart')[0] ?? null, 'id')
        const b = boxOf(ctx, els(el, 'xfrm')[0] ?? null, ctm)
        if (rId && b) {
          const target = relTarget(ctx.parts, ctx.slidePath, rId)
          const data = target ? parseChart(ctx.parts, target) : null
          if (data) out.push(`<div style="${boxStyle(ctx, b)}">${renderChartSvg(ctx, data, px(ctx, b.w), px(ctx, b.h))}</div>`)
          else out.push(`<div style="${boxStyle(ctx, b)} background: #eee; border: 1px solid #ccc;"></div>`)
        }
      }
    }
  }
  return out.join('')
}

/* ---------- backgrounds + notes ---------- */

function backgroundCss(ctx: Ctx): string {
  for (const [doc, path] of [
    [xmlOf(ctx.parts, ctx.slidePath), ctx.slidePath],
    [ctx.layout, ctx.layoutPath],
    [ctx.master, ctx.masterPath],
  ] as Array<[Document | null, string]>) {
    const bg = els(doc, 'bg')[0]
    if (!bg) continue
    const pr = child(bg, 'bgPr')
    const c = fillCss(ctx, pr, path)
    if (c) return c
    const ref = child(bg, 'bgRef')
    const refC = colorUnder(ctx, ref)
    if (refC) return refC
  }
  return '#FFFFFF'
}

function notesText(parts: Parts, slidePath: string): string[] {
  const [notesPath] = relsOfType(parts, slidePath, '/notesSlide')
  const doc = notesPath ? xmlOf(parts, notesPath) : null
  if (!doc) return []
  const out: string[] = []
  for (const sp of els(doc, 'sp')) {
    const type = els(sp, 'ph')[0]?.getAttribute('type')
    if (type !== 'body') continue // skip the slide image + number placeholders
    for (const p of els(sp, 'p')) {
      const line = els(p, 't').map((t) => t.textContent ?? '').join('')
      if (line.trim()) out.push(line.trim())
    }
  }
  return out
}

/* ---------- entry ---------- */

/** true when the bytes smell like a zip (every pptx is one) */
export function looksLikePptx(bytes: ArrayBuffer | Uint8Array, name = ''): boolean {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return /\.pptx$/i.test(name) || (u.length > 3 && u[0] === 0x50 && u[1] === 0x4b)
}

/** Render a .pptx into a self-contained foreign HTML document, ready for
 * the normal import pipeline. Throws with a readable message on files
 * that are not presentations. */
export function pptxToHtml(data: ArrayBuffer | Uint8Array, name = 'deck.pptx'): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  let parts: Parts
  try {
    const raw = unzipSync(bytes)
    parts = new Map(Object.entries(raw))
  } catch {
    throw new Error(`${name}: not a readable zip archive`)
  }
  const presPath = 'ppt/presentation.xml'
  const pres = xmlOf(parts, presPath)
  if (!pres) throw new Error(`${name}: no ppt/presentation.xml — not a PowerPoint file`)

  const sldSz = els(pres, 'sldSz')[0]
  const emuW = Number(sldSz?.getAttribute('cx') ?? 12192000)
  const emuH = Number(sldSz?.getAttribute('cy') ?? 6858000)
  const scale = DESIGN_W / (emuW / EMU_PER_PX)
  const slideW = DESIGN_W
  const slideH = Math.round((emuH / EMU_PER_PX) * scale)

  // slide order from sldIdLst r:id refs
  const slidePaths: string[] = []
  for (const sldId of els(pres, 'sldId')) {
    const rId = rid(sldId, 'id')
    const t = rId ? relTarget(parts, presPath, rId) : null
    if (t) slidePaths.push(t)
  }
  if (slidePaths.length === 0) throw new Error(`${name}: presentation lists no slides`)

  const sections: string[] = []
  for (const slidePath of slidePaths) {
    const slide = xmlOf(parts, slidePath)
    if (!slide) continue
    if (slide.documentElement.getAttribute('show') === '0') continue // hidden

    const [layoutPath = ''] = relsOfType(parts, slidePath, '/slideLayout')
    const layout = layoutPath ? xmlOf(parts, layoutPath) : null
    const [masterPath = ''] = layoutPath ? relsOfType(parts, layoutPath, '/slideMaster') : []
    const master = masterPath ? xmlOf(parts, masterPath) : null
    const [themePath = ''] = masterPath ? relsOfType(parts, masterPath, '/theme') : []
    const theme = themePath ? xmlOf(parts, themePath) : null

    const clrMap: Record<string, string> = {}
    const mapEl = master ? els(master, 'clrMap')[0] : null
    if (mapEl) for (const a of mapEl.attributes) clrMap[a.name] = a.value
    else Object.assign(clrMap, { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' })

    const ctx: Ctx = { parts, slidePath, layout, layoutPath, master, masterPath, theme, clrMap, scale, slideW, slideH }
    const bg = backgroundCss(ctx)
    const ctm: GroupCtm = { offX: 0, offY: 0, scaleX: 1, scaleY: 1 }
    // paint layout + master decoration UNDER the slide's own shapes —
    // but only non-placeholder shapes (placeholders are prompts, not art)
    const underlay = [master, layout]
      .map((doc) => {
        if (!doc) return ''
        const tree = els(doc, 'spTree')[0]
        if (!tree) return ''
        const clone = tree.cloneNode(true) as Element
        for (const sp of els(clone, 'sp')) if (phKey(sp)) sp.remove()
        return renderShapes(ctx, clone, ctm)
      })
      .join('')
    const tree = els(slide, 'spTree')[0]
    const bodyHtml = tree ? renderShapes(ctx, tree, ctm) : ''
    const notes = notesText(parts, slidePath)
    const notesHtml = notes.length
      ? `<aside class="dia-notes" style="display: none;">${notes.map((n) => `<p>${esc(n)}</p>`).join('')}</aside>`
      : ''
    sections.push(
      `<section class="pptx-slide" data-dia-source-slide style="position: relative; width: ${slideW}px; height: ${slideH}px;` +
      ` overflow: hidden; background: ${bg};">${underlay}${bodyHtml}${notesHtml}</section>`)
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(name.replace(/\.pptx$/i, ''))}</title>
<style>
body { margin: 0; background: #666; }
section.pptx-slide { margin: 24px auto; box-shadow: 0 2px 14px rgba(0,0,0,.35); font-family: sans-serif; }
section.pptx-slide p { margin: 0; }
</style>
</head>
<body>
${sections.join('\n')}
</body>
</html>`
}
