/* Derived document content — what LaTeX numbers for you: section, figure,
 * table, and equation numbers, resolved into \ref texts. A pure DOM pass
 * (the dia-chart-derived contract): no ops, no source changes.
 *
 * Because derived text lives INSIDE source-backed blocks, every mutation
 * here must re-seal the render memos on the ancestor chain — otherwise
 * emit.ts would read the block as "edited" and reconstruct instead of
 * re-emitting its exact source bytes. loadDoc runs this pass before the
 * first serialization so saved bodies are deterministic. */

import { blockMemo } from '../latex/render'
import { cleanOuter } from '../latex/emit'

export function refreshDerived(article: HTMLElement): void {
  const numbers = new Map<string, string>()
  const counters = [0, 0, 0, 0]
  let figures = 0
  let tables = 0
  let equations = 0

  for (const el of article.querySelectorAll<HTMLElement>(
    'h2.dia-sec, h3.dia-sec, h4.dia-sec, figure.dia-figure, div.dia-math[data-dia-env]',
  )) {
    const label = el.getAttribute('data-dia-label')
    if (el.matches('.dia-sec')) {
      const level = Number(el.tagName[1]) - 2 // h2 → 0
      counters[level]++
      for (let i = level + 1; i < counters.length; i++) counters[i] = 0
      if (label) numbers.set(label, counters.slice(0, level + 1).join('.'))
      continue
    }
    if (el.matches('figure.dia-figure')) {
      const isTable = el.getAttribute('data-dia-float') === 'table'
      const n = isTable ? ++tables : ++figures
      if (label) numbers.set(label, String(n))
      continue
    }
    // numbered math environments (starred ones don't count)
    const env = el.getAttribute('data-dia-env') ?? ''
    if (!env.endsWith('*')) {
      equations++
      if (label) numbers.set(label, String(equations))
    }
  }

  for (const ref of article.querySelectorAll<HTMLElement>('a.dia-ref')) {
    const key = ref.getAttribute('data-dia-ref') ?? ''
    // resolved refs show the number; unresolved keep the key (honest)
    const want = numbers.get(key) ?? key
    if (ref.textContent === want) continue
    ref.textContent = want
    resealMemos(ref, article)
  }
}

/** derived text changed inside a block: update the pristine-markup seal on
 * every memoized ancestor so unedited blocks keep emitting exact bytes.
 * Exported: bibliography.ts's citation resolution reseals the same way,
 * on its own schedule (a compile's .bbl lands after the fact, not before
 * the first serialization like refreshDerived's ref pass does). */
export function resealMemos(from: Element, article: HTMLElement): void {
  let cur: Element | null = from
  while (cur && cur !== article) {
    if (cur instanceof HTMLElement) {
      const memo = blockMemo.get(cur)
      if (memo) memo.html = cleanOuter(cur)
    }
    cur = cur.parentElement
  }
}
