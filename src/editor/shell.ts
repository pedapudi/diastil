/* Editor shell: topbar, three-column layout (minimap | main | rail),
 * altitude orchestration with the FLIP lift, global keyboard, and the
 * inspect / copilot / tokens rail. mountEditor(host) builds the whole app. */

import './editor.css'
import '../chrome/tokens.css'
import '../chrome/base.css'
import demoDeckRaw from '../../examples/demo-deck.html?raw'
import type { Altitude, Deck } from '../types'
import { state } from '../state'
import { loadDeck } from '../model/parse'
import { insertEl, setStyleProp, setToken } from '../model/ops'
import { routeAll } from '../scene/route'
import { ensureSceneStyleRules } from '../scene/interact'
import { assignFreshIds } from './slides'
import { mountThemePicker, mountTypePicker } from '../chrome/pickers'
import { mountCopilot } from '../copilot/rail'
import { mountTable, activateTable, deactivateTable, scrollToSlide } from './table'
import { mountStage, enterStage, exitStage, stageFlipTarget } from './stage'
import { mountMinimap } from './minimap'
import { installHistory } from './history'
import { legendOpen, toggleLegend, closeLegend } from './legend'
import { installTextEditing } from './textedit'
import { bootFromCli, openDeck, saveDeck, presentDeck } from './slides'

/* styles that must live inside the deck shadow root; serialization strips
 * style.dia-editor-artifact (slides.ts removes them around serializeDeck) */
const ARTIFACT_CSS = `
section.dia-slide { margin-block: 34px; }
section.dia-slide:first-of-type { margin-block-start: 0; }
section.dia-slide:last-of-type { margin-block-end: 0; }
:host(.dia-stage) section.dia-slide { margin-block: 0; }
:host(.dia-stage) section.dia-slide:not([data-dia-current]) { display: none !important; }
[data-dia-selected] { outline: 1.5px solid var(--accent); outline-offset: 4px; }
/* blank svg areas are click-through by default (visiblePainted) — the scene
 * background must be selectable in the editor for the creation toolbar */
svg.dia-scene { pointer-events: bounding-box; }
[contenteditable] { outline: 2px solid var(--accent); outline-offset: 2px; cursor: text; }
`

export function mountEditor(host: HTMLElement): void {
  host.classList.add('de-app')

  /* ---------- topbar ---------- */

  const topbar = h('header', 'de-topbar')
  const brand = h('div', 'de-brand', 'diastil')
  const crumbs = h('div', 'de-crumbs')

  const seg = h('div', 'dn-seg')
  const segTable = segButton('table', () => state.setAltitude('table'))
  segTable.title = 'all slides in a vertical flow — read, reorder, edit in place'
  const segStage = segButton('stage', () => state.setAltitude('stage'))
  segStage.title = 'one slide fills the view — detail and diagram work (Esc returns)'
  const segPresent = segButton('present', () => { if (state.deck) presentDeck(state.deck) })
  segPresent.title = 'open the saved deck in a new tab, self-running'
  seg.append(segTable, segStage, segPresent)

  const btnOpen = dnButton('open', () => { void openDeck(canvasHost) })
  btnOpen.title = 'open any HTML deck — diastil files load directly; foreign decks convert through review'
  const btnSave = dnButton('save', () => { void doSave() })
  btnSave.title = 'write the deck back as self-contained HTML (⌘S)'

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

  const tabsBar = h('div', 'de-tabs')
  const inspectPane = h('div', 'de-pane de-on')
  const copilotPane = h('div', 'de-pane')
  const tokensPane = h('div', 'de-pane')
  const inspectBody = h('div', 'de-pane-pad')
  const tokensBody = h('div', 'de-pane-pad')
  inspectPane.append(inspectBody)
  tokensPane.append(tokensBody)
  const tabs: Array<{ btn: HTMLButtonElement; pane: HTMLElement }> = []
  for (const [label, pane] of [['inspect', inspectPane], ['copilot', copilotPane], ['tokens', tokensPane]] as const) {
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
  rail.append(tabsBar, inspectPane, copilotPane, tokensPane)

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
        break
      }
      case 'slides-changed': {
        updateCrumbs()
        break
      }
      case 'altitude': {
        onAltitude(e.altitude)
        break
      }
    }
  })

  /* ---------- mount submodules ---------- */

  mountTable(main, canvasHost)
  mountStage(main, canvasHost)
  mountMinimap(minimapEl)
  installTextEditing(canvasHost)
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
    if (state.altitude === 'table') {
      if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); stepSlide(1) }
      else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); stepSlide(-1) }
      else if (e.key === 'Enter') { e.preventDefault(); state.setAltitude('stage') }
      else if (e.key === 'Escape') { state.selection = { kind: 'none' } }
    } else {
      if (e.key === 'ArrowRight') { e.preventDefault(); state.setCurrentSlide(state.currentSlide + 1) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); state.setCurrentSlide(state.currentSlide - 1) }
      else if (e.key === 'Escape') { e.preventDefault(); state.setAltitude('table') }
    }
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

  /* ----- altitude + FLIP lift ----- */

  function onAltitude(a: Altitude): void {
    segTable.classList.toggle('dn-on', a === 'table')
    segStage.classList.toggle('dn-on', a === 'stage')
    const slide = state.slides()[state.currentSlide]
    const from = slide?.getBoundingClientRect() ?? null
    if (a === 'stage') {
      deactivateTable()
      enterStage()
      if (slide && from) flipFrom(stageFlipTarget(), from)
    } else {
      exitStage()
      activateTable(state.currentSlide)
      if (slide && from) flipFrom(slide, from)
    }
    updateCrumbs()
  }

  function flipFrom(el: Element, from: DOMRect): void {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const to = el.getBoundingClientRect()
    if (!from.width || !to.width) return
    const dx = from.left - to.left
    const dy = from.top - to.top
    const s = from.width / to.width
    el.animate(
      [
        { transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${s})` },
        { transformOrigin: '0 0', transform: 'none' },
      ],
      { duration: 200, easing: 'ease' },
    )
  }

  /* ----- crumbs + status ----- */

  function updateCrumbs(): void {
    const d = state.deck
    if (!d) {
      crumbs.textContent = 'no deck'
      return
    }
    const file = h('b', '', d.fileName)
    if (state.altitude === 'table') {
      const n = state.slides().length
      const dirty = tick !== savedTick
      const stateWord = dirty ? h('span', 'de-unsaved', 'unsaved') : document.createTextNode('saved')
      crumbs.replaceChildren(file, document.createTextNode(` · ${n} slides · `), stateWord)
    } else {
      crumbs.replaceChildren(file, document.createTextNode(` · slide ${state.currentSlide + 1} › ${selectionRole()}`))
    }
  }

  function selectionRole(): string {
    const sel = state.selection
    switch (sel.kind) {
      case 'element': return primaryRole(sel.el)
      case 'slide': return 'slide'
      case 'scene-node': return 'scene node'
      case 'scene-edge': return 'scene edge'
      default: return 'slide'
    }
  }

  function updateStatus(): void {
    const d = state.deck
    statusWord.textContent = d ? `valid · v${d.version}` : 'no deck'
  }

  /* ----- inspect pane ----- */

  function renderInspect(): void {
    const d = state.deck
    const sel = state.selection
    inspectBody.replaceChildren()
    if (!d || sel.kind === 'none') {
      inspectBody.append(h('div', 'de-hint', 'click an element in a slide to inspect it'))
      return
    }
    if (sel.kind === 'scene-node' || sel.kind === 'scene-edge') {
      inspectBody.append(
        kv('role', sel.kind === 'scene-node' ? 'scene node' : 'scene edge'),
        h('div', 'de-hint', 'scene selections are edited on the canvas'),
      )
      return
    }
    const el = sel.kind === 'element' ? sel.el : sel.slide
    const slide = sel.slide
    const role = sel.kind === 'element' ? primaryRole(el) : 'dia-slide'
    inspectBody.append(kv('role', role))
    const slideIdx = state.slides().indexOf(slide)
    if (slideIdx >= 0) inspectBody.append(kv('slide', String(slideIdx + 1)))

    if (sel.kind === 'slide') {
      const rowEl = h('div', 'de-style-row')
      rowEl.append(h('span', 'de-style-k', 'insert'))
      const segEl = h('span', 'dn-seg')
      const b = h('button', '', '+ diagram')
      b.type = 'button'
      b.title = 'add an editable scene — shapes, nodes, edges'
      b.addEventListener('click', () => insertDiagram(slide))
      segEl.append(b)
      rowEl.append(segEl)
      inspectBody.append(rowEl)
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
  }

  /** add an empty editable scene to a slide — the scene toolbar takes over
   * from there (+ node, + circle, + square) */
  function insertDiagram(slide: HTMLElement): void {
    ensureSceneStyleRules()
    const fig = document.createElement('div')
    fig.className = 'dia-figure'
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('class', 'dia-scene')
    svg.setAttribute('viewBox', '0 0 480 270')
    fig.appendChild(svg)
    assignFreshIds(fig)
    state.apply(insertEl(slide, slide.children.length, fig, 'InsertDiagram'))
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
      const label = h('span', 'de-tok-name', name)
      label.title = name
      const input = document.createElement('input')
      input.type = 'text'
      input.value = rule.style.getPropertyValue(name).trim()
      input.dataset.token = name
      input.addEventListener('change', () => {
        const dk = state.deck
        if (!dk) return
        state.apply(setToken(dk.themeStyle, name, input.value.trim()))
      })
      row.append(label, input)
      tokensBody.append(row)
    }
  }

  /** update token input values in place (skip the focused one) */
  function refreshTokenValues(): void {
    const d = state.deck
    if (!d) return
    const rule = themeHostRule(d)
    if (!rule) return
    for (const input of tokensBody.querySelectorAll<HTMLInputElement>('input[data-token]')) {
      if (input === document.activeElement) continue
      const v = rule.style.getPropertyValue(input.dataset.token ?? '').trim()
      if (input.value !== v) input.value = v
    }
  }
}

/* ================= module helpers ================= */

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
