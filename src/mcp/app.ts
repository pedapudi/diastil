/* MCP App bridge — lets the diastil editor render inside an MCP host (Claude,
 * Copilot, …) as an "MCP App" (https://modelcontextprotocol.io/extensions/apps).
 *
 * The host renders this page in a sandboxed iframe and speaks a JSON-RPC 2.0
 * dialect over postMessage. We hand-roll the small handshake — no SDK, in keeping
 * with the rest of diastil (the service SSE parser and the `dia mcp` server are
 * hand-rolled too). The transport is plain: JSON-RPC messages posted to
 * window.parent, received on `message` events whose `data.jsonrpc === '2.0'`.
 *
 * Flow: on connect we send `ui/initialize`, await the host's result, then send
 * `ui/notifications/initialized`. The host delivers the deck to open via
 * `ui/notifications/tool-result` (or `…/tool-input`); we load it. As the user
 * edits, we push the current deck back to the model with `ui/update-model-context`
 * so the conversation sees the result. Outside a host (no parent, or no reply to
 * the handshake) this is a no-op and the editor behaves exactly as a web page. */

import { loadDeck } from '../model/parse'
import { serializeDeck } from '../model/serialize'
import { startImport } from '../ingest/pipeline'
import { isDialectHtml } from '../editor/slides'
import { state } from '../state'

const PROTOCOL_VERSION = '2026-01-26'
const HANDSHAKE_TIMEOUT_MS = 2000
const SYNC_DEBOUNCE_MS = 1200

interface Rpc {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: unknown
}

function loadDeckIntoEditor(html: string, name: string): void {
  const host = document.getElementById('deck-host')
  if (!host) return
  // dialect decks load directly; anything foreign converts through the pipeline,
  // exactly as the file picker / CLI bridge do.
  if (isDialectHtml(html)) {
    state.deck = loadDeck(html, host, name)
    state.bus.emit({ type: 'deck-loaded' })
  } else {
    void startImport(html, name)
  }
}

class McpAppBridge {
  private seq = 0
  private readonly pending = new Map<number, (result: unknown) => void>()
  private ready = false
  private syncTimer = 0

  private post(msg: Rpc): void {
    window.parent.postMessage(msg, '*')
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const id = ++this.seq
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.post({ jsonrpc: '2.0', id, method, params })
    })
  }

  private notify(method: string, params?: unknown): void {
    this.post({ jsonrpc: '2.0', method, params })
  }

  private readonly onMessage = (ev: MessageEvent): void => {
    const msg = ev.data as Rpc | null
    if (!msg || msg.jsonrpc !== '2.0') return

    // a response to one of our requests
    if (
      msg.id !== undefined &&
      msg.method === undefined &&
      (msg.result !== undefined || msg.error !== undefined)
    ) {
      const resolve = this.pending.get(msg.id as number)
      if (resolve) {
        this.pending.delete(msg.id as number)
        resolve(msg.error !== undefined ? undefined : msg.result)
      }
      return
    }

    // a request/notification from the host
    switch (msg.method) {
      case 'ping':
      case 'ui/resource-teardown':
        if (msg.id !== undefined) this.post({ jsonrpc: '2.0', id: msg.id, result: {} })
        break
      case 'ui/notifications/tool-result':
        this.openFromToolResult(msg.params)
        break
      case 'ui/notifications/tool-input':
        this.openFromToolInput(msg.params)
        break
    }
  }

  private openFromToolResult(params: unknown): void {
    const p = (params ?? {}) as {
      structuredContent?: { deckHtml?: unknown; name?: unknown }
      content?: Array<{ type?: string; text?: string }>
    }
    const deck =
      typeof p.structuredContent?.deckHtml === 'string'
        ? p.structuredContent.deckHtml
        : p.content?.find((c) => c?.type === 'text')?.text
    const name =
      typeof p.structuredContent?.name === 'string' ? p.structuredContent.name : 'deck.html'
    if (typeof deck === 'string' && deck.trim()) loadDeckIntoEditor(deck, name)
  }

  private openFromToolInput(params: unknown): void {
    const args = ((params ?? {}) as { arguments?: { html?: unknown; name?: unknown } }).arguments
    const deck = typeof args?.html === 'string' ? args.html : null
    const name = typeof args?.name === 'string' ? args.name : 'deck.html'
    if (deck && deck.trim()) loadDeckIntoEditor(deck, name)
  }

  async connect(): Promise<boolean> {
    // Only meaningful inside a host frame; a bare page has no parent to talk to.
    if (typeof window === 'undefined' || window.parent === window) return false
    window.addEventListener('message', this.onMessage)
    const ok = await Promise.race([
      this.request('ui/initialize', {
        appInfo: { name: 'diastil', version: '0.1.0' },
        appCapabilities: {},
        protocolVersion: PROTOCOL_VERSION,
      }).then(() => true),
      new Promise<boolean>((r) => window.setTimeout(() => r(false), HANDSHAKE_TIMEOUT_MS)),
    ])
    if (!ok) {
      window.removeEventListener('message', this.onMessage)
      return false
    }
    this.notify('ui/notifications/initialized')
    this.ready = true
    // Keep the model's view of the deck current as the user edits.
    state.bus.on((e) => {
      if (e.type === 'op' || e.type === 'undo' || e.type === 'redo' || e.type === 'deck-loaded') {
        this.scheduleSync()
      }
    })
    return true
  }

  private scheduleSync(): void {
    window.clearTimeout(this.syncTimer)
    this.syncTimer = window.setTimeout(() => this.syncDeck(), SYNC_DEBOUNCE_MS)
  }

  private syncDeck(): void {
    if (!this.ready || !state.deck) return
    const html = serializeDeck(state.deck)
    // update-model-context is a request in the spec; fire it and ignore the ack.
    void this.request('ui/update-model-context', {
      content: [{ type: 'text', text: 'The current diastil deck (edited in the editor):' }],
      structuredContent: { deckHtml: html },
    })
  }
}

/** Connect to an MCP host if we are running as an MCP App. No-op otherwise. */
export function initMcpApp(): void {
  void new McpAppBridge().connect()
}
