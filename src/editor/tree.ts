/* Slide structure tree for the inspect pane: the current slide's meaningful
 * elements (roles, containers, media, scenes with their nodes/edges/free
 * art, islands) as an indented, clickable outline. Clicking a row selects
 * that element on the slide itself (the canvas overlay + toolbars follow
 * through the normal selection event); the row of the current selection is
 * highlighted, so the tree reads both ways.
 *
 * While a studio session is bound, the bound drawing's rows ARE its layers
 * panel: they mirror the studio's picked set, click to pick, and carry the
 * layer verbs (hide, duplicate, delete, drag to restack) — one hierarchy,
 * one place, instead of a second list on the far side of the screen. */

import type { Selection, SlideEl } from '../types'
import { state } from '../state'
import { moveEl, removeEl, setStyleProp } from '../model/ops'
import { studioSession, type StudioSession } from '../studio/studio'
import { clearPicked, duplicateOne, pick as studioPick, refreshAll as studioRefresh } from '../studio/tools'

/** rows are capped so a pathological import can't freeze the rail */
const MAX_ROWS = 200
const SNIPPET_LEN = 26

const CONTAINER_CLASSES = ['dia-stack', 'dia-columns', 'dia-split', 'dia-cover', 'dia-figure']
const BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'UL', 'OL',
  'TABLE', 'DL', 'IMG', 'FIGURE', 'VIDEO',
])

export function buildSlideTree(slide: SlideEl): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'de-tree'
  const head = document.createElement('div')
  head.className = 'dn-subhead'
  head.textContent = 'structure'
  wrap.appendChild(head)
  const list = document.createElement('div')
  list.className = 'de-tree-list'
  wrap.appendChild(list)

  const counter = { rows: 0 }
  addRow(list, slide, 0, 'slide', snippet(slide), { kind: 'slide', slide }, counter, 'slide')
  for (const child of slide.children) walk(list, child, slide, 1, counter)
  if (counter.rows >= MAX_ROWS) {
    const more = document.createElement('div')
    more.className = 'de-hint'
    more.textContent = '… structure truncated'
    list.appendChild(more)
  }
  return wrap
}

function walk(list: HTMLElement, el: Element, slide: SlideEl, depth: number, counter: { rows: number }): void {
  if (counter.rows >= MAX_ROWS) return
  if (el instanceof HTMLStyleElement || el.tagName === 'SCRIPT') return

  // islands are opaque: one row, no descent
  if (el.hasAttribute('data-dia-island')) {
    addRow(list, el, depth, 'island', snippet(el), sel(el, slide), counter, 'island')
    return
  }
  // the studio's bound drawing: its rows are the layers panel
  const s = studioSession()
  if (el instanceof SVGSVGElement && s && (s.svg as unknown as Element) === el) {
    walkStudioSvg(list, s, depth, counter)
    return
  }
  // scenes show their object structure
  if (el instanceof SVGSVGElement) {
    const isScene = el.classList.contains('dia-scene')
    addRow(list, el, depth, isScene ? 'scene' : 'svg', '', { kind: 'element', el: el as unknown as HTMLElement, slide }, counter, isScene ? 'scene' : 'media')
    if (isScene) {
      for (const child of el.children) {
        if (counter.rows >= MAX_ROWS) return
        if (/^(defs|style|title|desc|metadata)$/.test(child.tagName)) continue
        if (child.hasAttribute('data-dia-node')) {
          const label = child.querySelector('.dia-node-label')?.textContent?.trim()
          addRow(list, child, depth + 1, `node ${child.getAttribute('data-dia-node')}`, label ?? '',
            { kind: 'scene-node', node: child as SVGGElement, scene: el, slide }, counter, 'node')
        } else if (child.hasAttribute('data-dia-edge')) {
          addRow(list, child, depth + 1, `edge ${child.getAttribute('data-dia-edge')}`, '',
            { kind: 'scene-edge', edge: child as SVGGElement, scene: el, slide }, counter, 'edge')
        } else {
          addRow(list, child, depth + 1, `<${child.tagName.toLowerCase()}>`, snippet(child),
            { kind: 'scene-free', el: child as SVGGraphicsElement, scene: el, slide }, counter, 'free')
        }
      }
    }
    return
  }
  if (!(el instanceof HTMLElement)) return

  const role = [...el.classList].find((c) => c.startsWith('dia-'))
  const isContainer = CONTAINER_CLASSES.some((c) => el.classList.contains(c))
  const meaningful = role !== undefined || BLOCK_TAGS.has(el.tagName)

  if (meaningful) {
    const kind =
      isContainer ? 'container' :
      /^(IMG|FIGURE|VIDEO)$/.test(el.tagName) || el.classList.contains('dia-figure') ? 'media' :
      role !== undefined ? 'text' : 'block'
    addRow(list, el, depth, role ?? el.tagName.toLowerCase(), snippet(el), sel(el, slide), counter, kind)
  }
  // descend into containers and unlabeled wrappers; leaves stay leaves
  if (isContainer || !meaningful) {
    for (const child of el.children) walk(list, child, slide, depth + (meaningful ? 1 : 0), counter)
  }
}

function sel(el: Element, slide: SlideEl): Selection {
  return { kind: 'element', el: el as HTMLElement, slide }
}

/* ---------- the bound studio drawing: these rows ARE its layers ---------- */

const ARTIFACT = 'dia-editor-artifact'

function walkStudioSvg(list: HTMLElement, s: StudioSession, depth: number, counter: { rows: number }): void {
  if (counter.rows >= MAX_ROWS) return
  counter.rows++
  // the surface itself: clicking it releases the studio selection
  const head = document.createElement('div')
  head.className = 'de-tree-row de-tree-studio'
  head.dataset.kind = 'scene'
  head.style.setProperty('--tree-depth', String(depth))
  head.append(glyphEl('scene'), nameEl('drawing'), hintEl('in studio — click picks · drag restacks'))
  head.addEventListener('click', () => clearPicked())
  list.appendChild(head)

  for (const child of s.svg.children) {
    if (counter.rows >= MAX_ROWS) return
    if (/^(defs|style|title|desc|metadata)$/i.test(child.tagName)) continue
    if (child.classList.contains(ARTIFACT)) continue
    if (!(child instanceof SVGGraphicsElement)) continue
    if (child.hasAttribute('data-dia-node')) {
      const label = child.querySelector('.dia-node-label')?.textContent?.trim() ?? ''
      studioRow(list, s, child, depth + 1, `node ${child.getAttribute('data-dia-node')}`, label, counter, 'node', true)
    } else if (child.hasAttribute('data-dia-edge')) {
      // edges are derived — they follow their nodes: hide/delete, never pick
      studioRow(list, s, child, depth + 1, `edge ${child.getAttribute('data-dia-edge')}`, 'derived', counter, 'edge', false)
    } else {
      studioRow(list, s, child, depth + 1, `<${child.tagName.toLowerCase()}>`, snippet(child), counter, 'free', true)
    }
  }
}

function studioRow(
  list: HTMLElement, s: StudioSession, el: SVGGraphicsElement, depth: number,
  label: string, hint: string, counter: { rows: number }, kind: string, pickable: boolean,
): void {
  if (counter.rows >= MAX_ROWS) return
  counter.rows++
  const row = document.createElement('div')
  row.className = 'de-tree-row de-tree-studio'
  row.dataset.kind = kind
  row.style.setProperty('--tree-depth', String(depth))
  if (s.picked.has(el)) row.classList.add('de-on')
  if (isLayerHidden(el)) row.classList.add('is-hidden')
  if (!pickable) row.style.cursor = 'default'
  row.append(glyphEl(kind), nameEl(label))
  if (hint) row.append(hintEl(hint))

  const acts = document.createElement('span')
  acts.className = 'de-tree-acts'
  const eye = act(isLayerHidden(el) ? '◌' : '●', isLayerHidden(el) ? 'show' : 'hide', () => {
    state.apply(setStyleProp(el, 'display', isLayerHidden(el) ? '' : 'none'))
    studioRefresh()
  })
  acts.append(eye)
  if (pickable) {
    acts.append(act('⧉', 'duplicate', () => {
      const copy = duplicateOne(s, el)
      s.picked.clear()
      s.picked.add(copy)
      studioRefresh()
    }))
  }
  acts.append(act('×', 'delete', () => {
    state.apply(removeEl(el))
    s.picked.delete(el)
    studioRefresh()
  }))
  row.append(acts)

  if (pickable) {
    row.addEventListener('click', (e) => {
      studioPick(el, e.shiftKey)
      ;(el as SVGElement).scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
    })
    /* drag to restack — the dragged element takes the target row's slot */
    row.draggable = true
    row.addEventListener('dragstart', (e) => {
      row.classList.add('is-dragging')
      e.dataTransfer?.setData('text/plain', String([...s.svg.children].indexOf(el)))
    })
    row.addEventListener('dragend', () => row.classList.remove('is-dragging'))
    row.addEventListener('dragover', (e) => e.preventDefault())
    row.addEventListener('drop', (e) => {
      e.preventDefault()
      const fromIdx = Number(e.dataTransfer?.getData('text/plain'))
      const dragged = s.svg.children[fromIdx]
      const targetIdx = [...s.svg.children].indexOf(el)
      if (!dragged || dragged === el || Number.isNaN(fromIdx) || targetIdx < 0) return
      state.apply(moveEl(dragged, s.svg, targetIdx + (fromIdx < targetIdx ? 1 : 0), 'Reorder drawing layers'))
      studioRefresh()
    })
  }
  list.appendChild(row)
}

function act(text: string, tip: string, run: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'de-tree-act'
  b.textContent = text
  b.title = tip
  b.addEventListener('click', (e) => { e.stopPropagation(); run() })
  return b
}

function isLayerHidden(el: SVGGraphicsElement): boolean {
  return el.style.display === 'none'
}

function glyphEl(kind: string): HTMLElement {
  const g = document.createElement('span')
  g.className = 'de-tree-glyph'
  g.textContent = KIND_GLYPHS[kind] ?? '·'
  return g
}

function nameEl(text: string): HTMLElement {
  const n = document.createElement('span')
  n.className = 'de-tree-name'
  n.textContent = text
  return n
}

function hintEl(text: string): HTMLElement {
  const s2 = document.createElement('span')
  s2.className = 'de-tree-hint'
  s2.textContent = text
  return s2
}

/** one small glyph per kind — read the tree's shape at a glance */
const KIND_GLYPHS: Record<string, string> = {
  slide: '▣', text: '¶', container: '⊟', media: '▨', block: '☰',
  scene: '⬡', node: '◻', edge: '→', free: '✎', island: '⬒',
}

function addRow(
  list: HTMLElement, el: Element, depth: number, label: string, hint: string,
  pick: Selection, counter: { rows: number }, kind = 'block',
): void {
  if (counter.rows >= MAX_ROWS) return
  counter.rows++
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'de-tree-row'
  row.dataset.kind = kind
  row.style.setProperty('--tree-depth', String(depth))
  if (isSelected(el)) row.classList.add('de-on')
  const glyph = document.createElement('span')
  glyph.className = 'de-tree-glyph'
  glyph.textContent = KIND_GLYPHS[kind] ?? '·'
  row.appendChild(glyph)
  const name = document.createElement('span')
  name.className = 'de-tree-name'
  name.textContent = label
  row.appendChild(name)
  if (hint) {
    const s = document.createElement('span')
    s.className = 'de-tree-hint'
    s.textContent = hint
    row.appendChild(s)
  }
  row.addEventListener('click', () => {
    state.selection = pick
    // bring the picked element into view on the canvas
    ;(el as HTMLElement | SVGElement).scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  })
  list.appendChild(row)
}

function isSelected(el: Element): boolean {
  const s = state.selection
  return (
    (s.kind === 'slide' && s.slide === el) ||
    (s.kind === 'element' && (s.el as unknown as Element) === el) ||
    (s.kind === 'scene-node' && s.node === el) ||
    (s.kind === 'scene-edge' && s.edge === el) ||
    (s.kind === 'scene-free' && s.el === el)
  )
}

function snippet(el: Element): string {
  const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return el instanceof HTMLImageElement ? (el.getAttribute('alt') || 'image') : ''
  return t.length > SNIPPET_LEN ? `${t.slice(0, SNIPPET_LEN)}…` : t
}
