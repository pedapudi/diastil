/* Compile serializable ProposedOp objects from the dia service into real Ops.
 * Every compiled op is authored 'copilot' so it reads honestly in the op log.
 * Unknown actions or missing targets are skipped with a console.warn — a bad
 * proposal must never throw and never take the editor down. */

import type { NodeGeom, NodeShape, Op, ProposedOp } from '../types'
import { state } from '../state'
import { slidesInLogicalOrder } from '../studio/focus'
import { batch } from '../model/ops'
import {
  insertEl, moveEl, moveSceneNode, removeEl, setAttr, setInlineHtml,
  setStyleProp, setText, setToken,
} from '../model/ops'
import { findNode, renderNodeShape, routeEdge } from '../scene/route'
import { setEdgeLabelOp, setNodeLabelOp, setShapeOp } from '../scene/interact'

const BY = 'copilot' as const

export interface CompileResult {
  ops: Op[]
  /** proposals that could not be compiled, each with WHY — surfaced on the
   * card and fed back to the model so it can correct itself */
  skipped: Array<{ op: ProposedOp; reason: string }>
}

export function compileOps(proposed: ProposedOp[]): CompileResult {
  const ops: Op[] = []
  const skipped: Array<{ op: ProposedOp; reason: string }> = []
  for (const p of proposed) {
    try {
      const op = compileOne(p)
      if (op) ops.push(op)
      else {
        const reason = `target "${p.target}" did not resolve (or a required value/extra field is missing)`
        skipped.push({ op: p, reason })
        console.warn('[copilot] skipped proposal:', reason, p)
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      skipped.push({ op: p, reason })
      console.warn('[copilot] skipped proposal (compile error):', p, err)
    }
  }
  return { ops, skipped }
}

function compileOne(p: ProposedOp): Op | null {
  const deck = state.deck
  if (!deck) return null

  switch (p.action) {
    case 'set-text': {
      const el = findEl(p.target)
      if (!el || p.value === undefined) return null
      return setText(el, p.value, BY)
    }

    case 'set-inline-html': {
      // rich text: inline formatting (spans, strong, em, code) in one leaf
      const el = findEl(p.target)
      if (!el || p.value === undefined) return null
      return setInlineHtml(el, p.value, BY)
    }

    case 'set-token': {
      if (p.value === undefined) return null
      return setToken(deck.themeStyle, p.target, p.value, BY)
    }

    case 'set-style': {
      const el = findEl(p.target)
      const prop = str(p.extra?.prop)
      if (!el || !prop || p.value === undefined) return null
      return setStyleProp(el, prop, p.value, BY)
    }

    case 'set-attr': {
      const el = findEl(p.target)
      const name = str(p.extra?.name)
      if (!el || !name || p.value === undefined) return null
      if (/^on/i.test(name)) return null // handlers never enter the dialect
      return setAttr(el, name, p.value, BY)
    }

    case 'insert-html': {
      const parent = findEl(p.target)
      if (!parent || p.value === undefined) return null
      const el = parseFragment(p.value)
      if (!el) return null
      const index = clampIndex(num(p.extra?.index), parent.children.length)
      return insertEl(parent, index, el, p.label, BY)
    }

    case 'remove': {
      const el = findEl(p.target)
      if (!el) return null
      return removeEl(el, p.label, BY)
    }

    case 'move-el': {
      // reorder/reparent within the deck: extra.parent addresses the new
      // parent (same grammar as target), extra.index the child position
      const el = findEl(p.target)
      if (!el) return null
      const parent = p.extra?.parent !== undefined ? findEl(String(p.extra.parent)) : el.parentElement
      if (!parent) return null
      const index = clampIndex(num(p.extra?.index), parent.children.length)
      return moveEl(el, parent, index, p.label, BY)
    }

    case 'add-slide': {
      if (p.value === undefined) return null
      const el = parseFragment(p.value)
      if (!el || !el.matches('section.dia-slide')) return null
      const slides = slidesInLogicalOrder()
      const anchor = slides[0]?.parentElement
      if (!anchor) return null
      // extra.index speaks the model's ONE numbering: 1-based slide numbers
      const slideIndex = clampIndex(num(p.extra?.index) - 1, slides.length)
      const domIndex = slides[slideIndex]
        ? [...anchor.children].indexOf(slides[slideIndex])
        : anchor.children.length
      return insertEl(anchor, domIndex, el, p.label, BY)
    }

    case 'move-node': {
      const scene = findScene(num(p.extra?.slide))
      if (!scene) return null
      const node = findNode(scene, p.target)
      if (!node) return null
      const geom: NodeGeom = {
        x: num(p.extra?.x, NaN), y: num(p.extra?.y, NaN),
        w: num(p.extra?.w, NaN), h: num(p.extra?.h, NaN),
      }
      const prev = nodeGeomFallback(node)
      const next: NodeGeom = {
        x: Number.isFinite(geom.x) ? geom.x : prev.x,
        y: Number.isFinite(geom.y) ? geom.y : prev.y,
        w: Number.isFinite(geom.w) ? geom.w : prev.w,
        h: Number.isFinite(geom.h) ? geom.h : prev.h,
      }
      return moveSceneNode(scene, node, next, BY)
    }

    case 'insert-edge': {
      const scene = findScene(num(p.extra?.slide))
      if (!scene) return null
      const ref = /^(.+?)->(.+)$/.exec(p.target)
      if (!ref || !findNode(scene, ref[1]) || !findNode(scene, ref[2])) return null
      const edge = buildEdge(ref[1], ref[2], str(p.extra?.label))
      const inner = insertEl(scene, scene.children.length, edge, p.label, BY)
      // wrap so the freshly inserted edge gets routed as part of apply
      return {
        label: p.label,
        author: BY,
        apply() { inner.apply(); routeEdge(scene, edge) },
        invert() { return inner.invert() },
      }
    }

    case 'insert-node': {
      // a new scene node: target = its id; extra: slide, x, y, w, h,
      // shape, label — geometry defaults sit near the scene origin
      const scene = findScene(num(p.extra?.slide))
      if (!scene || !p.target || findNode(scene, p.target)) return null
      const g = document.createElementNS(SVG_NS, 'g') as SVGGElement
      g.setAttribute('data-dia-node', p.target)
      g.setAttribute('data-shape', str(p.extra?.shape) ?? 'rounded')
      g.setAttribute('data-x', String(num(p.extra?.x, 24)))
      g.setAttribute('data-y', String(num(p.extra?.y, 24)))
      g.setAttribute('data-w', String(num(p.extra?.w, 120)))
      g.setAttribute('data-h', String(num(p.extra?.h, 40)))
      const labelText = str(p.extra?.label) ?? p.value
      if (labelText) {
        const t = document.createElementNS(SVG_NS, 'text')
        t.setAttribute('class', 'dia-node-label')
        t.textContent = labelText
        g.appendChild(t)
      }
      const inner = insertEl(scene, scene.children.length, g, p.label, BY)
      return {
        label: p.label,
        author: BY,
        apply() { inner.apply(); renderNodeShape(g) },
        invert() { return inner.invert() },
      }
    }

    case 'remove-node': {
      // a node leaves with every edge touching it — dangling edges are
      // a broken scene, not a smaller one
      const scene = findScene(num(p.extra?.slide))
      if (!scene) return null
      const node = findNode(scene, p.target)
      if (!node) return null
      const inner: Op[] = [
        ...[...scene.querySelectorAll<SVGGElement>('g[data-dia-edge]')]
          .filter((e) => {
            const ref = /^(.+?)->(.+)$/.exec(e.getAttribute('data-dia-edge') ?? '')
            return ref !== null && (ref[1] === p.target || ref[2] === p.target)
          })
          .map((e) => removeEl(e, undefined, BY)),
        removeEl(node, undefined, BY),
      ]
      return batch(p.label, inner, BY)
    }

    case 'set-node-label': {
      const scene = findScene(num(p.extra?.slide))
      if (!scene || p.value === undefined) return null
      const node = findNode(scene, p.target)
      return node ? setNodeLabelOp(node, p.value) : null
    }

    case 'set-shape': {
      const scene = findScene(num(p.extra?.slide))
      if (!scene || p.value === undefined) return null
      const node = findNode(scene, p.target)
      if (!node) return null
      return setShapeOp(scene, node, p.value as NodeShape)
    }

    case 'remove-edge': {
      const scene = findScene(num(p.extra?.slide))
      if (!scene) return null
      const edge = scene.querySelector<SVGGElement>(
        `g[data-dia-edge="${cssEscape(p.target)}"]`,
      )
      return edge ? removeEl(edge, p.label, BY) : null
    }

    case 'set-edge-label': {
      // annotate a connector; empty value removes the annotation
      const scene = findScene(num(p.extra?.slide))
      if (!scene || p.value === undefined) return null
      const edge = scene.querySelector<SVGGElement>(
        `g[data-dia-edge="${cssEscape(p.target)}"]`,
      )
      if (!edge) return null
      return setEdgeLabelOp(scene, edge, p.value)
    }

    case 'retarget-edge': {
      const scene = findScene(num(p.extra?.slide))
      if (!scene || p.value === undefined) return null
      const edge = scene.querySelector<SVGGElement>(
        `g[data-dia-edge="${cssEscape(p.target)}"]`,
      )
      if (!edge) return null
      const next = /^(.+?)->(.+)$/.exec(p.value)
      if (!next || !findNode(scene, next[1]) || !findNode(scene, next[2])) return null
      return retargetEdgeOp(scene, edge, p.value, p.label)
    }

    default:
      console.warn('[copilot] unknown proposed action:', (p as ProposedOp).action)
      return null
  }
}

/** setAttr on data-dia-edge wrapped so apply/invert both reroute the edge */
function retargetEdgeOp(scene: SVGSVGElement, edge: SVGGElement, value: string, label: string): Op {
  const prev = edge.getAttribute('data-dia-edge') ?? ''
  const attr = setAttr(edge, 'data-dia-edge', value, BY)
  return {
    label,
    author: BY,
    apply() { attr.apply(); routeEdge(scene, edge) },
    invert() { return retargetEdgeOp(scene, edge, prev, `un-${label}`) },
  }
}

/* ---------- lookup helpers ---------- */

function findEl(target: string): HTMLElement | null {
  const root = state.deck?.root
  if (!root) return null
  return resolveTarget(target, root, slidesInLogicalOrder(), state.currentSlide)
}

/** friendly role names the model may use → dialect classes */
const ROLE_ALIASES: Record<string, string> = {
  title: '.dia-title', kicker: '.dia-kicker', body: '.dia-body',
  caption: '.dia-caption', footnote: '.dia-footnote', figure: '.dia-figure',
  island: '[data-dia-island]', list: 'ul, ol', item: 'li', marker: '.dia-marker',
  table: 'table', image: 'img',
}

/** Resolve a proposal target to an element. Models rarely emit perfect
 * data-dia-ids, so the grammar is forgiving — every form below compiles:
 *   1. a data-dia-id (exact)
 *   2. "slide 3"                        → that slide's section
 *   3. "slide 3 title" / "slide 3 dia-body 2" / "slide 3 body #2"
 *                                        → role (aliases allowed) + ordinal
 *   4. a bare descriptor ("title", "dia-body 2") → current slide first,
 *      then deck-wide
 *   5. a CSS selector
 *   6. "…quoted or plain text…"          → the innermost element whose text
 *      matches (exact first, then prefix)
 * Exported for tests; compile passes live editor state. */
export function resolveTarget(
  target: string,
  root: ParentNode,
  slides: HTMLElement[],
  currentSlide: number,
): HTMLElement | null {
  const t = target.trim()
  if (!t) return null

  try {
    const byId = root.querySelector<HTMLElement>(`[data-dia-id="${cssEscape(t)}"]`)
    if (byId) return byId
  } catch { /* a target with quotes is never an id — keep resolving */ }

  // "slide N" / "slide N <descriptor>"
  const slideForm = /^slide\s*#?(\d+)\s*(?:[:,·>-]\s*)?(.*)$/i.exec(t)
  if (slideForm) {
    const slide = slides[parseInt(slideForm[1], 10) - 1]
    if (!slide) return null
    const rest = slideForm[2].trim()
    if (!rest) return slide
    return descriptorIn(slide, rest) ?? textMatch(slide, rest)
  }

  // bare descriptor: current slide first, then anywhere
  const current = slides[currentSlide]
  if (current) {
    const here = descriptorIn(current, t)
    if (here) return here
  }
  for (const s of slides) {
    const hit = descriptorIn(s, t)
    if (hit) return hit
  }

  try {
    const bySelector = root.querySelector<HTMLElement>(t)
    if (bySelector) return bySelector
  } catch { /* not a selector — fall through to text */ }

  if (current) {
    const here = textMatch(current, t)
    if (here) return here
  }
  return textMatch(root, t)
}

/** "<role-or-tag>[ <ordinal>]" inside a scope; role aliases resolve */
function descriptorIn(scope: ParentNode & Element | ParentNode, desc: string): HTMLElement | null {
  const m = /^([a-z-]+)\s*#?(\d+)?$/i.exec(desc.trim())
  if (!m) return null
  const word = m[1].toLowerCase()
  const nth = m[2] ? parseInt(m[2], 10) - 1 : 0
  const selector =
    ROLE_ALIASES[word] ??
    (word.startsWith('dia-') ? `.${word}` : /^(p|h[1-6]|ul|ol|li|img|svg|table|blockquote|pre|section)$/.test(word) ? word : null)
  if (!selector) return null
  try {
    const all = (scope as Element).querySelectorAll<HTMLElement>(selector)
    return all[nth] ?? null
  } catch { return null }
}

/** innermost element whose normalized text equals (then starts with) the
 * needle — quoted or bare */
function textMatch(scope: ParentNode, needle: string): HTMLElement | null {
  const text = needle.replace(/^["'“”]+|["'“”]+$/g, '').replace(/\s+/g, ' ').trim()
  if (text.length < 3) return null
  const all = [...scope.querySelectorAll<HTMLElement>('section.dia-slide, section.dia-slide *')]
    .filter((el) => !(el instanceof SVGElement))
  let exact: HTMLElement | null = null
  let prefix: HTMLElement | null = null
  for (const el of all) {
    const own = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (!own) continue
    // innermost wins: later matches that are DESCENDANTS of the current
    // match replace it; unrelated later matches do not
    if (own === text && (!exact || exact.contains(el))) exact = el
    else if (!exact && own.startsWith(text) && (!prefix || prefix.contains(el))) prefix = el
  }
  return exact ?? prefix
}

/** extra.slide is 1-BASED — the model speaks one numbering everywhere
 * (context, targets, scene ops); missing/invalid falls to the current */
function findScene(slideNumber: number): SVGSVGElement | null {
  const slides = slidesInLogicalOrder()
  const slide = slides[Number.isFinite(slideNumber) ? slideNumber - 1 : state.currentSlide]
  return slide?.querySelector<SVGSVGElement>('svg.dia-scene') ?? null
}

function nodeGeomFallback(node: SVGGElement): NodeGeom {
  const n = (a: string, f: number) => {
    const v = parseFloat(node.getAttribute(a) ?? '')
    return Number.isFinite(v) ? v : f
  }
  return { x: n('data-x', 0), y: n('data-y', 0), w: n('data-w', 120), h: n('data-h', 40) }
}

/* ---------- construction helpers ---------- */

const SVG_NS = 'http://www.w3.org/2000/svg'

/** detached scene-edge <g>; routed after insertion */
function buildEdge(from: string, to: string, label?: string): SVGGElement {
  const g = document.createElementNS(SVG_NS, 'g') as SVGGElement
  g.setAttribute('data-dia-edge', `${from}->${to}`)
  g.setAttribute('data-anchors', 'auto,auto')
  g.setAttribute('data-route', 'ortho')
  if (label) {
    const t = document.createElementNS(SVG_NS, 'text')
    t.setAttribute('class', 'dia-edge-label')
    t.textContent = label
    g.appendChild(t)
  }
  return g
}

function parseFragment(html: string): Element | null {
  const tpl = document.createElement('template')
  tpl.innerHTML = html.trim()
  return tpl.content.firstElementChild
}

/* ---------- small utils ---------- */

function str(v: string | number | undefined): string | undefined {
  return v === undefined ? undefined : String(v)
}
function num(v: string | number | undefined, fallback = NaN): number {
  const n = typeof v === 'number' ? v : parseFloat(v ?? '')
  return Number.isFinite(n) ? n : fallback
}
function clampIndex(i: number, len: number): number {
  return Number.isFinite(i) ? Math.max(0, Math.min(Math.trunc(i), len)) : len
}
function cssEscape(s: string): string { return s.replace(/["\\]/g, '\\$&') }
