/* Compile serializable ProposedOp objects from the dia service into real Ops.
 * Every compiled op is authored 'copilot' so it reads honestly in the op log.
 * Unknown actions or missing targets are skipped with a console.warn — a bad
 * proposal must never throw and never take the editor down. */

import type { NodeGeom, NodeShape, Op, ProposedOp } from '../types'
import type { Doc } from '../model/doc'
import { state } from '../state'
import { slidesInLogicalOrder } from '../studio/focus'
import { batch } from '../model/ops'
import {
  insertBlockOp, insertEl, moveBlockOp, moveEl, moveSceneNode, removeBlockOp,
  removeEl, setAttr, setInlineHtml, setStyleProp, setText, setToken,
} from '../model/ops'
import { findNode, renderNodeShape, routeEdge } from '../scene/route'
import { setEdgeLabelOp, setNodeLabelOp, setShapeOp } from '../scene/interact'
import { docBlockFromTex, docBlocks, lateDocOp, syncedDocOp, topBlockOf } from '../doc/sync'
import { emitBlockTex } from '../latex/emit'
import { mathToMathml } from '../latex/render'
import { lex } from '../latex/lex'
import { parseLatex } from '../latex/parse'

const BY = 'copilot' as const

export interface CompileResult {
  ops: Op[]
  /** proposals that could not be compiled, each with WHY — surfaced on the
   * card and fed back to the model so it can correct itself */
  skipped: Array<{ op: ProposedOp; reason: string }>
}

export function compileOps(proposed: ProposedOp[]): CompileResult {
  if (state.mode === 'doc') return compileDocOps(proposed)
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

/* ---------- documents ----------
 * A document's truth is its LaTeX source, so a copilot edit may NEVER be a
 * bare DOM op: every compiled op is wrapped in the paired block op (DOM +
 * source patch + derived refresh, one invertible step) that native editing
 * uses. Ops are grouped by the top-level block they land in — one wrapper
 * per block, in first-seen order — and anything that would touch the source
 * outside a block, or that has no source-patchable shape yet (moving or
 * removing whole blocks), is SKIPPED with a reason the model can act on. */

/** `make` is a STRUCTURAL entry: the op is built when it runs, because its
 * source offsets are only valid once the ops before it have landed */
interface DocEntry { block: HTMLElement | null; ops: Op[]; label: string; make?: (step: number) => Op | null }
type DocOutcome = DocEntry | { skip: string }

function compileDocOps(proposed: ProposedOp[]): CompileResult {
  const skipped: Array<{ op: ProposedOp; reason: string }> = []
  const doc = state.doc
  if (!doc) return { ops: [], skipped: proposed.map((op) => ({ op, reason: 'no document is loaded' })) }

  const order: DocEntry[] = []
  const byBlock = new Map<HTMLElement, DocEntry>()
  for (const p of proposed) {
    let outcome: DocOutcome
    try {
      outcome = compileDocOne(p, doc)
    } catch (err) {
      outcome = { skip: err instanceof Error ? err.message : String(err) }
    }
    if ('skip' in outcome) {
      skipped.push({ op: p, reason: outcome.skip })
      console.warn('[copilot] skipped proposal:', outcome.skip, p)
      continue
    }
    const existing = outcome.block ? byBlock.get(outcome.block) : null
    if (existing) existing.ops.push(...outcome.ops)
    else {
      order.push(outcome)
      if (outcome.block) byBlock.set(outcome.block, outcome)
    }
  }
  const ops = order.map((e) =>
    e.make ? lateDocOp(doc, e.label, BY, e.make)
      : e.block ? syncedDocOp(doc, e.block, e.ops, e.label, BY)
        : batch(e.label, e.ops, BY))
  return { ops, skipped }
}

function compileDocOne(p: ProposedOp, doc: Doc): DocOutcome {
  const inBlock = (el: HTMLElement | null, ops: () => Op[]): DocOutcome => {
    if (!el) return { skip: `target "${p.target}" did not resolve in the document` }
    const block = topBlockOf(doc, el)
    if (!block) {
      return { skip: `target "${p.target}" is not inside a source-backed block (the title header and the preamble are edited in the source view)` }
    }
    return { block, ops: ops(), label: p.label }
  }

  switch (p.action) {
    case 'set-text':
    case 'set-inline-html': {
      const el = findDocEl(p.target, doc)
      if (el && el.closest('.dia-math, .dia-tex-island')) {
        return { skip: 'math and LaTeX islands carry their own source — use set-tex' }
      }
      if (p.value === undefined) return { skip: 'no value given' }
      const value = p.value
      return inBlock(el, () => [p.action === 'set-text'
        ? setText(el as HTMLElement, value, BY)
        : setInlineHtml(el as HTMLElement, value, BY)])
    }

    case 'set-tex': {
      const el = findDocEl(p.target, doc)
      if (!el) return { skip: `target "${p.target}" did not resolve in the document` }
      if (p.value === undefined) return { skip: 'no value given' }
      const target = el.closest<HTMLElement>('.dia-math, .dia-tex-island')
      if (!target) return { skip: 'set-tex addresses a math block or a LaTeX island; nothing else carries tex' }
      const ops = target.classList.contains('dia-math')
        ? mathTexOps(target, p.value)
        : islandTexOps(target, p.value)
      if ('skip' in ops) return ops
      return inBlock(target, () => ops.ops)
    }

    case 'set-attr': {
      const el = findDocEl(p.target, doc)
      const name = str(p.extra?.name)
      if (!name || p.value === undefined) return { skip: 'set-attr needs extra.name and a value' }
      if (/^on/i.test(name)) return { skip: 'event handlers never enter the dialect' }
      if (name === 'data-dia-tex') return { skip: 'use set-tex to change math — it re-renders the MathML too' }
      const value = p.value
      return inBlock(el, () => [setAttr(el as HTMLElement, name, value, BY)])
    }

    case 'set-token': {
      // the document theme is CSS in the artifact, not LaTeX — no source
      // patch to pair, so this one op stands alone
      if (p.value === undefined) return { skip: 'no value given' }
      return { block: null, ops: [setToken(doc.themeStyle, p.target, p.value, BY)], label: p.label }
    }

    case 'insert-html': {
      const parent = findDocEl(p.target, doc)
      if (!parent || p.value === undefined) {
        return { skip: `target "${p.target}" did not resolve, or no value was given` }
      }
      if (parent === doc.article) return insertDocBlockOutcome(p, doc)
      const el = parseFragment(p.value)
      if (!el) return { skip: 'the value is not one parseable element' }
      const index = clampIndex(num(p.extra?.index), parent.children.length)
      return inBlock(parent, () => [insertEl(parent, index, el, p.label, BY)])
    }

    case 'remove': {
      const el = findDocEl(p.target, doc)
      if (!el) return { skip: `target "${p.target}" did not resolve in the document` }
      // a whole block leaves with its source slice and one separator; a
      // fragment inside one is the ordinary paired edit
      if (topBlockOf(doc, el) === el) {
        if (docBlocks(doc).length < 2) return { skip: 'this is the document\'s only block — removing it would leave an empty body' }
        return { block: null, ops: [], label: p.label, make: (step) => step > 0 ? null : removeBlockOp(doc, el, p.label, BY) }
      }
      return inBlock(el, () => [removeEl(el, p.label, BY)])
    }

    case 'set-style':
      return { skip: 'inline styles are not part of the LaTeX source — restyle with set-token, or edit the preamble in the source view' }

    case 'move-el': {
      const el = findDocEl(p.target, doc)
      if (!el) return { skip: `target "${p.target}" did not resolve in the document` }
      if (topBlockOf(doc, el) !== el) {
        return { skip: 'only whole top-level blocks move in a document — a fragment moves by editing the two blocks that hold it' }
      }
      if (str(p.extra?.parent) !== undefined) {
        return { skip: 'a document block has one parent, the document — move-el takes extra.index only' }
      }
      const to = num(p.extra?.index)
      if (!Number.isFinite(to)) return { skip: 'move-el in a document needs extra.index — the block position to move to' }
      // one hop per step, each read off the source as it stands after the
      // last, so the run of swaps relocates slices instead of rewriting them
      return {
        block: null,
        ops: [],
        label: p.label,
        make: () => {
          const blocks = docBlocks(doc)
          const from = blocks.indexOf(el)
          const target = clampIndex(to, blocks.length - 1)
          if (from < 0 || from === target) return null
          return moveBlockOp(doc, el, from < target ? 1 : -1, p.label, BY)
        },
      }
    }

    case 'add-slide':
      return { skip: 'this is a document, not a deck — it has no slides' }

    default:
      return { skip: `"${p.action}" is a deck action; documents take set-text, set-inline-html, set-tex, set-attr, set-token, insert-html and remove` }
  }
}

/** A whole new top-level block. The proposal carries HTML, but a document
 * is its LaTeX: the markup is emitted to tex and then RENDERED BACK, so
 * what lands is what the source says — a value that does not survive that
 * round trip is refused here rather than rendered as a block the source
 * could never reproduce. extra.index is the block position; omitted, the
 * block goes last. */
function insertDocBlockOutcome(p: ProposedOp, doc: Doc): DocOutcome {
  const el = parseFragment(p.value ?? '')
  if (!(el instanceof HTMLElement)) return { skip: 'the value is not one parseable element' }
  const tex = emitBlockTex(el).trim()
  if (!tex) return { skip: 'that block carries no content to write into the source' }
  if (!docBlockFromTex(tex)) {
    return { skip: `that block does not survive the trip through LaTeX (it became "${tex.slice(0, 60)}") — write it in the dialect vocabulary a block can carry` }
  }
  const index = num(p.extra?.index)
  return {
    block: null,
    ops: [],
    label: p.label,
    make: (step) => {
      if (step > 0) return null
      const blocks = docBlocks(doc)
      const at = clampIndex(index, blocks.length)
      const ref = blocks[at] ?? blocks[blocks.length - 1] ?? null
      const made = docBlockFromTex(tex)
      return made ? insertBlockOp(doc, made, tex, ref, blocks[at] ? 'before' : 'after', p.label, BY) : null
    },
  }
}

/** math: the tex attribute IS the source, the MathML is derived — both move
 * in one op, and tex temml cannot render is refused rather than rendered as
 * a hole in the document */
function mathTexOps(el: HTMLElement, tex: string): { ops: Op[] } | { skip: string } {
  const env = el.getAttribute('data-dia-env') ?? undefined
  const display = !el.matches('span')
  const mathml = mathToMathml(tex, env, display)
  if (mathml === null) return { skip: 'the proposed tex does not render as math — check the syntax' }
  const ops: Op[] = [setAttr(el, 'data-dia-tex', tex, BY), setInlineHtml(el, mathml, BY)]
  // a block that was showing its source (unrenderable before) becomes math
  if (el.classList.contains('dia-math-src')) {
    const cls = [...el.classList].filter((c) => c !== 'dia-math-src').join(' ')
    ops.push(setAttr(el, 'class', cls, BY))
  }
  return { ops }
}

/** an island's rendered text IS its LaTeX — replacing it replaces the
 * source slice verbatim, so it is validated before it can get there */
function islandTexOps(el: HTMLElement, tex: string): { ops: Op[] } | { skip: string } {
  const bad = texFragmentError(tex)
  if (bad) return { skip: `the proposed LaTeX is malformed: ${bad}` }
  const host = el.querySelector<HTMLElement>('pre') ?? el
  return { ops: [setText(host, tex, BY)] }
}

/** the structural checks a span-exact editor can make without a TeX engine:
 * the source must scan, its braces must balance, and its environments must
 * nest. The daemon compile remains the semantic authority. */
export function texFragmentError(tex: string): string | null {
  const parsed = parseLatex(tex)
  const only = parsed.blocks.length === 1 ? parsed.blocks[0] : null
  if (only?.kind === 'island' && only.reason === 'lexer tiling failure') {
    return 'it could not be scanned'
  }
  let depth = 0
  const envs: string[] = []
  for (const t of lex(tex)) {
    if (t.kind === 'open') depth++
    else if (t.kind === 'close') {
      if (--depth < 0) return 'a } closes a group that was never opened'
    } else if (t.kind === 'envbegin') envs.push(t.name)
    else if (t.kind === 'envend') {
      const open = envs.pop()
      if (open !== t.name) {
        return open === undefined
          ? `\\end{${t.name}} has no \\begin`
          : `\\end{${t.name}} closes \\begin{${open}}`
      }
    }
  }
  if (depth > 0) return `${depth} unclosed {`
  if (envs.length > 0) return `\\begin{${envs[0]}} is never closed`
  return null
}

/* ---------- document addressing ---------- */

function findDocEl(target: string, doc: Doc): HTMLElement | null {
  return resolveDocTarget(target, doc.article, state.currentBlock)
}

/** doc-side role words → dialect selectors (DOC-PROFILE grammar) */
const DOC_ROLE_ALIASES: Record<string, string> = {
  section: 'h2.dia-sec, h3.dia-sec, h4.dia-sec, h5.dia-sec',
  heading: 'h2.dia-sec, h3.dia-sec, h4.dia-sec, h5.dia-sec',
  para: 'p', paragraph: 'p', text: 'p',
  eq: '.dia-math', math: '.dia-math', equation: 'div.dia-math',
  island: '.dia-tex-island', tex: '.dia-tex-island',
  figure: 'figure.dia-figure', caption: 'figcaption', image: 'img',
  table: 'table', list: 'ul, ol, dl', item: 'li',
  abstract: 'section.dia-abstract', verbatim: 'pre.dia-verbatim',
  ref: 'a.dia-ref', cite: 'a.dia-cite', footnote: 'span.dia-footnote',
}

/** Resolve a proposal target inside a document. The deck grammar's shape,
 * with sections where slides were:
 *   1. a data-dia-id (exact)
 *   2. "section 3" / `section "Methods"`      → the heading's section
 *   3. "section 3 para 2" / `section "Methods" eq 1`
 *   4. "block 7"                              → the 7th top-level block
 *   5. a bare descriptor ("para 2")           → current section, then doc
 *   6. a CSS selector
 *   7. "…text…"                               → innermost matching element
 * Exported for tests; compile passes live editor state. */
export function resolveDocTarget(
  target: string,
  article: HTMLElement,
  currentBlock: number,
): HTMLElement | null {
  const t = target.trim()
  if (!t) return null

  try {
    const byId = article.querySelector<HTMLElement>(`[data-dia-id="${cssEscape(t)}"]`)
    if (byId) return byId
  } catch { /* a target with quotes is never an id — keep resolving */ }

  const blocks = [...article.children].filter((c): c is HTMLElement => c instanceof HTMLElement)

  // the document itself — the only "parent" a whole new top-level block can
  // be inserted into, and unreachable by selector (querySelector looks at
  // descendants, and the article is nobody's descendant here)
  if (/^(document|article|body)$/i.test(t)) return article

  // "block N" — the raw top-level address, ordinal in flow order
  const blockForm = /^block\s*#?(\d+)$/i.exec(t)
  if (blockForm) return blocks[parseInt(blockForm[1], 10) - 1] ?? null

  // "section N …" / `section "Title" …`
  const sectionForm = /^section\s*(?:#?(\d+)|"([^"]+)"|'([^']+)'|“([^”]+)”)\s*(?:[:,·>-]\s*)?(.*)$/i.exec(t)
  if (sectionForm) {
    const title = sectionForm[2] ?? sectionForm[3] ?? sectionForm[4]
    const scope = title !== undefined
      ? sectionByTitle(blocks, title)
      : sectionByNumber(blocks, parseInt(sectionForm[1], 10))
    if (!scope) return null
    const rest = sectionForm[5].trim()
    if (!rest) return scope[0] ?? null
    return descriptorInBlocks(scope, rest) ?? textMatchIn(scope, rest)
  }

  // bare descriptor: the section the user is reading first, then the document
  const here = sectionOf(blocks, blocks[currentBlock] ?? null)
  const inSection = descriptorInBlocks(here, t)
  if (inSection) return inSection
  const anywhere = descriptorInBlocks(blocks, t)
  if (anywhere) return anywhere

  try {
    const bySelector = article.querySelector<HTMLElement>(t)
    if (bySelector) return bySelector
  } catch { /* not a selector — fall through to text */ }

  return textMatchIn(here, t) ?? textMatchIn(blocks, t)
}

const DOC_HEADING = 'h2.dia-sec, h3.dia-sec, h4.dia-sec, h5.dia-sec'

/** the blocks of the Nth top-level section (h2), heading first */
function sectionByNumber(blocks: HTMLElement[], n: number): HTMLElement[] | null {
  if (!Number.isFinite(n) || n < 1) return null
  let seen = 0
  for (const el of blocks) {
    if (el.matches('h2.dia-sec') && ++seen === n) return sectionOf(blocks, el)
  }
  return null
}

/** the section whose heading text matches (exact, then prefix, folded) */
function sectionByTitle(blocks: HTMLElement[], title: string): HTMLElement[] | null {
  const want = fold(title)
  let prefix: HTMLElement | null = null
  for (const el of blocks) {
    if (!el.matches(DOC_HEADING)) continue
    const own = fold(el.textContent ?? '')
    if (own === want) return sectionOf(blocks, el)
    if (!prefix && own.startsWith(want)) prefix = el
  }
  return prefix ? sectionOf(blocks, prefix) : null
}

/** the section containing a block: its heading through the block before the
 * next heading at the same or a higher level */
function sectionOf(blocks: HTMLElement[], block: HTMLElement | null): HTMLElement[] {
  const at = block ? blocks.indexOf(block) : -1
  let head = -1
  for (let i = at >= 0 ? at : 0; i >= 0; i--) {
    if (blocks[i].matches(DOC_HEADING)) { head = i; break }
  }
  // front matter (no heading above it) ends at the first heading of any level
  const level = head >= 0 ? Number(blocks[head].tagName[1]) : Number.MAX_SAFE_INTEGER
  let end = blocks.length
  for (let i = head + 1; i < blocks.length; i++) {
    if (blocks[i].matches(DOC_HEADING) && Number(blocks[i].tagName[1]) <= level) { end = i; break }
  }
  return blocks.slice(head >= 0 ? head : 0, end)
}

/** "<role-or-tag>[ <ordinal>]" over a list of blocks: each block itself, then
 * its descendants, in flow order */
function descriptorInBlocks(scope: HTMLElement[], desc: string): HTMLElement | null {
  const m = /^([a-z-]+)\s*#?(\d+)?$/i.exec(desc.trim())
  if (!m) return null
  const word = m[1].toLowerCase()
  const nth = m[2] ? parseInt(m[2], 10) - 1 : 0
  const selector =
    DOC_ROLE_ALIASES[word] ??
    (word.startsWith('dia-') ? `.${word}` : /^(p|h[1-6]|ul|ol|li|dl|dt|dd|img|svg|table|tr|td|blockquote|pre|figure|figcaption|section|div|span|a|code|em|strong)$/.test(word) ? word : null)
  if (!selector) return null
  const hits: HTMLElement[] = []
  try {
    for (const block of scope) {
      if (block.matches(selector)) hits.push(block)
      hits.push(...block.querySelectorAll<HTMLElement>(selector))
    }
  } catch { return null }
  return hits[nth] ?? null
}

/** innermost element whose normalized text equals (then starts with) the
 * needle, searched over blocks and their descendants */
function textMatchIn(scope: HTMLElement[], needle: string): HTMLElement | null {
  const text = needle.replace(/^["'“”]+|["'“”]+$/g, '').replace(/\s+/g, ' ').trim()
  if (text.length < 3) return null
  let exact: HTMLElement | null = null
  let prefix: HTMLElement | null = null
  for (const block of scope) {
    for (const el of [block, ...block.querySelectorAll<HTMLElement>('*')]) {
      if (el instanceof SVGElement) continue
      const own = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (!own) continue
      if (own === text && (!exact || exact.contains(el))) exact = el
      else if (!exact && own.startsWith(text) && (!prefix || prefix.contains(el))) prefix = el
    }
  }
  return exact ?? prefix
}

function fold(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
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
