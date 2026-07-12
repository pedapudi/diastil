/* Minimap: persistent left filmstrip. One thumbnail per
 * slide, cloned into its own tiny shadow root (deck styles copied in, so
 * the clone renders correctly outside the deck's shadow root) and scaled
 * down with transform. Click = navigate (never changes altitude), drag =
 * reorder, "+ slide" inserts a template slide after the current one. */

import { state } from '../state'
import { batch, insertEl, removeEl } from '../model/ops'
import { isPinnedSlide, onContextChange, togglePinnedSlide } from '../copilot/rail'
import { scrollToSlide } from './table'
import { assignFreshIds, makeTemplateSlide } from './slides'

const THUMB_W = 108
const BASE_W = 980

let listEl!: HTMLElement
let ctxRow!: HTMLElement
let items: HTMLElement[] = []
let dragFrom = -1

export function mountMinimap(host: HTMLElement): void {
  listEl = document.createElement('div')
  listEl.className = 'de-mm-list'

  ctxRow = document.createElement('div')
  ctxRow.className = 'de-mm-ctx'
  ctxRow.append(
    ctxButton('⧉', 'duplicate slide', duplicateCurrent),
    ctxButton('⌫', 'delete slide', deleteCurrent),
  )

  const addBtn = document.createElement('button')
  addBtn.className = 'de-mm-add'
  addBtn.type = 'button'
  addBtn.textContent = '+ slide'
  addBtn.addEventListener('click', addSlide)

  host.append(listEl, addBtn)

  const debounced = debounce(rebuild, 300)
  state.bus.on((e) => {
    if (e.type === 'deck-loaded') rebuild()
    else if (e.type === 'op' || e.type === 'undo' || e.type === 'redo' || e.type === 'slides-changed') debounced()
    else if (e.type === 'current-slide') highlight()
  })
  onContextChange(rebuild) // pin markers live on the thumbnails
}

function ctxButton(glyph: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = glyph
  b.title = label
  b.setAttribute('aria-label', label)
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick() })
  return b
}

/* ---------- thumbnails ---------- */

function rebuild(): void {
  const deck = state.deck
  items = []
  listEl.replaceChildren()
  if (!deck) return
  const styleText = deckStyleText()
  state.slides().forEach((slide, i) => {
    const item = document.createElement('div')
    item.className = 'de-mm-item'
    item.draggable = true

    const shot = document.createElement('div')
    shot.className = 'de-mm-shot'
    const shotHost = document.createElement('div')
    shot.append(shotHost)
    const sh = shotHost.attachShadow({ mode: 'open' })
    const st = document.createElement('style')
    st.textContent = `${styleText}
:host { display: block; }
.de-mm-wrap { width: ${BASE_W}px; transform: scale(${THUMB_W / BASE_W}); transform-origin: 0 0; pointer-events: none; }
section.dia-slide { margin: 0 !important; box-shadow: none !important; }`
    const wrap = document.createElement('div')
    wrap.className = 'de-mm-wrap'
    const clone = slide.cloneNode(true) as HTMLElement
    for (const n of [clone, ...clone.querySelectorAll<HTMLElement>('*')]) {
      n.removeAttribute('data-dia-selected')
      n.removeAttribute('data-dia-current')
      n.removeAttribute('contenteditable')
    }
    wrap.append(clone)
    sh.append(st, wrap)

    const num = document.createElement('div')
    num.className = 'de-mm-num'
    num.textContent = String(i + 1)

    item.append(shot, num)
    if (isPinnedSlide(i)) {
      const pin = document.createElement('div')
      pin.className = 'de-mm-pin'
      pin.textContent = '◆'
      pin.title = 'pinned into copilot context'
      item.append(pin)
    }
    item.addEventListener('click', (e) => {
      // ⌥/⇧-click pins/unpins the slide into the copilot's context
      // (shift too: many Linux window managers grab Alt+click for themselves)
      if (e.altKey || e.shiftKey) togglePinnedSlide(i)
      else navigate(i)
    })
    item.addEventListener('dragstart', (e) => {
      dragFrom = i
      e.dataTransfer?.setData('text/plain', String(i))
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
    })
    item.addEventListener('dragover', (e) => {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      item.classList.add('de-drop-target')
    })
    item.addEventListener('dragleave', () => item.classList.remove('de-drop-target'))
    item.addEventListener('drop', (e) => {
      e.preventDefault()
      item.classList.remove('de-drop-target')
      moveSlide(dragFrom, i)
      dragFrom = -1
    })
    item.addEventListener('dragend', () => {
      dragFrom = -1
      for (const it of items) it.classList.remove('de-drop-target')
    })

    listEl.append(item)
    items.push(item)
  })
  highlight()
}

/** deck styles minus editor artifacts, for the thumb's own shadow root
 * (they are :host-scoped, which resolves to the thumb host) */
function deckStyleText(): string {
  const deck = state.deck
  if (!deck) return ''
  return [...deck.root.querySelectorAll('style')]
    .filter((s) => !s.classList.contains('dia-editor-artifact'))
    .map((s) => s.textContent ?? '')
    .join('\n')
}

function highlight(): void {
  const cur = state.currentSlide
  items.forEach((it, i) => it.classList.toggle('de-on', i === cur))
  const curItem = items[cur]
  if (curItem) curItem.append(ctxRow)
  else ctxRow.remove()
}

function navigate(i: number): void {
  state.setCurrentSlide(i)
  scrollToSlide(i, 'smooth')
  highlight() // in case index was already current elsewhere
}

/* ---------- structure ops ---------- */

/** child index inside the shadow root corresponding to slide position
 * `pos`, counted against `children` (which may exclude a dragged slide) */
function childIndexForSlidePos(children: Element[], pos: number): number {
  const slides = children.filter((c) => c instanceof HTMLElement && c.matches('section.dia-slide'))
  if (pos < slides.length) return children.indexOf(slides[pos])
  return children.length
}

/** Reorder via remove+insert in one undo step. (moveEl reads
 * el.parentElement at construction, which is null for direct children of
 * the deck's shadow root, so it cannot express a slide move.) */
function moveSlide(from: number, to: number): void {
  const deck = state.deck
  if (!deck || from < 0 || to === from) return
  const slide = state.slides()[from]
  if (!slide) return
  const rootEl = deck.root as unknown as Element
  const remaining = [...deck.root.children].filter((c) => c !== slide)
  const idx = childIndexForSlidePos(remaining, to)
  state.apply(batch('Move slide', [
    removeEl(slide, 'Move slide'),
    insertEl(rootEl, idx, slide, 'Move slide'),
  ]))
  state.bus.emit({ type: 'slides-changed' })
  state.setCurrentSlide(to)
  scrollToSlide(to, 'auto')
}

function addSlide(): void {
  const deck = state.deck
  if (!deck) return
  const pos = state.currentSlide + 1
  const idx = childIndexForSlidePos([...deck.root.children], pos)
  state.apply(insertEl(deck.root as unknown as Element, idx, makeTemplateSlide(), 'Insert slide'))
  state.bus.emit({ type: 'slides-changed' })
  state.setCurrentSlide(pos)
  scrollToSlide(pos, 'smooth')
}

function duplicateCurrent(): void {
  const deck = state.deck
  if (!deck) return
  const i = state.currentSlide
  const slide = state.slides()[i]
  if (!slide) return
  const clone = slide.cloneNode(true) as HTMLElement
  for (const n of [clone, ...clone.querySelectorAll<HTMLElement>('*')]) {
    n.removeAttribute('data-dia-selected')
    n.removeAttribute('data-dia-current')
    n.removeAttribute('contenteditable')
  }
  assignFreshIds(clone)
  const idx = childIndexForSlidePos([...deck.root.children], i + 1)
  state.apply(insertEl(deck.root as unknown as Element, idx, clone, 'Duplicate slide'))
  state.bus.emit({ type: 'slides-changed' })
  state.setCurrentSlide(i + 1)
  if (state.altitude === 'table') scrollToSlide(i + 1, 'smooth')
}

function deleteCurrent(): void {
  const deck = state.deck
  if (!deck) return
  const slides = state.slides()
  if (slides.length <= 1) return // keep at least one slide
  const i = state.currentSlide
  const slide = slides[i]
  state.apply(removeEl(slide, 'Delete slide'))
  state.bus.emit({ type: 'slides-changed' })
  state.setCurrentSlide(Math.min(i, slides.length - 2))
}

/* ---------- utils ---------- */

function debounce(fn: () => void, ms: number): () => void {
  let t = 0
  return () => {
    clearTimeout(t)
    t = window.setTimeout(fn, ms)
  }
}
