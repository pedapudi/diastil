/* Whole-source replacement (the raw editor's commit): re-parse, re-render,
 * and RECONCILE — a block whose source slice is unchanged keeps its
 * existing DOM element, data-dia-id, and render memo, so selection state
 * and comment anchors survive a source-view session untouched. Only
 * changed or new blocks get fresh elements. */

import type { Doc } from '../model/doc'
import { composeProject, markUnresolved } from '../latex/project'
import { freshId } from '../model/parse'
import { refreshDerived } from './derived'

export function applySourceText(doc: Doc, newText: string): void {
  // pool the existing top-level blocks by their CURRENT source slice —
  // order-preserving: equal slices match first-come-first-kept. A slice is
  // asked of the file that OWNS the block: after a re-compose the pool has
  // to be able to match a chapter's blocks too, and only that file's
  // DocSource can produce their bytes.
  const pool = new Map<string, HTMLElement[]>()
  for (const el of [...doc.article.children]) {
    if (!(el instanceof HTMLElement)) continue
    const id = el.getAttribute('data-dia-id')
    const source = (id && doc.project.sourceOfId(id)) || doc.source
    const slice = id ? source.sliceOf(id) : null
    if (slice === null) continue
    const queue = pool.get(slice)
    if (queue) queue.push(el)
    else pool.set(slice, [el])
  }

  doc.source.text = newText
  // every file's bindings go, not just the main file's: the re-compose
  // rebuilds all of them, and a stale binding into a chapter is a patch
  // aimed at bytes that may have moved
  doc.project.clearBindings()

  // re-compose, not re-render: the raw editor edits the MAIN file, and the
  // \input'd chapters it names must come back as content. Rendering main
  // alone would turn every resolved chapter back into an island — the
  // document would look like it had lost three chapters to one typo fix.
  const rendered = composeProject(doc.project, newText)
  const composed = new Map(rendered.blocks.map((b) => [b.el, b]))
  const children: HTMLElement[] = []
  const unresolved = new Map(rendered.unresolved.map((u) => [u.el, u]))
  const stillUnresolved: typeof rendered.unresolved = []
  for (const child of [...rendered.article.children]) {
    if (!(child instanceof HTMLElement)) continue
    const block = composed.get(child)
    if (!block) {
      // the derived header — always fresh (the preamble may have changed)
      stampIds(child)
      children.push(child)
      continue
    }
    const source = doc.project.sourceOfPath(block.path)
    const slice = source ? source.text.slice(block.span.start, block.span.end) : null
    const kept = slice === null ? undefined : pool.get(slice)?.shift()
    const el = kept ?? child
    if (!kept) stampIds(child)
    children.push(el)
    const id = el.getAttribute('data-dia-id')
    if (id) doc.project.bind(id, block.path, block.span)
    const note = unresolved.get(child)
    if (note) stillUnresolved.push({ ...note, el })
  }
  doc.article.replaceChildren(...children)
  markUnresolved(stillUnresolved)
  refreshDerived(doc.article)
}

function stampIds(rootEl: HTMLElement): void {
  for (const el of [rootEl, ...rootEl.querySelectorAll<HTMLElement>('*')]) {
    if (!el.hasAttribute('data-dia-id')) el.setAttribute('data-dia-id', freshId('d'))
  }
}
