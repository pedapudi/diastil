/* impress.js: steps under #impress (positioned in 3d space; document order
 * is presentation order). The camera/canvas chrome is stripped later by
 * convert's CHROME_SEL. */

import type { SlideExtractor } from './index'

export const impress: SlideExtractor = {
  name: 'impress',
  detect(doc) {
    const steps = [...doc.querySelectorAll<HTMLElement>('#impress .step')]
    return steps.length > 0 ? steps : null
  },
}
