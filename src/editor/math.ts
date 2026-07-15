/* Math: LaTeX in, MathML in the document. Authoring-time rendering via
 * temml keeps the DOCUMENT dependency-free — the deck carries only native
 * MathML, which every modern browser typesets without a runtime. The TeX
 * source persists as data-dia-tex on the element, so math stays editable
 * as text forever; re-rendering is one op (source + markup together). */

import temml from 'temml'
import { state } from '../state'
import { batch, insertEl, setAttr, setInlineHtml } from '../model/ops'

/** render TeX to MathML markup; null (with the reason) when it won't parse */
export function renderTex(tex: string): { mathml: string } | { error: string } {
  try {
    // throwOnError: a formula that will not parse must surface in the UI,
    // never land in the document as a rendered error glyph
    return { mathml: temml.renderToString(tex, { displayMode: true, throwOnError: true }) }
  } catch (err) {
    return { error: err instanceof Error ? err.message.replace(/^Temml[^:]*:\s*/, '') : String(err) }
  }
}

/** the math element a selection belongs to, if any */
export function mathOf(el: HTMLElement): HTMLElement | null {
  return el.closest<HTMLElement>('.dia-math')
}

/** one op: TeX source and rendered MathML move together */
export function applyTex(el: HTMLElement, tex: string): boolean {
  const r = renderTex(tex)
  if ('error' in r) return false
  state.apply(batch('Edit math', [
    setAttr(el, 'data-dia-tex', tex),
    setInlineHtml(el, r.mathml),
  ]))
  return true
}

const STARTER_TEX = 'f(x) = \\int_{-\\infty}^{\\infty} \\hat f(\\xi)\\, e^{2\\pi i \\xi x}\\, d\\xi'

/** insert a display-math block on a slide (before the footer, like figures) */
export function insertMathOnSlide(slide: HTMLElement): HTMLElement | null {
  const r = renderTex(STARTER_TEX)
  if ('error' in r) return null
  const el = document.createElement('div')
  el.className = 'dia-math'
  el.setAttribute('data-dia-tex', STARTER_TEX)
  el.innerHTML = r.mathml
  const foot = slide.querySelector(':scope > .dia-caption.foot')
  const index = foot ? [...slide.children].indexOf(foot) : slide.children.length
  state.apply(insertEl(slide, index, el, 'Insert math'))
  return el
}
