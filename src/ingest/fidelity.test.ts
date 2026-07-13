/* Pixel-diff scoring — pure math, exercised directly. Rasterization itself
 * needs a real canvas and is exercised in-browser. */

import { describe, expect, it } from 'vitest'
import { diffBitmaps } from './fidelity'

function bitmap(w: number, h: number, rgba: [number, number, number, number]): ImageData {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i)
  return { data, width: w, height: h, colorSpace: 'srgb' } as ImageData
}

describe('diffBitmaps', () => {
  it('identical rasters score 1', () => {
    const a = bitmap(8, 8, [200, 100, 50, 255])
    expect(diffBitmaps(a, bitmap(8, 8, [200, 100, 50, 255])).score).toBe(1)
  })

  it('anti-aliasing-scale differences are tolerated', () => {
    const a = bitmap(8, 8, [200, 100, 50, 255])
    const b = bitmap(8, 8, [220, 90, 60, 255]) // within per-channel tolerance
    expect(diffBitmaps(a, b).score).toBe(1)
  })

  it('content-weighted: junk covering half a BLANK original scores 0', () => {
    const a = bitmap(8, 8, [255, 255, 255, 255])
    const b = bitmap(8, 8, [255, 255, 255, 255])
    for (let i = 0; i < b.data.length / 2; i += 4) b.data[i] = 0 // top half red channel off
    const r = diffBitmaps(a, b)
    // every content pixel (all of them introduced by the candidate) is wrong
    expect(r.score).toBe(0)
    expect(r.diffPixels).toBe(32)
    expect(r.contentPixels).toBe(32)
    expect(r.totalPixels).toBe(64)
  })

  it('background domination cannot inflate the score', () => {
    // a dark slide whose small content is COMPLETELY different must fail,
    // even though ~90% of pixels are matching background
    const a = bitmap(16, 16, [20, 20, 20, 255])
    const b = bitmap(16, 16, [20, 20, 20, 255])
    // content in DISTANT places (beyond the 1px spatial tolerance)
    for (let p = 32; p < 44; p++) { const i = p * 4; a.data[i] = a.data[i + 1] = a.data[i + 2] = 255 }
    for (let p = 192; p < 204; p++) { const i = p * 4; b.data[i] = b.data[i + 1] = b.data[i + 2] = 255 }
    const r = diffBitmaps(a, b)
    expect(r.score).toBe(0) // all content misplaced
    expect(r.contentPixels).toBe(24)
  })

  it('matching content on a dominant background scores 1', () => {
    const a = bitmap(16, 16, [20, 20, 20, 255])
    const b = bitmap(16, 16, [20, 20, 20, 255])
    for (let p = 0; p < 12; p++) { const i = p * 4; a.data[i] = 255; b.data[i] = 255 }
    expect(diffBitmaps(a, b).score).toBe(1)
  })
})
