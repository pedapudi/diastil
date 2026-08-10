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
 * outside the region is untouched by construction, in both directions.
 *
 * A region belongs to ONE file. An edit may own a region in each of two
 * files — that is what a move across a chapter boundary is — and regionsOp
 * below says why the two are one op rather than two. */

const BLOCK_SEP = '\n\n'

/** a block id's stretch of a region, in offsets RELATIVE to the region */
interface RegionBind { id: string; start: number; end: number }
interface SourceRegion { text: string; binds: RegionBind[] }

/** one file's share of a structural edit: a contiguous region of the file
 * at `path`, by its exact bytes on both sides */
interface FileEdit { path: string; start: number; before: SourceRegion; after: SourceRegion }

/** One or more per-file region rewrites, applied and inverted as ONE op.
 *
 * Nearly every structural edit owns a region of a single file. A move
 * ACROSS a file boundary owns two — a removal in the file the block leaves,
 * an insertion in the file it joins — and they are one op here rather than
 * two composed regionOps because of the half-apply. Each region check
 * happens at ITS OWN apply time, so a composed pair would cheerfully delete
 * the paragraph from the first file and then refuse the second: the block
 * would exist in no file at all, and the only copy of its bytes would be
 * the op's own `before`. So EVERY premise is checked before ANY byte moves.
 *
 * That check is sound only because the regions are in DIFFERENT files:
 * patching one file cannot move another's offsets, so a premise verified up
 * front is still true when its turn comes. Two regions of the SAME file
 * would not have that property — the second's offsets would already be
 * stale — so that is refused rather than ordered-around. */
function regionsOp(doc: Doc, domOps: Op[], edits: FileEdit[], label: string, by?: 'you' | 'copilot'): Op {
  return {
    label,
    author: author(by),
    apply() {
      const sources: DocSource[] = []
      for (const e of edits) {
        const source = doc.project.sourceOfPath(e.path)
        if (!source) {
          console.error(`dia-doc: "${label}" names ${e.path}, which the project does not hold — nothing applied`)
          return
        }
        if (sources.includes(source)) {
          console.error(`dia-doc: "${label}" claims two regions of ${e.path} at once — nothing applied`)
          return
        }
        sources.push(source)
      }
      // the regions' bytes are this op's premise. If a source moved under it
      // — a source-view session between apply and redo — patching by offset
      // would rewrite bytes the op never owned, so it does nothing and says
      // so rather than corrupting the one thing it protects. ALL premises
      // first: a partially applied cross-file move loses a block.
      for (let i = 0; i < edits.length; i++) {
        const e = edits[i]
        if (sources[i].text.slice(e.start, e.start + e.before.text.length) !== e.before.text) {
          console.error(`dia-doc: "${label}" no longer matches its region in ${e.path} — nothing applied`)
          return
        }
      }
      for (const o of domOps) o.apply()
      for (let i = 0; i < edits.length; i++) {
        const e = edits[i]
        sources[i].patch(e.start, e.start + e.before.text.length, e.after.text)
      }
      // EVERY drop before ANY bind. A cross-file move drops the block's
      // binding in the file it left and binds it in the file it joined; run
      // per-edit in edit order, the undo direction would bind first and drop
      // second, and the moved block would come back bound to nothing —
      // still on screen, still editable-looking, its edits reaching no file.
      for (let i = 0; i < edits.length; i++) {
        for (const b of edits[i].before.binds) {
          sources[i].drop(b.id)
          doc.project.unbind(b.id)
        }
      }
      // through the PROJECT, not the DocSource: a bind that set the span but
      // not the owner map left the block answering its old file (or, for a
      // block the project never bound at all, the main file) on the next
      // write — a patch aimed at another file's coordinates
      for (const e of edits) {
        for (const b of e.after.binds) {
          doc.project.bind(b.id, e.path, { start: e.start + b.start, end: e.start + b.end })
        }
      }
    },
    invert() {
      const inverses = [...domOps].reverse().map((o) => o.invert())
      const swapped = edits.map((e) => ({ path: e.path, start: e.start, before: e.after, after: e.before }))
      return regionsOp(doc, inverses, swapped, `un-${label}`, author(by))
    },
  }
}

/** the single-file case, which is all but one of the callers */
function regionOp(
  doc: Doc, path: string, domOps: Op[], start: number,
  before: SourceRegion, after: SourceRegion, label: string, by?: 'you' | 'copilot',
): Op {
  return regionsOp(doc, domOps, [{ path, start, before, after }], label, by)
}

/** the project file a block's bytes actually live in. In a multi-file
 * project a block rendered from an \input'd chapter binds its span in THAT
 * chapter's DocSource, and a structural op that patched doc.source by those
 * offsets would rewrite the main file at a chapter's coordinates. Every
 * composed block is bound with its path (model/doc, doc/reconcile); a block
 * the project never bound can only be in the main file, which is what a
 * single-file document has always answered. */
function pathOf(doc: Doc, el: Element): string {
  const id = el.getAttribute('data-dia-id')
  return (id && doc.project.fileOfId(id)) || doc.project.mainPath
}

function sourceOf(doc: Doc, el: Element): DocSource {
  return doc.project.sourceOfPath(pathOf(doc, el)) ?? doc.source
}

/** the two blocks of a region must live in the SAME file: a region is a
 * contiguous run of bytes, and two files have no bytes between them. Ops
 * that REWRITE across the pair (a join re-emits the merged block) are
 * refused rather than guessed — the same rule that keeps an \input nested
 * in an environment from being spliced. A move does not rewrite, so it gets
 * a two-region op instead (moveAcrossFilesOp). */
function sharedPath(doc: Doc, a: Element, b: Element): string | null {
  const pa = pathOf(doc, a)
  return pa === pathOf(doc, b) ? pa : null
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
  const path = ref ? pathOf(doc, ref) : doc.project.mainPath
  const source = doc.project.sourceOfPath(path) ?? doc.source
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
  return regionOp(doc, path, [insertEl(doc.article, index, el, label, by)], at,
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
  const path = pathOf(doc, el)
  const source = sourceOf(doc, el)
  const { start, end } = removalRegion(doc, el, source, span)
  return regionOp(doc, path, [removeEl(el, label, by)], start,
    { text: source.text.slice(start, end), binds: [{ id, start: span.start - start, end: span.end - start }] },
    { text: '', binds: [] },
    label, by)
}

/** the bytes a block takes with it when it leaves: its own span plus ONE
 * separator (see removeBlockOp). Shared with the cross-file move, whose
 * departure side is exactly a removal — a block that crosses a chapter
 * boundary must not leave a stacked blank line behind any more than a
 * deleted one does. */
function removalRegion(doc: Doc, el: HTMLElement, source: DocSource, span: Span): { start: number; end: number } {
  let { start, end } = span
  // only a neighbour in the SAME file can lend its separator
  const nextSpan = blockSpanOfNeighbour(doc, el, 1, source)
  const prevSpan = blockSpanOfNeighbour(doc, el, -1, source)
  if (nextSpan && nextSpan.start >= end) {
    end += (/^\s*/.exec(source.text.slice(end, nextSpan.start)) ?? [''])[0].length
  } else if (prevSpan && prevSpan.end <= start) {
    start -= (/\s*$/.exec(source.text.slice(prevSpan.end, start)) ?? [''])[0].length
  }
  return { start, end }
}

/** swap a block with its neighbour: the two slices EXCHANGE places and the
 * whitespace between them stays where it is, so a move relocates bytes
 * rather than re-emitting (and thereby reformatting) either block.
 *
 * When the neighbour lives in another file there is nothing to exchange —
 * see moveAcrossFilesOp. */
export function moveBlockOp(doc: Doc, el: HTMLElement, dir: -1 | 1, label: string, by?: 'you' | 'copilot'): Op | null {
  const other = neighbourBlock(doc, el, dir)
  if (!other) return null
  const [first, second] = dir < 0 ? [other, el] : [el, other]
  const path = sharedPath(doc, first, second)
  if (!path) return moveAcrossFilesOp(doc, el, other, dir, label, by)
  const source = sourceOf(doc, first)
  const fs = blockSpan(doc, first)
  const ss = blockSpan(doc, second)
  const fid = first.getAttribute('data-dia-id')
  const sid = second.getAttribute('data-dia-id')
  if (!fs || !ss || !fid || !sid || ss.start < fs.end) return null

  const a = source.text.slice(fs.start, fs.end)
  const sep = source.text.slice(fs.end, ss.start)
  const b = source.text.slice(ss.start, ss.end)
  const index = [...doc.article.children].indexOf(second) + 1
  return regionOp(doc, path, [moveEl(first, doc.article, index, label, by)], fs.start,
    { text: a + sep + b, binds: bindPair(fid, a, sep, sid, b) },
    { text: b + sep + a, binds: bindPair(sid, b, sep, fid, a) },
    label, by)
}

/** Move a block PAST a neighbour that lives in another file: out of the
 * file it was in, into the file the neighbour is in.
 *
 * Within one file a move is a swap — the two slices exchange places and the
 * whitespace between them stays put. Across a boundary there is no "between
 * them", so the move is a removal in the departure file and an insertion in
 * the arrival file, and the block's OWN bytes travel: a move relocates, it
 * does not re-emit (and thereby reformat) the paragraph.
 *
 * The arrival region is the NEIGHBOUR's span, not the empty seam beside it,
 * for the same reason every other region carries its bytes: the neighbour's
 * exact text is then the op's premise, so an insertion whose offset has
 * drifted refuses instead of splicing a paragraph into the middle of one.
 *
 * The composed order is preserved by construction. The article is the files
 * flattened in \input order, `other` is the block adjacent to `el` in that
 * flattening, and `el` lands immediately beside `other` on the far side —
 * so a fresh compose of the edited files rebuilds exactly the order now on
 * screen, and the next recompose cannot bounce the block back to its old
 * file (its bytes are no longer there to be found). */
function moveAcrossFilesOp(
  doc: Doc, el: HTMLElement, other: HTMLElement, dir: -1 | 1, label: string, by?: 'you' | 'copilot',
): Op | null {
  const id = el.getAttribute('data-dia-id')
  const oid = other.getAttribute('data-dia-id')
  const fromPath = pathOf(doc, el)
  const toPath = pathOf(doc, other)
  const from = doc.project.sourceOfPath(fromPath)
  const to = doc.project.sourceOfPath(toPath)
  const span = blockSpan(doc, el)
  const otherSpan = blockSpan(doc, other)
  // `from === to` cannot happen through sharedPath, but a move that wrote
  // two regions of one file would patch the second at stale offsets, and
  // that is the failure this whole shape exists to prevent
  if (!id || !oid || !from || !to || from === to || !span || !otherSpan) return null

  // the departure: the block's own span plus one separator, exactly as a
  // delete would take it
  const leave = removalRegion(doc, el, from, span)
  const gone = from.text.slice(leave.start, leave.end)
  // the arrival: the block's bytes, seated at the seam beside `other`.
  // Trimmed first because the seam's separators are computed HERE, from the
  // destination's own gap — a span that carried its own leading newline
  // would otherwise stack them onto seated()'s.
  const tex = from.text.slice(span.start, span.end).trim()
  if (!tex) return null
  const otherTex = to.text.slice(otherSpan.start, otherSpan.end)
  const at = dir > 0 ? otherSpan.end : otherSpan.start
  const { text: payload, offset } = seated(to, at, tex)
  const arrival: SourceRegion = dir > 0
    ? {
      text: otherTex + payload,
      binds: [
        { id: oid, start: 0, end: otherTex.length },
        { id, start: otherTex.length + offset, end: otherTex.length + offset + tex.length },
      ],
    }
    : {
      text: payload + otherTex,
      binds: [
        { id, start: offset, end: offset + tex.length },
        { id: oid, start: payload.length, end: payload.length + otherTex.length },
      ],
    }

  // the DOM move is the same one a same-file move makes: `first` steps past
  // `second`, which for either direction leaves el on the far side of other
  const [first, second] = dir < 0 ? [other, el] : [el, other]
  const index = [...doc.article.children].indexOf(second) + 1
  return regionsOp(doc, [moveEl(first, doc.article, index, label, by)], [
    {
      path: fromPath,
      start: leave.start,
      before: { text: gone, binds: [{ id, start: span.start - leave.start, end: span.end - leave.start }] },
      after: { text: '', binds: [] },
    },
    {
      path: toPath,
      start: otherSpan.start,
      before: { text: otherTex, binds: [{ id: oid, start: 0, end: otherTex.length }] },
      after: arrival,
    },
  ], label, by)
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
  const path = pathOf(doc, el)
  const source = sourceOf(doc, el)

  const headTex = emitAs(el, headHtml)
  const tailTex = emitBlockTex(tailEl)
  const after = headTex + BLOCK_SEP + tailTex
  const index = [...doc.article.children].indexOf(el) + 1
  const domOps = [setInlineHtml(el, headHtml, by), insertEl(doc.article, index, tailEl, label, by)]
  return regionOp(doc, path, domOps, span.start,
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

/** join a block into the one before it — the inverse shape of a split.
 *
 * Still refused across a file boundary, and it is a different refusal from
 * the move's. A join REWRITES: the two blocks become one re-emitted block,
 * which has to end up in one file, and neither answer is the user's — the
 * chapter that keeps the merged prose loses it from the other file's view,
 * and pressing Backspace at the top of a chapter is not a request to
 * dissolve the chapter boundary. */
export function joinBlocksOp(
  doc: Doc, first: HTMLElement, second: HTMLElement, merged: string, label: string, by?: 'you' | 'copilot',
): Op | null {
  const fid = first.getAttribute('data-dia-id')
  const sid = second.getAttribute('data-dia-id')
  const path = sharedPath(doc, first, second)
  const source = sourceOf(doc, first)
  const fs = blockSpan(doc, first)
  const ss = blockSpan(doc, second)
  if (!fid || !sid || !fs || !ss || !path || ss.start < fs.end) return null

  const joined = emitAs(first, merged)
  const domOps = [setInlineHtml(first, merged, by), removeEl(second, label, by)]
  return regionOp(doc, path, domOps, fs.start,
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
