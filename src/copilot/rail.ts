/* Copilot rail — right-column chat over the local dia service.
 * Selection-aware context, streamed replies, op-diff cards with
 * apply/reject; applied batches join the same undo history as
 * direct edits. Fully quiet when the service is offline. */

import './copilot.css'
import type { ChatContext, ProposedOp, Selection } from '../types'
import { state } from '../state'
import { service } from '../service/client'
import { batch } from '../model/ops'
import { compileOps } from './compile'

const HEALTH_MIN_INTERVAL = 30_000

export function mountCopilot(host: HTMLElement): void {
  host.classList.add('dia-cop')

  /* ---------- structure ---------- */

  const header = div('dia-cop-header')
  const title = div('dia-cop-title'); title.textContent = 'copilot'
  const model = div('dia-cop-model')
  header.append(title, model)

  const context = div('dia-cop-context')

  const log = div('dia-cop-log')

  const composer = div('dia-cop-composer')
  const input = document.createElement('textarea')
  input.className = 'dia-cop-input'
  input.rows = 1
  input.placeholder = 'ask the copilot…'
  const send = document.createElement('button')
  send.type = 'button'
  send.className = 'dn-btn dn-btn-accent dia-cop-send'
  send.textContent = 'send'
  composer.append(input, send)

  host.append(header, context, log, composer)

  /* ---------- session ---------- */

  let sessionId = newSessionId()
  let online = false
  let offlineLine: HTMLElement | null = null
  let busy = false

  /* ---------- health / offline ---------- */

  let lastHealthAt = 0
  async function checkHealth(): Promise<void> {
    const now = Date.now()
    if (now - lastHealthAt < HEALTH_MIN_INTERVAL) return
    lastHealthAt = now
    const h = await service.health()
    online = h.ok
    model.textContent = h.ok ? (h.model ?? '') : ''
    setComposerEnabled(h.ok && !busy)
    if (!h.ok) {
      if (!offlineLine) {
        offlineLine = div('dia-cop-offline')
        offlineLine.textContent =
          'service offline — the editor is fully functional without it. start it with: dia serve'
        log.appendChild(offlineLine)
        scrollDown()
      }
    } else if (offlineLine) {
      offlineLine.remove()
      offlineLine = null
    }
  }

  function setComposerEnabled(on: boolean): void {
    input.disabled = !on
    send.disabled = !on
  }

  lastHealthAt = -Infinity
  void checkHealth()
  window.addEventListener('focus', () => { void checkHealth() })

  /* ---------- context line ---------- */

  function renderContext(): void {
    const n = state.currentSlide + 1
    const what = describeSelection(state.selection)
    const scope = state.altitude === 'table' ? 'deck overview' : `slide ${n}`
    context.textContent = `sees: ${scope}${what ? ` › ${what}` : ''} + theme tokens`
  }
  renderContext()

  state.bus.on((e) => {
    if (e.type === 'selection' || e.type === 'altitude' || e.type === 'current-slide') {
      renderContext()
    } else if (e.type === 'deck-loaded') {
      sessionId = newSessionId()
      renderContext()
    }
  })

  /* ---------- composer behavior ---------- */

  function autogrow(): void {
    input.style.height = 'auto'
    const cs = getComputedStyle(input)
    const line = parseFloat(cs.lineHeight) || 16
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
    const cap = line * 3 + pad + 2 /* borders */
    input.style.height = `${Math.min(input.scrollHeight + 2, cap)}px`
  }
  input.addEventListener('input', autogrow)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void sendMessage()
    }
  })
  send.addEventListener('click', () => { void sendMessage() })

  /* ---------- chat ---------- */

  async function sendMessage(): Promise<void> {
    const text = input.value.trim()
    if (!text || busy || !online) return
    input.value = ''
    autogrow()

    appendBubble('user', text)
    busy = true
    setComposerEnabled(false)

    let assistant: HTMLElement | null = null
    try {
      for await (const ev of service.chat(sessionId, text, buildContext())) {
        if (ev.type === 'text') {
          if (!assistant) assistant = appendBubble('assistant', '')
          assistant.textContent += ev.delta
          scrollDown()
        } else if (ev.type === 'ops') {
          appendOpsCard(ev.ops)
          assistant = null
        } else if (ev.type === 'error') {
          appendQuiet(ev.message)
          assistant = null
        } else if (ev.type === 'done') {
          assistant = null
        }
      }
    } finally {
      busy = false
      setComposerEnabled(online)
      lastHealthAt = -Infinity
      void checkHealth()
    }
  }

  function buildContext(): ChatContext {
    const deck = state.deck
    // multi-slide awareness: the previous, current, and next slides ride
    // along (size-capped) so answers can reason across the flow, not just
    // the selection — the same context in either altitude
    const slides = state.slides()
    const i = state.currentSlide
    const cap = (el: HTMLElement | undefined): string | null => {
      if (!el) return null
      const html = el.outerHTML
      return html.length > 6000 ? `${html.slice(0, 6000)}\n<!-- …truncated -->` : html
    }
    return {
      altitude: state.altitude,
      slideIndex: i,
      selectionHtml: selectionHtml(state.selection),
      tokensCss: deck?.themeStyle.textContent ?? '',
      flowNeighborsHtml: [cap(slides[i - 1]), cap(slides[i]), cap(slides[i + 1])]
        .filter((s): s is string => s !== null),
    }
  }

  /* ---------- log rendering ---------- */

  function appendBubble(who: 'user' | 'assistant', text: string): HTMLElement {
    const b = div(`dia-cop-msg dia-cop-${who}`)
    b.textContent = text
    log.appendChild(b)
    scrollDown()
    return b
  }

  function appendQuiet(text: string): void {
    const q = div('dia-cop-quiet')
    q.textContent = text
    log.appendChild(q)
    scrollDown()
  }

  function appendOpsCard(ops: ProposedOp[]): void {
    const card = div('dia-cop-card')
    const list = div('dia-cop-card-ops')
    for (const op of ops) {
      const line = div('dia-cop-card-op')
      line.textContent = op.label
      list.appendChild(line)
    }
    const actions = div('dia-cop-card-actions')
    const apply = document.createElement('button')
    apply.type = 'button'
    apply.className = 'dn-btn dia-cop-apply'
    apply.textContent = 'apply'
    const reject = document.createElement('button')
    reject.type = 'button'
    reject.className = 'dn-btn'
    reject.textContent = 'reject'
    actions.append(apply, reject)
    card.append(list, actions)
    log.appendChild(card)
    scrollDown()

    const settle = (note: string) => {
      actions.remove()
      const done = div('dia-cop-card-note')
      done.textContent = note
      card.appendChild(done)
    }
    apply.addEventListener('click', () => {
      const compiled = compileOps(ops)
      if (compiled.length === 0) {
        settle('nothing to apply — targets not found')
        return
      }
      const label = ops.length === 1 ? ops[0].label : `Copilot: ${ops.length} changes`
      state.apply(batch(label, compiled, 'copilot'))
      settle(compiled.length === ops.length
        ? 'applied · in undo history'
        : `applied ${compiled.length}/${ops.length} · in undo history`)
    })
    reject.addEventListener('click', () => settle('rejected'))
  }

  function scrollDown(): void {
    log.scrollTop = log.scrollHeight
  }
}

/* ---------- helpers ---------- */

function div(cls: string): HTMLElement {
  const d = document.createElement('div')
  d.className = cls
  return d
}

function newSessionId(): string {
  const base = state.deck?.fileName ?? 'deck'
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10)
  return `${base}#${rand}`
}

function describeSelection(sel: Selection): string | null {
  switch (sel.kind) {
    case 'none': return null
    case 'slide': return 'whole slide'
    case 'element': {
      const role = [...sel.el.classList].find((c) => c.startsWith('dia-'))
      return role ?? sel.el.tagName.toLowerCase()
    }
    case 'scene-node': return `node ${sel.node.getAttribute('data-dia-node') ?? ''}`.trim()
    case 'scene-edge': return `edge ${sel.edge.getAttribute('data-dia-edge') ?? ''}`.trim()
    case 'scene-free': return `svg <${sel.el.tagName.toLowerCase()}>`
  }
}

function selectionHtml(sel: Selection): string | null {
  switch (sel.kind) {
    case 'none': return null
    case 'slide': return sel.slide.outerHTML
    case 'element': return sel.el.outerHTML
    case 'scene-node': return sel.node.outerHTML
    case 'scene-edge': return sel.edge.outerHTML
    case 'scene-free': return sel.el.outerHTML
  }
}
