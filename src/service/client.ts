/* Client for the local dia service (ADK-based). Offline-graceful:
 * health() false ⇒ UI shows the offline state, editor works fully without it. */

import type { ChatContext, ChatEvent, ImportResult } from '../types'

/** a single-shot skill run: the output plus any model reasoning — the
 * import review shows the FULL transcript, not a one-line summary */
export interface SkillResult {
  output: string
  thinking: string
}

export const SERVICE_PORT = 8317

/* When the page is served by the dia service itself (dia edit / dia ingest /
 * dia serve --editor mount the built editor at /editor on port 8317), service
 * calls are SAME-ORIGIN and the base must be relative: an absolute
 * http://127.0.0.1:8317 base turns them cross-origin the moment the user
 * opens the page as localhost:8317 (localhost ≠ 127.0.0.1 to the browser),
 * and CORS then blocks /health, /file, and /skills/*. Relative URLs sidestep
 * origins entirely there — no allowlist widening needed. The absolute
 * default remains for the Vite dev server (5199) and the file:// standalone,
 * which genuinely are cross-origin and are on the service's allowlist. */
export const SERVICE_BASE =
  typeof window !== 'undefined' && window.location.port === String(SERVICE_PORT)
    ? ''
    : `http://127.0.0.1:${SERVICE_PORT}`

export class ServiceClient {
  base: string
  constructor(base: string = SERVICE_BASE) { this.base = base }

  async health(): Promise<{ ok: boolean; model?: string }> {
    try {
      const r = await fetch(`${this.base}/health`, { signal: AbortSignal.timeout(1200) })
      if (!r.ok) return { ok: false }
      const j = await r.json()
      return { ok: true, model: j.model }
    } catch {
      return { ok: false }
    }
  }

  /** copilot chat; yields streamed events (SSE) */
  async *chat(sessionId: string, message: string, ctx: ChatContext): AsyncGenerator<ChatEvent> {
    let res: Response
    try {
      res = await fetch(`${this.base}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, message, context: ctx }),
      })
    } catch {
      yield { type: 'error', message: 'dia service unreachable — start it with `dia serve`' }
      return
    }
    if (!res.ok || !res.body) {
      yield { type: 'error', message: `service error ${res.status}` }
      return
    }
    for await (const payload of sseData(res.body)) {
      try { yield JSON.parse(payload) as ChatEvent } catch { /* skip malformed frame */ }
    }
    yield { type: 'done' }
  }

  /** model-assisted translation for one slide (ingest); throws when offline.
   * images (optional): a render of the ORIGINAL slide, so a vision model
   * sees the layout it must reproduce. feedback: reviewer notes. */
  async translateSlide(
    sourceHtml: string, tokensCss: string, images: string[] = [], feedback = '',
  ): Promise<SkillResult> {
    return this.skill('translate-slide', { sourceHtml, tokensCss, images, feedback }, 'slideHtml')
  }

  /** one fidelity-loop repair round: corrected slide for a reported mismatch.
   * images (PNG data URLs, optional): original render, candidate render,
   * diff heatmap — a vision model uses them to see the miss directly.
   * feedback: reviewer notes riding along with the mismatch. */
  async repairFidelity(
    sourceHtml: string,
    candidateHtml: string,
    tokensCss: string,
    mismatch: string,
    images: string[] = [],
    feedback = '',
  ): Promise<SkillResult> {
    return this.skill('repair-fidelity', { sourceHtml, candidateHtml, tokensCss, mismatch, images, feedback }, 'slideHtml')
  }

  /** lift a raw SVG diagram into the scene vocabulary.
   * images (optional): a render of the source diagram for vision models.
   * feedback: reviewer notes. */
  async liftDiagram(svgHtml: string, images: string[] = [], feedback = ''): Promise<SkillResult> {
    return this.skill('lift-diagram', { svgHtml, images, feedback }, 'sceneHtml')
  }

  private async skill(name: string, body: object, field: string): Promise<SkillResult> {
    const r = await fetch(`${this.base}/skills/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!r.ok) throw new Error(`${name} failed: ${r.status}`)
    const j = await r.json()
    return { output: (j[field] as string) ?? '', thinking: (j.thinking as string) ?? '' }
  }
}

/* ---------- SSE parsing ----------
 * The platform has no POST-capable EventSource, so the stream is parsed by
 * hand — SPEC-FAITHFULLY, which an earlier ad-hoc reader was not (it framed
 * on bare \n\n only, so a server emitting CRLF frames streamed a correct
 * 200 reply that rendered as total silence). */

/** event-stream line terminators: CRLF, LF, or bare CR — all three are legal */
const SSE_LINE = /\r\n|\r|\n/

/** Parse an SSE byte stream into data payloads, one string per event:
 * `data:` lines accumulate (joined with \n, one leading space stripped),
 * a blank line dispatches, all other fields are ignored. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let data: string[] = []

  function* lines(final: boolean): Generator<string> {
    while (true) {
      const m = SSE_LINE.exec(buf)
      if (!m) break
      // a lone trailing \r may be the first half of a CRLF split across
      // chunks — wait for the next chunk before treating it as a terminator
      if (!final && m[0] === '\r' && m.index === buf.length - 1) break
      yield buf.slice(0, m.index)
      buf = buf.slice(m.index + m[0].length)
    }
  }

  const dispatch = function* (line: string): Generator<string> {
    if (line === '') {
      if (data.length > 0) yield data.join('\n')
      data = []
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''))
    } // comments (:) and other fields (event:, id:, retry:) are ignored
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    for (const line of lines(false)) yield* dispatch(line)
  }
  buf += decoder.decode() // flush any trailing multi-byte sequence
  for (const line of lines(true)) yield* dispatch(line)
  if (buf) yield* dispatch(buf) // an unterminated final line still counts
  yield* dispatch('') // …and an unterminated final event still dispatches
}

export const service = new ServiceClient()
export type { ImportResult }
