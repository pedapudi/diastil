/* Copilot proposal PREVIEW — the proposed ops run on the live document the
 * moment the card arrives, labeled and reversible, so the decision is made
 * by LOOKING at the slide instead of reading op labels.
 *
 * The preview lives OUTSIDE the op log: apply() runs the compiled ops
 * directly (no history entry, no bus event); reverting runs their inverts
 * in reverse. Accepting reverts first, then commits through state.apply as
 * one batch — exactly the artifact the old flow produced. Anything that
 * changes the document out from under the preview (a manual edit, undo,
 * redo, a deck load, a newer proposal) clears it immediately: a preview
 * must never be able to corrupt real state, and a save must never
 * serialize one (slides.ts clears before serializing). */

import type { Op } from '../types'
import { state } from '../state'
import { pruneMirrors } from '../doc/blockmirror'

let current: {
  ops: Op[]
  badge: HTMLElement | null
  onCleared: (reason: string) => void
} | null = null
let watching = false

function ensureWatcher(): void {
  if (watching) return
  watching = true
  state.bus.on((e) => {
    if (e.type === 'op' || e.type === 'undo' || e.type === 'redo'
      || e.type === 'deck-loaded' || e.type === 'doc-loaded') {
      clearPreview('the document changed')
    }
  })
}

/** apply ops as a labeled preview on the live document (replaces any
 * active preview). region: the slide (deck) or top-level block (document)
 * the badge frames, when known. */
export function startPreview(ops: Op[], region: HTMLElement | null, onCleared: (reason: string) => void): void {
  clearPreview('replaced by a newer proposal')
  ensureWatcher()
  for (const op of ops) op.apply()
  // a preview runs OUTSIDE the op log, so no bus event tells the compiled
  // mirror its crops now disagree with the document — say so directly
  pruneMirrors()
  current = { ops, badge: region ? mountBadge(region) : null, onCleared }
}

/** is THIS compiled set the one currently previewing? */
export function previewIsActive(ops: Op[]): boolean {
  return current !== null && current.ops === ops
}

/** revert the active preview (no-op when none). notify=false is for the
 * owning card's own apply/reject — it already knows. */
export function clearPreview(reason: string, notify = true): void {
  if (!current) return
  const { ops, badge, onCleared } = current
  current = null // cleared FIRST: the accept path re-enters via the bus watcher
  badge?.remove()
  for (const op of [...ops].reverse()) op.invert().apply()
  pruneMirrors() // reverting is a document change too, and just as silent
  if (notify) onCleared(reason)
}

/** dashed frame + corner chip over the previewed slide — an editor
 * artifact, stripped from every save */
function mountBadge(region: HTMLElement): HTMLElement {
  const badge = region.ownerDocument.createElement('div')
  badge.className = 'dia-editor-artifact dia-preview-badge'
  // a document block is prose and cannot host the inset frame; a slide can
  if (state.doc && region.parentElement === state.doc.article) return mountDocBadge(region, badge)
  region.appendChild(badge)
  return badge
}

/** A document block is prose: it cannot host an inset overlay (positioning
 * it would mean writing to the block's style attribute, which breaks the
 * byte-exact emit seal). The badge is measured and mounted BESIDE the
 * article, inside the shadow root — never a child of article, so nothing
 * that walks blocks or serializes the document ever sees it. */
function mountDocBadge(block: HTMLElement, badge: HTMLElement): HTMLElement {
  const root = block.getRootNode()
  const host = root instanceof ShadowRoot ? (root.host as HTMLElement) : block.parentElement
  const mount: ParentNode = root instanceof ShadowRoot ? root : (block.parentElement ?? block)
  const b = block.getBoundingClientRect()
  const h = host?.getBoundingClientRect()
  const top = h ? b.top - h.top : 0
  const left = h ? b.left - h.left : 0
  badge.style.cssText =
    `position:absolute;z-index:44;pointer-events:none;`
    + `top:${top - 6}px;left:${left - 10}px;width:${b.width + 20}px;height:${b.height + 12}px;`
    + `border:2.5px dashed var(--dia-accent, #b4552d);border-radius:3px;`
  mount.appendChild(badge)
  return badge
}
