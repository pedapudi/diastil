/* Editor state hub: deck handle, selection, altitude, op log, event bus.
 * Owned by integration — module agents consume, do not edit. */

import type { Altitude, Deck, EditorEvent, Op, OpLogEntry, Selection, SlideEl } from './types'
import { OpLog } from './model/oplog'

type Listener = (e: EditorEvent) => void

export class Bus {
  private listeners = new Set<Listener>()
  on(fn: Listener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  emit(e: EditorEvent): void { for (const fn of [...this.listeners]) fn(e) }
}

export class EditorState {
  deck: Deck | null = null
  bus = new Bus()
  log = new OpLog()
  private _sel: Selection = { kind: 'none' }
  private _altitude: Altitude = 'table'
  private _current = 0

  get selection(): Selection { return this._sel }
  set selection(sel: Selection) { this._sel = sel; this.bus.emit({ type: 'selection', sel }) }

  get altitude(): Altitude { return this._altitude }
  setAltitude(a: Altitude): void {
    if (a === this._altitude) return
    this._altitude = a
    this.bus.emit({ type: 'altitude', altitude: a })
  }

  get currentSlide(): number { return this._current }
  setCurrentSlide(i: number): void {
    const n = this.slides().length
    const clamped = Math.max(0, Math.min(i, n - 1))
    if (clamped === this._current) return
    this._current = clamped
    this.bus.emit({ type: 'current-slide', index: clamped })
  }

  slides(): SlideEl[] {
    if (!this.deck) return []
    return [...this.deck.root.querySelectorAll<HTMLElement>('section.dia-slide')]
  }

  /** apply an op through the log (single entry point for every mutation) */
  apply(op: Op): void {
    const entry: OpLogEntry = { op, at: Date.now() }
    this.log.push(entry)
    op.apply()
    this.bus.emit({ type: 'op', entry })
  }

  undo(): void { if (this.log.undo()) this.bus.emit({ type: 'undo' }) }
  redo(): void { if (this.log.redo()) this.bus.emit({ type: 'redo' }) }
}

/** module-global singleton — main.ts creates it, modules import it */
export const state = new EditorState()
