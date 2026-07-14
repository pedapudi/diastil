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
 * table gutter. Feedback is IMMEDIATE: executing + activated sampling take
 * seconds, and dead air reads as an unresponsive app. */
export async function startImport(html: string, name: string): Promise<void> {
  const progress = mountImportProgress(name)
  let outcome: ReviewOutcome | undefined
  let execution: Awaited<ReturnType<typeof executeSource>> | undefined
  try {
    progress.set('executing the original deck — scripts, fonts, first paint…')
    execution = await executeSource(html)
    const extraction = await extractSlides(execution, (i, n) =>
      progress.set(`sampling slide ${i + 1} of ${n} in its activated state…`))
    progress.set('converting to the dialect…')
    const conversions = convertSlides(extraction)
    progress.remove()
    outcome = await openReview({ name, execution, extraction, conversions })
  } finally {
    progress.remove()
    execution?.iframe.remove()
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

/** minimal blocking progress overlay for the pre-review pipeline stages */
function mountImportProgress(name: string): { set(msg: string): void; remove(): void } {
  const overlay = document.createElement('div')
  overlay.className = 'dia-import-progress'
  overlay.setAttribute('role', 'status')
  const panel = document.createElement('div')
  panel.className = 'dn-panel dia-import-progress-panel'
  const title = document.createElement('div')
  title.className = 'dia-import-progress-title'
  title.textContent = `importing ${name}`
  const bar = document.createElement('div')
  bar.className = 'dia-import-progress-bar'
  bar.appendChild(document.createElement('span'))
  const status = document.createElement('div')
  status.className = 'dia-import-progress-status'
  panel.append(title, bar, status)
  overlay.appendChild(panel)
  document.body.appendChild(overlay)
  return {
    set(msg: string) { status.textContent = msg },
    remove() { overlay.remove() },
  }
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
  const extraction = await extractSlides(execution)
  const conversions = convertSlides(extraction)
  const title = name.replace(/\.html?$/, '')
  const originals = extraction.slides.map((s) => s.originalHtml)
  // originals ride along (profile §8) exactly as they do on review accept —
  // the headless deck must not be a lesser artifact than the reviewed one
  const deckHtml = assembleDeck(conversions.map((c) => c.html), extraction.tokens, title, originals)
  const report = buildReport(extraction, name, conversions)
  appendProfileFindings(report, deckHtml)
  return {
    deckHtml,
    report,
    originalSlides: originals,
    cleanup: () => execution.iframe.remove(),
  }
}
