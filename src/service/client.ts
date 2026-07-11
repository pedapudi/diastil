/* Client for the local dia service (ADK-based). Offline-graceful:
 * health() false ⇒ UI shows the offline state, editor works fully without it. */

import type { ChatContext, ChatEvent, ImportResult } from '../types'

export const SERVICE_BASE = 'http://127.0.0.1:8317'

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
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2)
        const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
        if (!data) continue
        try { yield JSON.parse(data) as ChatEvent } catch { /* skip malformed frame */ }
      }
    }
    yield { type: 'done' }
  }

  /** model-assisted translation for one slide (ingest); throws when offline */
  async translateSlide(sourceHtml: string, tokensCss: string): Promise<string> {
    const r = await fetch(`${this.base}/skills/translate-slide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceHtml, tokensCss }),
    })
    if (!r.ok) throw new Error(`translate-slide failed: ${r.status}`)
    const j = await r.json()
    return j.slideHtml as string
  }
}

export const service = new ServiceClient()
export type { ImportResult }
