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
import { insertEl, setAttr, setStyleProp, setToken } from '../model/ops'
import { routeAll } from '../scene/route'
import {
  ensureSceneStyleRules, getDrawTool, insertShapeNode, setDrawTool,
} from '../scene/interact'
import { assignFreshIds } from './slides'
import { mountThemePicker, mountTypePicker } from '../chrome/pickers'
import { mountCopilot } from '../copilot/rail'
import { mountTable, scrollToSlide } from './table'
import { mountMinimap } from './minimap'
import { installHistory } from './history'
import { installElementDragging } from './elemdrag'
import { legendOpen, toggleLegend, closeLegend } from './legend'
import { installTextEditing } from './textedit'
import { buildSlideTree } from './tree'
import { bootFromCli, openDeck, saveDeck, presentDeck } from './slides'

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
`

export function mountEditor(host: HTMLElement): void {
  host.classList.add('de-app')

  /* ---------- topbar ---------- */

  const topbar = h('header', 'de-topbar')
  const brand = h('div', 'de-brand', 'diastil')
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

  topbar.append(brand, crumbs, h('div', 'de-spacer'), seg, btnOpen, btnSave, pickerSlot, status)

  /* ---------- layout ---------- */

  const layout = h('div', 'de-layout')
  const minimapEl = h('aside', 'de-minimap')
  const main = h('div', 'de-main')
  const rail = h('aside', 'de-rail')
  layout.append(minimapEl, main, rail)
  host.append(topbar, layout)

  const canvasHost = h('div', 'de-canvas')
  canvasHost.id = 'deck-host' // ingest loads accepted imports through this id

  /* ---------- rail: inspect · copilot · tokens ---------- */

  // rail anatomy: [tabs: inspect · tokens · copilot] scrollable top region,
  // a drag-resizable divider, then the copilot DOCK — always present (chat
  // is a companion, not a mode). The 'copilot' tab MAXIMIZES the same chat
  // to the full rail (enabled once the service is reachable); the other
  // tabs return it to the dock.
  const tabsBar = h('div', 'de-tabs')
  const inspectPane = h('div', 'de-pane de-on')
  const tokensPane = h('div', 'de-pane')
  const copilotFullPane = h('div', 'de-pane')
  const copilotPane = h('div', 'de-cop-dock') // the chat element; lives in the dock or the full pane
  const inspectBody = h('div', 'de-pane-pad')
  const tokensBody = h('div', 'de-pane-pad')
  inspectPane.append(inspectBody)
  tokensPane.append(tokensBody)
  const tabs: Array<{ btn: HTMLButtonElement; pane: HTMLElement }> = []
  let copilotTabBtn!: HTMLButtonElement
  for (const [label, pane] of [
    ['inspect', inspectPane], ['tokens', tokensPane], ['copilot', copilotFullPane],
  ] as const) {
    const btn = h('button', label === 'inspect' ? 'de-on' : '', label)
    btn.type = 'button'
    btn.addEventListener('click', () => {
      if (btn.disabled) return
      for (const t of tabs) {
        t.btn.classList.toggle('de-on', t.btn === btn)
        t.pane.classList.toggle('de-on', t.pane === pane)
      }
      const maximized = pane === copilotFullPane
      rail.classList.toggle('de-cop-max', maximized)
      if (maximized) copilotFullPane.append(copilotPane)
      else railDockSlot.append(copilotPane)
      if (pane === tokensPane) renderTokens()
    })
    tabsBar.append(btn)
    tabs.push({ btn, pane })
    if (label === 'copilot') copilotTabBtn = btn
  }
  copilotTabBtn.disabled = true
  copilotTabBtn.title = 'maximize the copilot (needs the dia service)'
  window.addEventListener('dia-service-status', (e) => {
    const online = (e as CustomEvent).detail?.online === true
    copilotTabBtn.disabled = !online
    copilotTabBtn.title = online
      ? 'maximize the copilot to the full rail'
      : 'maximize the copilot (needs the dia service)'
    if (!online && rail.classList.contains('de-cop-max')) tabs[0].btn.click()
  })
  const railHide = h('button', 'de-rail-hide', '⇥')
  railHide.type = 'button'
  railHide.title = 'hide the rail (\\)'
  railHide.addEventListener('click', () => setRail(false))
  tabsBar.append(railHide)

  const railTop = h('div', 'de-rail-top')
  railTop.append(tabsBar, inspectPane, tokensPane, copilotFullPane)
  const railDockSlot = h('div', 'de-cop-slot')
  railDockSlot.append(copilotPane)

  const split = h('div', 'de-rail-split')
  split.title = 'drag to resize the copilot'
  split.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    const railRect = rail.getBoundingClientRect()
    const ac = new AbortController()
    const apply = (clientY: number): void => {
      const px = Math.min(Math.max(railRect.bottom - clientY, 140), railRect.height - 140)
      rail.style.setProperty('--de-cop-h', `${Math.round(px)}px`)
    }
    window.addEventListener('pointermove', (ev) => apply(ev.clientY), { signal: ac.signal })
    window.addEventListener('pointerup', () => {
      ac.abort()
      try { localStorage.setItem('dia-cop-h', rail.style.getPropertyValue('--de-cop-h')) } catch { /* private mode */ }
    }, { signal: ac.signal })
  })
  try {
    const saved = localStorage.getItem('dia-cop-h')
    if (saved) rail.style.setProperty('--de-cop-h', saved)
  } catch { /* private mode */ }

  // rail width: drag the left edge (persisted); the dock divider handles height
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

  rail.append(railTop, split, railDockSlot, widthGrip)

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
        segEl.append(b)
        rowEl.append(segEl)
        inspectBody.append(rowEl)
      }

      // per-slide background: token options + a free color swatch
      const bgRow = styleSeg('bg', slide, 'background', [
        ['auto', ''], ['paper', 'var(--dia-paper)'], ['rule', 'var(--dia-rule)'], ['accent', 'var(--dia-accent)'],
      ])
      const swatch = document.createElement('input')
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
    }

    // a selected svg (scene background click) gets CREATION tools here in
    // the stable rail — floating bars are reserved for concrete selections
    if (sel.kind === 'element' && (el as unknown as Element) instanceof SVGSVGElement) {
      inspectBody.append(...sceneToolRows(el as unknown as SVGSVGElement))
      appendTree()
      return
    }

    if (sel.kind === 'element') {
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
      inspectBody.append(
        styleSeg('size', el, 'font-size', [
          ['auto', ''],
          ...[1, 2, 3, 4, 5, 6, 7].map((n) => [`${n}`, `var(--dia-scale-${n})`] as [string, string]),
        ]),
        styleSeg('face', el, 'font-family', [
          ['auto', ''], ['display', 'var(--dia-face-display)'],
          ['body', 'var(--dia-face-body)'], ['label', 'var(--dia-face-label)'],
        ]),
        styleSeg('ink', el, 'color', [
          ['auto', ''], ['ink', 'var(--dia-ink)'],
          ['soft', 'var(--dia-ink-soft)'], ['accent', 'var(--dia-accent)'],
        ]),
      )

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
      for (const [labelText, kind] of [['+ node', 'node'], ['+ circle', 'circle'], ['+ square', 'square']] as const) {
        const b = h('button', '', labelText)
        b.type = 'button'
        b.addEventListener('click', () => insertShapeNode(scene, kind))
        seg.append(b)
      }
      r.append(seg)
      rows.push(r)
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
      const swatch = document.createElement('input')
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
