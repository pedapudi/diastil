/* The SSE parser is spec-faithful: CRLF, LF, and bare CR all frame events,
 * chunk boundaries can fall anywhere (including inside a CRLF pair), and
 * multi-line data joins with newlines. */

import { describe, expect, it } from 'vitest'
import { sseData } from './client'

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
}

async function collect(chunks: string[]): Promise<string[]> {
  const out: string[] = []
  for await (const p of sseData(streamOf(chunks))) out.push(p)
  return out
}

describe('sseData', () => {
  it('LF frames', async () => {
    expect(await collect(['data: {"a":1}\n\ndata: {"b":2}\n\n']))
      .toEqual(['{"a":1}', '{"b":2}'])
  })

  it('CRLF frames — the case the ad-hoc reader dropped entirely', async () => {
    expect(await collect(['data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n']))
      .toEqual(['{"a":1}', '{"b":2}'])
  })

  it('bare-CR frames', async () => {
    expect(await collect(['data: one\r\rdata: two\r\r'])).toEqual(['one', 'two'])
  })

  it('a CRLF split across chunk boundaries stays one terminator', async () => {
    expect(await collect(['data: x\r', '\n\r', '\ndata: y\r\n\r\n']))
      .toEqual(['x', 'y'])
  })

  it('multi-line data joins with newlines; one leading space strips', async () => {
    expect(await collect(['data: line1\ndata:line2\n\n'])).toEqual(['line1\nline2'])
  })

  it('comments and other fields are ignored', async () => {
    expect(await collect([': keepalive\nevent: message\nid: 7\ndata: payload\n\n']))
      .toEqual(['payload'])
  })

  it('an unterminated final event still dispatches', async () => {
    expect(await collect(['data: tail'])).toEqual(['tail'])
  })

  it('blank frames dispatch nothing', async () => {
    expect(await collect(['\n\n\n\n: ping\n\n'])).toEqual([])
  })
})

/* ---------- chat event normalization ----------
 * Model output is untrusted at every layer: a frame that parses as JSON can
 * still be the wrong shape. These pin what survives and what is dropped. */

import { normalizeChatEvent } from './client'

describe('normalizeChatEvent', () => {
  it('passes well-formed events through', () => {
    expect(normalizeChatEvent({ type: 'text', delta: 'hi' })).toEqual({ type: 'text', delta: 'hi' })
    expect(normalizeChatEvent({ type: 'thinking', delta: 'hm' })).toEqual({ type: 'thinking', delta: 'hm' })
    expect(normalizeChatEvent({ type: 'done' })).toEqual({ type: 'done' })
    expect(normalizeChatEvent({ type: 'error', message: 'boom' })).toEqual({ type: 'error', message: 'boom' })
  })

  it('rejects junk frames outright', () => {
    expect(normalizeChatEvent(null)).toBeNull()
    expect(normalizeChatEvent('text')).toBeNull()
    expect(normalizeChatEvent({ type: 'surprise' })).toBeNull()
    expect(normalizeChatEvent({ type: 'text' })).toBeNull() // no delta
    expect(normalizeChatEvent({ type: 'text', delta: { nested: true } })).toBeNull()
  })

  it('coerces numeric deltas and defaults error messages', () => {
    expect(normalizeChatEvent({ type: 'text', delta: 42 })).toEqual({ type: 'text', delta: '42' })
    expect(normalizeChatEvent({ type: 'error' })).toEqual({ type: 'error', message: 'service error' })
  })

  it('ops: accepts a clean list and synthesizes missing labels', () => {
    const ev = normalizeChatEvent({ type: 'ops', ops: [{ action: 'set-text', target: 'slide 1 title', value: 'New' }] })
    expect(ev).toEqual({
      type: 'ops',
      dropped: 0,
      ops: [{ action: 'set-text', target: 'slide 1 title', label: 'set-text slide 1 title', value: 'New' }],
    })
  })

  it('ops: unwraps a JSON-string list (models double-encode)', () => {
    const ev = normalizeChatEvent({
      type: 'ops',
      ops: '[{"action":"remove","target":"#x","label":"rm"}]',
    })
    expect(ev).toEqual({ type: 'ops', dropped: 0, ops: [{ action: 'remove', target: '#x', label: 'rm' }] })
  })

  it('ops: drops unreadable items and counts them, keeping the rest', () => {
    const ev = normalizeChatEvent({
      type: 'ops',
      ops: [{ action: 'remove', target: '#x', label: 'rm' }, 'junk', 7, { target: 'no action' }],
    })
    expect(ev).toEqual({ type: 'ops', dropped: 3, ops: [{ action: 'remove', target: '#x', label: 'rm' }] })
  })

  it('ops: coerces numeric targets/values and filters extra to primitives', () => {
    const ev = normalizeChatEvent({
      type: 'ops',
      ops: [{ action: 'set-style', target: 3, value: 12, extra: { prop: 'gap', junk: { deep: 1 } } }],
    })
    expect(ev).toEqual({
      type: 'ops',
      dropped: 0,
      ops: [{ action: 'set-style', target: '3', label: 'set-style 3', value: '12', extra: { prop: 'gap' } }],
    })
  })

  it('ops: a hopeless payload becomes an empty proposal with dropped > 0', () => {
    expect(normalizeChatEvent({ type: 'ops', ops: 'not json' }))
      .toEqual({ type: 'ops', dropped: 1, ops: [] })
    expect(normalizeChatEvent({ type: 'ops', ops: { action: 'x' } }))
      .toEqual({ type: 'ops', dropped: 1, ops: [] })
  })

  it('ops: honors the service-side dropped count additively', () => {
    const ev = normalizeChatEvent({ type: 'ops', dropped: 2, ops: ['junk'] })
    expect(ev).toEqual({ type: 'ops', dropped: 3, ops: [] })
  })
})
