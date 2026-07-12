/* INGEST pipeline — execute → extract → convert → review → load into the
 * editor. Entry point for importing foreign HTML decks. */

import { setImportReport } from '../editor/table'
import { loadDeck } from '../model/parse'
import { state } from '../state'
import type { ImportReport, ImportResult } from '../types'
import { validateDeckHtml } from '../model/validate'
import { convertSlides, buildReport, assembleDeck } from './convert'
import { executeSource } from './execute'
import { extractSlides } from './extract'
import { openReview, type ReviewOutcome } from './review'

/** Run the full import pipeline on foreign HTML, open the review UI, and on
 * accept load the converted deck into the editor + hand the report to the
 * table gutter. */
export async function startImport(html: string, name: string): Promise<void> {
  const execution = await executeSource(html)
  let outcome: ReviewOutcome | undefined
  try {
    const extraction = extractSlides(execution)
    const conversions = convertSlides(extraction)
    outcome = await openReview({ name, execution, extraction, conversions })
  } finally {
    execution.iframe.remove()
  }
  if (!outcome?.accepted) return

  const host = document.querySelector<HTMLElement>('#deck-host')
  if (!host) throw new Error('ingest: #deck-host not found — the shell must render the canvas host before import')

  const fileName = name.replace(/\.html?$/, '') + '.dia.html'
  appendProfileFindings(outcome.report, outcome.deckHtml)
  const deck = loadDeck(outcome.deckHtml, host, fileName)
  state.deck = deck
  state.bus.emit({ type: 'deck-loaded' })
  setImportReport(outcome.report)
}

/** Fold profile-validator findings into an import report — every import
 * ships with a profile verdict, never a silent maybe. */
function appendProfileFindings(report: ImportReport, deckHtml: string): void {
  for (const f of validateDeckHtml(deckHtml).findings) {
    report.warnings.push(`profile ${f.level} ${f.rule}${f.locator ? ` at ${f.locator}` : ''}: ${f.message}`)
  }
}

/** Run only the headless part of the pipeline (no UI) — used for programmatic
 * verification and by callers that want an ImportResult without review. */
export async function runPipeline(html: string, name: string): Promise<ImportResult & { cleanup: () => void }> {
  const execution = await executeSource(html)
  const extraction = extractSlides(execution)
  const conversions = convertSlides(extraction)
  const title = name.replace(/\.html?$/, '')
  const deckHtml = assembleDeck(conversions.map((c) => c.html), extraction.tokens, title)
  const report = buildReport(extraction, name, conversions)
  appendProfileFindings(report, deckHtml)
  return {
    deckHtml,
    report,
    originalSlides: extraction.slides.map((s) => s.originalHtml),
    cleanup: () => execution.iframe.remove(),
  }
}
