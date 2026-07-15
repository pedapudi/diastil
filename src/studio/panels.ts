/* Studio rail: properties (fill/stroke/width/dash/opacity, deck-token
 * swatches, text words) + layers (top-first list of the svg's children:
 * select, hide, duplicate, delete, drag to reorder). Every control writes
 * ops; token colors write var(--dia-*) STYLE properties so the artwork
 * retints with the deck theme. */

import { state } from '../state'
import { batch, insertEl, moveEl, removeEl, setAttr, setStyleProp, setText } from '../model/ops'
import type { StudioSession } from './studio'
import { h } from './studio'
import { isEdgeEl, isNodeEl, pick, pickables, refreshAll } from './tools'
import { attachPickerProxy } from '../editor/colorwell'

/** scene nodes style through their custom props (the scene rules read
 * them); plain artwork styles through ordinary svg properties */
function propFor(el: SVGGraphicsElement, prop: string): string {
  if (!isNodeEl(el)) return prop
  return prop === 'fill' ? '--dia-node-fill'
    : prop === 'stroke' ? '--dia-node-stroke'
    : prop === 'stroke-width' ? '--dia-node-stroke-w'
    : prop
}

/** deck color roles offered as swatches, in signal order */
const TOKEN_INKS: Array<[string, string]> = [
  ['ink', 'var(--dia-ink)'], ['ink-soft', 'var(--dia-ink-soft)'],
  ['accent', 'var(--dia-accent)'], ['rule', 'var(--dia-rule)'], ['paper', 'var(--dia-paper)'],
]

const DASHES: Array<[string, string]> = [
  ['solid', ''], ['dash', '5 4'], ['dot', '1.5 3'], ['long', '9 5'],
]

let host: HTMLElement | null = null

export function mountPanels(s: StudioSession, railEl: HTMLElement): void {
  host = railEl
  refreshPanels(s)
}

export function disposePanels(): void {
  host?.replaceChildren()
  host = null
}

export function refreshPanels(s: StudioSession): void {
  if (!host) return
  host.replaceChildren()
  host.append(h('div', 'dia-st-sect', 'properties'))
  host.append(...propRows(s))
  host.append(h('div', 'dia-st-sect', 'layers'))
  host.append(layersPanel(s))
}

/* ---------- properties ---------- */

function propRows(s: StudioSession): HTMLElement[] {
  const els = [...s.picked]
  if (els.length === 0) {
    return [h('div', 'dia-st-hint', 'pick something — or draw with the tools on the left')]
  }
  const rows: HTMLElement[] = []
  const first = els[0]

  // words of a single selected <text>
  if (els.length === 1 && first instanceof SVGTextElement) {
    const row = h('div', 'dia-st-row')
    row.append(h('span', 'dia-st-k', 'words'))
    const input = document.createElement('input')
    input.className = 'dia-st-text'
    input.value = first.textContent ?? ''
    input.addEventListener('change', () => {
      state.apply(setText(first as unknown as HTMLElement, input.value))
      refreshAll()
    })
    row.append(input)
    rows.push(row)
  }

  rows.push(
    colorRow(s, 'fill', 'fill', els),
    colorRow(s, 'stroke', 'stroke', els),
    widthRow(s, els),
    dashRow(s, els),
    opacityRow(s, els),
  )
  return rows
}

/** a color row: none · token swatches · free color well */
function colorRow(s: StudioSession, label: string, prop: 'fill' | 'stroke', els: SVGGraphicsElement[]): HTMLElement {
  const row = h('div', 'dia-st-row')
  row.append(h('span', 'dia-st-k', label))
  const current = els[0].style.getPropertyValue(propFor(els[0], prop)).trim() ||
    els[0].getAttribute(prop) || ''

  const none = document.createElement('button')
  none.type = 'button'
  none.className = `dia-st-swatch is-none${current === 'none' ? ' dia-st-on' : ''}`
  none.title = `no ${label}`
  none.addEventListener('click', () => applyStyle(s, els, prop, 'none'))
  row.append(none)

  for (const [name, value] of TOKEN_INKS) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `dia-st-swatch${current === value ? ' dia-st-on' : ''}`
    b.title = `${name} — retints with the deck theme`
    b.style.background = resolveToken(s, value)
    b.addEventListener('click', () => applyStyle(s, els, prop, value))
    row.append(b)
  }

  const well = attachPickerProxy(document.createElement('input'))
  well.type = 'color'
  well.className = 'dia-st-swatch'
  well.title = `custom ${label} color`
  if (/^#[0-9a-f]{6}$/i.test(current)) well.value = current
  well.addEventListener('change', () => applyStyle(s, els, prop, well.value))
  row.append(well)
  return row
}

function widthRow(s: StudioSession, els: SVGGraphicsElement[]): HTMLElement {
  const row = h('div', 'dia-st-row')
  row.append(h('span', 'dia-st-k', 'width'))
  const input = document.createElement('input')
  input.type = 'number'
  input.min = '0'
  input.step = '0.25'
  input.className = 'dia-st-num'
  const current = els[0].style.getPropertyValue('stroke-width') || els[0].getAttribute('stroke-width') || ''
  input.value = current ? String(parseFloat(current)) : '1.5'
  input.addEventListener('change', () => {
    const v = Math.max(0, parseFloat(input.value) || 0)
    applyStyle(s, els, 'stroke-width', String(v))
  })
  row.append(input, h('span', 'dia-st-hint', 'stroke px'))
  return row
}

function dashRow(s: StudioSession, els: SVGGraphicsElement[]): HTMLElement {
  const row = h('div', 'dia-st-row')
  row.append(h('span', 'dia-st-k', 'dash'))
  const current = els[0].style.getPropertyValue('stroke-dasharray').trim()
  for (const [name, value] of DASHES) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `dia-st-btn${(current || '') === value ? ' dia-st-on' : ''}`
    b.textContent = name
    b.addEventListener('click', () => applyStyle(s, els, 'stroke-dasharray', value))
    row.append(b)
  }
  return row
}

function opacityRow(s: StudioSession, els: SVGGraphicsElement[]): HTMLElement {
  const row = h('div', 'dia-st-row')
  row.append(h('span', 'dia-st-k', 'opacity'))
  const input = document.createElement('input')
  input.type = 'range'
  input.min = '0'
  input.max = '1'
  input.step = '0.05'
  input.className = 'dia-st-range'
  input.value = els[0].style.getPropertyValue('opacity') || '1'
  const readout = h('span', 'dia-st-zoom', `${Math.round(parseFloat(input.value) * 100)}%`)
  let before: string[] | null = null
  input.addEventListener('input', () => {
    if (!before) before = els.map((el) => el.style.getPropertyValue('opacity'))
    els.forEach((el) => el.style.setProperty('opacity', input.value)) // preview
    readout.textContent = `${Math.round(parseFloat(input.value) * 100)}%`
  })
  input.addEventListener('change', () => {
    if (before) els.forEach((el, i) => before![i]
      ? el.style.setProperty('opacity', before![i])
      : el.style.removeProperty('opacity'))
    before = null
    applyStyle(s, els, 'opacity', input.value === '1' ? '' : input.value)
  })
  row.append(input, readout)
  return row
}

/** one styling gesture = one op; '' clears the property */
function applyStyle(s: StudioSession, els: SVGGraphicsElement[], prop: string, value: string): void {
  const ops = els.map((el) => {
    const target = propFor(el, prop)
    // presentation attributes lose to css — clear a same-named attribute
    // so the style property actually takes effect
    const styleOp = setStyleProp(el, target, value)
    if (target !== prop || el.getAttribute(prop) === null) return styleOp
    return batch(`Set ${prop}`, [setAttr(el, prop, null), styleOp])
  })
  state.apply(ops.length === 1 ? ops[0] : batch(`Set ${prop} on ${ops.length} elements`, ops))
  refreshAll()
}

/** resolve a var(--dia-*) reference against the artwork for swatch preview */
function resolveToken(s: StudioSession, value: string): string {
  const name = /var\((--[\w-]+)\)/.exec(value)?.[1]
  if (!name) return value
  return getComputedStyle(s.svg).getPropertyValue(name).trim() || value
}

/* ---------- layers ---------- */

function layersPanel(s: StudioSession): HTMLElement {
  const wrap = h('div', 'dia-st-layers')
  const els = pickables(s)
  if (els.length === 0) {
    wrap.append(h('div', 'dia-st-hint', 'nothing here yet — draw or import'))
    return wrap
  }
  // top of the stack first, like every layers panel
  for (const el of [...els].reverse()) {
    wrap.append(layerRow(s, el, els))
  }
  // scene edges are DERIVED — they follow their nodes, so they list
  // separately: deletable and hideable, never reordered or duplicated
  const edges = [...s.svg.children].filter(isEdgeEl) as SVGGElement[]
  if (edges.length > 0) {
    wrap.append(h('div', 'dia-st-sect', 'edges — derived'))
    for (const edge of edges) {
      const row = h('div', 'dia-st-layer')
      const eye = lbtn(isHidden(edge as SVGGraphicsElement) ? '◌' : '●', isHidden(edge as SVGGraphicsElement) ? 'show' : 'hide')
      eye.addEventListener('click', (e) => {
        e.stopPropagation()
        state.apply(setStyleProp(edge, 'display', isHidden(edge as SVGGraphicsElement) ? '' : 'none'))
        refreshAll()
      })
      const ref = edge.getAttribute('data-dia-edge') ?? '?'
      const route = edge.getAttribute('data-route') ?? 'ortho'
      const name = h('span', 'dia-st-lname', `${ref.replace('->', ' → ')} · ${route}`)
      const del = lbtn('×', 'delete edge')
      del.addEventListener('click', (e) => {
        e.stopPropagation()
        state.apply(removeEl(edge, `DeleteEdge ${ref}`))
        refreshAll()
      })
      row.append(eye, name, del)
      wrap.append(row)
    }
  }
  return wrap
}

function layerRow(s: StudioSession, el: SVGGraphicsElement, all: SVGGraphicsElement[]): HTMLElement {
  const row = h('div', `dia-st-layer${s.picked.has(el) ? ' dia-st-on' : ''}${isHidden(el) ? ' is-hidden' : ''}`)
  row.draggable = true

  const eye = lbtn(isHidden(el) ? '◌' : '●', isHidden(el) ? 'show' : 'hide')
  eye.addEventListener('click', (e) => {
    e.stopPropagation()
    state.apply(setStyleProp(el, 'display', isHidden(el) ? '' : 'none'))
    refreshAll()
  })

  const name = h('span', 'dia-st-lname', describeLayer(el))

  const dup = lbtn('⧉', 'duplicate')
  dup.addEventListener('click', (e) => {
    e.stopPropagation()
    const copy = el.cloneNode(true) as SVGGraphicsElement
    if (isNodeEl(copy)) {
      // node ids key the edge references — a copy needs its own
      const base = copy.getAttribute('data-dia-node') ?? 'node'
      let id = `${base}-copy`
      for (let n = 2; s.svg.querySelector(`[data-dia-node="${id}"]`); n++) id = `${base}-copy${n}`
      copy.setAttribute('data-dia-node', id)
    }
    state.apply(insertEl(s.svg, [...s.svg.children].indexOf(el) + 1, copy, 'Duplicate drawing element'))
    s.picked.clear()
    s.picked.add(copy)
    refreshAll()
  })

  const del = lbtn('×', 'delete')
  del.addEventListener('click', (e) => {
    e.stopPropagation()
    state.apply(removeEl(el))
    s.picked.delete(el)
    refreshAll()
  })

  row.append(eye, name, dup, del)
  row.addEventListener('click', (e) => pick(el, e.shiftKey))

  /* drag to reorder — drop above the row under the cursor */
  row.addEventListener('dragstart', (e) => {
    row.classList.add('is-dragging')
    e.dataTransfer?.setData('text/plain', String(all.indexOf(el)))
  })
  row.addEventListener('dragend', () => row.classList.remove('is-dragging'))
  row.addEventListener('dragover', (e) => e.preventDefault())
  row.addEventListener('drop', (e) => {
    e.preventDefault()
    const fromIdx = Number(e.dataTransfer?.getData('text/plain'))
    const dragged = all[fromIdx]
    if (!dragged || dragged === el) return
    // panel is top-first; dropping ON a row puts the dragged element
    // directly ABOVE it in the stack (after it in document order)
    const targetIdx = [...s.svg.children].indexOf(el)
    state.apply(moveEl(dragged, s.svg, targetIdx + (fromIdx > all.indexOf(el) ? 1 : 0), 'Reorder drawing layers'))
    refreshAll()
  })
  return row
}

function isHidden(el: SVGGraphicsElement): boolean {
  return el.style.display === 'none'
}

function describeLayer(el: SVGGraphicsElement): string {
  const tag = el.tagName.toLowerCase()
  if (el.hasAttribute('data-dia-node')) {
    const shape = el.getAttribute('data-shape') ?? 'node'
    return `node ${el.getAttribute('data-dia-node')} · ${shape}`
  }
  if (el instanceof SVGTextElement) return `text “${(el.textContent ?? '').slice(0, 18)}”`
  if (tag === 'g') return `group (${el.children.length})`
  return tag
}

function lbtn(text: string, tip: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'dia-st-lbtn'
  b.textContent = text
  b.title = tip
  return b
}
