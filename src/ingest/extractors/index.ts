/* Extractor plugin surface (plan §3): per-framework slide detection is the
 * highest-ROI ingest code — agent tools converge on a handful of deck
 * shapes, and each shape is a small deterministic module here.
 *
 * Extractors are tried in registry order: specific framework markers first,
 * the generic layout heuristic last, whole-body as the final fallback.
 * Adding a new deck shape = one file + one registry entry. */

import { declared } from './declared'
import { reveal } from './reveal'
import { impress } from './impress'
import { marp } from './marp'
import { remark } from './remark'
import { siblings } from './siblings'

export interface SlideExtractor {
  /** short id; lands in Extraction.method and import reports */
  name: string
  /** slide roots in presentation order when this extractor recognizes the
   * executed document, null when it does not apply */
  detect(doc: Document): HTMLElement[] | null
}

export const EXTRACTORS: SlideExtractor[] = [declared, reveal, impress, marp, remark, siblings]

export function findSlideRoots(doc: Document): { roots: HTMLElement[]; method: string } {
  for (const ex of EXTRACTORS) {
    const roots = ex.detect(doc)
    if (roots && roots.length > 0) return { roots, method: ex.name }
  }
  return { roots: [doc.body], method: 'body' }
}
