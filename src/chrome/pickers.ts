// chrome/pickers.ts — the zicato color-theme + typeface pickers, faithfully.
//
// Two popover pickers in the dt-cd idiom (trigger + panel listbox):
//   • mountThemePicker — the swatch dropdown. The closed control is the current
//     theme name + a 6-chip swatch strip (paper · panel · ink · good · bad ·
//     accent — the legibility preview) + a caret; opening reveals a listbox of
//     all 16 themes, each row its own swatch strip + name.
//   • mountTypePicker — the grouped popover. Three mode headers (Technical ·
//     Editorial · Display) over 12 options, each rendered as a TRUE type
//     specimen (label in its own head face over a faint sample line in its body
//     face), with an S/M/L text-size segmented control in the footer.
//
// Selections stamp data-theme / data-type / data-fontsize (+ --dt-font-scale)
// on <html> and persist to localStorage (diastil.theme / .type / .fontsize).
// initChromePrefs() replays the persisted choices before mount. Every mounted
// instance registers a setValue so a change by ANY path keeps all triggers +
// selected rows in lockstep. Fully keyboard-accessible: Enter/Space/ArrowDown
// open, ArrowUp/ArrowDown move (skipping group headers), Enter/Space select,
// Esc closes back to the trigger; a click outside also closes; opening one
// picker closes the other.
//
// The preview swatch hexes are deliberately hardcoded here (lifted verbatim
// from tokens.css): each row must preview ITS theme, not the active one, so
// the strips cannot read the live role tokens. Everything else is token-only.

import './chrome.css'
import { hov } from './hovercard'

// ---------------------------------------------------------------- storage --

const THEME_KEY = 'diastil.theme'
const TYPE_KEY = 'diastil.type'
const SIZE_KEY = 'diastil.fontsize'

function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* private mode / quota — the choice still applies for this session */
  }
}

// ------------------------------------------------------------ the 16 themes --
// [id, label, [paper, panel, ink, good, bad, accent]] — tokens.css order,
// preview hexes lifted exactly from tokens.css (lunaria-eclipse's #C8429F IS
// its real accent; no substitution needed).

type Swatches = readonly [string, string, string, string, string, string]

const COLOR_THEMES: ReadonlyArray<readonly [string, string, Swatches]> = [
  ['monokai', 'monokai', ['#1e1f1c', '#272822', '#f8f8f2', '#a6e22e', '#f92672', '#66d9ef']],
  ['solarized-dark', 'solarized dark', ['#04222B', '#0A2D38', '#93A1A1', '#8BB80E', '#E0483C', '#2AA198']],
  ['solarized-light', 'solarized light', ['#FDF6E3', '#FBF1D6', '#586E75', '#6B9B0B', '#DC322F', '#268BD2']],
  ['google-light', 'google light', ['#FFFFFF', '#F4F4F4', '#474A4E', '#34A853', '#EA4335', '#1B9CB8']],
  ['google-dark', 'google dark', ['#202124', '#2C2D30', '#FFFFFF', '#34A853', '#EA4335', '#24C1E0']],
  ['lunaria-light', 'lunaria light', ['#EBE4E1', '#E2DCD9', '#363434', '#497D46', '#783C1F', '#3778A9']],
  ['lunaria-eclipse', 'lunaria eclipse', ['#323F46', '#3B484F', '#DFE2ED', '#BEDBC1', '#BA9088', '#C8429F']],
  ['belafonte-day', 'belafonte day', ['#D5CCBA', '#CCC3B2', '#34292D', '#6E6A4E', '#BE100E', '#426A79']],
  ['belafonte-night', 'belafonte night', ['#20111B', '#271821', '#D5CCBA', '#A6A07A', '#D6403E', '#6F8E97']],
  ['paper', 'paper', ['#F2EEDE', '#E6E2D3', '#1A1A1A', '#216609', '#CC3E28', '#1E6FCC']],
  ['zenburn', 'zenburn', ['#3A3A3A', '#424241', '#DCDCCC', '#8FB28F', '#CC9393', '#8CD0D3']],
  ['selenized-black', 'selenized black', ['#181818', '#202020', '#DEDEDE', '#83C746', '#FF5E56', '#56D8C9']],
  ['relaxed', 'relaxed', ['#353A44', '#3D424B', '#F7F7F7', '#A0AC77', '#BC5653', '#7EAAC7']],
  ['espresso', 'espresso', ['#323232', '#3A3A3A', '#FFFFFF', '#A5C261', '#D25252', '#6C99BB']],
  ['dracula', 'dracula', ['#282A36', '#343746', '#F8F8F2', '#50FA7B', '#FF5555', '#BD93F9']],
  ['ubuntu', 'ubuntu', ['#300A24', '#3D1530', '#EEEEEC', '#8AE234', '#CC0000', '#34E2E2']],
]

const THEME_DEFAULT = 'monokai'
const themeById = new Map(COLOR_THEMES.map((t) => [t[0], t]))

function normalizeTheme(v: string | null | undefined): string {
  return v && themeById.has(v) ? v : THEME_DEFAULT
}

// ---------------------------------------------------------- the 12 typefaces --
// Head/body stacks lifted verbatim from tokens.css so each option's specimen
// renders in its REAL faces regardless of the active data-type.

interface TypeOption {
  readonly id: string
  readonly label: string
  readonly group: 'Technical' | 'Editorial' | 'Display'
  readonly head: string // the heading face stack — the option label renders in it
  readonly body: string // the body face stack — the sample line renders in it
}

const MONO_GSM = '"Google Sans Mono","Noto Sans Mono",ui-monospace,monospace'
const SANS_GROTESK = '"Space Grotesk",system-ui,sans-serif'

const TYPE_OPTIONS: readonly TypeOption[] = [
  // Technical
  { id: 'T7', label: 'Google Sans Mono', group: 'Technical', head: MONO_GSM, body: MONO_GSM },
  { id: 'T9', label: 'Source Sans 3 + Source Code Pro', group: 'Technical',
    head: '"Source Sans 3",system-ui,sans-serif', body: '"Source Sans 3",system-ui,sans-serif' },
  { id: 'T12', label: 'Inconsolata', group: 'Technical',
    head: '"Inconsolata",ui-monospace,monospace', body: '"Inconsolata",ui-monospace,monospace' },
  { id: 'T14', label: 'Ubuntu + Ubuntu Mono', group: 'Technical',
    head: '"Ubuntu",system-ui,sans-serif', body: '"Ubuntu",system-ui,sans-serif' },
  // Editorial
  { id: 'E5', label: 'Fraunces', group: 'Editorial',
    head: '"Fraunces",Georgia,serif', body: '"Fraunces",Georgia,serif' },
  { id: 'E7', label: 'Bitter', group: 'Editorial',
    head: '"Bitter",Georgia,serif', body: '"Bitter",Georgia,serif' },
  { id: 'E8', label: 'Literata', group: 'Editorial',
    head: '"Literata",Georgia,serif', body: '"Literata",Georgia,serif' },
  { id: 'E15', label: 'Domine', group: 'Editorial',
    head: '"Domine",Georgia,serif', body: '"Domine",Georgia,serif' },
  // Display
  { id: 'D2', label: 'Archivo Narrow + Space Grotesk', group: 'Display',
    head: `"Archivo Narrow",${SANS_GROTESK}`, body: SANS_GROTESK },
  { id: 'D12', label: 'Hanken Grotesk', group: 'Display',
    head: '"Hanken Grotesk",system-ui,sans-serif', body: '"Hanken Grotesk",system-ui,sans-serif' },
  { id: 'D14', label: 'Barlow Condensed + Space Grotesk', group: 'Display',
    head: '"Barlow Condensed","Archivo Narrow",system-ui,sans-serif', body: SANS_GROTESK },
  { id: 'D5', label: 'Bricolage Grotesque', group: 'Display',
    head: '"Bricolage Grotesque",system-ui,sans-serif', body: '"Bricolage Grotesque",system-ui,sans-serif' },
]

const TYPE_GROUPS = ['Technical', 'Editorial', 'Display'] as const
const TYPE_DEFAULT = 'T7'
const typeById = new Map(TYPE_OPTIONS.map((o) => [o.id, o]))

function normalizeType(v: string | null | undefined): string {
  return v && typeById.has(v) ? v : TYPE_DEFAULT
}

const SAMPLE_LINE = 'the quick brown fox 0123'

// ------------------------------------------------------------ the text sizes --

const FONT_SIZES: ReadonlyArray<{ id: string; label: string; scale: number; tip: string }> = [
  { id: 'S', label: 'S', scale: 1, tip: 'small text (1.0×)' },
  { id: 'M', label: 'M', scale: 1.15, tip: 'medium text (1.15×)' },
  { id: 'L', label: 'L', scale: 1.3, tip: 'large text (1.3×)' },
]

const SIZE_DEFAULT = 'S'

function normalizeSize(v: string | null | undefined): string {
  return v && FONT_SIZES.some((s) => s.id === v) ? v : SIZE_DEFAULT
}

// ------------------------------------------------------------- apply + sync --
// Every mounted picker registers a setValue; applying a choice by ANY path
// (either picker instance, restore) fans out so all triggers stay in lockstep.

const themeInstances = new Set<(id: string) => void>()
const typeInstances = new Set<(id: string) => void>()
const sizeInstances = new Set<(id: string) => void>()

function applyTheme(id: string, persist: boolean): void {
  const v = normalizeTheme(id)
  document.documentElement.setAttribute('data-theme', v)
  if (persist) writePref(THEME_KEY, v)
  for (const sync of themeInstances) sync(v)
}

function applyType(id: string, persist: boolean): void {
  const v = normalizeType(id)
  document.documentElement.setAttribute('data-type', v)
  if (persist) writePref(TYPE_KEY, v)
  for (const sync of typeInstances) sync(v)
}

function applyFontSize(id: string, persist: boolean): void {
  const v = normalizeSize(id)
  const def = FONT_SIZES.find((s) => s.id === v) ?? FONT_SIZES[0]
  document.documentElement.setAttribute('data-fontsize', v)
  document.documentElement.style.setProperty('--dt-font-scale', String(def.scale))
  if (persist) writePref(SIZE_KEY, v)
  for (const sync of sizeInstances) sync(v)
}

// Replay the persisted appearance prefs onto <html> — called before mount so
// the first paint is already in the operator's theme/face/size.
export function initChromePrefs(): void {
  applyTheme(normalizeTheme(readPref(THEME_KEY)), false)
  applyType(normalizeType(readPref(TYPE_KEY)), false)
  applyFontSize(normalizeSize(readPref(SIZE_KEY)), false)
}

// ------------------------------------------------------------- DOM helpers --

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

// the 6-chip swatch strip (paper · panel · ink · good · bad · accent)
function swatchStrip(swatches: Swatches): HTMLSpanElement {
  const strip = el('span', 'dt-swatch-strip')
  strip.setAttribute('aria-hidden', 'true')
  for (const c of swatches) {
    const chip = el('span', 'dt-swatch')
    chip.style.background = c
    strip.appendChild(chip)
  }
  return strip
}

// ONE picker open at a time — opening any picker closes the other.
let closeOpenPicker: (() => void) | null = null

// -------------------------------------------------------- the theme picker --

export function mountThemePicker(host: HTMLElement): void {
  let value = normalizeTheme(document.documentElement.getAttribute('data-theme'))
  let open = false

  const themeOf = (id: string) => themeById.get(id) ?? COLOR_THEMES[0]

  const triggerName = el('span', 'dt-cd-name', themeOf(value)[1])
  let triggerStrip = swatchStrip(themeOf(value)[2])
  const caret = el('span', 'dt-cd-caret', '▾')
  caret.setAttribute('aria-hidden', 'true')
  const trigger = el('button', 'dt-cd-trigger')
  trigger.type = 'button'
  trigger.setAttribute('aria-haspopup', 'listbox')
  trigger.setAttribute('aria-expanded', 'false')
  trigger.setAttribute('aria-label', 'Color theme')
  trigger.append(triggerName, triggerStrip, caret)
  hov(trigger, 'color theme')

  const options = COLOR_THEMES.map(([id, label, swatches]) => {
    const opt = el('div', 'dt-cd-option')
    opt.setAttribute('role', 'option')
    opt.setAttribute('data-theme', id)
    opt.setAttribute('aria-selected', String(id === value))
    opt.tabIndex = -1
    opt.append(swatchStrip(swatches), el('span', 'dt-cd-name', label))
    opt.addEventListener('click', () => choose(id))
    return opt
  })

  const listbox = el('div', 'dt-cd-list dn-panel')
  listbox.setAttribute('role', 'listbox')
  listbox.setAttribute('aria-label', 'Color theme')
  listbox.tabIndex = -1
  listbox.append(...options)

  const node = el('div', 'dt-cd')
  node.setAttribute('role', 'group')
  node.setAttribute('aria-label', 'Color theme')
  node.append(trigger, listbox)

  let activeIdx = Math.max(0, COLOR_THEMES.findIndex((t) => t[0] === value))
  function setActive(i: number): void {
    activeIdx = (i + options.length) % options.length
    options.forEach((o, k) => o.classList.toggle('dt-cd-active', k === activeIdx))
    options[activeIdx].scrollIntoView({ block: 'nearest' })
  }
  function setOpen(next: boolean): void {
    if (next && closeOpenPicker && closeOpenPicker !== close) closeOpenPicker()
    open = next
    node.classList.toggle('dt-cd-open', open)
    trigger.setAttribute('aria-expanded', String(open))
    if (open) {
      closeOpenPicker = close
      setActive(Math.max(0, COLOR_THEMES.findIndex((t) => t[0] === value)))
      listbox.focus()
    } else if (closeOpenPicker === close) {
      closeOpenPicker = null
    }
  }
  const close = () => setOpen(false)
  function choose(id: string): void {
    applyTheme(id, true) // fans out to setValue on every instance, incl. this one
    setOpen(false)
    trigger.focus()
  }
  function setValue(v: string): void {
    value = normalizeTheme(v)
    const def = themeOf(value)
    triggerName.textContent = def[1]
    const fresh = swatchStrip(def[2])
    triggerStrip.replaceWith(fresh)
    triggerStrip = fresh
    for (const o of options) {
      o.setAttribute('aria-selected', String(o.getAttribute('data-theme') === value))
    }
  }

  trigger.addEventListener('click', () => setOpen(!open))
  node.addEventListener('keydown', (ev) => {
    const k = ev.key
    if (!open) {
      if (k === 'ArrowDown' || k === 'Enter' || k === ' ') {
        ev.preventDefault()
        setOpen(true)
      }
      return
    }
    if (k === 'Escape') {
      ev.preventDefault()
      setOpen(false)
      trigger.focus()
    } else if (k === 'ArrowDown') {
      ev.preventDefault()
      setActive(activeIdx + 1)
    } else if (k === 'ArrowUp') {
      ev.preventDefault()
      setActive(activeIdx - 1)
    } else if (k === 'Enter' || k === ' ') {
      ev.preventDefault()
      const id = options[activeIdx]?.getAttribute('data-theme')
      if (id) choose(id)
    }
  })
  document.addEventListener('click', (ev) => {
    if (open && !node.contains(ev.target as Node)) setOpen(false)
  })

  themeInstances.add(setValue)
  host.appendChild(node)
}

// ----------------------------------------------------- the typeface picker --

export function mountTypePicker(host: HTMLElement): void {
  let value = normalizeType(document.documentElement.getAttribute('data-type'))
  let open = false

  const optOf = (id: string) => typeById.get(id) ?? TYPE_OPTIONS[0]

  // trigger: current face name + a micro-specimen ("Ag" in that face)
  const triggerName = el('span', 'dt-cd-name', optOf(value).label)
  const triggerSpec = el('span', 'dt-tf-spec', 'Ag')
  triggerSpec.setAttribute('aria-hidden', 'true')
  triggerSpec.style.fontFamily = optOf(value).head
  const caret = el('span', 'dt-cd-caret', '▾')
  caret.setAttribute('aria-hidden', 'true')
  const trigger = el('button', 'dt-cd-trigger dt-tf-trigger')
  trigger.type = 'button'
  trigger.setAttribute('aria-haspopup', 'listbox')
  trigger.setAttribute('aria-expanded', 'false')
  trigger.setAttribute('aria-label', 'Typeface')
  trigger.append(triggerName, triggerSpec, caret)
  hov(trigger, 'typeface & text size')

  // the grouped listbox — headers are presentational; `options` is the FLAT
  // ordered list of selectable rows so keyboard nav skips the headers cleanly.
  const options: HTMLDivElement[] = []
  const listbox = el('div', 'dt-tf-list')
  listbox.setAttribute('role', 'listbox')
  listbox.setAttribute('aria-label', 'Typeface')
  listbox.tabIndex = -1
  for (const group of TYPE_GROUPS) {
    const head = el('div', 'dn-subhead dt-tf-group', group)
    head.setAttribute('role', 'presentation')
    head.setAttribute('aria-hidden', 'true')
    listbox.appendChild(head)
    for (const o of TYPE_OPTIONS.filter((x) => x.group === group)) {
      const name = el('span', 'dt-tf-name', o.label)
      name.style.fontFamily = o.head
      const sample = el('span', 'dt-tf-sample', SAMPLE_LINE)
      sample.style.fontFamily = o.body
      sample.setAttribute('aria-hidden', 'true')
      const opt = el('div', 'dt-tf-option')
      opt.setAttribute('role', 'option')
      opt.setAttribute('data-type', o.id)
      opt.setAttribute('aria-selected', String(o.id === value))
      opt.tabIndex = -1
      opt.append(name, sample)
      opt.addEventListener('click', () => choose(o.id))
      options.push(opt)
      listbox.appendChild(opt)
    }
  }

  // footer: the S/M/L text-size segmented control
  let size = normalizeSize(document.documentElement.getAttribute('data-fontsize'))
  const segButtons: HTMLButtonElement[] = []
  const seg = el('div', 'dn-seg')
  seg.setAttribute('role', 'radiogroup')
  seg.setAttribute('aria-label', 'Text size')
  FONT_SIZES.forEach((s, i) => {
    const b = el('button', s.id === size ? 'dn-on' : '', s.label)
    b.type = 'button'
    b.setAttribute('role', 'radio')
    b.setAttribute('data-fontsize', s.id)
    b.setAttribute('aria-checked', String(s.id === size))
    b.setAttribute('aria-label', s.tip)
    hov(b, s.tip)
    b.addEventListener('click', () => applyFontSize(s.id, true))
    b.addEventListener('keydown', (ev) => {
      const dir = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0
      if (!dir) return
      ev.preventDefault()
      const next = FONT_SIZES[(i + dir + FONT_SIZES.length) % FONT_SIZES.length]
      applyFontSize(next.id, true)
      segButtons[FONT_SIZES.findIndex((x) => x.id === next.id)]?.focus()
    })
    segButtons.push(b)
    seg.appendChild(b)
  })
  function setSize(v: string): void {
    size = normalizeSize(v)
    for (const b of segButtons) {
      const on = b.getAttribute('data-fontsize') === size
      b.classList.toggle('dn-on', on)
      b.setAttribute('aria-checked', String(on))
    }
  }
  const foot = el('div', 'dt-tf-foot')
  foot.append(el('span', 'dn-subhead', 'size'), seg)

  const popover = el('div', 'dt-tf-pop dn-panel')
  popover.append(listbox, foot)

  const node = el('div', 'dt-cd dt-tf')
  node.setAttribute('role', 'group')
  node.setAttribute('aria-label', 'Typeface')
  node.append(trigger, popover)

  const idxOf = (v: string) => options.findIndex((o) => o.getAttribute('data-type') === v)
  let activeIdx = Math.max(0, idxOf(value))
  function setActive(i: number): void {
    activeIdx = (i + options.length) % options.length
    options.forEach((o, k) => o.classList.toggle('dt-cd-active', k === activeIdx))
    options[activeIdx].scrollIntoView({ block: 'nearest' })
  }
  function setOpen(next: boolean): void {
    if (next && closeOpenPicker && closeOpenPicker !== close) closeOpenPicker()
    open = next
    node.classList.toggle('dt-cd-open', open)
    trigger.setAttribute('aria-expanded', String(open))
    if (open) {
      closeOpenPicker = close
      setActive(Math.max(0, idxOf(value)))
      listbox.focus()
    } else if (closeOpenPicker === close) {
      closeOpenPicker = null
    }
  }
  const close = () => setOpen(false)
  function choose(id: string): void {
    applyType(id, true) // fans out to setValue on every instance, incl. this one
    setOpen(false)
    trigger.focus()
  }
  function setValue(v: string): void {
    value = normalizeType(v)
    const def = optOf(value)
    triggerName.textContent = def.label
    triggerSpec.style.fontFamily = def.head
    for (const o of options) {
      o.setAttribute('aria-selected', String(o.getAttribute('data-type') === value))
    }
  }

  trigger.addEventListener('click', () => setOpen(!open))
  node.addEventListener('keydown', (ev) => {
    const k = ev.key
    if (!open) {
      if (k === 'ArrowDown' || k === 'Enter' || k === ' ') {
        ev.preventDefault()
        setOpen(true)
      }
      return
    }
    if (k === 'Escape') {
      ev.preventDefault()
      setOpen(false)
      trigger.focus()
      return
    }
    // keys inside the S/M/L footer belong to the segmented control
    if (foot.contains(ev.target as Node)) return
    if (k === 'ArrowDown') {
      ev.preventDefault()
      setActive(activeIdx + 1)
    } else if (k === 'ArrowUp') {
      ev.preventDefault()
      setActive(activeIdx - 1)
    } else if (k === 'Enter' || k === ' ') {
      ev.preventDefault()
      const id = options[activeIdx]?.getAttribute('data-type')
      if (id) choose(id)
    }
  })
  document.addEventListener('click', (ev) => {
    if (open && !node.contains(ev.target as Node)) setOpen(false)
  })

  typeInstances.add(setValue)
  sizeInstances.add(setSize)
  host.appendChild(node)
}
