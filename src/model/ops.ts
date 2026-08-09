/* Op constructors — the ONLY way modules mutate the document.
 * Each returns an Op with apply/invert; route through state.apply(op). */

import type { NodeGeom, Op } from '../types'
import type { Doc } from './doc'
import type { DocSource } from '../latex/source'
import type { Span } from '../latex/lex'
import { routeAll, routeEdge, setNodeGeom, getNodeGeom } from '../scene/route'
import { emitBlockTex } from '../latex/emit'
import { blockMemo } from '../latex/render'
import { applySourceText } from '../doc/reconcile'

const author = (a?: 'you' | 'copilot') => a ?? 'you'

/** Put a re-emitted block back in the whitespace its span already had.
 *
 * A span owns the blank lines and newlines that SEPARATE its block from the
 * neighbours; an unedited block emits them back verbatim, but every
 * reconstruction path in emit.ts produces the block alone. Patched in raw,
 * an edited paragraph would swallow the newline after the `\section{…}`
 * above it and glue the two into one line of LaTeX — source the engine
 * still compiles, into a document that is not the one on screen.
 *
 * Both cases pass through here: the unedited emission already carries the
 * separators, so stripping and re-adding them is the identity. */
function reseated(source: DocSource, span: { start: number; end: number }, emitted: string): string {
  const slice = source.text.slice(span.start, span.end)
  const lead = /^\s*/.exec(slice)?.[0] ?? ''
  const tail = /\s*$/.exec(slice.slice(lead.length))?.[0] ?? ''
  return lead + emitted.replace(/^\s+/, '').replace(/\s+$/, '') + tail
}

/** DOM mutation + LaTeX source patch as ONE op — the document mode's only
 * legal write shape (the applyTex pattern generalized). The source patch is
 * DERIVED at apply time: run the DOM ops, re-emit the containing top-level
 * block, replace its span. Undo applies the inverse DOM ops and re-emits —
 * a block restored to its pristine DOM re-emits its memoized source slice,
 * so undo restores the source BYTE-EXACTLY by construction. */
export function syncedBlockOp(doc: Doc, blockEl: HTMLElement, domOps: Op[], label: string, by?: 'you' | 'copilot'): Op {
  return {
    label,
    author: author(by),
    apply() {
      for (const o of domOps) o.apply()
      const id = blockEl.getAttribute('data-dia-id')
      // multi-file: a block rendered from an \input'd chapter binds its
      // span in THAT file's DocSource, so the patch has to land there.
      // Single-file documents route to doc.source exactly as before —
      // their project holds nothing else (latex/project.ts).
      const source = (id && doc.project.sourceOfId(id)) || doc.source
      const span = id ? source.spanOf(id) : null
      if (!span) {
        console.error('dia-doc: edited block has no bound source span — source not updated')
        return
      }
      const text = reseated(source, span, emitBlockTex(blockEl))
      source.patch(span.start, span.end, text)
      // A block with an EMPTY span — a paragraph a split created, before
      // anything was typed into it — sits exactly ON the boundary of its
      // own patch, and patch reads a span ending there as ending BEFORE the
      // change (the rule that keeps the block above from swallowing this
      // one). It would stay empty, and the next edit would insert a second
      // copy beside the first: the source would stop being the document.
      if (id && span.start === span.end) source.bind(id, { start: span.start, end: span.start + text.length })
    },
    invert() {
      const inverses = [...domOps].reverse().map((o) => o.invert())
      return syncedBlockOp(doc, blockEl, inverses, `un-${label}`, author(by))
    },
  }
}

/* ---------- document structure: whole top-level blocks ----------
 *
 * syncedBlockOp can change what is INSIDE one block. These change the
 * sequence of blocks itself — insert, remove, move, split, join — and they
 * are the same bargain at one level up: the DOM move and the source patch
 * are one invertible op, or the two truths drift apart.
 *
 * The shape is a REGION rewrite. A structural edit owns a contiguous run of
 * source — one or two adjacent block spans plus the whitespace between them
 * — and is described by that region's exact bytes on BOTH sides, plus which
 * block id owns which stretch afterwards. The inverse is then literally the
 * same op with the sides swapped: undo restores the region's original bytes
 * verbatim (not a re-emission that might reformat them), and every byte
 * outside the region is untouched by construction, in both directions. */

const BLOCK_SEP = '\n\n'

/** a block id's stretch of a region, in offsets RELATIVE to the region */
interface RegionBind { id: string; start: number; end: number }
interface SourceRegion { text: string; binds: RegionBind[] }

function regionOp(
  doc: Doc, source: DocSource, domOps: Op[], start: number,
  before: SourceRegion, after: SourceRegion, label: string, by?: 'you' | 'copilot',
): Op {
  return {
    label,
    author: author(by),
    apply() {
      // the region's bytes are this op's premise. If the source moved under
      // it — a source-view session between apply and redo — patching by
      // offset would rewrite bytes the op never owned, so it does nothing
      // and says so rather than corrupting the one thing it protects.
      if (source.text.slice(start, start + before.text.length) !== before.text) {
        console.error(`dia-doc: "${label}" no longer matches its source region — nothing applied`)
        return
      }
      for (const o of domOps) o.apply()
      source.patch(start, start + before.text.length, after.text)
      for (const b of before.binds) source.drop(b.id)
      for (const b of after.binds) source.bind(b.id, { start: start + b.start, end: start + b.end })
    },
    invert() {
      const inverses = [...domOps].reverse().map((o) => o.invert())
      return regionOp(doc, source, inverses, start, after, before, `un-${label}`, author(by))
    },
  }
}

/** the file a block's bytes actually live in. In a multi-file project a
 * block rendered from an \input'd chapter binds its span in THAT chapter's
 * DocSource, and a structural op that patched doc.source by those offsets
 * would rewrite the main file at a chapter's coordinates. Single-file
 * documents answer doc.source, exactly as before. */
function sourceOf(doc: Doc, el: Element): DocSource {
  const id = el.getAttribute('data-dia-id')
  return (id && doc.project.sourceOfId(id)) || doc.source
}

/** the two blocks of a region must live in the SAME file: a region is a
 * contiguous run of bytes, and two files have no bytes between them. A
 * cross-file structural edit is refused rather than guessed — the same rule
 * that keeps an \input nested in an environment from being spliced. */
function sharedSource(doc: Doc, a: Element, b: Element): DocSource | null {
  const sa = sourceOf(doc, a)
  return sa === sourceOf(doc, b) ? sa : null
}

function blockSpan(doc: Doc, el: Element): Span | null {
  const id = el.getAttribute('data-dia-id')
  return id ? sourceOf(doc, el).spanOf(id) : null
}

/** the neighbouring top-level block that HAS source bytes. The derived
 * header has none — it is not a place a block can sit next to, and treating
 * it as one would put a paragraph's source above \begin{document}. */
export function neighbourBlock(doc: Doc, el: HTMLElement, dir: -1 | 1): HTMLElement | null {
  let cur = dir < 0 ? el.previousElementSibling : el.nextElementSibling
  while (cur) {
    if (cur instanceof HTMLElement && blockSpan(doc, cur)) return cur
    cur = dir < 0 ? cur.previousElementSibling : cur.nextElementSibling
  }
  return null
}

/** insert a rendered block, with `tex` as its source, beside `ref` (or into
 * an empty body when ref is null). The insertion is PURE: the payload is
 * the block plus one blank line, spliced at a boundary, so neither
 * neighbour's bytes are rewritten. */
export function insertBlockOp(
  doc: Doc, el: HTMLElement, tex: string, ref: HTMLElement | null,
  where: 'before' | 'after', label: string, by?: 'you' | 'copilot',
): Op | null {
  const id = el.getAttribute('data-dia-id')
  if (!id) return null

  // the new block joins the file its neighbour lives in; with no neighbour
  // there is only the main file to join
  const source = ref ? sourceOf(doc, ref) : doc.source
  let at: number
  if (ref) {
    // the seam is the ref block's own edge, so the gap between two blocks —
    // whitespace, and any % comment written into it — is never split
    const span = blockSpan(doc, ref)
    if (!span) return null
    at = where === 'after' ? span.end : span.start
  } else {
    // an empty body — the only anchor left is \begin{document} itself
    const m = /\\begin\{document\}[^\n]*\n?/.exec(source.text)
    if (!m) return null
    at = m.index + m[0].length
  }

  const { text, offset } = seated(source, at, tex)
  const index = ref ? [...doc.article.children].indexOf(ref) + (where === 'after' ? 1 : 0) : doc.article.children.length
  return regionOp(doc, source, [insertEl(doc.article, index, el, label, by)], at,
    { text: '', binds: [] },
    { text, binds: [{ id, start: offset, end: offset + tex.length }] },
    label, by)
}

/** A block that is inserted at a seam has to be SEATED there: enough
 * newlines on each side that it reads as its own paragraph, and no more.
 *
 * Two newlines is the separator, but the seam rarely offers a clean one —
 * a block's span may already carry its leading newline, and the gap above
 * it may end in a % comment with no newline after it. Pasting a fixed
 * "\n\n" + block against that comment would make the block PART of the
 * comment: source that still compiles, into a document missing a paragraph
 * the editor is showing. So each side is counted and only the missing
 * newlines are added. */
function seated(source: DocSource, at: number, tex: string): { text: string; offset: number } {
  const lead = '\n'.repeat(Math.max(0, 2 - trailingNewlines(source.text.slice(0, at))))
  const trail = '\n'.repeat(Math.max(0, 2 - leadingNewlines(source.text.slice(at))))
  return { text: lead + tex + trail, offset: lead.length }
}

function trailingNewlines(s: string): number {
  return (/(\n[^\S\n]*)*$/.exec(s)?.[0].match(/\n/g) ?? []).length
}

function leadingNewlines(s: string): number {
  return (/^([^\S\n]*\n)*/.exec(s)?.[0].match(/\n/g) ?? []).length
}

/** remove a whole block, taking ONE separator with it — the blank line a
 * removed block leaves behind would otherwise stack with its neighbour's.
 * WHITESPACE only: a % comment written in the gap is somebody's note, not
 * this block's punctuation, and it stays. */
export function removeBlockOp(doc: Doc, el: HTMLElement, label: string, by?: 'you' | 'copilot'): Op | null {
  const id = el.getAttribute('data-dia-id')
  const span = blockSpan(doc, el)
  if (!id || !span) return null
  const source = sourceOf(doc, el)
  let { start, end } = span
  // only a neighbour in the SAME file can lend its separator
  const nextSpan = blockSpanOfNeighbour(doc, el, 1, source)
  const prevSpan = blockSpanOfNeighbour(doc, el, -1, source)
  if (nextSpan && nextSpan.start >= end) {
    end += (/^\s*/.exec(source.text.slice(end, nextSpan.start)) ?? [''])[0].length
  } else if (prevSpan && prevSpan.end <= start) {
    start -= (/\s*$/.exec(source.text.slice(prevSpan.end, start)) ?? [''])[0].length
  }
  return regionOp(doc, source, [removeEl(el, label, by)], start,
    { text: source.text.slice(start, end), binds: [{ id, start: span.start - start, end: span.end - start }] },
    { text: '', binds: [] },
    label, by)
}

/** swap a block with its neighbour: the two slices EXCHANGE places and the
 * whitespace between them stays where it is, so a move relocates bytes
 * rather than re-emitting (and thereby reformatting) either block */
export function moveBlockOp(doc: Doc, el: HTMLElement, dir: -1 | 1, label: string, by?: 'you' | 'copilot'): Op | null {
  const other = neighbourBlock(doc, el, dir)
  if (!other) return null
  const [first, second] = dir < 0 ? [other, el] : [el, other]
  const source = sharedSource(doc, first, second)
  if (!source) return null
  const fs = blockSpan(doc, first)
  const ss = blockSpan(doc, second)
  const fid = first.getAttribute('data-dia-id')
  const sid = second.getAttribute('data-dia-id')
  if (!fs || !ss || !fid || !sid || ss.start < fs.end) return null

  const a = source.text.slice(fs.start, fs.end)
  const sep = source.text.slice(fs.end, ss.start)
  const b = source.text.slice(ss.start, ss.end)
  const index = [...doc.article.children].indexOf(second) + 1
  return regionOp(doc, source, [moveEl(first, doc.article, index, label, by)], fs.start,
    { text: a + sep + b, binds: bindPair(fid, a, sep, sid, b) },
    { text: b + sep + a, binds: bindPair(sid, b, sep, fid, a) },
    label, by)
}

function bindPair(firstId: string, a: string, sep: string, secondId: string, b: string): RegionBind[] {
  return [
    { id: firstId, start: 0, end: a.length },
    { id: secondId, start: a.length + sep.length, end: a.length + sep.length + b.length },
  ]
}

/** split a block in two: `el` keeps the head (and its identity, so an
 * untouched head re-emits its ORIGINAL bytes), `tailEl` is the new block */
export function splitBlockOp(
  doc: Doc, el: HTMLElement, headHtml: string, tailEl: HTMLElement,
  label: string, by?: 'you' | 'copilot',
): Op | null {
  const id = el.getAttribute('data-dia-id')
  const tailId = tailEl.getAttribute('data-dia-id')
  const span = blockSpan(doc, el)
  if (!id || !tailId || !span) return null
  const source = sourceOf(doc, el)

  const headTex = emitAs(el, headHtml)
  const tailTex = emitBlockTex(tailEl)
  const after = headTex + BLOCK_SEP + tailTex
  const index = [...doc.article.children].indexOf(el) + 1
  const domOps = [setInlineHtml(el, headHtml, by), insertEl(doc.article, index, tailEl, label, by)]
  return regionOp(doc, source, domOps, span.start,
    { text: source.text.slice(span.start, span.end), binds: [{ id, start: 0, end: span.end - span.start }] },
    {
      text: after,
      binds: [
        { id, start: 0, end: headTex.length },
        { id: tailId, start: headTex.length + BLOCK_SEP.length, end: after.length },
      ],
    },
    label, by)
}

/** join a block into the one before it — the inverse shape of a split */
export function joinBlocksOp(
  doc: Doc, first: HTMLElement, second: HTMLElement, merged: string, label: string, by?: 'you' | 'copilot',
): Op | null {
  const fid = first.getAttribute('data-dia-id')
  const sid = second.getAttribute('data-dia-id')
  const source = sharedSource(doc, first, second)
  const fs = blockSpan(doc, first)
  const ss = blockSpan(doc, second)
  if (!fid || !sid || !fs || !ss || !source || ss.start < fs.end) return null

  const joined = emitAs(first, merged)
  const domOps = [setInlineHtml(first, merged, by), removeEl(second, label, by)]
  return regionOp(doc, source, domOps, fs.start,
    {
      text: source.text.slice(fs.start, ss.end),
      binds: bindPair(fid, source.text.slice(fs.start, fs.end),
        source.text.slice(fs.end, ss.start), sid, source.text.slice(ss.start, ss.end)),
    },
    { text: joined, binds: [{ id: fid, start: 0, end: joined.length }] },
    label, by)
}

/** the LaTeX a block would emit if its inline content were `html`.
 *
 * The probe carries the original's render memo on purpose: a split whose
 * head is the paragraph's untouched markup must emit that paragraph's
 * original bytes, not a reconstruction of them — pressing Enter at the end
 * of a paragraph is not an edit to the paragraph, and reflowing its
 * whitespace would say it was. */
function emitAs(el: HTMLElement, html: string): string {
  const probe = el.cloneNode(false) as HTMLElement
  probe.innerHTML = html
  const memo = blockMemo.get(el)
  if (memo) blockMemo.set(probe, memo)
  return emitBlockTex(probe)
}

function blockSpanOfNeighbour(doc: Doc, el: HTMLElement, dir: -1 | 1, source?: DocSource): Span | null {
  const other = neighbourBlock(doc, el, dir)
  if (!other) return null
  if (source && sourceOf(doc, other) !== source) return null
  return blockSpan(doc, other)
}

/** replace an element's text content (role text editing).
 * The inverse restores the exact previous child nodes, not just the flattened
 * text — setText on a container (e.g. a copilot proposal) must undo cleanly. */
export function setText(el: HTMLElement, text: string, by?: 'you' | 'copilot'): Op {
  const prevNodes = [...el.childNodes]
  return {
    label: `SetText ${describe(el)}`,
    author: author(by),
    apply() { el.textContent = text },
    invert() {
      const redo = () => setText(el, text, author(by))
      return {
        label: `un-SetText ${describe(el)}`,
        author: author(by),
        apply() { el.replaceChildren(...prevNodes) },
        invert: redo,
      }
    },
  }
}

/** replace an element's inline content — rich text editing that PRESERVES
 * inline markup (strong/em/code/…); exact undo via child-node snapshot */
export function setInlineHtml(el: HTMLElement, html: string, by?: 'you' | 'copilot'): Op {
  const prevNodes = [...el.childNodes]
  return {
    label: `SetText ${describe(el)}`,
    author: author(by),
    apply() { el.innerHTML = html },
    invert() {
      const redo = () => setInlineHtml(el, html, author(by))
      return {
        label: `un-SetText ${describe(el)}`,
        author: author(by),
        apply() { el.replaceChildren(...prevNodes) },
        invert: redo,
      }
    },
  }
}

/** set/remove an attribute */
export function setAttr(el: Element, name: string, value: string | null, by?: 'you' | 'copilot'): Op {
  const prev = el.getAttribute(name)
  return {
    label: `SetAttr ${name}`,
    author: author(by),
    apply() { value === null ? el.removeAttribute(name) : el.setAttribute(name, value) },
    invert() { return setAttr(el, name, prev, author(by)) },
  }
}

/** set a deck theme token inside <style id="dia-theme"> */
export function setToken(themeStyle: HTMLStyleElement, name: string, value: string, by?: 'you' | 'copilot'): Op {
  const sheet = themeStyle.sheet as CSSStyleSheet
  const rule = [...sheet.cssRules].find(
    (r): r is CSSStyleRule => r instanceof CSSStyleRule && r.selectorText === ':host',
  )
  const prev = rule?.style.getPropertyValue(name).trim() ?? ''
  return {
    label: `SetToken ${name}: ${value}`,
    author: author(by),
    apply() { rule?.style.setProperty(name, value) },
    invert() { return setToken(themeStyle, name, prev, author(by)) },
  }
}

/** set an inline style property on an element (last-resort write target;
 * scene styling sets the dia-node / dia-edge custom props on svg groups) */
export function setStyleProp(el: HTMLElement | SVGElement, prop: string, value: string, by?: 'you' | 'copilot'): Op {
  const prev = el.style.getPropertyValue(prop)
  return {
    label: `SetProp ${describe(el)}/${prop}`,
    author: author(by),
    apply() { el.style.setProperty(prop, value) },
    invert() { return setStyleProp(el, prop, prev, author(by)) },
  }
}

/** insert an element at (parent, index) */
export function insertEl(parent: Element, index: number, el: Element, label?: string, by?: 'you' | 'copilot'): Op {
  return {
    label: label ?? `Insert ${describe(el)}`,
    author: author(by),
    apply() { parent.insertBefore(el, parent.children[index] ?? null) },
    invert() { return removeEl(el, label && `un-${label}`, author(by)) },
  }
}

/** remove an element (remembers its position). The anchor is the following
 * SIBLING NODE, not a child index: prose blocks are mixed content, and an
 * element restored to the wrong side of a text node would come back with
 * different bytes than it left with. */
export function removeEl(el: Element, label?: string, by?: 'you' | 'copilot'): Op {
  const parent = el.parentElement ?? (el.parentNode as Element)
  const next = el.nextSibling
  return {
    label: label ?? `Delete ${describe(el)}`,
    author: author(by),
    apply() { el.remove() },
    invert() { return insertBeforeNode(parent, el, next, undefined, author(by)) },
  }
}

/** insert an element before a specific sibling node (null, or a node that
 * has since moved away, appends) */
function insertBeforeNode(parent: Element, el: Element, ref: Node | null, label?: string, by?: 'you' | 'copilot'): Op {
  return {
    label: label ?? `Insert ${describe(el)}`,
    author: author(by),
    apply() { parent.insertBefore(el, ref && ref.parentNode === parent ? ref : null) },
    invert() { return removeEl(el, label && `un-${label}`, author(by)) },
  }
}

/** move an element to (parent, index) — slide reorder, layout moves */
export function moveEl(el: Element, toParent: ParentNode, toIndex: number, label?: string, by?: 'you' | 'copilot'): Op {
  const fromParent = (el.parentElement ?? el.parentNode) as ParentNode & Element
  const fromIndex = [...fromParent.children].indexOf(el)
  return {
    label: label ?? `Move ${describe(el)}`,
    author: author(by),
    apply() {
      const ref = toParent.children[toIndex] ?? null
      toParent.insertBefore(el, ref === el ? el.nextSibling : ref)
    },
    invert() { return moveEl(el, fromParent as ParentNode & Element, fromIndex, label && `un-${label}`, author(by)) },
  }
}

/** move a scene node and reroute — ALL edges, not just its own: the moved
 * node may now sit in some unrelated edge's path, which must divert */
export function moveSceneNode(scene: SVGSVGElement, node: SVGGElement, geom: NodeGeom, by?: 'you' | 'copilot'): Op {
  const prev = getNodeGeom(node)
  const id = node.getAttribute('data-dia-node') ?? '?'
  return {
    label: `MoveNode ${id} → (${Math.round(geom.x)},${Math.round(geom.y)})`,
    author: author(by),
    apply() { setNodeGeom(node, geom); routeAll(scene) },
    invert() { return moveSceneNode(scene, node, prev, author(by)) },
  }
}

/** set (or clear) an edge's user-owned waypoint and re-route it — the
 * drag of a connector's middle handle, as ONE op */
export function setEdgeVia(scene: SVGSVGElement, edge: SVGGElement, via: string | null, by?: 'you' | 'copilot'): Op {
  const prev = edge.getAttribute('data-via')
  const ref = edge.getAttribute('data-dia-edge') ?? '?'
  return {
    label: via ? `ReRoute ${ref} via (${via})` : `ReRoute ${ref} auto`,
    author: author(by),
    apply() {
      via === null ? edge.removeAttribute('data-via') : edge.setAttribute('data-via', via)
      routeEdge(scene, edge)
    },
    invert() { return setEdgeVia(scene, edge, prev, author(by)) },
  }
}

/** whole-source replacement from the raw LaTeX editor — coarse but
 * truthful undo: one op per source-view session, restoring the exact
 * previous text, DOM children, and span bindings */
export function setDocSource(doc: Doc, newText: string, by?: 'you' | 'copilot'): Op {
  const prevText = doc.source.text
  const prevChildren = [...doc.article.children]
  // the WHOLE project's bindings: applySourceText re-composes, which clears
  // every file's spans and the owner map. Restoring only the main file's
  // would leave the chapter blocks bound to nothing — still on screen,
  // still editable-looking, their edits silently reaching no source
  const prevSpans = doc.project.snapshotBindings()
  const label = 'Edit source'
  return {
    label,
    author: author(by),
    apply() { applySourceText(doc, newText) },
    invert() {
      const redo = () => setDocSource(doc, newText, author(by))
      return {
        label: `un-${label}`,
        author: author(by),
        apply() {
          doc.source.text = prevText
          doc.project.restoreBindings(prevSpans)
          doc.article.replaceChildren(...prevChildren)
        },
        invert: redo,
      }
    },
  }
}

/** batch several ops into one undo step */
export function batch(label: string, ops: Op[], by?: 'you' | 'copilot'): Op {
  return {
    label,
    author: author(by),
    apply() { for (const o of ops) o.apply() },
    invert() {
      const inverses = [...ops].reverse().map((o) => o.invert())
      return batch(`un-${label}`, inverses, author(by))
    },
  }
}

function describe(el: Element): string {
  const role = [...el.classList].find((c) => c.startsWith('dia-'))
  return role ?? el.tagName.toLowerCase()
}
