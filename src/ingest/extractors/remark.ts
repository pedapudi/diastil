/* remark: runtime-built .remark-slide-container elements (one per slide,
 * only the current one visible). The inner .remark-slide-content carries
 * the authored content; scaler/notes chrome is stripped by convert. */

import type { SlideExtractor } from './index'

export const remark: SlideExtractor = {
  name: 'remark',
  detect(doc) {
    const content = [...doc.querySelectorAll<HTMLElement>('.remark-slide-container .remark-slide-content')]
    if (content.length > 0) return content
    const slides = [...doc.querySelectorAll<HTMLElement>('.remark-slide')]
    return slides.length > 0 ? slides : null
  },
}
