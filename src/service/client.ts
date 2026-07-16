/* Client for the local dia service (ADK-based). Offline-graceful:
 * health() false ⇒ UI shows the offline state, editor works fully without it. */

import type { ChatContext, ChatEvent, ImportResult, ProposedOp } from '../types'

/** a single-shot skill run: the output plus any model reasoning — the
 * import review shows the FULL transcript, not a one-line summary */
export interface SkillResult {
  output: string
  thinking: string
}

export const SERVICE_PORT = 8317

/* When the page is served by the dia service itself (dia edit / dia ingest /
 * dia serve --editor mount the built editor at /editor), service calls are
 * SAME-ORIGIN and the base must be relative. Keying that off a specific port
 * (== 8317) breaks as soon as the service is served on any other port — e.g.
 * `dia serve --port 9000`: the check fails, the base falls back to the absolute
 * http://127.0.0.1:8317, and /chat, /health, /skills/* hit the wrong port (or a
 * cross-origin one), so the copilot goes dead. Detect same-origin structurally
 * instead: if the page was served over http(s) by anything other than the Vite
 * dev server, use a relative base. An absolute http://127.0.0.1:8317 base also
 * turns cross-origin the moment the page is opened as localhost:8317 (localhost
 * ≠ 127.0.0.1 to the browser), which relative URLs sidestep. The absolute
 * default remains for the Vite dev server (5199) and the file:// standalone,
 * which genuinely are cross-origin and are on the service's allowlist. */
export const SERVICE_BASE = ((): string => {
  if (typeof window === 'undefined') return `http://127.0.0.1:${SERVICE_PORT}`
  const {protocol, port} = window.location
  const isViteDev = port === '5199'
  const servedByService =
    (protocol === 'http:' || protocol === 'https:') && !isViteDev
  return servedByService ? '' : `http://127.0.0.1:${SERVICE_PORT}`
})()

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
      let raw: unknown
      try { raw = JSON.parse(payload) } catch { continue } // malformed frame — skip
      const ev = normalizeChatEvent(raw)
      if (ev) yield ev
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
    if (!r.ok) {
      // the service's detail says WHY (e.g. "model returned no <section>
      // element, even after a correction round") — surface it, not just 422
      let detail = ''
      try { detail = String((await r.json())?.detail ?? '') } catch { /* body not json */ }
      throw new Error(`${name} failed: ${r.status}${detail ? ` — ${detail}` : ''}`)
    }
    const j = await r.json()
    return { output: (j[field] as string) ?? '', thinking: (j.thinking as string) ?? '' }
  }
}

/* ---------- chat event normalization ----------
 * Everything on the wire is model-shaped until proven otherwise. A frame
 * that parses as JSON can still be junk: wrong type tag, ops as a JSON
 * string, numeric deltas. Normalize what is recoverable, drop the rest —
 * a bad frame must never reach the rail as a lie about its own shape. */

export function normalizeChatEvent(raw: unknown): ChatEvent | null {
  if (typeof raw !== 'object' || raw === null) return null
  const ev = raw as Record<string, unknown>
  switch (ev.type) {
    case 'text':
    case 'thinking': {
      const delta = typeof ev.delta === 'string' ? ev.delta
        : typeof ev.delta === 'number' ? String(ev.delta) : null
      return delta === null ? null : { type: ev.type, delta }
    }
    case 'error': {
      const message = typeof ev.message === 'string' ? ev.message : 'service error'
      return { type: 'error', message }
    }
    case 'done':
      return { type: 'done' }
    case 'ops': {
      let list = ev.ops
      if (typeof list === 'string') {
        try { list = JSON.parse(list) } catch { list = null }
      }
      const items = Array.isArray(list) ? list : []
      const ops: ProposedOp[] = []
      let dropped = typeof ev.dropped === 'number' && ev.dropped > 0 ? ev.dropped : 0
      for (const item of items) {
        const op = normalizeProposedOp(item)
        if (op) ops.push(op)
        else dropped++
      }
      if (!Array.isArray(list) && items.length === 0 && ev.ops != null) dropped++
      return { type: 'ops', ops, dropped }
    }
    default:
      return null
  }
}

function normalizeProposedOp(item: unknown): ProposedOp | null {
  if (typeof item !== 'object' || item === null) return null
  const o = item as Record<string, unknown>
  if (typeof o.action !== 'string' || o.action === '') return null
  const target = typeof o.target === 'string' ? o.target
    : typeof o.target === 'number' ? String(o.target) : null
  if (target === null) return null
  const label = typeof o.label === 'string' && o.label !== '' ? o.label : `${o.action} ${target}`.trim()
  const op: ProposedOp = { action: o.action as ProposedOp['action'], target, label }
  if (o.value !== undefined && o.value !== null) {
    op.value = typeof o.value === 'string' ? o.value : String(o.value)
  }
  if (typeof o.extra === 'object' && o.extra !== null) {
    const extra: Record<string, string | number> = {}
    for (const [k, v] of Object.entries(o.extra as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number') extra[k] = v
    }
    op.extra = extra
  }
  return op
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
