/* Marp / Marpit: emitted decks wrap each slide <section> in the .marpit
 * container (sometimes inside per-slide svg foreignObject scaffolding);
 * bespoke exports keep marpit data attributes on the sections. */

import type { SlideExtractor } from './index'

export const marp: SlideExtractor = {
  name: 'marp',
  detect(doc) {
    const sections = [
      ...doc.querySelectorAll<HTMLElement>('.marpit section, section[data-marpit-fragment], section[data-marpit-svg]'),
    ]
    // nested fragments can match twice — keep outermost sections only
    const roots = sections.filter((s) => !sections.some((o) => o !== s && o.contains(s)))
    return roots.length > 0 ? roots : null
  },
}
