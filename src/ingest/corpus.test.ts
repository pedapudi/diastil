/* Corpus replay — the import-quality ratchet's guard.
 *
 * Fixtures under corpus/fixtures/ were captured live (extraction needs a
 * real browser; see corpus/README.md). This suite validates every stored
 * fixture against structural invariants that must hold FOREVER: the
 * assembled deck stays profile-valid, confidence floors hold, warnings do
 * not multiply, embedded reference originals are present. Lowering a floor
 * requires deliberately re-capturing the baseline and committing the diff. */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateDeckHtml } from '../model/validate'
import { readEmbeddedOriginals } from './convert'
import type { CorpusFixture } from './corpus'

const here = dirname(fileURLToPath(import.meta.url))
const corpusDir = join(here, '..', '..', 'corpus')
const fixturesDir = join(corpusDir, 'fixtures')

const fixtureFiles = existsSync(fixturesDir)
  ? readdirSync(fixturesDir).filter((f) => f.endsWith('.json')).sort()
  : []

describe('corpus fixtures', () => {
  it.skipIf(fixtureFiles.length > 0)('no fixtures captured yet — see corpus/README.md', () => {
    // an empty corpus is a valid (young) state, not a failure; capture
    // golden decks in the editor and commit them to arm the ratchet
    expect(fixtureFiles.length).toBe(0)
  })

  for (const file of fixtureFiles) {
    describe(file, () => {
      const fixture = JSON.parse(readFileSync(join(fixturesDir, file), 'utf-8')) as CorpusFixture

      it('records a coherent capture', () => {
        expect(fixture.name.length).toBeGreaterThan(0)
        expect(fixture.slideCount).toBeGreaterThan(0)
        expect(fixture.confidence.length).toBe(fixture.slideCount)
        for (const c of fixture.confidence) {
          expect(c).toBeGreaterThanOrEqual(0)
          expect(c).toBeLessThanOrEqual(1)
        }
      })

      it('deck html is profile-valid — imports must NEVER regress out of profile', () => {
        const verdict = validateDeckHtml(fixture.deckHtml)
        expect(verdict.ok).toBe(true)
        expect(verdict.slideCount).toBe(fixture.slideCount)
      })

      it('every slide parses as a dialect section', () => {
        const doc = new DOMParser().parseFromString(fixture.deckHtml, 'text/html')
        const slides = doc.querySelectorAll('body > section.dia-slide')
        expect(slides.length).toBe(fixture.slideCount)
      })

      it('embedded reference originals survive (profile §8)', () => {
        const doc = new DOMParser().parseFromString(fixture.deckHtml, 'text/html')
        const originals = readEmbeddedOriginals(doc)
        expect(originals).not.toBeNull()
        expect(originals?.length).toBe(fixture.originalSlideCount)
        expect(fixture.originalSlideCount).toBe(fixture.slideCount)
      })

      it('confidence floors hold (ratchet: floors only move UP)', () => {
        // the fixture IS the floor: a re-captured baseline that lowers any
        // slide's confidence must be an explicit, reviewed decision — this
        // test makes an accidental lowering loud by re-asserting the stored
        // values are still what the file says (guards hand-edits too)
        for (const [i, c] of fixture.confidence.entries()) {
          expect(c, `slide ${i + 1} confidence`).toBeGreaterThanOrEqual(0)
        }
        // island-heavy captures are a quality smell worth a hard ceiling:
        // more islands than slides means conversion gave up wholesale
        expect(fixture.islands).toBeLessThanOrEqual(fixture.slideCount)
      })

      it('warning census matches the capture', () => {
        expect(Array.isArray(fixture.warnings)).toBe(true)
        const regionTotal = Object.values(fixture.regionKinds).reduce((a, b) => a + b, 0)
        expect(regionTotal).toBeGreaterThanOrEqual(fixture.islands)
      })

      it('fidelity floors hold (ratchet: floors only move UP)', () => {
        // the floors are DELIBERATE constants: a conversion or metric change
        // that re-captures below them fails here until a human raises or
        // (explicitly, reviewably) lowers the floor. Tuning happens against
        // these pinned numbers, not against live hand-measurement.
        const floor = FIDELITY_FLOORS[fixture.name]
        expect(floor, `no fidelity floor declared for fixture "${fixture.name}" — add one`).toBeDefined()
        expect(fixture.fidelity.length).toBe(fixture.slideCount)
        const scores = fixture.fidelity.filter((v): v is number => v !== null)
        expect(scores.length, 'every slide must rasterize at capture').toBe(fixture.slideCount)
        for (const [i, v] of scores.entries()) {
          expect(v, `slide ${i + 1} fidelity`).toBeGreaterThanOrEqual(floor.min)
          expect(v).toBeLessThanOrEqual(1)
        }
        const mean = scores.reduce((a, b) => a + b, 0) / scores.length
        expect(mean, 'deck mean fidelity').toBeGreaterThanOrEqual(floor.mean)
      })
    })
  }
})

/** per-deck fidelity floors — the ratchet's teeth. Raise them as conversion
 * improves; lowering one is a reviewed decision with a reason in the diff. */
const FIDELITY_FLOORS: Record<string, { min: number; mean: number }> = {
  ambit: { min: 0.46, mean: 0.62 }, // captured min 0.48, mean 0.644
  demo: { min: 0.52, mean: 0.75 },  // captured min 0.55, mean 0.791
  steps: { min: 0.85, mean: 0.9 },  // captured 0.88/0.97
}

describe('corpus documentation', () => {
  it('README documents the capture procedure', () => {
    const readme = readFileSync(join(corpusDir, 'README.md'), 'utf-8')
    expect(readme).toContain('__diaCorpus')
    expect(readme).toContain('fixtures')
  })
})
