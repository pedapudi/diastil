/* Op log invariants: every op's invert() is exact, undo walks back to the
 * initial document, redo replays to the final one — including under seeded
 * random op sequences (the property the whole editor rests on). */

import { describe, expect, it } from 'vitest'
import { EditorState } from '../state'
import { batch, insertEl, moveEl, removeEl, setAttr, setStyleProp, setText } from './ops'

function fixture(): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML =
    '<section class="dia-slide"><h1 class="dia-title">one</h1><p class="dia-body">a</p><p class="dia-body">b</p></section>' +
    '<section class="dia-slide"><h1 class="dia-title">two</h1><p class="dia-body">c</p></section>'
  document.body.appendChild(root)
  return root
}

describe('op inversion', () => {
  it('setText / setAttr / setStyleProp invert exactly', () => {
    const root = fixture()
    const title = root.querySelector<HTMLElement>('.dia-title')!
    const before = root.innerHTML
    for (const op of [
      setText(title, 'changed'),
      setAttr(title, 'data-dia-step', '2'),
      setStyleProp(title, 'letter-spacing', '0.1em'),
    ]) {
      op.apply()
      expect(root.innerHTML).not.toBe(before)
      op.invert().apply()
      expect(root.innerHTML).toBe(before)
    }
  })

  it('insert / remove / move invert exactly', () => {
    const root = fixture()
    const [s1, s2] = [...root.querySelectorAll('section')]
    const before = root.innerHTML

    const p = document.createElement('p')
    p.textContent = 'new'
    const ins = insertEl(s1, 1, p)
    ins.apply()
    expect(s1.children[1]).toBe(p)
    ins.invert().apply()
    expect(root.innerHTML).toBe(before)

    const rem = removeEl(s1.children[1])
    rem.apply()
    rem.invert().apply()
    expect(root.innerHTML).toBe(before)

    const mv = moveEl(s1.children[2], s2, 0)
    mv.apply()
    expect(s2.children[0].textContent).toBe('b')
    mv.invert().apply()
    expect(root.innerHTML).toBe(before)
  })

  it('batch inverts in reverse order', () => {
    const root = fixture()
    const title = root.querySelector<HTMLElement>('.dia-title')!
    const before = root.innerHTML
    const op = batch('restyle', [setText(title, 'x'), setText(title, 'y')])
    op.apply()
    expect(title.textContent).toBe('y')
    op.invert().apply()
    expect(root.innerHTML).toBe(before)
  })
})

describe('op log', () => {
  it('undo/redo walk the exact document states', () => {
    const root = fixture()
    const st = new EditorState()
    const title = root.querySelectorAll<HTMLElement>('.dia-title')

    const initial = root.innerHTML
    st.apply(setText(title[0], 'ONE'))
    const mid = root.innerHTML
    st.apply(setText(title[1], 'TWO'))
    const final = root.innerHTML

    st.undo()
    expect(root.innerHTML).toBe(mid)
    st.undo()
    expect(root.innerHTML).toBe(initial)
    st.redo()
    st.redo()
    expect(root.innerHTML).toBe(final)
  })

  it('a new op clears the redo stack', () => {
    const root = fixture()
    const st = new EditorState()
    const title = root.querySelector<HTMLElement>('.dia-title')!
    st.apply(setText(title, 'A'))
    st.undo()
    st.apply(setText(title, 'B'))
    expect(st.log.entries.length).toBe(1)
    st.redo() // must be a no-op
    expect(title.textContent).toBe('B')
  })

  it('property: seeded random op sequences undo to initial and redo to final', () => {
    for (const seed of [1, 42, 2026]) {
      const root = fixture()
      const st = new EditorState()
      const rand = mulberry32(seed)
      const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]

      const initial = root.innerHTML
      const states: string[] = []
      for (let i = 0; i < 60; i++) {
        const els = [...root.querySelectorAll<HTMLElement>('section, h1, p')]
        const el = pick(els)
        const kind = pick(['text', 'attr', 'style', 'insert', 'remove', 'move'] as const)
        if (kind === 'text') st.apply(setText(el, `t${i}`))
        else if (kind === 'attr') st.apply(setAttr(el, 'data-dia-emphasis', rand() > 0.5 ? `e${i}` : null))
        else if (kind === 'style') st.apply(setStyleProp(el, 'margin-top', `${Math.floor(rand() * 40)}px`))
        else if (kind === 'insert') {
          const p = document.createElement('p')
          p.textContent = `new${i}`
          st.apply(insertEl(pick([...root.querySelectorAll('section'), root]), Math.floor(rand() * 3), p))
        } else if (kind === 'remove') {
          if (el !== root && root.contains(el)) st.apply(removeEl(el))
        } else {
          const target = pick([...root.querySelectorAll('section'), root])
          if (el !== root && root.contains(el) && !el.contains(target)) {
            st.apply(moveEl(el, target, Math.floor(rand() * target.children.length)))
          }
        }
        states.push(root.innerHTML)
      }

      const applied = st.log.entries.length
      for (let i = 0; i < applied; i++) st.undo()
      expect(root.innerHTML).toBe(initial)
      for (let i = 0; i < applied; i++) st.redo()
      expect(root.innerHTML).toBe(states[states.length - 1])
    }
  })
})

/** tiny seeded PRNG so the property test is reproducible */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
