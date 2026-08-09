/* The topbar's file doors, driven through the real shell: mount the editor,
 * open the split button's menu, click the items. Only the LOGIC is testable
 * here — happy-dom has no layout, so where the menu lands on screen is not
 * asserted anywhere.
 *
 * The case that earns this file: the guard between an unsaved file and the
 * next one. It only exists in the wiring (the shell owns the dirty bit), so
 * a unit test of confirmReplace alone would pass with the door unguarded. */

import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mountEditor } from './shell'
import { state } from '../state'
import { setAttr } from '../model/ops'

// the copilot rail polls the local service on mount; nothing here needs it
vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))

let app: HTMLElement

beforeAll(async () => {
  app = document.createElement('div')
  document.body.append(app)
  mountEditor(app)
  await new Promise((r) => setTimeout(r, 50)) // the boot promise settles
})

/** open the topbar's open-split menu and click one of its items */
function clickFileMenuItem(label: string): void {
  const caret = [...app.querySelectorAll('button')].find((b) => b.title === 'open & new…')
  expect(caret, 'the open split button carries a caret').toBeTruthy()
  caret!.click()
  const item = [...document.querySelectorAll<HTMLButtonElement>('.de-menu button')]
    .find((b) => b.textContent === label)
  expect(item, `the menu offers "${label}"`).toBeTruthy()
  item!.click()
}

/** edit the open file the way every editor surface does — one op through
 * the log, which is exactly what the shell counts as unsaved work */
function edit(): void {
  const el = (state.doc?.article ?? state.deck?.root.querySelector('section.dia-slide')) as HTMLElement
  state.apply(setAttr(el, 'data-dia-part', 'edited'))
}

describe('the topbar file doors', () => {
  it('boots on the demo deck', () => {
    expect(state.deck?.fileName).toBe('demo-deck.html')
  })

  it('offers open, a new deck and a new document', () => {
    const caret = [...app.querySelectorAll('button')].find((b) => b.title === 'open & new…')
    caret!.click()
    const labels = [...document.querySelectorAll('.de-menu button')].map((b) => b.textContent)
    expect(labels).toEqual(['open…', 'new deck', 'new document'])
  })

  it('starts a document when nothing is at stake, without asking', () => {
    const ask = vi.fn(() => false)
    vi.stubGlobal('confirm', ask)
    clickFileMenuItem('new document')
    expect(ask).not.toHaveBeenCalled()
    expect(state.doc?.texName).toBe('untitled.tex')
    expect(state.deck).toBeNull()
  })

  it('keeps an edited document when the user declines', () => {
    edit()
    const before = state.doc
    vi.stubGlobal('confirm', vi.fn(() => false))
    clickFileMenuItem('new deck')
    expect(state.doc).toBe(before)
    expect(state.deck).toBeNull()
  })

  it('replaces it once the user accepts', () => {
    const ask = vi.fn((_message: string) => true)
    vi.stubGlobal('confirm', ask)
    clickFileMenuItem('new deck')
    expect(ask.mock.calls[0][0]).toContain('Start a new deck?')
    expect(state.deck?.fileName).toBe('untitled.html')
    expect(state.doc).toBeNull()
  })

  it('guards the open door with the same gate', () => {
    edit()
    vi.stubGlobal('confirm', vi.fn(() => false))
    const picker = vi.fn()
    vi.stubGlobal('showOpenFilePicker', picker)
    clickFileMenuItem('open…')
    expect(picker, 'a declined prompt never reaches the file picker').not.toHaveBeenCalled()
  })
})
