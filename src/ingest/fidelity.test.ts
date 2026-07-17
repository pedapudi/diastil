/* Pixel-diff scoring — pure math, exercised directly. Rasterization itself
 * needs a real canvas and is exercised in-browser. */

import { describe, expect, it } from 'vitest'
import { diffBitmaps, diffRegions, estimateVerticalDrift } from './fidelity'

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

  it('junk covering half a BLANK original scores 0 (content invented)', () => {
    const a = bitmap(8, 8, [255, 255, 255, 255])
    const b = bitmap(8, 8, [255, 255, 255, 255])
    for (let i = 0; i < b.data.length / 2; i += 4) b.data[i] = 0 // top half red channel off
    const r = diffBitmaps(a, b)
    expect(r.score).toBe(0)
    // the pixel accounting (heatmap/regions layer) is unchanged
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
    expect(r.score).toBeLessThan(0.35) // all content misplaced
    expect(r.contentPixels).toBe(24)
  })

  it('matching content on a dominant background scores 1', () => {
    const a = bitmap(16, 16, [20, 20, 20, 255])
    const b = bitmap(16, 16, [20, 20, 20, 255])
    for (let p = 0; p < 12; p++) { const i = p * 4; a.data[i] = 255; b.data[i] = 255 }
    expect(diffBitmaps(a, b).score).toBe(1)
  })
})

describe('diffRegions', () => {
  /** paint a solid white block into a bitmap */
  function block(img: ImageData, x0: number, y0: number, w: number, h: number): void {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const i = (y * img.width + x) * 4
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255
      }
    }
  }

  it('aligned rasters produce zero regions', () => {
    const a = bitmap(48, 48, [20, 20, 20, 255])
    const b = bitmap(48, 48, [20, 20, 20, 255])
    block(a, 4, 4, 8, 8)
    block(b, 4, 4, 8, 8)
    expect(diffRegions(a, b)).toEqual([])
  })

  it('two separated diff clusters become two regions in the right quadrants', () => {
    const a = bitmap(48, 48, [20, 20, 20, 255])
    const b = bitmap(48, 48, [20, 20, 20, 255])
    block(a, 0, 0, 8, 8) // only in the original — top-left
    block(b, 40, 40, 8, 8) // only in the candidate — bottom-right
    const regions = diffRegions(a, b)
    expect(regions.length).toBe(2)
    const topLeft = regions.find((r) => r.x < 0.5 && r.y < 0.5)
    const bottomRight = regions.find((r) => r.x >= 0.5 && r.y >= 0.5)
    expect(topLeft).toBeDefined()
    expect(bottomRight).toBeDefined()
    for (const r of regions) {
      // fractions stay in 0..1 and every content pixel in these boxes differs
      expect(r.x).toBeGreaterThanOrEqual(0)
      expect(r.y).toBeGreaterThanOrEqual(0)
      expect(r.x + r.w).toBeLessThanOrEqual(1)
      expect(r.y + r.h).toBeLessThanOrEqual(1)
      expect(r.frac).toBe(1)
    }
  })

  it('caps the region count at maxRegions, heaviest first', () => {
    const a = bitmap(48, 48, [20, 20, 20, 255])
    const b = bitmap(48, 48, [20, 20, 20, 255])
    block(a, 0, 0, 12, 12) // the heaviest cluster
    block(a, 40, 0, 6, 6)
    block(a, 0, 40, 6, 6)
    block(a, 40, 40, 6, 6)
    const regions = diffRegions(a, b, 2)
    expect(regions.length).toBe(2)
    // the largest cluster wins the first slot
    expect(regions[0].x).toBe(0)
    expect(regions[0].y).toBe(0)
  })
})

describe('estimateVerticalDrift', () => {
  const paint = (img: ImageData, x0: number, y0: number, w: number, h: number): void => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const i = (y * img.width + x) * 4
        img.data[i] = 10; img.data[i + 1] = 10; img.data[i + 2] = 10
      }
    }
  }

  it('a uniformly shifted block reports its displacement as a height fraction', () => {
    const a = bitmap(100, 100, [250, 250, 250, 255])
    const b = bitmap(100, 100, [250, 250, 250, 255])
    paint(a, 20, 30, 60, 20) // original: content at rows 30..50
    paint(b, 20, 50, 60, 20) // candidate: same block 20 rows LOWER
    const drift = estimateVerticalDrift(a, b)
    expect(drift).not.toBeNull()
    expect(drift! * 100).toBeCloseTo(20, 0)
  })

  it('content shifted UP reports negative drift', () => {
    const a = bitmap(100, 100, [250, 250, 250, 255])
    const b = bitmap(100, 100, [250, 250, 250, 255])
    paint(a, 20, 60, 60, 20)
    paint(b, 20, 40, 60, 20)
    expect(estimateVerticalDrift(a, b)!).toBeLessThan(0)
  })

  it('aligned content reports no drift', () => {
    const a = bitmap(100, 100, [250, 250, 250, 255])
    const b = bitmap(100, 100, [250, 250, 250, 255])
    paint(a, 20, 30, 60, 20)
    paint(b, 20, 30, 60, 20)
    expect(estimateVerticalDrift(a, b)).toBeNull()
  })

  it('structural mismatch (different content, no clean shift) reports null', () => {
    const a = bitmap(100, 100, [250, 250, 250, 255])
    const b = bitmap(100, 100, [250, 250, 250, 255])
    paint(a, 20, 10, 60, 10)
    paint(a, 20, 80, 60, 10)
    paint(b, 20, 45, 60, 10)
    expect(estimateVerticalDrift(a, b)).toBeNull()
  })
})

/* The property the composite exists for: the penalty for displacement is
 * GRADED, so a faithfully-converted slide whose text sits a few pixels off
 * scores near the top, not near zero — and ranking follows perception. */
describe('visual-consistency ranking', () => {
  /** text-like content: several thin horizontal stripes */
  function stripes(img: ImageData, xShift: number): void {
    for (const row of [40, 60, 80, 100, 140]) {
      for (let y = row; y < row + 4; y++) {
        for (let x = 30 + xShift; x < 170 + xShift; x++) {
          const i = (y * img.width + x) * 4
          img.data[i] = img.data[i + 1] = img.data[i + 2] = 250
        }
      }
    }
  }
  const dark: [number, number, number, number] = [20, 22, 28, 255]

  it('a small global shift scores near the top; ranking is monotonic in displacement', () => {
    const orig = bitmap(200, 200, dark); stripes(orig, 0)
    const shifted2 = bitmap(200, 200, dark); stripes(shifted2, 2)
    const shifted8 = bitmap(200, 200, dark); stripes(shifted8, 8)
    const missing = bitmap(200, 200, dark) // no content at all
    const s2 = diffBitmaps(orig, shifted2).score
    const s8 = diffBitmaps(orig, shifted8).score
    const sMissing = diffBitmaps(orig, missing).score
    expect(s2).toBeGreaterThanOrEqual(0.8) // consistent slides score like it
    expect(s2).toBeGreaterThan(s8)
    expect(s8).toBeGreaterThan(sMissing)
    expect(sMissing).toBe(0)
  })

  it('same shape in the wrong color: layout holds, appearance pays', () => {
    const a = bitmap(200, 200, dark)
    const b = bitmap(200, 200, dark)
    for (let y = 50; y < 120; y++) for (let x = 50; x < 150; x++) {
      const ia = (y * 200 + x) * 4
      a.data[ia] = 220; a.data[ia + 1] = 60; a.data[ia + 2] = 60 // red block
      b.data[ia] = 60; b.data[ia + 1] = 60; b.data[ia + 2] = 220 // blue block
    }
    const s = diffBitmaps(a, b).score
    expect(s).toBeGreaterThan(0.4)
    expect(s).toBeLessThan(0.92)
  })

  it('half the content missing scores well below a small shift', () => {
    const orig = bitmap(200, 200, dark); stripes(orig, 0)
    const half = bitmap(200, 200, dark)
    for (const row of [40, 60]) { // keep only two of five stripes
      for (let y = row; y < row + 4; y++) for (let x = 30; x < 170; x++) {
        const i = (y * 200 + x) * 4
        half.data[i] = half.data[i + 1] = half.data[i + 2] = 250
      }
    }
    const shifted2 = bitmap(200, 200, dark); stripes(shifted2, 2)
    expect(diffBitmaps(orig, shifted2).score - diffBitmaps(orig, half).score).toBeGreaterThan(0.2)
  })
})

describe('subtle surfaces (cards) are graded symmetrically', () => {
  const bg: [number, number, number, number] = [20, 22, 28, 255]
  /** a card: subtle surface fill (delta ~24/channel) + text-ish ink on top */
  function card(img: ImageData, x0: number, y0: number): void {
    for (let y = y0; y < y0 + 40; y++) for (let x = x0; x < x0 + 70; x++) {
      const i = (y * img.width + x) * 4
      img.data[i] = 44; img.data[i + 1] = 46; img.data[i + 2] = 54
    }
    for (let y = y0 + 8; y < y0 + 12; y++) for (let x = x0 + 8; x < x0 + 60; x++) {
      const i = (y * img.width + x) * 4
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 240
    }
  }

  it('adding the missing card IMPROVES the score — never lowers it', () => {
    const original = bitmap(200, 200, bg)
    card(original, 20, 30)
    card(original, 20, 100)
    const withCards = bitmap(200, 200, bg)
    card(withCards, 20, 30)
    card(withCards, 20, 100)
    const missingOne = bitmap(200, 200, bg)
    card(missingOne, 20, 30)
    // the second card's TEXT is there but its surface panel is missing
    for (let y = 108; y < 112; y++) for (let x = 28; x < 80; x++) {
      const i = (y * 200 + x) * 4
      missingOne.data[i] = missingOne.data[i + 1] = missingOne.data[i + 2] = 240
    }
    const sWith = diffBitmaps(original, withCards).score
    const sMissing = diffBitmaps(original, missingOne).score
    expect(sWith).toBeGreaterThan(sMissing)
    expect(sWith).toBeGreaterThanOrEqual(0.95)
  })
})

describe('negative space cannot be gamed by dropping content', () => {
  const bg: [number, number, number, number] = [250, 250, 246, 255]
  function block(img: ImageData, x0: number, y0: number, w: number, h: number): void {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      const i = (y * img.width + x) * 4
      img.data[i] = 20; img.data[i + 1] = 24; img.data[i + 2] = 30
    }
  }

  it('dropping a SMALL element (a footer) costs real score, more than a small shift', () => {
    // mostly-blank slide: one title block + a small footer line
    const orig = bitmap(200, 200, bg)
    block(orig, 20, 30, 120, 24) // title
    block(orig, 20, 180, 90, 8)  // footer — tiny ink mass
    const shifted = bitmap(200, 200, bg)
    block(shifted, 22, 32, 120, 24) // everything kept, nudged 2px
    block(shifted, 22, 182, 90, 8)
    const dropped = bitmap(200, 200, bg)
    block(dropped, 20, 30, 120, 24) // title perfect, footer DELETED
    const sShifted = diffBitmaps(orig, shifted).score
    const sDropped = diffBitmaps(orig, dropped).score
    expect(sShifted).toBeGreaterThan(sDropped)
    expect(sDropped).toBeLessThan(0.85) // dropping is never near-free
    const comp = diffBitmaps(orig, dropped).components
    expect(comp?.completeness).toBeLessThan(1)
  })

  it('keeping everything on a mostly-blank slide still scores near 1', () => {
    const orig = bitmap(200, 200, bg)
    block(orig, 20, 30, 120, 24)
    block(orig, 20, 180, 90, 8)
    const same = bitmap(200, 200, bg)
    block(same, 20, 30, 120, 24)
    block(same, 20, 180, 90, 8)
    expect(diffBitmaps(orig, same).score).toBeGreaterThanOrEqual(0.98)
  })
})

describe('ink-color axis: recolored text is priced even at sliver mass', () => {
  function textRows(img: ImageData, rgb: [number, number, number]): void {
    // thin 2px "text lines" — a sliver of total area, like real glyphs
    for (const y0 of [20, 40, 60, 80]) {
      for (let y = y0; y < y0 + 2; y++) {
        for (let x = 10; x < 150; x += 3) { // broken runs — not a frame
          const i = (y * img.width + x) * 4
          img.data[i] = rgb[0]; img.data[i + 1] = rgb[1]; img.data[i + 2] = rgb[2]; img.data[i + 3] = 255
        }
      }
    }
  }
  it('same-position black vs red text: inkColor falls, displacement stays high', () => {
    const a = bitmap(160, 100, [255, 255, 255, 255])
    const b = bitmap(160, 100, [255, 255, 255, 255])
    const c = bitmap(160, 100, [255, 255, 255, 255])
    textRows(a, [0, 0, 0])
    textRows(b, [0, 0, 0])
    textRows(c, [200, 30, 30])
    const same = diffBitmaps(a, b)
    const recolored = diffBitmaps(a, c)
    expect(recolored.components!.displacement).toBeGreaterThan(0.95) // geometry identical
    expect(recolored.components!.inkColor).toBeLessThanOrEqual(0.5)
    expect(recolored.score).toBeLessThan(same.score - 0.05)
  })
})

describe('structure axis: dropped card frames are priced', () => {
  function frame(img: ImageData, x0: number, y0: number, w: number, h: number): void {
    for (let x = x0; x < x0 + w; x++) {
      for (const y of [y0, y0 + h - 1]) {
        const i = (y * img.width + x) * 4
        img.data[i] = 60; img.data[i + 1] = 60; img.data[i + 2] = 60; img.data[i + 3] = 255
      }
    }
    for (let y = y0; y < y0 + h; y++) {
      for (const x of [x0, x0 + w - 1]) {
        const i = (y * img.width + x) * 4
        img.data[i] = 60; img.data[i + 1] = 60; img.data[i + 2] = 60; img.data[i + 3] = 255
      }
    }
  }
  function fill(img: ImageData, x0: number, y0: number, w: number, h: number): void {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const i = (y * img.width + x) * 4
        img.data[i] = 30; img.data[i + 1] = 30; img.data[i + 2] = 30; img.data[i + 3] = 255
      }
    }
  }
  it('missing border around identical content drops the structure axis', () => {
    const a = bitmap(200, 120, [255, 255, 255, 255])
    const b = bitmap(200, 120, [255, 255, 255, 255])
    fill(a, 60, 40, 80, 40) // the "content" both sides share
    fill(b, 60, 40, 80, 40)
    frame(a, 40, 20, 120, 80) // the card outline only the source has
    const r = diffBitmaps(a, b)
    expect(r.components!.structure).toBeLessThan(0.3)
    const both = bitmap(200, 120, [255, 255, 255, 255])
    fill(both, 60, 40, 80, 40)
    frame(both, 40, 20, 120, 80)
    expect(diffBitmaps(a, both).components!.structure).toBeGreaterThan(0.9)
  })
  it('frameless pairs owe nothing to the axis', () => {
    const a = bitmap(200, 120, [255, 255, 255, 255])
    const b = bitmap(200, 120, [255, 255, 255, 255])
    fill(a, 60, 40, 80, 40)
    fill(b, 60, 40, 80, 40)
    expect(diffBitmaps(a, b).components!.structure).toBe(1)
  })
})
