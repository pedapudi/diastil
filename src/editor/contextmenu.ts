/* Right-click context menu: the verbs that fit what's under the pointer
 * AND where you are. Three environments share one builder — the deck
 * table, a slide in the studio, and an isolated drawing — and each shows
 * only the verbs that make sense there (no 'delete slide' under a focused
 * slide, no deck chrome over an isolated drawing). Everything routes
 * through EXISTING actions (ops, studio, textedit, compare) — the menu is
 * a faster path, never a second implementation. */

import { state } from '../state'
import { insertEl, removeEl } from '../model/ops'
import { canStudio, isSceneArt, openStudio, studioSession, type StudioSession } from '../studio/studio'
import { newDrawingOnSlide } from '../studio/svgimport'
import {
  deletePicked, duplicatePicked, enterGroup, groupPicked, hitOf, isNodeEl,
  isPlainGroup, pick, refreshAll, reorderPicked, ungroupPicked,
} from '../studio/tools'
import { insertTextOnSlide, startEdit } from './textedit'
import { openCompare } from './compare'
import { assignFreshIds } from './slides'
import {
  deleteSceneSelection, insertShapeNode,
  openEdgeLabelEdit, openLabelEdit, openSvgTextEdit,
} from '../scene/interact'
import { canPointEdit, openPointEditor } from '../scene/points'
import { openMenu, SEP, type Entry } from './menu'
import { openStoryboard } from './storyboard'
import { closeSlideFocus, exitFocusIsolation, focusedSlide, isolatedDrawing, openSlideFocus } from '../studio/focus'

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

/** environment × target: the deck table, a slide in the studio, or the
 * studio's bound drawing surface each get their own verb set */
function entriesFor(target: Element, slide: HTMLElement): Entry[] {
  if (focusedSlide() === slide) {
    const s = studioSession()
    if (s && s.svg.contains(target)) return drawingEntries(target, s)
    return focusEntries(target, slide)
  }
  return deckEntries(target, slide)
}

/* ---------- verbs for the thing under the pointer (shared) ---------- */

function targetEntries(target: Element, slide: HTMLElement, svgVerb: string): Entry[] {
  const items: Entry[] = []
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
    if (canStudio(svg)) items.push({ label: svgVerb, run: () => openStudio(svg) })
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
  return items
}

/* ---------- environment: the deck table ---------- */

function deckEntries(target: Element, slide: HTMLElement): Entry[] {
  const items = targetEntries(target, slide, 'open drawing in studio')
  const deck = state.deck

  items.push(
    { label: '+ text', run: () => insertTextOnSlide(slide) },
    { label: '+ drawing', run: () => newDrawingOnSlide(slide) },
    SEP,
    { label: 'open slide in studio', run: () => openSlideFocus(slide) },
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

/* ---------- environment: a slide in the studio ---------- */

function focusEntries(target: Element, slide: HTMLElement): Entry[] {
  const items: Entry[] = []
  // over a dimmed slide (a drawing is isolated) only navigation applies
  if (!isolatedDrawing()) {
    items.push(...targetEntries(target, slide, 'step into drawing'))
    items.push(
      { label: '+ text', run: () => insertTextOnSlide(slide) },
      { label: '+ drawing', run: () => newDrawingOnSlide(slide) },
      SEP,
    )
  }
  items.push(...navEntries())
  return items
}

/* ---------- environment: the studio's bound drawing surface ---------- */

function drawingEntries(target: Element, s: StudioSession): Entry[] {
  const items: Entry[] = []
  // right-click acts on the element under the pointer — it joins the
  // selection first, exactly like a left click would
  const hit = hitOf(target)
  if (hit && !s.picked.has(hit)) pick(hit, false)
  const picked = [...s.picked]
  const solo = picked.length === 1 ? picked[0] : null

  // words, wherever they live
  const edgeEl = target.closest('[data-dia-edge]')
  if (edgeEl instanceof SVGGElement && isSceneArt(s.svg)) {
    items.push({ label: 'edit label', run: () => openEdgeLabelEdit(s.svg, edgeEl) })
  } else if (solo && isNodeEl(solo) && isSceneArt(s.svg)) {
    items.push({ label: 'edit label', run: () => openLabelEdit(s.svg, solo) })
  } else if (solo instanceof SVGTextElement) {
    items.push({
      label: 'edit words',
      run: () => openSvgTextEdit(s.svg, solo, () => {
        if (!solo.isConnected) s.picked.delete(solo)
        refreshAll()
      }),
    })
  }
  if (solo instanceof SVGPathElement && canPointEdit(solo)) {
    items.push({ label: 'edit points', run: () => openPointEditor({ kind: 'free', scene: s.svg, el: solo }) })
  }

  if (picked.length > 0) {
    items.push(
      { label: picked.length > 1 ? `duplicate ${picked.length} elements` : 'duplicate', run: () => duplicatePicked() },
    )
    if (picked.length >= 2 && !picked.some(isNodeEl)) {
      items.push({ label: 'group', run: () => groupPicked() })
    }
    if (solo && isPlainGroup(solo)) {
      items.push(
        { label: 'enter group', run: () => enterGroup(solo) },
        { label: 'ungroup', run: () => ungroupPicked() },
      )
    }
    items.push(
      { label: 'bring to front', run: () => reorderPicked(true) },
      { label: 'send to back', run: () => reorderPicked(false) },
      SEP,
      { label: picked.length > 1 ? `delete ${picked.length} elements` : 'delete', run: () => deletePicked(), danger: true },
      SEP,
    )
  }
  items.push(...navEntries())
  return items
}

/** the way back up the ladder — mirrors the header crumbs and esc */
function navEntries(): Entry[] {
  const items: Entry[] = []
  if (isolatedDrawing()) items.push({ label: 'back to slide', run: () => exitFocusIsolation() })
  items.push({ label: 'back to deck', run: () => closeSlideFocus() })
  return items
}

/* ---------- shared ---------- */

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
