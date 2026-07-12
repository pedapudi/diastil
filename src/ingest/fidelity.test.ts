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

  it('a real color change on half the pixels scores 0.5', () => {
    const a = bitmap(8, 8, [255, 255, 255, 255])
    const b = bitmap(8, 8, [255, 255, 255, 255])
    for (let i = 0; i < b.data.length / 2; i += 4) b.data[i] = 0 // top half red channel off
    const r = diffBitmaps(a, b)
    expect(r.score).toBe(0.5)
    expect(r.diffPixels).toBe(32)
    expect(r.totalPixels).toBe(64)
  })
})
