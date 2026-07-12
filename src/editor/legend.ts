/* Keyboard legend: a modal cheat-sheet on `/` (or `?`). Esc, another `/`,
 * or a backdrop click closes it. Pure chrome — no document state. */

import './editor.css'

const SECTIONS: Array<[string, Array<[string, string]>]> = [
  ['anywhere', [
    ['⌘S', 'save the deck'],
    ['⌘Z · ⇧⌘Z', 'undo · redo (history continues across sessions)'],
    ['/', 'this legend'],
  ]],
  ['table', [
    ['↓ / j · ↑ / k', 'next · previous slide'],
    ['Enter', 'lift the current slide to stage'],
    ['Esc', 'clear selection'],
  ]],
  ['stage', [
    ['→ · ←', 'next · previous slide'],
    ['Esc', 'back to table (position kept)'],
  ]],
  ['text', [
    ['double-click', 'edit text in place'],
    ['Enter · Esc', 'commit · cancel the edit'],
  ]],
  ['diagram (node or edge selected)', [
    ['drag', 'move a node — edges reroute live'],
    ['arrows', 'nudge 1px (⇧ = 10px)'],
    ['double-click node', 'edit its label'],
    ['double-click empty scene', 'create a node'],
    ['Delete / Backspace', 'delete the selection'],
  ]],
  ['import review', [
    ['← · →', 'previous · next slide'],
    ['Esc', 'cancel the import'],
  ]],
]

let overlay: HTMLDivElement | null = null

export function legendOpen(): boolean {
  return overlay !== null
}

export function toggleLegend(): void {
  if (overlay) { closeLegend(); return }
  overlay = document.createElement('div')
  overlay.className = 'de-legend'
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeLegend() })

  const panel = document.createElement('div')
  panel.className = 'dn-panel de-legend-panel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', 'keyboard shortcuts')

  const head = document.createElement('div')
  head.className = 'de-legend-head'
  head.textContent = 'keyboard'
  panel.appendChild(head)

  for (const [title, rows] of SECTIONS) {
    const sec = document.createElement('div')
    sec.className = 'de-legend-sec'
    sec.textContent = title
    panel.appendChild(sec)
    for (const [keys, what] of rows) {
      const row = document.createElement('div')
      row.className = 'de-legend-row'
      const k = document.createElement('kbd')
      k.textContent = keys
      const v = document.createElement('span')
      v.textContent = what
      row.append(k, v)
      panel.appendChild(row)
    }
  }

  const foot = document.createElement('div')
  foot.className = 'de-legend-foot'
  foot.textContent = 'esc · / — close'
  panel.appendChild(foot)

  overlay.appendChild(panel)
  document.body.appendChild(overlay)
}

export function closeLegend(): void {
  overlay?.remove()
  overlay = null
}
