// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { DocSource } from './source'

describe('DocSource', () => {
  it('patch replaces a range and returns the removed slice', () => {
    const s = new DocSource('hello world')
    expect(s.patch(6, 11, 'there')).toBe('world')
    expect(s.text).toBe('hello there')
  })

  it('spans after a patch shift by the delta', () => {
    const s = new DocSource('aaa bbb ccc')
    s.bind('c', { start: 8, end: 11 })
    s.patch(4, 7, 'BBBBB')
    expect(s.spanOf('c')).toEqual({ start: 10, end: 13 })
    expect(s.sliceOf('c')).toBe('ccc')
  })

  it('a span enclosing the patch resizes', () => {
    const s = new DocSource('aaa bbb ccc')
    s.bind('all', { start: 0, end: 11 })
    s.patch(4, 7, 'x')
    expect(s.sliceOf('all')).toBe('aaa x ccc')
  })

  it('a span partially overlapping the patch is dropped — never guessed', () => {
    const s = new DocSource('aaa bbb ccc')
    s.bind('ab', { start: 0, end: 6 })
    s.patch(4, 9, 'x')
    expect(s.spanOf('ab')).toBeNull()
  })

  it('spans before the patch are untouched', () => {
    const s = new DocSource('aaa bbb ccc')
    s.bind('a', { start: 0, end: 3 })
    s.patch(8, 11, 'CCCCC')
    expect(s.sliceOf('a')).toBe('aaa')
  })

  it('lineOf / offsetOfLine agree', () => {
    const s = new DocSource('one\ntwo\nthree\n')
    expect(s.lineOf(0)).toBe(1)
    expect(s.lineOf(4)).toBe(2)
    expect(s.lineOf(8)).toBe(3)
    expect(s.offsetOfLine(2)).toBe(4)
    expect(s.offsetOfLine(3)).toBe(8)
    expect(s.lineOf(s.offsetOfLine(3))).toBe(3)
  })

  it('idAt finds the innermost containing span', () => {
    const s = new DocSource('aaa bbb ccc')
    s.bind('outer', { start: 0, end: 11 })
    s.bind('inner', { start: 4, end: 7 })
    expect(s.idAt(5)).toBe('inner')
    expect(s.idAt(1)).toBe('outer')
    expect(s.idAt(20)).toBeNull()
  })
})
