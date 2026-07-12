/* Cross-session revision chain: reconcile on load, cursor-follows-undo,
 * branch truncation, boundary walks across "sessions", and the cap. */

import { describe, expect, it } from 'vitest'
import { MAX_STATES, MemoryHistoryStore, RevisionChain } from './history'

async function freshChain(store = new MemoryHistoryStore(), key = 'deck.html', current = 's0') {
  const chain = new RevisionChain(key, store)
  await chain.init(current)
  return chain
}

describe('RevisionChain', () => {
  it('records edits and walks back/forward', async () => {
    const c = await freshChain()
    c.record('s1')
    c.record('s2')
    expect(c.back('s2')).toBe('s1')
    expect(c.back('s1')).toBe('s0')
    expect(c.back('s0')).toBeNull() // beginning of history
    expect(c.forward('s0')).toBe('s1')
    expect(c.forward('s1')).toBe('s2')
    expect(c.forward('s2')).toBeNull() // end of history
  })

  it('in-session undo/redo just moves the cursor (no truncation)', async () => {
    const c = await freshChain()
    c.record('s1')
    c.record('s2')
    c.record('s1') // op-level undo landed back on a recorded neighbor
    expect(c.length).toBe(3)
    c.record('s2') // redo forward again
    expect(c.length).toBe(3)
  })

  it('a new edit after stepping back truncates the redo tail', async () => {
    const c = await freshChain()
    c.record('s1')
    c.record('s2')
    c.record('s1')      // stepped back
    c.record('s1b')     // branched
    expect(c.length).toBe(3) // s0, s1, s1b
    expect(c.forward('s1b')).toBeNull()
    expect(c.back('s1b')).toBe('s1')
  })

  it('survives a "session boundary": a new chain resumes where the old one ended', async () => {
    const store = new MemoryHistoryStore()
    const session1 = await freshChain(store)
    session1.record('s1')
    session1.record('s2')

    // reload: new chain instance, document is at the last saved state
    const session2 = new RevisionChain('deck.html', store)
    await session2.init('s2')
    expect(session2.back('s2')).toBe('s1') // undo into the previous session
    expect(session2.back('s1')).toBe('s0')
    expect(session2.forward('s0')).toBe('s1') // and forward again
  })

  it('a document that diverged outside the chain restarts history', async () => {
    const store = new MemoryHistoryStore()
    const session1 = await freshChain(store)
    session1.record('s1')

    const session2 = new RevisionChain('deck.html', store)
    await session2.init('edited-elsewhere')
    expect(session2.length).toBe(1)
    expect(session2.back('edited-elsewhere')).toBeNull()
  })

  it('reopening at an EARLIER recorded state keeps redo forward possible', async () => {
    const store = new MemoryHistoryStore()
    const session1 = await freshChain(store)
    session1.record('s1')
    session1.record('s2')

    const session2 = new RevisionChain('deck.html', store)
    await session2.init('s1') // e.g. the user saved at s1, reopened that file
    expect(session2.forward('s1')).toBe('s2')
  })

  it('caps the chain at MAX_STATES, dropping the oldest', async () => {
    const c = await freshChain()
    for (let i = 1; i <= MAX_STATES + 20; i++) c.record(`s${i}`)
    expect(c.length).toBe(MAX_STATES)
    expect(c.back(`s${MAX_STATES + 20}`)).toBe(`s${MAX_STATES + 19}`)
  })

  it('aligns the cursor when asked to step from an unrecorded state', async () => {
    const c = await freshChain()
    c.record('s1')
    // a pending-debounce state the chain never saw
    expect(c.back('s1-pending')).toBe('s1')
  })
})
