/* SVG import for the studio: paste markup or pick a file. Foreign svg is
 * SANITIZED, never trusted — scripts, event handlers, and remote references
 * are stripped; animation elements are preserved (animated svgs are a
 * supported import, same policy as ingest). Imported artwork lands as ops:
 * a group appended to the open drawing, or a fresh drawing on a slide. */

import { state } from '../state'
import { batch, insertEl } from '../model/ops'
import type { StudioSession } from './studio'
import { h, button, openStudio } from './studio'
import { focusedSlide } from './focus'
import { refreshAll } from './tools'

const NS = 'http://www.w3.org/2000/svg'

const DROP_ELEMENTS = new Set(['script', 'foreignobject', 'iframe', 'audio', 'video', 'embed', 'object'])

/** parse + sanitize foreign svg markup; null when it isn't an svg at all */
export function sanitizeSvg(markup: string): SVGSVGElement | null {
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml')
  const root = doc.documentElement
  if (root.tagName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) return null
  const clean = document.importNode(root, true) as unknown as SVGSVGElement
  const walk = [clean, ...clean.querySelectorAll('*')]
  for (const el of walk) {
    if (DROP_ELEMENTS.has(el.tagName.toLowerCase())) { el.remove(); continue }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase()
      const value = attr.value.trim().toLowerCase()
      if (name.startsWith('on')) el.removeAttribute(attr.name)
      // remote references can exfiltrate or restyle from the network —
      // a deck must stay self-contained (data: images are fine)
      else if ((name === 'href' || name === 'xlink:href' || name === 'src') &&
        /^(https?:|\/\/|javascript:)/.test(value)) el.removeAttribute(attr.name)
      else if (value.includes('url(http') || value.startsWith('javascript:')) el.removeAttribute(attr.name)
    }
  }
  return clean
}

/** the studio's import surface: paste markup or pick an .svg file */
export function openImportDialog(s: StudioSession): void {
  const scrim = h('div', 'dia-st-import')
  const card = h('div', 'dia-st-card')
  card.append(h('div', 'dia-st-sect', 'import svg'))
  card.append(h('div', 'dia-st-hint',
    'paste svg markup, or pick a file. scripts and remote references are stripped; animations survive.'))
  const ta = document.createElement('textarea')
  ta.placeholder = '<svg …>'
  ta.spellcheck = false
  const err = h('div', 'dia-st-err')
  const row = h('div', 'dia-st-row')
  const file = button('from file…', 'pick an .svg file')
  const add = button('add to drawing', 'append the artwork as a group (one undo step)')
  const cancel = button('cancel', 'close (esc)')
  row.append(file, h('span', 'dia-st-spacer'), cancel, add)
  card.append(ta, err, row)
  scrim.append(card)
  s.overlay.appendChild(scrim)

  const close = (): void => scrim.remove()
  cancel.addEventListener('click', close)
  scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim) close() })

  file.addEventListener('click', async () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.svg,image/svg+xml'
    input.addEventListener('change', async () => {
      const f = input.files?.[0]
      if (f) ta.value = await f.text()
    })
    input.click()
  })

  add.addEventListener('click', () => {
    const clean = sanitizeSvg(ta.value)
    if (!clean) { err.textContent = 'that is not parseable svg — check the markup and try again'; return }
    const group = importAsGroup(s.svg, clean)
    state.apply(insertEl(s.svg, [...s.svg.children].length, group, 'Import svg artwork'))
    s.picked.clear()
    s.picked.add(group)
    close()
    refreshAll()
  })
}

/** wrap an imported svg's content as ONE group, scaled into the drawing */
function importAsGroup(target: SVGSVGElement, imported: SVGSVGElement): SVGGElement {
  const group = document.createElementNS(NS, 'g') as SVGGElement
  // defs must ride along (gradients, markers, clip paths)
  for (const child of [...imported.children]) group.appendChild(child)
  const vb = imported.viewBox?.baseVal
  const tvb = target.viewBox?.baseVal
  if (vb && vb.width > 0 && tvb && tvb.width > 0) {
    const k = Math.min(tvb.width / vb.width, tvb.height / vb.height, 1)
    const tx = tvb.x - vb.x * k
    const ty = tvb.y - vb.y * k
    if (k !== 1 || tx !== 0 || ty !== 0) {
      group.setAttribute('transform', `translate(${round2(tx)} ${round2(ty)}) scale(${round2(k)})`)
    }
  }
  return group
}

/** a fresh drawing on a slide: empty viewBoxed svg inserted as an op,
 * then opened in the studio (the inspector's "+ drawing" entry).
 * While THIS slide is focused, the drawing lands in place instead —
 * focus already carries the full toolset, and studios never nest. */
export function newDrawingOnSlide(slide: HTMLElement): void {
  const svg = document.createElementNS(NS, 'svg') as SVGSVGElement
  svg.setAttribute('viewBox', '0 0 480 300')
  svg.setAttribute('role', 'img')
  svg.style.width = '100%'
  const figure = document.createElement('figure')
  figure.className = 'dia-figure'
  figure.appendChild(svg)
  const foot = slide.querySelector(':scope > .dia-caption.foot')
  const index = foot ? [...slide.children].indexOf(foot) : slide.children.length
  state.apply(batch('Insert drawing', [insertEl(slide, index, figure, 'Insert drawing figure')]))
  if (focusedSlide() === slide) {
    state.selection = { kind: 'element', el: svg as unknown as HTMLElement, slide }
    return
  }
  openStudio(svg)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
