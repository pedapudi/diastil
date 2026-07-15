/* Right-click context menu: the verbs that fit what's under the pointer.
 * Everything here routes through EXISTING actions (ops, studio, textedit,
 * compare) — the menu is a faster path, never a second implementation.
 * Chrome-token styling; clamped inside the viewport; Esc / click-away /
 * scroll dismisses. */

import { state } from '../state'
import { insertEl, removeEl } from '../model/ops'
import { canStudio, openStudio } from '../studio/studio'
import { newDrawingOnSlide } from '../studio/svgimport'
import { insertMathOnSlide } from './math'
import { insertTextOnSlide, startEdit } from './textedit'
import { openCompare } from './compare'
import { assignFreshIds } from './slides'
import { deleteSceneSelection, insertShapeNode } from '../scene/interact'
import { openMenu, SEP, type Entry } from './menu'
import { openStoryboard } from './storyboard'
import { openSlideFocus } from '../studio/focus'

export function installContextMenu(host: HTMLElement): void {
  host.addEventListener('contextmenu', (e) => {
    const target = e.composedPath()[0]
    if (!(target instanceof Element)) return
    const slide = target.closest<HTMLElement>('section.dia-slide')
    if (!slide) return // outside a slide the native menu stays
    e.preventDefault()
    openMenu(e.clientX, e.clientY, entriesFor(target, slide))
  })
}

function entriesFor(target: Element, slide: HTMLElement): Entry[] {
  const items: Entry[] = []
  const deck = state.deck

  // ---- what was clicked ----
  const math = target.closest<HTMLElement>('.dia-math')
  const svg = target.closest('svg') as SVGSVGElement | null
  const island = target.closest<HTMLElement>('[data-dia-island]')
  const block = !math && !svg && target instanceof HTMLElement && target !== slide
    ? target.closest<HTMLElement>('p, li, h1, h2, h3, blockquote, figcaption, .dia-title, .dia-kicker, .dia-caption, .dia-footnote')
    : null

  if (math) {
    items.push(
      { label: 'edit latex', run: () => startEdit(math) },
      { label: 'delete formula', run: () => remove(math), danger: true },
      SEP,
    )
  } else if (svg && !island) {
    if (canStudio(svg)) items.push({ label: 'open in studio', run: () => openStudio(svg) })
    if (svg.classList.contains('dia-scene')) {
      items.push({ label: 'insert node', run: () => insertShapeNode(svg, 'node') })
      const sel = state.selection
      if (sel.kind === 'scene-node' || sel.kind === 'scene-edge' || sel.kind === 'scene-free') {
        items.push({ label: 'delete scene selection', run: () => deleteSceneSelection(), danger: true })
      }
    } else {
      items.push({ label: 'delete drawing', run: () => remove(svg), danger: true })
    }
    items.push(SEP)
  } else if (island) {
    items.push({ label: 'delete island', run: () => remove(island), danger: true }, SEP)
  } else if (block && slide.contains(block)) {
    items.push(
      { label: 'edit text', run: () => startEdit(block) },
      { label: 'delete element', run: () => remove(block), danger: true },
      SEP,
    )
  }

  // ---- the slide itself ----
  items.push(
    { label: '+ text', run: () => insertTextOnSlide(slide) },
    { label: '+ math', run: () => { const el = insertMathOnSlide(slide); if (el) state.selection = { kind: 'element', el, slide } } },
    { label: '+ drawing', run: () => newDrawingOnSlide(slide) },
    SEP,
    { label: 'focus slide…', run: () => openSlideFocus(slide) },
    { label: 'storyboard…', run: () => openStoryboard(slide) },
    { label: 'duplicate slide', run: () => duplicateSlide(slide) },
  )
  if (deck && slide.querySelector(':scope')) {
    const idx = state.slides().indexOf(slide)
    if (deck.headExtras.includes('dia-originals')) {
      items.push({ label: 'compare with original', run: () => openCompare(deck, Math.max(0, idx)) })
    }
  }
  if (state.slides().length > 1) {
    items.push({ label: 'delete slide', run: () => remove(slide), danger: true })
  }
  return items
}

function remove(el: Element): void {
  state.apply(removeEl(el))
  state.selection = { kind: 'none' }
}

function duplicateSlide(slide: HTMLElement): void {
  const deck = state.deck
  if (!deck) return
  const clone = slide.cloneNode(true) as HTMLElement
  for (const n of [clone, ...clone.querySelectorAll<HTMLElement>('*')]) {
    n.removeAttribute('data-dia-selected')
    n.removeAttribute('data-dia-current')
    n.removeAttribute('contenteditable')
  }
  assignFreshIds(clone)
  const idx = [...(slide.parentNode?.children ?? [])].indexOf(slide)
  state.apply(insertEl(slide.parentNode as Element, idx + 1, clone, 'Duplicate slide'))
}
