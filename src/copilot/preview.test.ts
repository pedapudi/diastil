/* Staged proposal preview — outside the op log, reversible, cleared by
 * anything that touches real state. */

import { describe, expect, it } from 'vitest'
import { setText, setStyleProp } from '../model/ops'
import { clearPreview, previewIsActive, startPreview } from './preview'
import { state } from '../state'

function el(text: string): HTMLElement {
  const d = document.createElement('div')
  d.textContent = text
  document.body.appendChild(d)
  return d
}

describe('proposal preview', () => {
  it('applies on start, reverts on clear, reports the reason', () => {
    const target = el('before')
    const ops = [setText(target, 'after', 'copilot')]
    let cleared = ''
    startPreview(ops, null, (reason) => { cleared = reason })
    expect(target.textContent).toBe('after')
    expect(previewIsActive(ops)).toBe(true)
    clearPreview('rejected')
    expect(target.textContent).toBe('before')
    expect(cleared).toBe('rejected')
    expect(previewIsActive(ops)).toBe(false)
  })

  it('a newer preview replaces the active one, reverting it first', () => {
    const a = el('alpha')
    const b = el('beta')
    const opsA = [setText(a, 'ALPHA', 'copilot')]
    const opsB = [setStyleProp(b, 'color', 'red', 'copilot')]
    let aCleared = ''
    startPreview(opsA, null, (r) => { aCleared = r })
    startPreview(opsB, null, () => {})
    expect(a.textContent).toBe('alpha') // A reverted
    expect(b.style.color).toBe('red')
    expect(aCleared).toContain('newer proposal')
    clearPreview('done')
  })

  it('a real op through the bus clears the preview (document changed)', () => {
    const target = el('x')
    const ops = [setText(target, 'y', 'copilot')]
    let cleared = ''
    startPreview(ops, null, (r) => { cleared = r })
    state.bus.emit({ type: 'op', entry: { label: 't', author: 'you' } } as never)
    expect(target.textContent).toBe('x')
    expect(cleared).toBe('the document changed')
  })

  it('the badge mounts on the slide as an editor artifact and unmounts', () => {
    const slide = el('slide')
    slide.className = 'dia-slide'
    const target = el('t')
    const ops = [setText(target, 't2', 'copilot')]
    startPreview(ops, slide, () => {})
    const badge = slide.querySelector('.dia-preview-badge')
    expect(badge).not.toBeNull()
    expect(badge?.classList.contains('dia-editor-artifact')).toBe(true)
    clearPreview('rejected', false)
    expect(slide.querySelector('.dia-preview-badge')).toBeNull()
  })

  it('notify=false silences the owning card (accept path)', () => {
    const target = el('n')
    const ops = [setText(target, 'n2', 'copilot')]
    let called = false
    startPreview(ops, null, () => { called = true })
    clearPreview('accepted', false)
    expect(called).toBe(false)
    expect(target.textContent).toBe('n')
  })
})
