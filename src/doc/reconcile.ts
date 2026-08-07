/* Whole-source replacement (the raw editor's commit): re-parse, re-render,
 * and RECONCILE — a block whose source slice is unchanged keeps its
 * existing DOM element, data-dia-id, and render memo, so selection state
 * and comment anchors survive a source-view session untouched. Only
 * changed or new blocks get fresh elements. */

import type { Doc } from '../model/doc'
import { parseLatex } from '../latex/parse'
import { renderDoc } from '../latex/render'
import { freshId } from '../model/parse'
import { refreshDerived } from './derived'

export function applySourceText(doc: Doc, newText: string): void {
  // pool the existing top-level blocks by their CURRENT source slice —
  // order-preserving: equal slices match first-come-first-kept
  const pool = new Map<string, HTMLElement[]>()
  for (const el of [...doc.article.children]) {
    if (!(el instanceof HTMLElement)) continue
    const id = el.getAttribute('data-dia-id')
    const slice = id ? doc.source.sliceOf(id) : null
    if (slice === null) continue
    const queue = pool.get(slice)
    if (queue) queue.push(el)
    else pool.set(slice, [el])
  }

  doc.source.text = newText
  doc.source.clearBindings()

  const rendered = renderDoc(parseLatex(newText))
  const spanOf = new Map(rendered.blocks.map((b) => [b.el, b.span]))
  const children: HTMLElement[] = []
  for (const child of [...rendered.article.children]) {
    if (!(child instanceof HTMLElement)) continue
    const span = spanOf.get(child)
    if (!span) {
      // the derived header — always fresh (the preamble may have changed)
      stampIds(child)
      children.push(child)
      continue
    }
    const slice = newText.slice(span.start, span.end)
    const kept = pool.get(slice)?.shift()
    const el = kept ?? child
    if (!kept) stampIds(child)
    children.push(el)
    const id = el.getAttribute('data-dia-id')
    if (id) doc.source.bind(id, span)
  }
  doc.article.replaceChildren(...children)
  refreshDerived(doc.article)
}

function stampIds(rootEl: HTMLElement): void {
  for (const el of [rootEl, ...rootEl.querySelectorAll<HTMLElement>('*')]) {
    if (!el.hasAttribute('data-dia-id')) el.setAttribute('data-dia-id', freshId('d'))
  }
}
