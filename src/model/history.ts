/* Cross-session revision history.
 *
 * In-session undo/redo stays op-based (fine-grained, exact). This layer
 * records serialized document states into a per-deck chain persisted in
 * IndexedDB, and takes over only at session BOUNDARIES: when the op log
 * is exhausted, undo restores the previous recorded state — including
 * states from earlier sessions — and redo walks forward again. Byte-stable
 * serialization is what makes state equality, and therefore the walk,
 * exact. The chain is capped; ops within a debounce window coalesce into
 * one recorded state. */

export const MAX_STATES = 100

export interface HistoryStore {
  load(key: string): Promise<string[]>
  save(key: string, chain: string[]): Promise<void>
}

/** One deck's chain of serialized states + a session-local cursor. */
export class RevisionChain {
  private chain: string[] = []
  private cursor = -1

  constructor(private key: string, private store: HistoryStore) {}

  /** Load the persisted chain and reconcile with the current state: found
   * in the chain → keep it (boundary redo stays possible) and point the
   * cursor there; absent → the document diverged outside this chain, so
   * history restarts from the current state. */
  async init(current: string): Promise<void> {
    const persisted = await this.store.load(this.key)
    const at = persisted.lastIndexOf(current)
    if (at >= 0) {
      this.chain = persisted
      this.cursor = at
    } else {
      this.chain = [current]
      this.cursor = 0
    }
    void this.persist()
  }

  /** Record the document's state after a change. In-session undo/redo land
   * on neighboring recorded states and just move the cursor; a genuinely
   * new state truncates the redo tail (a branch, like any undo history). */
  record(current: string): void {
    if (this.chain[this.cursor] === current) return
    if (this.chain[this.cursor - 1] === current) { this.cursor--; void this.persist(); return }
    if (this.chain[this.cursor + 1] === current) { this.cursor++; void this.persist(); return }
    this.chain.length = this.cursor + 1
    this.chain.push(current)
    if (this.chain.length > MAX_STATES) this.chain.splice(0, this.chain.length - MAX_STATES)
    this.cursor = this.chain.length - 1
    void this.persist()
  }

  /** step back from the current state; null when at the beginning */
  back(current: string): string | null {
    this.align(current)
    if (this.cursor <= 0) return null
    this.cursor--
    void this.persist()
    return this.chain[this.cursor]
  }

  /** step forward from the current state; null when at the end */
  forward(current: string): string | null {
    this.align(current)
    if (this.cursor < 0 || this.cursor >= this.chain.length - 1) return null
    this.cursor++
    void this.persist()
    return this.chain[this.cursor]
  }

  /** the cursor must sit on the state the document actually shows */
  private align(current: string): void {
    if (this.chain[this.cursor] === current) return
    const at = this.chain.lastIndexOf(current)
    if (at >= 0) this.cursor = at
    else {
      // unrecorded state (e.g. a pending debounce) — record it in place
      this.record(current)
    }
  }

  get length(): number { return this.chain.length }
  get position(): number { return this.cursor }

  private persist(): Promise<void> {
    return this.store.save(this.key, this.chain)
  }
}

/* ---------------- stores ---------------- */

/** test / no-IndexedDB fallback */
export class MemoryHistoryStore implements HistoryStore {
  private data = new Map<string, string[]>()
  async load(key: string): Promise<string[]> { return [...(this.data.get(key) ?? [])] }
  async save(key: string, chain: string[]): Promise<void> { this.data.set(key, [...chain]) }
}

/** IndexedDB persistence — one object store, one record per deck key */
export class IdbHistoryStore implements HistoryStore {
  private db: Promise<IDBDatabase>

  constructor(name = 'dia-history') {
    this.db = new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1)
      req.onupgradeneeded = () => { req.result.createObjectStore('chains') }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }

  async load(key: string): Promise<string[]> {
    const db = await this.db
    return new Promise((resolve) => {
      const rq = db.transaction('chains', 'readonly').objectStore('chains').get(key)
      rq.onsuccess = () => resolve(Array.isArray(rq.result) ? rq.result : [])
      rq.onerror = () => resolve([])
    })
  }

  async save(key: string, chain: string[]): Promise<void> {
    const db = await this.db
    return new Promise((resolve) => {
      const tx = db.transaction('chains', 'readwrite')
      tx.objectStore('chains').put(chain, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
  }
}

export function defaultHistoryStore(): HistoryStore {
  try {
    if (typeof indexedDB !== 'undefined') return new IdbHistoryStore()
  } catch { /* fall through */ }
  return new MemoryHistoryStore()
}
