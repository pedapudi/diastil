/* Slide structure tree for the inspect pane: the current slide's meaningful
 * elements (roles, containers, media, scenes with their nodes/edges/free
 * art, islands) as an indented, clickable outline. Clicking a row selects
 * that element on the slide itself (the canvas overlay + toolbars follow
 * through the normal selection event); the row of the current selection is
 * highlighted, so the tree reads both ways. */

import type { Selection, SlideEl } from '../types'
import { state } from '../state'

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
  addRow(list, slide, 0, 'slide', snippet(slide), { kind: 'slide', slide }, counter)
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
    addRow(list, el, depth, 'island', snippet(el), sel(el, slide), counter)
    return
  }
  // scenes show their object structure
  if (el instanceof SVGSVGElement) {
    const isScene = el.classList.contains('dia-scene')
    addRow(list, el, depth, isScene ? 'scene' : 'svg', '', { kind: 'element', el: el as unknown as HTMLElement, slide }, counter)
    if (isScene) {
      for (const child of el.children) {
        if (counter.rows >= MAX_ROWS) return
        if (/^(defs|style|title|desc|metadata)$/.test(child.tagName)) continue
        if (child.hasAttribute('data-dia-node')) {
          const label = child.querySelector('.dia-node-label')?.textContent?.trim()
          addRow(list, child, depth + 1, `node ${child.getAttribute('data-dia-node')}`, label ?? '',
            { kind: 'scene-node', node: child as SVGGElement, scene: el, slide }, counter)
        } else if (child.hasAttribute('data-dia-edge')) {
          addRow(list, child, depth + 1, `edge ${child.getAttribute('data-dia-edge')}`, '',
            { kind: 'scene-edge', edge: child as SVGGElement, scene: el, slide }, counter)
        } else {
          addRow(list, child, depth + 1, `<${child.tagName.toLowerCase()}>`, snippet(child),
            { kind: 'scene-free', el: child as SVGGraphicsElement, scene: el, slide }, counter)
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
    addRow(list, el, depth, role ?? el.tagName.toLowerCase(), snippet(el), sel(el, slide), counter)
  }
  // descend into containers and unlabeled wrappers; leaves stay leaves
  if (isContainer || !meaningful) {
    for (const child of el.children) walk(list, child, slide, depth + (meaningful ? 1 : 0), counter)
  }
}

function sel(el: Element, slide: SlideEl): Selection {
  return { kind: 'element', el: el as HTMLElement, slide }
}

function addRow(
  list: HTMLElement, el: Element, depth: number, label: string, hint: string,
  pick: Selection, counter: { rows: number },
): void {
  if (counter.rows >= MAX_ROWS) return
  counter.rows++
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'de-tree-row'
  row.style.paddingLeft = `${6 + depth * 12}px`
  if (isSelected(el)) row.classList.add('de-on')
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
