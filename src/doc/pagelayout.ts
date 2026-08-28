/* Immutable page-space geometry shared by the compiled document surfaces. */

import type { PageDims } from './pdfpages'

export interface PageRect {
  page: number
  xMin: number
  xMax: number
  yMin: number
  yMax: number
  whole?: true
  blockId: string
}

export interface DocumentLayout {
  jobId: string
  pages: PageDims[]
  byBlock: Map<string, PageRect[]>
  /** the source this compile was of, so a surface drawing the engine's page
   * breaks can tell whether the document has moved on since — the snapshot
   * doc/auxnumbers.ts keeps for the same reason */
  source?: string
}

let current: DocumentLayout | null = null

export function setDocumentLayout(layout: DocumentLayout): void {
  current = layout
  window.dispatchEvent(new CustomEvent('dia-document-layout', { detail: layout }))
}

export function documentLayout(): DocumentLayout | null { return current }

export function clearDocumentLayout(): void {
  current = null
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('dia-document-layout', { detail: null }))
  }
}

export function rectsForBlock(block: HTMLElement): PageRect[] {
  const id = block.getAttribute('data-dia-id')
  return id ? current?.byBlock.get(id) ?? [] : []
}

