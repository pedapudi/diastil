/* Document sync: every native-view edit routes through here so the DOM and
 * the LaTeX source can never diverge. One rule, enforced at one choke
 * point: doc-mode surfaces never apply bare DOM ops to article content —
 * they build a syncedBlockOp (DOM ops + derived source patch, one undo
 * step) via commitDocEdit. */

import type { Op } from '../types'
import type { Doc } from '../model/doc'
import { state } from '../state'
import { setDocSource, syncedBlockOp } from '../model/ops'
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

/** commit a raw-editor session: one whole-source op (reconcile keeps
 * unchanged blocks' identity); no-op when the text is unchanged */
export function commitSourceEdit(doc: Doc, newText: string): boolean {
  if (newText === doc.source.text) return false
  state.apply(setDocSource(doc, newText))
  state.bus.emit({ type: 'blocks-changed' })
  return true
}
