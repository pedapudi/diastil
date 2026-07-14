/* Copilot rail — right-column chat over the local dia service.
 * Selection-aware context, streamed replies, op-diff cards with
 * apply/reject; applied batches join the same undo history as
 * direct edits. Fully quiet when the service is offline. */

import './copilot.css'
import type { ChatContext, Deck, ProposedOp, Selection } from '../types'
import { state } from '../state'
import { service } from '../service/client'
import { batch } from '../model/ops'
import { rasterizeToDataUrl } from '../ingest/fidelity'
import { embeddedOriginals } from '../editor/compare'
import { compileOps } from './compile'
import { renderMarkdown } from './markdown'

const HEALTH_MIN_INTERVAL = 30_000

/* ---------- the imported original as context ----------
 * Imported decks carry one self-contained reference page per slide
 * (script#dia-originals, profile §8) — the same pages the compare overlay
 * shows. The copilot gets the current slide's original as BOTH body markup
 * (content and implementation to reference) and a render (what the import
 * aimed at). Originals never change for a loaded deck, so everything is
 * cached per deck object. */

const ORIGINAL_HTML_CAP = 8000
const ORIGINAL_LOAD_TIMEOUT_MS = 4000

interface OriginalContext { html: string | null; image: string | null }

const originalCache = new WeakMap<Deck, { pages: string[] | null; bySlide: Map<number, OriginalContext> }>()

/** true when the loaded deck carries embedded originals at all — cheap,
 * safe to call from render paths */
export function deckHasOriginals(deck: Deck | null): boolean {
  return !!deck && deck.headExtras.includes('dia-originals')
}

async function originalFor(deck: Deck, index: number): Promise<OriginalContext | null> {
  let entry = originalCache.get(deck)
  if (!entry) {
    entry = { pages: deckHasOriginals(deck) ? embeddedOriginals(deck) : null, bySlide: new Map() }
    originalCache.set(deck, entry)
  }
  // indices past the imported slide count (slides added since import) have
  // no original — send nothing rather than a neighboring slide's original
  const page = entry.pages?.[index]
  if (!page) return null
  const cached = entry.bySlide.get(index)
  // a null image is retried (rasterization can fail transiently while the
  // tab is occluded); a successful raster is final
  if (cached?.image) return cached
  const doc = new DOMParser().parseFromString(page, 'text/html')
  const body = doc.body?.innerHTML.trim() ?? ''
  const html = body
    ? (body.length > ORIGINAL_HTML_CAP ? `${body.slice(0, ORIGINAL_HTML_CAP)}\n<!-- …truncated -->` : body)
    : null
  // hard deadline: a wedged raster degrades this send to markup-only —
  // it must never block the chat
  const image = await Promise.race([
    rasterizeOriginalPage(page),
    new Promise<null>((r) => setTimeout(() => r(null), ORIGINAL_LOAD_TIMEOUT_MS * 2)),
  ])
  const fresh: OriginalContext = { html, image }
  entry.bySlide.set(index, fresh)
  return fresh
}

/** render a reference page in a hidden same-origin iframe and rasterize its
 * body — the pages are static (css + cleaned markup, no scripts) */
async function rasterizeOriginalPage(page: string): Promise<string | null> {
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:fixed;left:-10020px;top:0;width:1280px;height:720px;border:0;'
  document.body.appendChild(frame)
  try {
    const loaded = new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => resolve(false), ORIGINAL_LOAD_TIMEOUT_MS)
      frame.addEventListener('load', () => { window.clearTimeout(timer); resolve(true) })
    })
    frame.srcdoc = page
    if (!(await loaded)) return null
    const doc = frame.contentDocument
    if (!doc?.body) return null
    try {
      await Promise.race([doc.fonts?.ready, new Promise((r) => setTimeout(r, 1500))])
    } catch { /* best effort */ }
    // NOT requestAnimationFrame: rAF never fires in an occluded tab and
    // would hang every chat send. Layout is synchronous after load; this
    // pause only lets decoded images/fonts reach the frame's render tree.
    await new Promise((r) => setTimeout(r, 80))
    return await rasterizeToDataUrl(doc.body)
  } catch {
    return null
  } finally {
    frame.remove()
  }
}

/* ---------- context slice: which slides ride along ----------
 * auto = previous · current · next; pins add more (⌥-click in the minimap
 * or click a chip). The rail shows exactly this set — no hidden context. */

const pinnedSlides = new Set<number>()
const contextListeners = new Set<() => void>()

export function togglePinnedSlide(i: number): void {
  if (pinnedSlides.has(i)) pinnedSlides.delete(i)
  else pinnedSlides.add(i)
  for (const fn of [...contextListeners]) fn()
}

export function isPinnedSlide(i: number): boolean {
  return pinnedSlides.has(i)
}

export function onContextChange(fn: () => void): void {
  contextListeners.add(fn)
}

/** slide indices in the copilot's context, in document order */
export function contextSlideIndices(): number[] {
  const n = state.slides().length
  const i = state.currentSlide
  const set = new Set<number>([i - 1, i, i + 1].filter((k) => k >= 0 && k < n))
  for (const p of pinnedSlides) if (p >= 0 && p < n) set.add(p)
  return [...set].sort((a, b) => a - b)
}

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
  /** force=true skips the throttle — used when the user ACTS (sends),
   * so a service started after the editor is picked up immediately
   * instead of leaving a dead composer for up to 30 s */
  async function checkHealth(force = false): Promise<boolean> {
    const now = Date.now()
    if (!force && now - lastHealthAt < HEALTH_MIN_INTERVAL) return online
    lastHealthAt = now
    const h = await service.health()
    online = h.ok
    model.textContent = h.ok ? (h.model ?? '') : 'offline'
    model.classList.toggle('is-off', !h.ok)
    // let the shell react (e.g. enable the copilot maximize tab)
    window.dispatchEvent(new CustomEvent('dia-service-status', { detail: { online } }))
    setComposerEnabled(!busy)
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
    return online
  }

  /** the input stays typeable even offline (drafting is free); only the
   * send affordance follows the busy state */
  function setComposerEnabled(on: boolean): void {
    input.disabled = false
    send.disabled = !on
  }

  lastHealthAt = -Infinity
  void checkHealth()
  window.addEventListener('focus', () => { void checkHealth() })

  /* ---------- context line ---------- */

  function renderContext(): void {
    context.replaceChildren()
    const label = document.createElement('span')
    label.textContent = 'sees slides '
    context.appendChild(label)
    const indices = contextSlideIndices()
    for (const i of indices) {
      const chip = document.createElement('button')
      chip.type = 'button'
      const pinned = isPinnedSlide(i)
      chip.className = `dia-cop-chip${pinned ? ' is-pinned' : ''}`
      chip.textContent = String(i + 1)
      chip.title = pinned
        ? `slide ${i + 1} is pinned into context — click to unpin`
        : `slide ${i + 1} rides along automatically (around the current slide) — click to pin it`
      chip.addEventListener('click', () => togglePinnedSlide(i))
      context.appendChild(chip)
    }
    const what = describeSelection(state.selection)
    const tail = document.createElement('span')
    const pinGesture = /Mac|iP(hone|ad|od)/.test(navigator.platform) ? '⌥-click' : 'alt/shift-click'
    const withOriginal = deckHasOriginals(state.deck) ? ' + original' : ''
    tail.textContent = `${what ? ` › ${what}` : ''} + tokens + slide render${withOriginal} · ${pinGesture} a minimap slide to pin`
    context.appendChild(tail)
  }
  renderContext()
  onContextChange(renderContext)

  state.bus.on((e) => {
    if (e.type === 'selection' || e.type === 'altitude' || e.type === 'current-slide' || e.type === 'slides-changed') {
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
    if (!text || busy) return
    // sending is an explicit act: re-check health NOW rather than trusting
    // a stale throttled probe — a service started after the editor should
    // work on the first try, and a refusal should say why
    if (!online && !(await checkHealth(true))) {
      appendError('service offline — start it with `dia serve`, then send again (your message is kept)')
      return
    }
    input.value = ''
    autogrow()

    appendBubble('user', text)
    busy = true
    setComposerEnabled(false)
    const pending = appendPending()

    let assistant: { el: HTMLElement; raw: string } | null = null
    let thinking: { body: HTMLElement; box: HTMLDetailsElement; raw: string } | null = null
    // proposals are HELD until the stream ends: the apply/reject decision
    // belongs after the model's full explanation, not in the middle of it
    const proposals: ProposedOp[][] = []
    let produced = false
    let failed = false
    try {
      for await (const ev of service.chat(sessionId, text, await buildContext())) {
        pending.remove()
        if (ev.type === 'thinking') {
          produced = true
          if (!thinking) thinking = appendThinking()
          thinking.raw += ev.delta
          thinking.body.replaceChildren(renderMarkdown(thinking.raw))
          scrollDown()
        } else if (ev.type === 'text') {
          produced = true
          if (thinking) { thinking.box.open = false; thinking = null } // fold the reasoning away once the answer starts
          if (!assistant) assistant = { el: appendBubble('assistant', ''), raw: '' }
          assistant.raw += ev.delta
          assistant.el.replaceChildren(renderMarkdown(assistant.raw))
          scrollDown()
        } else if (ev.type === 'ops') {
          produced = true
          proposals.push(ev.ops)
        } else if (ev.type === 'error') {
          failed = true
          appendError(ev.message)
          assistant = null
        } else if (ev.type === 'done') {
          assistant = null
        }
      }
    } finally {
      pending.remove()
      if (thinking) thinking.box.open = false
      for (const ops of proposals) appendOpsCard(ops)
      busy = false
      setComposerEnabled(true)
      // a chat that failed before producing anything gives the draft back
      if (failed && !produced && !input.value) { input.value = text; autogrow() }
      input.focus()
      void checkHealth(true)
    }
  }

  async function buildContext(): Promise<ChatContext> {
    const deck = state.deck
    // the exact slide set the context chips display: neighbors + pins,
    // size-capped, in document order — what you see is what it sees
    const slides = state.slides()
    const cap = (el: HTMLElement | undefined): string | null => {
      if (!el) return null
      const html = el.outerHTML
      return html.length > 6000 ? `${html.slice(0, 6000)}\n<!-- …truncated -->` : html
    }
    // the copilot's EYES: the current slide as actually rendered — html
    // shows structure, the image shows what the user is looking at.
    // null (rasterization failed) degrades to text-only, same as before.
    let slideImage: string | null = null
    const current = slides[state.currentSlide]
    if (current) {
      try { slideImage = await rasterizeToDataUrl(current) } catch { /* text-only */ }
    }
    // the imported original of this slide, when the deck carries one —
    // the model sees what the conversion was aiming at, not just its result
    let original: OriginalContext | null = null
    if (deck) {
      try { original = await originalFor(deck, state.currentSlide) } catch { /* without */ }
    }
    return {
      altitude: state.altitude,
      slideIndex: state.currentSlide,
      selectionHtml: selectionHtml(state.selection),
      tokensCss: deck?.themeStyle.textContent ?? '',
      flowNeighborsHtml: contextSlideIndices()
        .map((i) => cap(slides[i]))
        .filter((s): s is string => s !== null),
      slideImage,
      originalHtml: original?.html ?? null,
      originalImage: original?.image ?? null,
    }
  }

  /* ---------- log rendering ---------- */

  function appendBubble(who: 'user' | 'assistant', text: string): HTMLElement {
    const b = div(`dia-cop-msg dia-cop-${who}`)
    b.textContent = text
    log.appendChild(b)
    scrollDown(true)
    return b
  }

  /** errors are quiet lines with a bad-colored edge — never a pill */
  function appendError(text: string): void {
    const q = div('dia-cop-quiet dia-cop-error')
    q.replaceChildren(renderMarkdown(text))
    log.appendChild(q)
    scrollDown(true)
  }

  /** three pulsing dots while the model hasn't produced its first token */
  function appendPending(): HTMLElement {
    const p = div('dia-cop-msg dia-cop-assistant dia-cop-pending')
    for (let i = 0; i < 3; i++) p.appendChild(div('dia-cop-dot'))
    log.appendChild(p)
    scrollDown(true)
    return p
  }

  /** streamed reasoning: a collapsible quiet block, open while it streams,
   * folded automatically the moment the answer starts */
  function appendThinking(): { body: HTMLElement; box: HTMLDetailsElement; raw: string } {
    const box = document.createElement('details')
    box.className = 'dia-cop-think'
    box.open = true
    const sum = document.createElement('summary')
    sum.textContent = 'thinking'
    const body = div('dia-cop-think-body')
    box.append(sum, body)
    log.appendChild(box)
    scrollDown(true)
    return { body, box, raw: '' }
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
      const { ops: compiled, skipped } = compileOps(ops)
      if (compiled.length === 0) {
        settle(`nothing to apply — no target resolved (${skipped.map((s) => s.label).join(' · ')})`)
        return
      }
      const label = ops.length === 1 ? ops[0].label : `Copilot: ${ops.length} changes`
      state.apply(batch(label, compiled, 'copilot'))
      settle(skipped.length === 0
        ? 'applied · in undo history'
        : `applied ${compiled.length}/${ops.length} · skipped: ${skipped.map((s) => s.label).join(' · ')}`)
    })
    reject.addEventListener('click', () => settle('rejected'))
  }

  /** follow the stream only when the reader is already at the bottom —
   * scrolling up to reread must not be yanked away by the next delta */
  function scrollDown(force = false): void {
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60
    if (force || nearBottom) log.scrollTop = log.scrollHeight
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
