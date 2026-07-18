/* Declared slides: sources that KNOW their slide boundaries say so with
 * data-dia-source-slide, and no heuristic second-guesses them. Our own
 * pptx front-end emits it; any exporter can. This is the same doctrine
 * as the service's same-origin marker — topology is declared by whoever
 * knows it, never inferred (a generated page's large positioned children
 * can outnumber its sections and win the sibling-group heuristic). */

import type { SlideExtractor } from './index'

export const declared: SlideExtractor = {
  name: 'declared',
  detect(doc) {
    const roots = [...doc.querySelectorAll<HTMLElement>('[data-dia-source-slide]')]
    return roots.length > 0 ? roots : null
  },
}
