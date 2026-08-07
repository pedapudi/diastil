import { describe, expect, it } from 'vitest'
import { nearestRecord } from './pagesview'
import type { SynctexRecord } from '../doc/blockmirror'

describe('nearestRecord', () => {
  const recs: SynctexRecord[] = [
    { line: 10, page: 3, x: 71, y: 200, w: 219 },   // col 1
    { line: 40, page: 3, x: 307, y: 202, w: 219 },  // col 2, same band
    { line: 12, page: 3, x: 71, y: 240, w: 219 },
    { line: 99, page: 4, x: 71, y: 200, w: 219 },
  ]
  it('resolves within the clicked column, not across the gutter', () => {
    expect(nearestRecord(recs, 3, 150, 205)?.line).toBe(10)
    expect(nearestRecord(recs, 3, 400, 205)?.line).toBe(40)
  })
  it('picks the nearest line inside a column', () => {
    expect(nearestRecord(recs, 3, 100, 238)?.line).toBe(12)
  })
  it('never leaves the page', () => {
    expect(nearestRecord(recs, 4, 100, 200)?.line).toBe(99)
    expect(nearestRecord(recs, 9, 100, 200)).toBeNull()
  })
})
