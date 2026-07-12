/* Editor wiring for cross-session revision history (model/history.ts).
 *
 * Records the serialized document (debounced, so op bursts coalesce) on
 * every change, and answers the op log's "nothing left to undo/redo" by
 * restoring the neighboring recorded state — which may come from an
 * earlier session. Restores reload the deck through the normal
 * deck-loaded path, so every module resets consistently. */

import { defaultHistoryStore, RevisionChain } from '../model/history'
import { loadDeck } from '../model/parse'
import { serializeDeck } from '../model/serialize'
import { state } from '../state'

const RECORD_DEBOUNCE_MS = 500

export function installHistory(canvasHost: HTMLElement): void {
  const store = defaultHistoryStore()
  let chain: RevisionChain | null = null
  let restoring = false
  let timer = 0

  const snapshot = (): string | null => (state.deck ? serializeDeck(state.deck) : null)

  const flush = (): void => {
    window.clearTimeout(timer)
    timer = 0
    const s = snapshot()
    if (s && chain) chain.record(s)
  }

  state.bus.on((e) => {
    if (e.type === 'deck-loaded') {
      window.clearTimeout(timer)
      const s = snapshot()
      if (!s || restoring) return // restores reconcile against the same chain
      chain = new RevisionChain(state.deck!.fileName, store)
      void chain.init(s)
      return
    }
    if (e.type === 'op' || e.type === 'undo' || e.type === 'redo') {
      window.clearTimeout(timer)
      timer = window.setTimeout(flush, RECORD_DEBOUNCE_MS)
    }
  })

  // don't lose the trailing debounce window when the tab goes away
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && timer) flush()
  })

  const restore = (html: string): void => {
    if (!state.deck) return
    restoring = true
    try {
      const deck = loadDeck(html, canvasHost, state.deck.fileName)
      state.deck = deck
      state.bus.emit({ type: 'deck-loaded' })
    } finally {
      restoring = false
    }
  }

  state.onUndoExhausted = () => {
    if (timer) flush()
    const s = snapshot()
    if (!s || !chain) return
    const prev = chain.back(s)
    if (prev) restore(prev)
  }
  state.onRedoExhausted = () => {
    if (timer) flush()
    const s = snapshot()
    if (!s || !chain) return
    const next = chain.forward(s)
    if (next) restore(next)
  }
}
