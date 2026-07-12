/* Client for the local dia service (ADK-based). Offline-graceful:
 * health() false ⇒ UI shows the offline state, editor works fully without it. */

import type { ChatContext, ChatEvent, ImportResult } from '../types'

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
    return this.skill('translate-slide', { sourceHtml, tokensCss }, 'slideHtml')
  }

  /** one fidelity-loop repair round: corrected slide for a reported mismatch.
   * images (PNG data URLs, optional): original render, candidate render,
   * diff heatmap — a vision model uses them to see the miss directly. */
  async repairFidelity(
    sourceHtml: string,
    candidateHtml: string,
    tokensCss: string,
    mismatch: string,
    images: string[] = [],
  ): Promise<string> {
    return this.skill('repair-fidelity', { sourceHtml, candidateHtml, tokensCss, mismatch, images }, 'slideHtml')
  }

  /** lift a raw SVG diagram into the scene vocabulary.
   * images (optional): a render of the source diagram for vision models. */
  async liftDiagram(svgHtml: string, images: string[] = []): Promise<string> {
    return this.skill('lift-diagram', { svgHtml, images }, 'sceneHtml')
  }

  private async skill(name: string, body: object, field: string): Promise<string> {
    const r = await fetch(`${this.base}/skills/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!r.ok) throw new Error(`${name} failed: ${r.status}`)
    const j = await r.json()
    return j[field] as string
  }
}

export const service = new ServiceClient()
export type { ImportResult }
