/* reveal.js: .reveal > .slides > section, where a section wrapping further
 * sections is a vertical stack — flattened into linear order, matching how
 * the deck reads when presented. */

import type { SlideExtractor } from './index'

export const reveal: SlideExtractor = {
  name: 'reveal',
  detect(doc) {
    // elements live in the iframe's realm — tagName checks, never instanceof
    const tops = [...doc.querySelectorAll<HTMLElement>('.reveal .slides > section')]
    if (tops.length === 0) return null
    const flat: HTMLElement[] = []
    for (const s of tops) {
      const vertical = [...s.children].filter((c) => c.tagName === 'SECTION') as HTMLElement[]
      if (vertical.length > 0) flat.push(...vertical)
      else flat.push(s)
    }
    return flat
  },
}
