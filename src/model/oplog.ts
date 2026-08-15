/* Undo/redo over inverting ops. */

import type { Op, OpLogEntry } from '../types'

export class OpLog {
  entries: OpLogEntry[] = []
  private undone: OpLogEntry[] = []

  push(entry: OpLogEntry): void {
    this.entries.push(entry)
    this.undone = []
  }

  undo(): boolean {
    const entry = this.entries.pop()
    if (!entry) return false
    const inverse = entry.op.invert()
    inverse.apply()
    this.undone.push(entry)
    return true
  }

  redo(): boolean {
    const entry = this.undone.pop()
    if (!entry) return false
    entry.op.apply()
    this.entries.push(entry)
    return true
  }

  recent(n: number): OpLogEntry[] { return this.entries.slice(-n) }

  /** Fold a burst that has already been applied into one undo entry.  Page
   * editing commits on idle so TeX can preview the draft, but the user's
   * focus session is still one edit. */
  coalesceFrom(index: number, label: string): void {
    if (index < 0 || index >= this.entries.length - 1) return
    const held = this.entries.splice(index)
    const ops = held.map((entry) => entry.op)
    const author = ops.some((op) => op.author === 'copilot') ? 'copilot' : 'you'
    const compose = (xs: Op[], name: string): Op => ({
      label: name,
      author,
      apply() { for (const op of xs) op.apply() },
      invert() { return compose([...xs].reverse().map((op) => op.invert()), `un-${name}`) },
    })
    this.entries.push({ op: compose(ops, label), at: held[0].at })
  }
}
