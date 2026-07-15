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
    if (e.type === 'op' || e.type === 'undo' || e.type === 'redo' || e.type === 'deck-loaded') {
      clearPreview('the document changed')
    }
  })
}

/** apply ops as a labeled preview on the live document (replaces any
 * active preview). slide: where the badge mounts, when known. */
export function startPreview(ops: Op[], slide: HTMLElement | null, onCleared: (reason: string) => void): void {
  clearPreview('replaced by a newer proposal')
  ensureWatcher()
  for (const op of ops) op.apply()
  current = { ops, badge: slide ? mountBadge(slide) : null, onCleared }
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
  if (notify) onCleared(reason)
}

/** dashed frame + corner chip over the previewed slide — an editor
 * artifact, stripped from every save */
function mountBadge(slide: HTMLElement): HTMLElement {
  const badge = slide.ownerDocument.createElement('div')
  badge.className = 'dia-editor-artifact dia-preview-badge'
  slide.appendChild(badge)
  return badge
}
