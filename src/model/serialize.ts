/* Serialize the live deck back to a self-contained HTML document.
 * Stable output: attribute order untouched (browser preserves source order),
 * editor artifacts stripped, 2-space indent between top-level blocks. */

import type { Deck } from '../types'
import { unscopeFromHost } from './parse'
import runtimeSource from '../runtime/runtime.js?raw'

const EDITOR_ATTRS = ['data-dia-id', 'contenteditable', 'spellcheck', 'data-dia-selected']

export function serializeDeck(deck: Deck): string {
  const styles = [...deck.root.querySelectorAll('style')]
    .filter((s) => s.id !== 'dia-editor-base')
    .map((s) => `<style${s.id ? ` id="${s.id}"` : ''}>\n${unscopeFromHost(s.textContent ?? '').trim()}\n</style>`)
    .join('\n')

  const slides = [...deck.root.querySelectorAll<HTMLElement>('section.dia-slide')]
    .map((s) => cleanClone(s).outerHTML)
    .join('\n\n')

  return `<!doctype html>
<html lang="en" data-dia-version="1">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(deck.title)}</title>
${deck.headExtras ? deck.headExtras + '\n' : ''}${styles}
</head>
<body>
${slides}
<script id="dia-runtime">
${runtimeSource.trim()}
</script>
</body>
</html>
`
}

function cleanClone(el: HTMLElement): HTMLElement {
  const clone = el.cloneNode(true) as HTMLElement
  for (const node of [clone, ...clone.querySelectorAll<HTMLElement>('*')]) {
    for (const a of EDITOR_ATTRS) node.removeAttribute(a)
    if (node.classList.contains('dia-editor-artifact')) node.remove()
  }
  return clone
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
