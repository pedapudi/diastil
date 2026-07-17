/* Keyboard legend: a modal cheat-sheet on `/` (or `?`). Esc, another `/`,
 * or a backdrop click closes it. Pure chrome — no document state. */

import './editor.css'

/* platform-aware key labels: ⌘/⌥ are macOS glyphs; on Linux/Windows the
 * Super key belongs to the OS, so Ctrl is the real modifier there (the
 * handlers bind metaKey OR ctrlKey — the labels must match the platform) */
const IS_MAC = /Mac|iP(hone|ad|od)/.test(navigator.platform)
const MOD = IS_MAC ? '⌘' : 'Ctrl+'
const MODSHIFT = IS_MAC ? '⇧⌘' : 'Ctrl+Shift+'
const PIN_CLICK = IS_MAC ? '⌥-click' : 'Alt/Shift-click'

const SECTIONS: Array<[string, Array<[string, string]>]> = [
  ['anywhere', [
    [`${MOD}S`, 'save the deck'],
    [`${MOD}Z · ${MODSHIFT}Z`, 'undo · redo (history continues across sessions)'],
    ['right-click', 'context menu — edit, insert, studio, duplicate, delete'],
    ['\\', 'show / hide the right rail'],
    ['/', 'this legend'],
  ]],
  ['navigate', [
    ['↓ / j / → · ↑ / k / ←', 'next · previous slide'],
    ['s · m · l (topbar)', 'zoom the slides (l ≈ detail work)'],
    ['Esc', 'clear selection'],
    [`${PIN_CLICK} a minimap slide`, 'pin it into the copilot context'],
  ]],
  ['text', [
    ['double-click', 'edit text in place'],
    ['Enter · Esc', 'commit · cancel the edit'],
  ]],
  ['blocks', [
    ['drag', 'move a text block, figure, image, or island'],
    ['⇧-drag on a drawing', 'move the FIGURE the svg lives in (a plain drag edits inside it)'],
    ['drag the ⤡ grip', 'resize the selection — text reflows, images/drawings scale'],
    ['drag the ⛶ grip', 'crop instead: images crop their frame, drawings crop/extend the canvas (Ctrl/Alt + ⤡ does the same)'],
    ['⇧ + ⤡ drag', 'also set the height (text boxes) · stretch (images)'],
    ['Delete / Backspace', 'delete the selected element'],
  ]],
  ['diagram', [
    ['drag', 'move a node or any svg element — edges reroute live'],
    ['⇧ + resize', 'lock the aspect (true circles / squares)'],
    ['arrows', 'nudge 1px (⇧ = 10px)'],
    ['drag from an anchor dot', 'new edge — drop on a dot to pin the side it lands on'],
    ['drag a connector’s middle dot', 're-route it by hand — drop near the direct line to go back to auto'],
    ['double-click node', 'edit its label'],
    ['double-click empty scene', 'create a node'],
    ['pen / line (toolbar)', 'draw — release commits, Esc exits the tool'],
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
