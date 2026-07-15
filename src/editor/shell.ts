/* Editor shell: topbar, three-column layout (minimap | main | rail),
 * the single table surface with zoom, global keyboard, and the
 * inspect / copilot / tokens rail. mountEditor(host) builds the whole app. */

import './editor.css'
import '../chrome/tokens.css'
import '../chrome/base.css'
import demoDeckRaw from '../../examples/demo-deck.html?raw'
import type { Deck } from '../types'
import { state } from '../state'
import { loadDeck } from '../model/parse'
import { batch as batchOps, insertEl, removeEl, setAttr, setStyleProp, setToken } from '../model/ops'
import { routeAll } from '../scene/route'
import {
  ensureSceneStyleRules, expandSceneCanvas, fitSceneCanvas, getDrawTool,
  insertShapeNode, setDrawTool,
} from '../scene/interact'
import { swatch } from '../scene/icons'
import { assignFreshIds } from './slides'
import { mountThemePicker, mountTypePicker } from '../chrome/pickers'
import { mountCopilot } from '../copilot/rail'
import { mountTable, scrollToSlide } from './table'
import { mountMinimap } from './minimap'
import { installHistory } from './history'
import { installElementDragging } from './elemdrag'
import { legendOpen, toggleLegend, closeLegend } from './legend'
import { installTextEditing, insertTextOnSlide } from './textedit'
import { installContextMenu } from './contextmenu'
import { buildSlideTree } from './tree'
import { openCompare } from './compare'
import { bootFromCli, openDeck, saveDeck, presentDeck } from './slides'
import { canStudio, openStudio } from '../studio/studio'
import { newDrawingOnSlide } from '../studio/svgimport'
import { applyTex, insertMathOnSlide, mathOf, renderTex } from './math'
import { attachPickerProxy } from './colorwell'

/* styles that must live inside the deck shadow root; serialization strips
 * style.dia-editor-artifact (slides.ts removes them around serializeDeck) */
const ARTIFACT_CSS = `
section.dia-slide { margin-block: 34px; }
section.dia-slide:first-of-type { margin-block-start: 0; }
section.dia-slide:last-of-type { margin-block-end: 0; }
[data-dia-selected] { outline: 1.5px solid var(--accent); outline-offset: 4px; }
/* blank svg areas are click-through by default (visiblePainted) — every
 * editable svg background must be selectable; islands stay untouched */
section.dia-slide svg { pointer-events: bounding-box; }
[data-dia-island] svg { pointer-events: auto; }
/* full-slide diagram layers pass idle clicks through to the text beneath;
 * their CONTENT stays interactive, and draw mode flips the whole surface */
section.dia-slide svg.dia-scene-full { pointer-events: none; }
section.dia-slide svg.dia-scene-full > :not(.dia-editor-artifact) { pointer-events: auto; }
:host([data-dia-drawing]) section.dia-slide svg { pointer-events: bounding-box; }
[contenteditable] { outline: 2px solid var(--accent); outline-offset: 2px; cursor: text; }
/* copilot proposal preview: dashed frame + corner chip over the previewed
 * slide — inspect the change, then apply or reject in the rail */
section.dia-slide > .dia-preview-badge {
  position: absolute; inset: 0; z-index: 44; pointer-events: none;
  border: 2.5px dashed var(--accent);
}
section.dia-slide > .dia-preview-badge::after {
  content: 'copilot preview — apply or reject in the rail';
  position: absolute; top: 8px; right: 8px;
  font: 10.5px/1.9 ui-monospace, monospace; letter-spacing: .04em;
  padding: 0 9px; border-radius: 4px;
  background: var(--accent); color: var(--paper, #fff);
}
/* highlight-for-context: user-shaded regions the copilot receives.
 * THEME-PROOF by construction: orange stroke, white OUTER halo, dark INNER
 * line — whatever the background, one of the halos contrasts with it. */
section.dia-slide > .dia-hl-layer { position: absolute; inset: 0; z-index: 40; pointer-events: none; }
section.dia-slide > .dia-hl-layer.is-active { pointer-events: auto; cursor: crosshair; }
.dia-hl-layer .dia-hl-box {
  position: absolute;
  background: rgba(255, 153, 0, 0.22);
  border: 2px solid #ff9500;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.9), inset 0 0 0 1.5px rgba(0, 0, 0, 0.4);
  pointer-events: auto;
  cursor: pointer;
}
.dia-hl-layer .dia-hl-box:hover { background: rgba(255, 80, 60, 0.28); border-color: #ff5040; }
.dia-hl-layer .dia-hl-box:hover::after {
  content: '\\00d7 remove';
  position: absolute; top: -1.6em; right: -2px;
  font: 11px/1.6 ui-monospace, monospace;
  padding: 0 6px; border-radius: 3px;
  background: #ff5040; color: #fff; white-space: nowrap;
}
.dia-hl-layer .dia-hl-box.is-ghost { pointer-events: none; border-style: dashed; background: rgba(255, 153, 0, 0.12); box-shadow: none; }
`

export function mountEditor(host: HTMLElement): void {
  host.classList.add('de-app')

  /* ---------- topbar ---------- */

  const topbar = h('header', 'de-topbar')
  // the brand: condensation mark (slides distilled to one drop) + wordmark.
  // diastīl takes its macron ONLY in display contexts — code, paths, and
  // the CLI stay ascii (docs/BRAND.md)
  const brand = h('div', 'de-brand')
  brand.insertAdjacentHTML('afterbegin',
    '<svg viewBox="0 0 60 26" aria-hidden="true" class="de-brand-mark">' +
    '<path d="M3,6 L34,10.5 M3,13 L38,13 M3,20 L34,15.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".62"/>' +
    '<circle cx="49" cy="13" r="5.5" fill="var(--accent)"/></svg>')
  brand.append(h('span', '', 'diastīl'))
  // the zicato research-preview pill: a quiet two-line product-status tag
  // in the wordmark's register — informational, never interactive
  const respreview = h('span', 'de-respreview')
  respreview.setAttribute('role', 'note')
  respreview.setAttribute('aria-label', 'research preview')
  respreview.append(h('span', '', 'research'), h('span', '', 'preview'))
  const crumbs = h('div', 'de-crumbs')

  // one surface: the table. zoom replaces the old stage altitude's larger
  // working area (s = compact, m = reading, l = stage-scale for detail work)
  const ZOOMS: Array<[string, string, string]> = [
    ['s', '760px', 'compact — more slides in view'],
    ['m', '980px', 'reading size'],
    ['l', '1280px', 'large — diagram and detail work'],
  ]
  const seg = h('div', 'dn-seg')
  const zoomButtons = new Map<string, HTMLButtonElement>()
  for (const [name, width, tip] of ZOOMS) {
    const b = segButton(name, () => setZoom(name, width))
    b.title = tip
    b.classList.remove('dn-on')
    zoomButtons.set(name, b)
    seg.append(b)
  }
  function setZoom(name: string, width: string): void {
    document.documentElement.style.setProperty('--de-deck-w', width)
    for (const [n, b] of zoomButtons) b.classList.toggle('dn-on', n === name)
    try { localStorage.setItem('dia-zoom', name) } catch { /* private mode */ }
  }
  {
    let saved = 'm'
    try { saved = localStorage.getItem('dia-zoom') ?? 'm' } catch { /* private mode */ }
    const z = ZOOMS.find(([n]) => n === saved) ?? ZOOMS[1]
    setZoom(z[0], z[1])
  }
  const segPresent = segButton('present', () => { if (state.deck) presentDeck(state.deck) })
  segPresent.title = 'open the saved deck in a new tab, self-running'
  seg.append(segPresent)

  const btnOpen = dnButton('open', () => { void openDeck(canvasHost) })
  btnOpen.title = 'open any HTML deck — diastil files load directly; foreign decks convert through review'
  const btnSave = dnButton('save', () => { void doSave() })
  btnSave.title = `write the deck back as self-contained HTML (${/Mac|iP(hone|ad|od)/.test(navigator.platform) ? '⌘S' : 'Ctrl+S'})`

  const pickerSlot = h('div')
  pickerSlot.id = 'picker-slot'

  const status = h('div', 'de-status')
  const statusWord = h('span', '', 'valid · v1')
  status.append(h('span', 'de-sdot'), statusWord)

  topbar.append(brand, respreview, crumbs, h('div', 'de-spacer'), seg, btnOpen, btnSave, pickerSlot, status)

  /* ---------- layout ---------- */

  const layout = h('div', 'de-layout')
  const minimapEl = h('aside', 'de-minimap')
  const main = h('div', 'de-main')
  const rail = h('aside', 'de-rail')
  layout.append(minimapEl, main, rail)
  host.append(topbar, layout)

  const canvasHost = h('div', 'de-canvas')
  canvasHost.id = 'deck-host' // ingest loads accepted imports through this id

  /* ---------- rail: inspect · tokens · copilot ---------- */

  // rail anatomy: [tabs: inspect · tokens · copilot], one full-height pane
  // per tab. The copilot is a PEER TAB, not a bottom dock — the old
  // dock-plus-maximize hybrid ate half the rail permanently and left the
  // tab disabled offline, which read as broken. The chat pane owns its
  // offline state (drafting stays free), so the tab is always live.
  const tabsBar = h('div', 'de-tabs')
  const inspectPane = h('div', 'de-pane de-on')
  const tokensPane = h('div', 'de-pane')
  const copilotFullPane = h('div', 'de-pane')
  const copilotPane = h('div', 'de-cop-dock') // the chat element
  copilotFullPane.append(copilotPane)
  const inspectBody = h('div', 'de-pane-pad')
  const tokensBody = h('div', 'de-pane-pad')
  inspectPane.append(inspectBody)
  tokensPane.append(tokensBody)
  const tabs: Array<{ btn: HTMLButtonElement; pane: HTMLElement }> = []
  for (const [label, pane] of [
    ['inspect', inspectPane], ['tokens', tokensPane], ['copilot', copilotFullPane],
  ] as const) {
    const btn = h('button', label === 'inspect' ? 'de-on' : '', label)
    btn.type = 'button'
    btn.addEventListener('click', () => {
      for (const t of tabs) {
        t.btn.classList.toggle('de-on', t.btn === btn)
        t.pane.classList.toggle('de-on', t.pane === pane)
      }
      if (pane === tokensPane) renderTokens()
    })
    tabsBar.append(btn)
    tabs.push({ btn, pane })
  }
  const railHide = h('button', 'de-rail-hide', '⇥')
  railHide.type = 'button'
  railHide.title = 'hide the rail (\\)'
  railHide.addEventListener('click', () => setRail(false))
  tabsBar.append(railHide)

  const railTop = h('div', 'de-rail-top')
  railTop.append(tabsBar, inspectPane, tokensPane, copilotFullPane)

  // rail width: drag the left edge (persisted)
  const widthGrip = h('div', 'de-rail-wgrip')
  widthGrip.title = 'drag to resize the rail'
  widthGrip.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    const ac = new AbortController()
    window.addEventListener('pointermove', (ev) => {
      const w = Math.min(Math.max(window.innerWidth - ev.clientX, 240), 560)
      layout.style.setProperty('--de-rail-w', `${Math.round(w)}px`)
    }, { signal: ac.signal })
    window.addEventListener('pointerup', () => {
      ac.abort()
      try { localStorage.setItem('dia-rail-w', layout.style.getPropertyValue('--de-rail-w')) } catch { /* private mode */ }
    }, { signal: ac.signal })
  })
  try {
    const savedW = localStorage.getItem('dia-rail-w')
    if (savedW) layout.style.setProperty('--de-rail-w', savedW)
  } catch { /* private mode */ }

  rail.append(railTop, widthGrip)

  const railRestore = h('button', 'de-rail-restore', '⇤')
  railRestore.type = 'button'
  railRestore.title = 'show the rail (\\)'
  railRestore.addEventListener('click', () => setRail(true))
  host.append(railRestore)

  function setRail(on: boolean): void {
    layout.classList.toggle('de-rail-off', !on)
    railRestore.hidden = on
    try { localStorage.setItem('dia-rail', on ? 'on' : 'off') } catch { /* private mode */ }
  }
  setRail((() => { try { return localStorage.getItem('dia-rail') !== 'off' } catch { return true } })())

  /* ---------- dirty tracking ---------- */

  let tick = 0
  let savedTick = 0

  /* ---------- bus wiring (before submodule mounts, so artifact styles
   * and scene routing land before minimap/table rebuild their views) ---- */

  state.bus.on((e) => {
    switch (e.type) {
      case 'deck-loaded': {
        const deck = state.deck
        if (deck) {
          installDeckArtifacts(deck)
          // heal the theme BEFORE any module (minimap!) snapshots deck styles
          if (deck.root.querySelector('svg.dia-scene')) ensureSceneStyleRules()
          routeAllScenes(deck)
        }
        state.resetLog() // old ops reference the previous document's elements
        tick = 0
        savedTick = 0
        state.selection = { kind: 'none' }
        state.setCurrentSlide(0)
        updateStatus()
        updateCrumbs()
        renderInspect()
        renderTokens()
        break
      }
      case 'undo':
      case 'redo': {
        if (state.deck) routeAllScenes(state.deck)
        tick++
        updateCrumbs()
        renderInspect()
        refreshTokenValues()
        break
      }
      case 'op': {
        tick++
        updateCrumbs()
        renderInspect()
        refreshTokenValues()
        break
      }
      case 'selection': {
        updateCrumbs()
        renderInspect()
        break
      }
      case 'current-slide': {
        updateCrumbs()
        renderInspect() // the structure tree follows the current slide
        break
      }
      case 'slides-changed': {
        updateCrumbs()
        break
      }
    }
  })

  /* ---------- mount submodules ---------- */

  mountTable(main, canvasHost)
  mountMinimap(minimapEl)
  installTextEditing(canvasHost)
  installElementDragging()
  installHistory(canvasHost)
  installContextMenu(canvasHost, { insertDiagram })
  mountThemePicker(pickerSlot)
  mountTypePicker(pickerSlot)
  mountCopilot(copilotPane)

  /* ---------- global keyboard ---------- */

  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey
    if (mod && (e.key === 's' || e.key === 'S')) {
      e.preventDefault()
      void doSave()
      return
    }
    const inField = e.composedPath().some((t) =>
      t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable))
    if (inField) return
    if (legendOpen() && (e.key === 'Escape' || e.key === '/' || e.key === '?')) {
      e.preventDefault()
      closeLegend()
      return
    }
    if (!mod && (e.key === '/' || e.key === '?')) {
      e.preventDefault()
      toggleLegend()
      return
    }
    if (!mod && e.key === '\\') {
      e.preventDefault()
      setRail(layout.classList.contains('de-rail-off'))
      return
    }
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault()
      if (e.shiftKey) state.redo()
      else state.undo()
      return
    }
    if (!state.deck) return
    // Delete removes the selected ELEMENT (one undoable op) — the legend
    // has promised this all along; scene selections handle their own key
    // (interact.ts stops propagation), and whole slides are deleted from
    // the minimap, not from a keystroke
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selection.kind === 'element') {
      const el = state.selection.el
      if (!el.matches('section.dia-slide')) {
        e.preventDefault()
        const role = [...el.classList].find((c) => c.startsWith('dia-')) ?? el.tagName.toLowerCase()
        state.apply(removeEl(el, `Delete ${role}`))
        state.selection = { kind: 'none' }
        return
      }
    }
    if (e.key === 'ArrowDown' || e.key === 'j' || e.key === 'ArrowRight') { e.preventDefault(); stepSlide(1) }
    else if (e.key === 'ArrowUp' || e.key === 'k' || e.key === 'ArrowLeft') { e.preventDefault(); stepSlide(-1) }
    else if (e.key === 'Escape') { state.selection = { kind: 'none' } }
  })

  /* ---------- boot: CLI file (?file= / ?import=), else the demo deck ---------- */

  void bootFromCli(canvasHost).then((handled) => {
    if (!handled) {
      const deck = loadDeck(demoDeckRaw, canvasHost, 'demo-deck.html')
      state.deck = deck
      state.bus.emit({ type: 'deck-loaded' })
    }
    updateCrumbs()
  })

  /* ================= shell internals ================= */

  function stepSlide(d: number): void {
    state.setCurrentSlide(state.currentSlide + d)
    scrollToSlide(state.currentSlide, 'smooth')
  }

  async function doSave(): Promise<void> {
    if (!state.deck) return
    await saveDeck(state.deck)
    savedTick = tick
    updateCrumbs()
  }

  /* ----- crumbs + status ----- */

  function updateCrumbs(): void {
    const d = state.deck
    if (!d) {
      crumbs.textContent = 'no deck'
      return
    }
    const file = h('b', '', d.fileName)
    const n = state.slides().length
    const dirty = tick !== savedTick
    const stateWord = dirty ? h('span', 'de-unsaved', 'unsaved') : document.createTextNode('saved')
    crumbs.replaceChildren(
      file,
      document.createTextNode(` · slide ${state.currentSlide + 1}/${n} › ${selectionRole()} · `),
      stateWord,
    )
  }

  function selectionRole(): string {
    const sel = state.selection
    switch (sel.kind) {
      case 'element': return primaryRole(sel.el)
      case 'slide': return 'slide'
      case 'scene-node': return 'scene node'
      case 'scene-edge': return 'scene edge'
      case 'scene-free': return `svg <${sel.el.tagName.toLowerCase()}>`
      default: return 'slide'
    }
  }

  function updateStatus(): void {
    const d = state.deck
    statusWord.textContent = d ? `valid · v${d.version}` : 'no deck'
  }

  /* ----- inspect pane ----- */

  /** the slide the inspect pane is about: the selection's, else the current */
  function inspectedSlide(): HTMLElement | null {
    const sel = state.selection
    if (sel.kind !== 'none') return sel.slide
    return state.slides()[state.currentSlide] ?? null
  }

  function appendTree(): void {
    const slide = inspectedSlide()
    if (slide) inspectBody.append(buildSlideTree(slide))
    // imported decks carry their reference originals (profile §8) — offer
    // the side-by-side comparison for the slide under inspection
    const d = state.deck
    if (d && slide && d.headExtras.includes('dia-originals')) {
      const row = h('div', 'de-style-row')
      const b = h('button', 'dn-btn', 'compare with original')
      b.type = 'button'
      b.title = 'side-by-side: the imported source of this slide vs its current form (esc closes)'
      const idx = state.slides().indexOf(slide)
      b.addEventListener('click', () => openCompare(d, Math.max(0, idx)))
      row.appendChild(b)
      inspectBody.append(row)
    }
  }

  function renderInspect(): void {
    const d = state.deck
    const sel = state.selection
    inspectBody.replaceChildren()
    if (!d || sel.kind === 'none') {
      inspectBody.append(h('div', 'de-hint', 'click an element in a slide to inspect it'))
      appendTree()
      return
    }
    if (sel.kind === 'scene-node' || sel.kind === 'scene-edge' || sel.kind === 'scene-free') {
      inspectBody.append(
        kv('role', sel.kind === 'scene-node' ? 'scene node'
          : sel.kind === 'scene-edge' ? 'scene edge'
          : `svg <${sel.el.tagName.toLowerCase()}>`),
        h('div', 'de-hint', 'scene selections are edited on the canvas'),
      )
      appendTree()
      return
    }
    const el = sel.kind === 'element' ? sel.el : sel.slide
    const slide = sel.slide
    const role = sel.kind === 'element' ? primaryRole(el) : 'dia-slide'
    inspectBody.append(kv('role', role))
    const slideIdx = state.slides().indexOf(slide)
    if (slideIdx >= 0) inspectBody.append(kv('slide', String(slideIdx + 1)))

    if (sel.kind === 'slide') {
      const layer = slide.querySelector<SVGSVGElement>(':scope > svg.dia-scene-full')
      if (layer) {
        inspectBody.append(...sceneToolRows(layer))
      } else {
        const rowEl = h('div', 'de-style-row')
        rowEl.append(h('span', 'de-style-k', 'insert'))
        const segEl = h('span', 'dn-seg')
        const b = h('button', '', '+ diagram')
        b.type = 'button'
        b.title = 'add a full-slide diagram layer — shapes anywhere on the slide'
        b.addEventListener('click', () => { insertDiagram(slide); renderInspect() })
        const bd = h('button', '', '+ drawing')
        bd.type = 'button'
        bd.title = 'add freeform svg artwork and open it in the studio'
        bd.addEventListener('click', () => newDrawingOnSlide(slide))
        const bt = h('button', '', '+ text')
        bt.type = 'button'
        bt.title = 'add a text block — starts editing right away (drag to place, inspector restyles)'
        bt.addEventListener('click', () => insertTextOnSlide(slide))
        const bm = h('button', '', '+ math')
        bm.type = 'button'
        bm.title = 'add a LaTeX formula — rendered to native MathML, source kept on the element'
        bm.addEventListener('click', () => {
          const el = insertMathOnSlide(slide)
          if (el) state.selection = { kind: 'element', el, slide }
        })
        segEl.append(bt, b, bd, bm)
        rowEl.append(segEl)
        inspectBody.append(rowEl)
      }

      // per-slide background: token options + a free color swatch
      const bgRow = styleSeg('bg', slide, 'background', [
        ['auto', ''], ['paper', 'var(--dia-paper)'], ['rule', 'var(--dia-rule)'], ['accent', 'var(--dia-accent)'],
      ])
      const swatch = attachPickerProxy(document.createElement('input'))
      swatch.type = 'color'
      swatch.className = 'de-tok-swatch'
      swatch.title = 'custom background color (this slide only)'
      swatch.value = toHexColor(getComputedStyle(slide).backgroundColor)
      let bgBefore: string | null = null
      swatch.addEventListener('input', () => {
        if (bgBefore === null) bgBefore = slide.style.getPropertyValue('background')
        slide.style.setProperty('background', swatch.value) // preview
      })
      swatch.addEventListener('change', () => {
        if (bgBefore === null) return
        slide.style.setProperty('background', bgBefore) // restore for the op
        bgBefore = null
        state.apply(setStyleProp(slide, 'background', swatch.value))
      })
      bgRow.append(swatch)
      inspectBody.append(bgRow)

      // slide transition: how this slide ENTERS in present mode
      const tRow = h('div', 'de-style-row')
      tRow.append(h('span', 'de-style-k', 'enter'))
      const tSeg = h('span', 'dn-seg')
      const currentT = slide.getAttribute('data-dia-transition') ?? ''
      for (const [labelText, value] of [
        ['inherit', ''], ['none', 'none'], ['fade', 'fade'], ['slide', 'slide'], ['rise', 'rise'],
      ] as const) {
        const b = h('button', value === currentT ? 'dn-on' : '', labelText)
        b.type = 'button'
        b.title = value === '' ? 'no per-slide override' : `enter with ${labelText} in present mode`
        b.addEventListener('click', () => {
          state.apply(setAttr(slide, 'data-dia-transition', value || null))
          renderInspect()
        })
        tSeg.append(b)
      }
      tRow.append(tSeg)
      const allBtn = h('button', 'dn-btn de-trans-all', 'all slides')
      allBtn.type = 'button'
      allBtn.title = 'apply this slide’s transition to every slide (one undo step)'
      allBtn.addEventListener('click', () => {
        const v = slide.getAttribute('data-dia-transition')
        state.apply(batchOps(`Transition ${v ?? 'inherit'} → all slides`, state.slides()
          .map((sl) => setAttr(sl, 'data-dia-transition', v))))
        renderInspect()
      })
      tRow.append(allBtn)
      inspectBody.append(tRow)
    }

    // a selected svg (scene background click) gets CREATION tools here in
    // the stable rail — floating bars are reserved for concrete selections
    if (sel.kind === 'element' && (el as unknown as Element) instanceof SVGSVGElement) {
      const svgEl = el as unknown as SVGSVGElement
      if (canStudio(svgEl)) {
        const row = h('div', 'de-style-row')
        row.append(h('span', 'de-style-k', 'studio'))
        const b = h('button', 'dn-btn', 'open in studio')
        b.type = 'button'
        b.title = 'edit this artwork on a large canvas — draw, import, transform, layer'
        b.addEventListener('click', () => openStudio(svgEl))
        row.append(b)
        inspectBody.append(row)
      }
      inspectBody.append(...sceneToolRows(svgEl))
      appendTree()
      return
    }

    if (sel.kind === 'element') {
      // math: the TeX source is the element's real editing surface
      const mathEl = mathOf(el)
      if (mathEl) {
        const wrap = h('div', 'de-math-edit')
        const ta = document.createElement('textarea')
        ta.className = 'de-math-tex'
        ta.spellcheck = false
        ta.rows = 3
        ta.value = mathEl.getAttribute('data-dia-tex') ?? ''
        const err = h('div', 'de-hint de-math-err')
        const row = h('div', 'de-style-row')
        row.append(h('span', 'de-style-k', 'latex'))
        const apply = h('button', 'dn-btn', 'render')
        apply.type = 'button'
        apply.title = 'render the LaTeX to MathML (one undo step; source stays on the element)'
        apply.addEventListener('click', () => {
          const probe = renderTex(ta.value)
          if ('error' in probe) { err.textContent = probe.error; return }
          err.textContent = ''
          applyTex(mathEl, ta.value)
        })
        row.append(apply)
        wrap.append(row, ta, err)
        inspectBody.append(wrap)
      }

      const matches = matchScaleTokens(el)
      const chips = h('div', 'de-chips')
      if (matches.length > 0) {
        for (const m of matches) {
          const chip = h('span', 'de-token-chip')
          chip.append(h('b', '', m.name), document.createTextNode(` · ${m.value}`))
          chips.append(chip)
        }
      } else {
        chips.append(h('span', 'de-token-chip', 'no scale token bound'))
      }
      inspectBody.append(chips)

      // per-element typesetting: inline var(--dia-…) references — element
      // scope, token grammar. 'auto' clears the inline value (role default).
      // face and ink get the same visual-and-general treatment as the scene
      // toolbar and the tokens tab: self-previewing faces, color chips, and
      // a free color well.
      inspectBody.append(
        styleSeg('size', el, 'font-size', [
          ['auto', ''],
          ...[1, 2, 3, 4, 5, 6, 7].map((n) => [`${n}`, `var(--dia-scale-${n})`] as [string, string]),
        ]),
        faceRow(el),
        inkRow(el),
      )
      const list = el.closest('ul, ol') as HTMLElement | null
      if (list) inspectBody.append(listRow(list))

      // build step: this element's reveal order in present mode
      const stepRow = h('div', 'de-style-row')
      stepRow.append(h('span', 'de-style-k', 'step'))
      const stepSeg = h('span', 'dn-seg')
      const currentStep = el.getAttribute('data-dia-step') ?? ''
      for (const v of ['', '1', '2', '3', '4', '5', '6'] as const) {
        const b = h('button', v === currentStep ? 'dn-on' : '', v === '' ? 'none' : v)
        b.type = 'button'
        b.title = v === '' ? 'always visible' : `revealed ${v === '1' ? 'first' : `at step ${v}`} in present mode`
        b.addEventListener('click', () => {
          state.apply(setAttr(el, 'data-dia-step', v || null))
          renderInspect()
        })
        stepSeg.append(b)
      }
      stepRow.append(stepSeg)
      inspectBody.append(stepRow)

      // write-target line: computed honestly from the bound token and the
      // number of elements sharing this role class across the deck
      const wt = h('div', 'de-wt')
      const bound = matches[0]
      if (bound && role.startsWith('dia-')) {
        const count = d.root.querySelectorAll(`.${cssEscapeIdent(role)}`).length
        const noun = role.replace(/^dia-/, '')
        const plural = count === 1 ? noun : `${noun}s`
        wt.append(
          document.createTextNode('controls write to this element as token references · '),
          h('b', '', bound.name),
          document.createTextNode(` styles all ${count} ${plural} — edit its value in the tokens tab`),
        )
      } else {
        wt.textContent = 'controls write to this element only (no scale token bound)'
      }
      inspectBody.append(wt)
    }
    appendTree()
  }

  /** creation + drawing tools for a scene, rendered in the inspector (stable
   * chrome — the floating bar is reserved for concrete selections) */
  function sceneToolRows(scene: SVGSVGElement): HTMLElement[] {
    const rows: HTMLElement[] = []
    if (scene.classList.contains('dia-scene')) {
      const r = h('div', 'de-style-row')
      r.append(h('span', 'de-style-k', 'insert'))
      const seg = h('span', 'dn-seg')
      for (const [labelText, kind] of [
        ['+ node', 'node'], ['+ circle', 'circle'], ['+ square', 'square'],
        ['+ star', 'star'], ['+ arrow', 'arrow'],
      ] as const) {
        const b = h('button', '', labelText)
        b.type = 'button'
        b.addEventListener('click', () => insertShapeNode(scene, kind))
        seg.append(b)
      }
      r.append(seg)
      rows.push(r)
      // canvas: room to work OUTSIDE the current box. grow pads the viewBox;
      // fit shrink-wraps it back around the content. Full-slide layers are
      // the slide — their canvas is not resizable.
      if (!scene.classList.contains('dia-scene-full')) {
        const cr = h('div', 'de-style-row')
        cr.append(h('span', 'de-style-k', 'canvas'))
        const cseg = h('span', 'dn-seg')
        const grow = h('button', '', 'grow')
        grow.type = 'button'
        grow.title = 'pad the canvas on every side — move or draw outside the current box'
        grow.addEventListener('click', () => expandSceneCanvas(scene))
        const fit = h('button', '', 'fit content')
        fit.type = 'button'
        fit.title = 'shrink-wrap the canvas around the drawing'
        fit.addEventListener('click', () => fitSceneCanvas(scene))
        cseg.append(grow, fit)
        cr.append(cseg)
        rows.push(cr)
      }
    } else {
      const r = h('div', 'de-style-row')
      r.append(h('span', 'de-style-k', 'svg'))
      const seg = h('span', 'dn-seg')
      const b = h('button', '', 'make diagram')
      b.type = 'button'
      b.title = 'opt this svg into the node/edge vocabulary'
      b.addEventListener('click', () => {
        ensureSceneStyleRules()
        const cls = scene.getAttribute('class') ?? ''
        state.apply(setAttr(scene, 'class', cls ? `${cls} dia-scene` : 'dia-scene'))
        renderInspect()
      })
      seg.append(b)
      r.append(seg)
      rows.push(r)
    }
    const dr = h('div', 'de-style-row')
    dr.append(h('span', 'de-style-k', 'draw'))
    const seg2 = h('span', 'dn-seg')
    for (const tool of ['off', 'line', 'pen'] as const) {
      const b = h('button', (getDrawTool() ?? 'off') === tool ? 'dn-on' : '', tool)
      b.type = 'button'
      b.addEventListener('click', () => {
        setDrawTool(tool === 'off' ? null : tool)
        renderInspect()
      })
      seg2.append(b)
    }
    dr.append(seg2)
    rows.push(dr)
    return rows
  }

  /** add a FULL-SLIDE diagram layer: an absolutely-positioned scene over the
   * whole slide (viewBox = slide aspect) — shapes, nodes, edges, and drawn
   * strokes can land anywhere, layered with the slide's text. Idle clicks
   * pass through to the text; painted content stays interactive. */
  function insertDiagram(slide: HTMLElement): void {
    ensureSceneStyleRules()
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('class', 'dia-scene dia-scene-full')
    svg.setAttribute('viewBox', '0 0 1280 720')
    svg.setAttribute('aria-label', 'diagram layer')
    assignFreshIds(svg as unknown as HTMLElement)
    state.apply(insertEl(slide, slide.children.length, svg, 'InsertDiagramLayer'))
    state.selection = { kind: 'element', el: svg as unknown as HTMLElement, slide }
  }

  /** one per-element style control row: current value highlighted, every
   * change a setStyleProp op (inline token reference), 'auto' clears it */
  function styleSeg(label: string, el: HTMLElement, prop: string, options: Array<[string, string]>): HTMLElement {
    const row = h('div', 'de-style-row')
    row.append(h('span', 'de-style-k', label))
    const seg = h('span', 'dn-seg')
    const current = el.style.getPropertyValue(prop).trim()
    for (const [name, value] of options) {
      const b = h('button', value === current ? 'dn-on' : '', name)
      b.type = 'button'
      b.title = value || 'role default'
      b.addEventListener('click', () => {
        if (el.style.getPropertyValue(prop).trim() === value) return
        state.apply(setStyleProp(el, prop, value))
      })
      seg.append(b)
    }
    row.append(seg)
    return row
  }

  function kv(k: string, v: string): HTMLElement {
    const row = h('div', 'dn-kv')
    row.append(h('span', 'k', k), h('span', 'v', v))
    return row
  }

  /** face: a self-previewing menu — role default, the deck's token faces,
   * then the curated system stacks (the tokens tab's generalization, at
   * element scope) */
  function faceRow(el: HTMLElement): HTMLElement {
    const row = h('div', 'de-style-row')
    row.append(h('span', 'de-style-k', 'face'))
    const sel = document.createElement('select')
    sel.className = 'de-tok-face de-inspect-face'
    const current = el.style.getPropertyValue('font-family').trim()
    const cs = getComputedStyle(el)
    // the RESOLVED family is always visible — "auto" alone hides the one
    // fact needed to replicate a font on another slide
    const firstFace = (stack: string): string =>
      (stack.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '')
    const rendered = firstFace(cs.fontFamily)
    sel.title = `this element renders in: ${cs.fontFamily}`
    const addOpt = (parent: HTMLSelectElement | HTMLOptGroupElement, labelText: string, value: string, preview: string): void => {
      const o = document.createElement('option')
      o.textContent = labelText
      o.value = value
      if (preview) o.style.fontFamily = preview // the menu previews itself
      if (value === current) o.selected = true
      parent.append(o)
    }
    addOpt(sel, `auto — ${rendered} (role default)`, '', cs.fontFamily)
    const tokenGroup = document.createElement('optgroup')
    tokenGroup.label = 'deck faces'
    for (const t of ['display', 'body', 'label'] as const) {
      const stack = cs.getPropertyValue(`--dia-face-${t}`).trim()
      addOpt(tokenGroup, `${t} — ${firstFace(stack) || 'unset'}`, `var(--dia-face-${t})`, stack)
    }
    sel.append(tokenGroup)
    const sysGroup = document.createElement('optgroup')
    sysGroup.label = 'system faces'
    for (const [labelText, stack] of FACE_STACKS) addOpt(sysGroup, labelText, stack, stack)
    sel.append(sysGroup)
    if (current && ![...sel.options].some((o) => o.selected)) {
      addOpt(sel, 'current (custom)', current, current)
      sel.value = current
    }
    sel.addEventListener('change', () => {
      if (el.style.getPropertyValue('font-family').trim() !== sel.value) {
        state.apply(setStyleProp(el, 'font-family', sel.value))
      }
    })
    row.append(sel)
    return row
  }

  /** list: marker style for the WHOLE list — native bullets/numbers, plain,
   * or a custom glyph via the --dia-marker token (theme paints its ink) */
  function listRow(list: HTMLElement): HTMLElement {
    const row = h('div', 'de-style-row')
    row.append(h('span', 'de-style-k', 'list'))
    const seg = h('span', 'dn-seg')
    const currentGlyph = list.style.getPropertyValue('--dia-marker').replace(/^"|"$/g, '')
    const type = list.style.getPropertyValue('list-style-type') || list.style.listStyle
    const options: Array<[string, () => void, boolean]> = [
      ['• bullets', () => {
        state.apply(batchListStyle(list, 'disc', null))
      }, !currentGlyph && !/none/.test(type)],
      ['1. numbers', () => {
        state.apply(batchListStyle(list, 'decimal', null))
      }, false],
      ['plain', () => {
        state.apply(batchListStyle(list, 'none', null))
      }, !currentGlyph && /none/.test(type)],
    ]
    for (const [labelText, run, on] of options) {
      const b = h('button', on ? 'dn-on' : '', labelText)
      b.type = 'button'
      b.addEventListener('click', () => { run(); renderInspect() })
      seg.append(b)
    }
    row.append(seg)
    // custom glyph: one token, every item — the theme binds its ink
    const glyph = document.createElement('input')
    glyph.type = 'text'
    glyph.className = 'de-tok-num de-list-glyph'
    glyph.placeholder = '▸'
    glyph.value = currentGlyph
    glyph.title = 'custom marker glyph for every item (sets --dia-marker; clear to return to native bullets)'
    glyph.addEventListener('change', () => {
      const v = glyph.value.trim()
      state.apply(batchListStyle(list, v ? 'none' : 'disc', v || null))
      renderInspect()
    })
    row.append(glyph)
    return row
  }

  /** one op: list-style-type + --dia-marker move together */
  function batchListStyle(list: HTMLElement, type: string, glyph: string | null) {
    return batchOps(`ListStyle ${glyph ?? type}`, [
      setStyleProp(list, 'list-style-type', type === 'disc' ? '' : type),
      setStyleProp(list, '--dia-marker', glyph ? `"${glyph.replace(/"/g, '')}"` : ''),
    ])
  }

  /** ink: token colors as resolved chips (auto = dashed, theme decides) plus
   * a free color well — the scene toolbar's icon-and-generalization for text */
  function inkRow(el: HTMLElement): HTMLElement {
    const row = h('div', 'de-style-row')
    row.append(h('span', 'de-style-k', 'ink'))
    const seg = h('span', 'dn-seg')
    const current = el.style.getPropertyValue('color').trim()
    const options: Array<[string, string]> = [
      ['auto', ''], ['ink', 'var(--dia-ink)'], ['soft', 'var(--dia-ink-soft)'],
      ['accent', 'var(--dia-accent)'], ['paper', 'var(--dia-paper)'],
    ]
    for (const [name, value] of options) {
      const b = h('button', `dn-seg-icon${value === current ? ' dn-on' : ''}`)
      ;(b as HTMLButtonElement).type = 'button'
      b.title = name === 'auto' ? 'auto — role default' : `${name} · ${value}`
      b.setAttribute('aria-label', name)
      b.appendChild(swatch(value, el))
      b.addEventListener('click', () => {
        if (el.style.getPropertyValue('color').trim() === value) return
        state.apply(setStyleProp(el, 'color', value))
      })
      seg.append(b)
    }
    row.append(seg)
    // free color well: preview while dragging, ONE op on release — the same
    // contract as the per-slide background and the token swatches
    const well = attachPickerProxy(document.createElement('input'))
    well.type = 'color'
    well.className = 'de-tok-swatch'
    well.title = 'custom color (this element only)'
    well.value = toHexColor(getComputedStyle(el).color)
    if (current && !options.some(([, v]) => v === current)) well.classList.add('is-custom-active')
    let before: string | null = null
    well.addEventListener('input', () => {
      if (before === null) before = el.style.getPropertyValue('color')
      el.style.setProperty('color', well.value) // preview only, no op
    })
    well.addEventListener('change', () => {
      if (before === null) return
      el.style.setProperty('color', before) // restore so the op captures true prev
      before = null
      state.apply(setStyleProp(el, 'color', well.value))
    })
    row.append(well)
    return row
  }

  /** which --dia-scale-N tokens match this element's computed font-size */
  function matchScaleTokens(el: HTMLElement): Array<{ name: string; value: string }> {
    const cs = getComputedStyle(el)
    const fs = parseFloat(cs.fontSize)
    const out: Array<{ name: string; value: string }> = []
    if (!Number.isFinite(fs)) return out
    for (let n = 1; n <= 7; n++) {
      const name = `--dia-scale-${n}`
      const raw = cs.getPropertyValue(name).trim()
      if (!raw || !raw.endsWith('px')) continue
      const px = parseFloat(raw)
      if (Number.isFinite(px) && Math.abs(px - fs) < 0.26) out.push({ name, value: raw })
    }
    return out
  }

  /* ----- tokens pane ----- */

  function themeHostRule(d: Deck): CSSStyleRule | null {
    const sheet = d.themeStyle.sheet
    if (!sheet) return null
    for (const r of sheet.cssRules) {
      if (r instanceof CSSStyleRule && r.selectorText === ':host') return r
    }
    return null
  }

  function renderTokens(): void {
    const d = state.deck
    tokensBody.replaceChildren()
    if (!d) return
    const rule = themeHostRule(d)
    if (!rule) {
      tokensBody.append(h('div', 'de-hint', 'no :host token block in the deck theme'))
      return
    }
    const names: string[] = []
    for (let i = 0; i < rule.style.length; i++) {
      const name = rule.style[i]
      if (name.startsWith('--dia-')) names.push(name)
    }
    if (names.length === 0) {
      tokensBody.append(h('div', 'de-hint', 'the deck theme declares no --dia-* tokens'))
      return
    }
    for (const name of names) {
      const row = h('div', 'de-tok-row')
      const label = h('span', 'de-tok-name', name.replace(/^--dia-/, ''))
      label.title = name
      const value = rule.style.getPropertyValue(name).trim()
      row.append(label, ...tokenControls(name, value))
      const del = h('button', 'de-tok-del', '×')
      del.type = 'button'
      del.title = `remove ${name} (rules referencing it fall back; undoable)`
      del.addEventListener('click', () => {
        const dk = state.deck
        if (!dk) return
        state.apply(setToken(dk.themeStyle, name, ''))
        renderTokens()
      })
      row.append(del)
      tokensBody.append(row)
    }

    // add a new token: named value → one SetToken op, immediately editable
    const addRow = h('div', 'de-tok-row de-tok-add')
    const prefix = h('span', 'de-tok-unit', '--dia-')
    const nameInput = document.createElement('input')
    nameInput.type = 'text'
    nameInput.placeholder = 'name'
    nameInput.className = 'de-tok-newname'
    const valueInput = document.createElement('input')
    valueInput.type = 'text'
    valueInput.placeholder = '#b4552d · 12px · any css'
    const addBtn = h('button', 'dn-btn', '+ add')
    addBtn.type = 'button'
    const commitAdd = (): void => {
      const dk = state.deck
      const raw = nameInput.value.trim().replace(/^--/, '').replace(/^dia-/, '')
      const value = valueInput.value.trim()
      if (!dk || !raw || !value) return
      const name = `--dia-${raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`
      state.apply(setToken(dk.themeStyle, name, value))
      nameInput.value = ''
      valueInput.value = ''
      renderTokens()
    }
    addBtn.addEventListener('click', commitAdd)
    valueInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') commitAdd() })
    addRow.append(prefix, nameInput, valueInput, addBtn)
    tokensBody.append(addRow)
  }

  /** WYSIWYG controls per token kind — every change is a setToken op */
  function tokenControls(name: string, value: string): HTMLElement[] {
    const apply = (v: string): void => {
      const dk = state.deck
      if (dk && v.trim()) state.apply(setToken(dk.themeStyle, name, v.trim()))
    }

    if (/face/.test(name)) {
      const sel = document.createElement('select')
      sel.className = 'de-tok-face'
      sel.dataset.token = name
      const options = [...FACE_STACKS]
      if (!options.some(([, v]) => v === value)) options.unshift(['current (custom)', value])
      for (const [labelText, stack] of options) {
        const o = document.createElement('option')
        o.textContent = labelText
        o.value = stack
        o.style.fontFamily = stack // the menu previews itself
        if (stack === value) o.selected = true
        sel.append(o)
      }
      sel.addEventListener('change', () => apply(sel.value))
      return [sel]
    }

    if (isColorValue(value)) {
      const swatch = attachPickerProxy(document.createElement('input'))
      swatch.type = 'color'
      swatch.className = 'de-tok-swatch'
      swatch.dataset.token = name
      swatch.value = toHexColor(value)
      const text = document.createElement('input')
      text.type = 'text'
      text.value = value
      text.dataset.token = name
      // dragging the picker previews live; ONE op lands on release
      let before: string | null = null
      swatch.addEventListener('input', () => {
        const dk = state.deck
        const r = dk && themeHostRule(dk)
        if (!r) return
        if (before === null) before = r.style.getPropertyValue(name).trim()
        r.style.setProperty(name, swatch.value) // preview only, no op
        text.value = swatch.value
      })
      swatch.addEventListener('change', () => {
        const dk = state.deck
        const r = dk && themeHostRule(dk)
        if (!r || before === null) { before = null; return }
        r.style.setProperty(name, before) // restore so the op captures true prev
        before = null
        apply(swatch.value)
      })
      text.addEventListener('change', () => { apply(text.value); swatch.value = toHexColor(text.value) })
      return [swatch, text]
    }

    const px = /^(-?[\d.]+)px$/.exec(value)
    if (px) {
      const num = document.createElement('input')
      num.type = 'number'
      num.className = 'de-tok-num'
      num.dataset.token = name
      num.value = px[1]
      num.step = '1'
      num.addEventListener('change', () => apply(`${num.value}px`))
      const unit = h('span', 'de-tok-unit', 'px')
      return [num, unit]
    }

    const input = document.createElement('input')
    input.type = 'text'
    input.value = value
    input.dataset.token = name
    input.addEventListener('change', () => apply(input.value))
    return [input]
  }

  /** update token control values in place (skip the focused one) */
  function refreshTokenValues(): void {
    const d = state.deck
    if (!d) return
    const rule = themeHostRule(d)
    if (!rule) return
    for (const el of tokensBody.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-token]')) {
      if (el === document.activeElement) continue
      const v = rule.style.getPropertyValue(el.dataset.token ?? '').trim()
      if (el instanceof HTMLSelectElement) {
        if (el.value !== v && [...el.options].some((o) => o.value === v)) el.value = v
      } else if (el.type === 'color') {
        const hex = toHexColor(v)
        if (el.value !== hex) el.value = hex
      } else if (el.type === 'number') {
        const n = /^(-?[\d.]+)px$/.exec(v)?.[1] ?? el.value
        if (el.value !== n) el.value = n
      } else if (el.value !== v) {
        el.value = v
      }
    }
  }
}

/* ================= module helpers ================= */

/** curated, self-contained font stacks (system faces only — a deck must not
 * silently depend on webfonts it doesn't embed) */
const FACE_STACKS: Array<[string, string]> = [
  ['Georgia', 'Georgia, "Times New Roman", serif'],
  ['Times', '"Times New Roman", Times, serif'],
  ['Palatino', 'Palatino, "Palatino Linotype", "Book Antiqua", serif'],
  ['Charter', 'Charter, "Bitstream Charter", Cambria, serif'],
  ['System UI', 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'],
  ['Helvetica', 'Helvetica, Arial, sans-serif'],
  ['Verdana', 'Verdana, Geneva, sans-serif'],
  ['Gill Sans', '"Gill Sans", "Trebuchet MS", Calibri, sans-serif'],
  ['Mono (UI)', 'ui-monospace, "SF Mono", Menlo, monospace'],
  ['Courier', '"Courier New", Courier, monospace'],
]

function isColorValue(v: string): boolean {
  if (!v) return false
  const probe = document.createElement('span')
  probe.style.color = ''
  probe.style.color = v
  return probe.style.color !== ''
}

/** canonicalize any CSS color to #rrggbb for <input type=color> */
function toHexColor(css: string): string {
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return '#000000'
  ctx.fillStyle = '#000000'
  try { ctx.fillStyle = css } catch { /* keep fallback */ }
  const v = String(ctx.fillStyle)
  if (/^#[0-9a-f]{6}$/i.test(v)) return v
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v)
  if (m) {
    const hex = (n: string) => Number(n).toString(16).padStart(2, '0')
    return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`
  }
  return '#000000'
}

function installDeckArtifacts(deck: Deck): void {
  if (deck.root.querySelector('style.dia-editor-artifact[data-de-shell]')) return
  const st = document.createElement('style')
  st.className = 'dia-editor-artifact'
  st.setAttribute('data-de-shell', '')
  st.textContent = ARTIFACT_CSS
  deck.root.appendChild(st)
}

function routeAllScenes(deck: Deck): void {
  for (const sc of deck.root.querySelectorAll<SVGSVGElement>('svg.dia-scene')) routeAll(sc)
}

function primaryRole(el: HTMLElement): string {
  return [...el.classList].find((c) => c.startsWith('dia-')) ?? el.tagName.toLowerCase()
}

function cssEscapeIdent(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '')
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  if (text) el.textContent = text
  return el
}

function segButton(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = label
  if (label === 'table') b.className = 'dn-on'
  b.addEventListener('click', onClick)
  return b
}

function dnButton(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'dn-btn'
  b.textContent = label
  b.addEventListener('click', onClick)
  return b
}
