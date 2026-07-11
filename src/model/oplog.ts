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
}
