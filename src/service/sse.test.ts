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
