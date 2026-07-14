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
import { findSlideRoots, forceVisible } from './extract'
import { DeckNavigator } from './navigate'
import { scoreSlideFidelityDetailed } from './fidelity'
import type { ExecuteResult } from './execute'

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
  /** per-slide visual-consistency scores (fidelity.ts composite), measured
   * at capture against the live original — THE tuning baseline: conversion
   * and metric changes are judged by diffing these across re-captures, and
   * corpus.test.ts holds them above explicit floors */
  fidelity: Array<number | null>
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
    const fidelity = await measureFidelity(result.execution, result.deckHtml,
      result.extraction.slides[0]?.rect.w)
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
      fidelity,
      deckHtml: result.deckHtml,
    }
    return JSON.stringify(fixture, null, 2)
  } finally {
    result.cleanup()
  }
}

/** Score every converted slide against the LIVE original — the same
 * measurement the review runs (activated navigation for one-at-a-time
 * decks, forced visibility otherwise), against the assembled deck rendered
 * in a hidden same-origin frame at the source's design width. */
async function measureFidelity(
  execution: ExecuteResult, deckHtml: string, designW?: number,
): Promise<Array<number | null>> {
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-same-origin')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText =
    `position:fixed;left:-12000px;top:0;width:${Math.round(designW || 1280)}px;height:720px;border:0;`
  document.body.appendChild(frame)
  try {
    await new Promise<void>((resolve) => {
      frame.addEventListener('load', () => resolve(), { once: true })
      frame.srcdoc = deckHtml
    })
    const convDoc = frame.contentDocument
    const origDoc = execution.iframe.contentDocument
    if (!convDoc || !origDoc) return []
    const convRoots = [...convDoc.querySelectorAll<HTMLElement>('section.dia-slide')]
    const origRoots = findSlideRoots(origDoc).roots
    const oneAtATime = origRoots.length > 1 && origRoots.some((r) => r.offsetWidth === 0)
    const nav = oneAtATime ? new DeckNavigator(origDoc, origRoots) : null
    const scores: Array<number | null> = []
    for (let i = 0; i < convRoots.length; i++) {
      const orig = origRoots[i]
      const conv = convRoots[i]
      if (!orig || !conv) { scores.push(null); continue }
      if (nav) await nav.show(i)
      const unforce = !oneAtATime ? forceVisible(orig) : null
      try {
        const detail = await scoreSlideFidelityDetailed(orig, conv)
        scores.push(detail ? detail.score.score : null)
      } finally {
        unforce?.()
      }
    }
    return scores
  } finally {
    frame.remove()
  }
}

/** dev hook: `await window.__diaCorpus.capture(html, 'name')` in the editor
 * tab returns the fixture JSON to save under corpus/fixtures/<name>.json */
export function installCorpusCapture(): void {
  ;(window as unknown as Record<string, unknown>).__diaCorpus = {
    capture: (html: string, name: string) => captureFixture(html, name),
  }
}
