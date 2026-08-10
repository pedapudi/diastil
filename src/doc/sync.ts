/* Document sync: every native-view edit routes through here so the DOM and
 * the LaTeX source can never diverge. One rule, enforced at one choke
 * point: doc-mode surfaces never apply bare DOM ops to article content —
 * they build a syncedBlockOp (DOM ops + derived source patch, one undo
 * step) via commitDocEdit. */

import type { Op } from '../types'
import type { Doc } from '../model/doc'
import { state } from '../state'
import {
  insertBlockOp, joinBlocksOp, moveBlockOp, neighbourBlock, removeBlockOp,
  setDocSource, splitBlockOp, syncedBlockOp,
} from '../model/ops'
import { freshId } from '../model/parse'
import { parseLatex } from '../latex/parse'
import { renderDoc } from '../latex/render'
import { refreshDerived } from './derived'

/** the top-level article block containing an element (spans bind there) */
export function topBlockOf(doc: Doc, el: Element): HTMLElement | null {
  let cur: Element | null = el
  while (cur && cur.parentElement !== doc.article) cur = cur.parentElement
  if (!cur || !(cur instanceof HTMLElement)) return null
  // the derived header is not source-backed — its edits are preamble edits
  if (cur.matches('header.dia-doc-header')) return null
  return cur
}

/** the paired op as a VALUE: DOM ops + source patch + derived refresh, in
 * one invertible step. Surfaces that APPLY an edit use commitDocEdit; the
 * copilot needs the op itself (it previews and batches before applying),
 * and it must be the identical shape — one write path, not two. */
export function syncedDocOp(doc: Doc, block: HTMLElement, domOps: Op[], label: string, by?: 'you' | 'copilot'): Op {
  return withDerived(doc, syncedBlockOp(doc, block, domOps, label, by))
}

/** numbering is derived from the DOM, so it refreshes with the edit in BOTH
 * directions — an undone edit must not leave stale \ref texts behind */
function withDerived(doc: Doc, op: Op): Op {
  return {
    label: op.label,
    author: op.author,
    apply() { op.apply(); refreshDerived(doc.article) },
    invert() { return withDerived(doc, op.invert()) },
  }
}

/** apply DOM ops touching ONE top-level block, with the source patched in
 * the same undo step; false when the target is not source-backed */
export function commitDocEdit(doc: Doc, target: Element, domOps: Op[], label: string, by?: 'you' | 'copilot'): boolean {
  const block = topBlockOf(doc, target)
  if (!block) return false
  state.apply(syncedDocOp(doc, block, domOps, label, by))
  return true
}

/* ---------- structure: whole blocks ----------
 * Same law, one level up: a block never appears, vanishes or changes places
 * without its LaTeX doing the same in the same undo step (model/ops
 * regionOp). The op constructors are exported as VALUES for the copilot,
 * which previews and batches before applying; the commit helpers below are
 * what the native surfaces call. */

/** the block sequence changed, so the views keyed to it (outline, compiled
 * mirror, comment rail) must rebuild — including on UNDO, which is why the
 * notice rides inside the op rather than beside state.apply */
function withStructure(doc: Doc, op: Op): Op {
  return {
    label: op.label,
    author: op.author,
    apply() {
      op.apply()
      refreshDerived(doc.article)
      state.bus.emit({ type: 'blocks-changed' })
    },
    invert() { return withStructure(doc, op.invert()) },
  }
}

/** Build-as-you-go: `make(step)` is called again after each op it returned
 * has been applied, until it returns null.
 *
 * A structural op is built from live source offsets, so anything that lands
 * AFTER another one — the second insert of a copilot proposal, the second
 * hop of a move across three blocks — has to be built once the first has
 * landed. Built upfront, it would point at bytes that had since moved, and
 * the region guard would (correctly, uselessly) refuse it. */
export function lateDocOp(doc: Doc, label: string, by: 'you' | 'copilot', make: (step: number) => Op | null): Op {
  let done: Op[] = []
  const self: Op = {
    label,
    author: by,
    apply() {
      done = []
      for (let op = make(0); op; op = make(done.length)) {
        op.apply()
        done.push(op)
      }
      if (done.length === 0) console.warn(`dia-doc: "${label}" no longer applies — nothing changed`)
      refreshDerived(doc.article)
      state.bus.emit({ type: 'blocks-changed' })
    },
    invert() {
      const inverses = [...done].reverse().map((o) => o.invert())
      return {
        label: `un-${label}`,
        author: by,
        apply() {
          for (const o of inverses) o.apply()
          refreshDerived(doc.article)
          state.bus.emit({ type: 'blocks-changed' })
        },
        invert: () => self,
      }
    },
  }
  return self
}

/** the top-level blocks that have source bytes, in flow order (the derived
 * header is a rendering of the preamble, not a block) */
export function docBlocks(doc: Doc): HTMLElement[] {
  return ([...doc.article.children] as HTMLElement[]).filter((el) => topBlockOf(doc, el) === el)
}

/** render ONE top-level block from LaTeX. Going through the parser (rather
 * than building the element by hand) is what makes the new block's DOM and
 * its source the same thing by construction: it carries the render memo for
 * exactly these bytes, so it re-emits them verbatim until it is edited. */
export function docBlockFromTex(tex: string): HTMLElement | null {
  const source = tex.trim()
  if (!source) return null
  const rendered = renderDoc(parseLatex(source))
  const els = [...rendered.article.children].filter((c): c is HTMLElement => c instanceof HTMLElement)
  if (rendered.blocks.length !== 1 || els.length !== 1) return null
  // the bound span must cover the whole text, or the block's source and its
  // binding would disagree the moment someone edits it
  const span = rendered.blocks[0].span
  if (span.start !== 0 || span.end !== source.length) return null
  const block = els[0]
  for (const el of [block, ...block.querySelectorAll<HTMLElement>('*')]) {
    if (!el.hasAttribute('data-dia-id')) el.setAttribute('data-dia-id', freshId('d'))
  }
  return block
}

export function docInsertBlockOp(
  doc: Doc, tex: string, ref: HTMLElement | null, where: 'before' | 'after',
  label: string, by?: 'you' | 'copilot',
): { op: Op; el: HTMLElement } | null {
  const source = tex.trim()
  const el = docBlockFromTex(source)
  if (!el) return null
  const op = insertBlockOp(doc, el, source, ref, where, label, by)
  return op ? { op: withStructure(doc, op), el } : null
}

export function docRemoveBlockOp(doc: Doc, block: HTMLElement, label: string, by?: 'you' | 'copilot'): Op | null {
  const op = removeBlockOp(doc, block, label, by)
  return op ? withStructure(doc, op) : null
}

export function docMoveBlockOp(doc: Doc, block: HTMLElement, dir: -1 | 1, label: string, by?: 'you' | 'copilot'): Op | null {
  const op = moveBlockOp(doc, block, dir, label, by)
  return op ? withStructure(doc, op) : null
}

/** insert a block written as LaTeX beside `ref` (null: an empty body);
 * returns the rendered block, or null when the LaTeX is not one block */
export function insertDocBlock(
  doc: Doc, tex: string, ref: HTMLElement | null, where: 'before' | 'after', label = 'Insert block',
): HTMLElement | null {
  const made = docInsertBlockOp(doc, tex, ref, where, label)
  if (!made) return null
  state.apply(made.op)
  return made.el
}

export function removeDocBlock(doc: Doc, block: HTMLElement, label = 'Delete block'): boolean {
  const op = docRemoveBlockOp(doc, block, label)
  if (!op) return false
  state.apply(op)
  const sel = state.selection
  if (sel.kind === 'block' && sel.block === block) state.selection = { kind: 'none' }
  return true
}

export function moveDocBlock(doc: Doc, block: HTMLElement, dir: -1 | 1, label = 'Move block'): boolean {
  const op = docMoveBlockOp(doc, block, dir, label)
  if (!op) return false
  state.apply(op)
  return true
}

/** is there a source-backed block on that side to trade places with? */
export function canMoveDocBlock(doc: Doc, block: HTMLElement, dir: -1 | 1): boolean {
  return topBlockOf(doc, block) === block && neighbourBlock(doc, block, dir) !== null
}

/** the project file a move would put the block IN, when that is not the
 * file it is in now — else null.
 *
 * Worth surfacing because nothing on the document surface shows where one
 * \input'd chapter ends and the next begins: the prose is continuous, and a
 * move at that invisible line rewrites two files and changes which one the
 * paragraph belongs to for good. The user should read that on the verb, not
 * discover it in a diff. */
export function moveCrossesInto(doc: Doc, block: HTMLElement, dir: -1 | 1): string | null {
  const other = neighbourBlock(doc, block, dir)
  if (!other) return null
  const here = doc.project.fileOfId(block.getAttribute('data-dia-id') ?? '')
  const there = doc.project.fileOfId(other.getAttribute('data-dia-id') ?? '')
  return there !== null && there !== here ? there : null
}

/** split a block in two at the caret: `block` keeps `headHtml`, a fresh
 * sibling of the same shape takes `tailHtml` */
export function splitDocBlock(
  doc: Doc, block: HTMLElement, headHtml: string, tailHtml: string, label = 'Split block',
): HTMLElement | null {
  const tailEl = siblingShell(block, tailHtml)
  const op = splitBlockOp(doc, block, headHtml, tailEl, label)
  if (!op) return null
  state.apply(withStructure(doc, op))
  return tailEl
}

/** join `second` into `first` — the Backspace-at-the-start path. The merged
 * content is passed IN rather than read off the two elements: a join can
 * carry the edit the user typed before pressing the key, while both
 * elements still hold their pristine children for the op to invert to. */
export function joinDocBlocks(
  doc: Doc, first: HTMLElement, second: HTMLElement,
  merged = first.innerHTML + second.innerHTML, label = 'Join blocks',
): boolean {
  const op = joinBlocksOp(doc, first, second, merged, label)
  if (!op) return false
  state.apply(withStructure(doc, op))
  const sel = state.selection
  if (sel.kind === 'block' && sel.block === second) state.selection = { kind: 'block', block: first }
  return true
}

/** an empty sibling of the same shape: the tag and its dialect classes, but
 * none of the identity — a copied data-dia-id would bind two elements to
 * one source span, and a copied \label would duplicate a cross-reference */
function siblingShell(block: HTMLElement, html: string): HTMLElement {
  const el = block.cloneNode(false) as HTMLElement
  for (const a of ['contenteditable', 'spellcheck', 'data-dia-selected', 'data-dia-current', 'data-dia-label']) {
    el.removeAttribute(a)
  }
  el.innerHTML = html
  for (const n of [el, ...el.querySelectorAll<HTMLElement>('*')]) n.setAttribute('data-dia-id', freshId('d'))
  return el
}

/** commit a raw-editor session: one whole-source op (reconcile keeps
 * unchanged blocks' identity); no-op when the text is unchanged */
export function commitSourceEdit(doc: Doc, newText: string): boolean {
  if (newText === doc.source.text) return false
  state.apply(setDocSource(doc, newText))
  state.bus.emit({ type: 'blocks-changed' })
  return true
}
