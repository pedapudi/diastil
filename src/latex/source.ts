/* DocSource — the LaTeX source string plus the session-only map from block
 * ids (data-dia-id) to source spans. Spans are NEVER persisted into the DOM:
 * a fresh session rebuilds the map deterministically by re-parsing, so the
 * serializer stays byte-stable and offsets can't rot in attributes.
 *
 * patch() is the single write path. Spans after the patch shift; a span
 * enclosing the patch resizes; a span PARTIALLY overlapping the patch is
 * dropped — its owner must re-bind, because guessing would silently corrupt
 * the one thing this module exists to keep exact. */

import type { Span } from './lex'

export class DocSource {
  private spans = new Map<string, Span>()

  constructor(public text: string) {}

  bind(id: string, span: Span): void {
    this.spans.set(id, { start: span.start, end: span.end })
  }

  drop(id: string): void {
    this.spans.delete(id)
  }

  spanOf(id: string): Span | null {
    const s = this.spans.get(id)
    return s ? { start: s.start, end: s.end } : null
  }

  sliceOf(id: string): string | null {
    const s = this.spans.get(id)
    return s ? this.text.slice(s.start, s.end) : null
  }

  /** replace [start, end) with `replacement`; returns the removed slice.
   * Bound spans shift/resize; partial overlaps are dropped (see above). */
  patch(start: number, end: number, replacement: string): string {
    const removed = this.text.slice(start, end)
    this.text = this.text.slice(0, start) + replacement + this.text.slice(end)
    const delta = replacement.length - (end - start)
    for (const [id, s] of this.spans) {
      if (s.end <= start) continue
      if (s.start >= end) {
        s.start += delta
        s.end += delta
        continue
      }
      if (s.start <= start && s.end >= end) {
        s.end += delta
        continue
      }
      this.spans.delete(id)
    }
    return removed
  }

  /** 1-based line of a byte offset — compile-error ↔ block mapping */
  lineOf(offset: number): number {
    let line = 1
    const to = Math.min(offset, this.text.length)
    for (let i = 0; i < to; i++) if (this.text[i] === '\n') line++
    return line
  }

  /** byte offset of the start of a 1-based line */
  offsetOfLine(line: number): number {
    if (line <= 1) return 0
    let seen = 1
    for (let i = 0; i < this.text.length; i++) {
      if (this.text[i] === '\n' && ++seen === line) return i + 1
    }
    return this.text.length
  }

  /** whole-source replacement support (the raw editor's commit path) */
  clearBindings(): void {
    this.spans.clear()
  }

  snapshotBindings(): Map<string, Span> {
    return new Map([...this.spans].map(([id, s]) => [id, { start: s.start, end: s.end }]))
  }

  restoreBindings(snapshot: Map<string, Span>): void {
    this.spans = new Map([...snapshot].map(([id, s]) => [id, { start: s.start, end: s.end }]))
  }

  /** the block id whose span contains a byte offset, innermost by size */
  idAt(offset: number): string | null {
    let best: string | null = null
    let bestSize = Infinity
    for (const [id, s] of this.spans) {
      if (offset >= s.start && offset < s.end && s.end - s.start < bestSize) {
        best = id
        bestSize = s.end - s.start
      }
    }
    return best
  }
}
