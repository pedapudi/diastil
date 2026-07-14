/* CORPUS — the guard on the import-quality ratchet.
 *
 * Extraction needs a real browser (computed styles, activated sampling), so
 * golden-deck fixtures are CAPTURED live in the editor and REPLAYED
 * deterministically by corpus.test.ts. A fixture records what the headless
 * pipeline actually produced for a deck: per-slide confidence (the ratchet
 * floors), warnings, region-note census, and the assembled deck html. Tests
 * assert invariants against the stored fixture — floors only ratchet UP; a
 * conversion change that would lower one fails the suite until the baseline
 * is deliberately re-captured and committed. See corpus/README.md. */

import { runPipeline } from './pipeline'

/** Everything a fixture records — derived strictly from ImportResult
 * (deckHtml · report · originalSlides), nothing invented. */
export interface CorpusFixture {
  name: string
  /** browser clock at capture — informational, never asserted on */
  capturedAt: string
  slideCount: number
  /** report.confidence — per-slide floors, the heart of the ratchet */
  confidence: number[]
  warnings: string[]
  /** region-note count per kind (island, lifted-svg, low-structure, …) */
  regionKinds: Record<string, number>
  islands: number
  tokens: Record<string, string>
  /** count of embedded reference originals (one per slide when present) */
  originalSlideCount: number
  /** the assembled dialect document — must stay profile-valid forever */
  deckHtml: string
}

/** Run the headless pipeline on foreign html and serialize a fixture.
 * Returns pretty-printed JSON, ready to save as corpus/fixtures/<name>.json. */
export async function captureFixture(html: string, name: string): Promise<string> {
  const result = await runPipeline(html, name)
  try {
    const regionKinds: Record<string, number> = {}
    for (const r of result.report.regions) {
      regionKinds[r.kind] = (regionKinds[r.kind] ?? 0) + 1
    }
    const fixture: CorpusFixture = {
      name,
      capturedAt: new Date().toISOString(),
      slideCount: result.report.slideCount,
      confidence: result.report.confidence,
      warnings: result.report.warnings,
      regionKinds,
      islands: regionKinds['island'] ?? 0,
      tokens: result.report.tokens,
      originalSlideCount: result.originalSlides.length,
      deckHtml: result.deckHtml,
    }
    return JSON.stringify(fixture, null, 2)
  } finally {
    result.cleanup()
  }
}

/** dev hook: `await window.__diaCorpus.capture(html, 'name')` in the editor
 * tab returns the fixture JSON to save under corpus/fixtures/<name>.json */
export function installCorpusCapture(): void {
  ;(window as unknown as Record<string, unknown>).__diaCorpus = {
    capture: (html: string, name: string) => captureFixture(html, name),
  }
}
