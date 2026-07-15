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
import { scrollToSlide } from '../editor/table'
import {
  highlightModeActive, installMarquee, renderHighlightBoxes, setHighlightMode,
  stampHighlights, type HighlightRegion,
} from '../editor/highlights'
import { focusedSlide } from '../studio/focus'
import { compileOps, resolveTarget } from './compile'
import { clearPreview, previewIsActive, startPreview } from './preview'
import { renderMarkdown } from './markdown'

const HEALTH_MIN_INTERVAL = 30_000

/* ---------- highlight-for-context on the editing surface ----------
 * The user shades regions of the current slide; they render as overlays
 * (editor artifacts — stripped on save), get stamped onto the slide render
 * the copilot receives, and are listed in the context. Keyed by slide
 * ELEMENT, so reordering slides keeps highlights with their slide. */

const slideHighlights = new WeakMap<HTMLElement, HighlightRegion[]>()

/** slides in LOGICAL order: a focused slide reparents into the studio
 * overlay, which pushes it to the end of document order — every consumer
 * here (highlight layers, renders, neighbors, target resolution) must see
 * it back at its own index */
function slidesInOrder(): HTMLElement[] {
  const f = focusedSlide()
  const all = state.slides()
  if (!f) return all
  const rest = all.filter((sl) => sl !== f)
  rest.splice(Math.min(state.currentSlide, rest.length), 0, f)
  return rest
}

function currentSlideEl(): HTMLElement | null {
  return focusedSlide() ?? state.slides()[state.currentSlide] ?? null
}

function hlList(slide: HTMLElement): HighlightRegion[] {
  let list = slideHighlights.get(slide)
  if (!list) { list = []; slideHighlights.set(slide, list) }
  return list
}

function ensureHlLayer(slide: HTMLElement): HTMLElement {
  let layer = slide.querySelector<HTMLElement>(':scope > .dia-hl-layer')
  if (!layer) {
    layer = document.createElement('div')
    layer.className = 'dia-editor-artifact dia-hl-layer'
    slide.appendChild(layer)
    installMarquee(layer, (r) => {
      hlList(slide).push(r)
      refreshHlLayer(slide)
      for (const fn of [...contextListeners]) fn()
    })
  }
  return layer
}

function refreshHlLayer(slide: HTMLElement): void {
  const layer = ensureHlLayer(slide)
  renderHighlightBoxes(layer, hlList(slide), (k) => {
    hlList(slide).splice(k, 1)
    refreshHlLayer(slide)
    for (const fn of [...contextListeners]) fn()
  })
  layer.classList.toggle('is-active', highlightModeActive() && slide === currentSlideEl())
}

/** activate only the current slide's layer; others go inert */
function syncHlLayers(): void {
  const cur = currentSlideEl()
  for (const slide of state.slides()) {
    const has = (slideHighlights.get(slide)?.length ?? 0) > 0
    if (has || (highlightModeActive() && slide === cur)) refreshHlLayer(slide)
    else slide.querySelector(':scope > .dia-hl-layer')?.classList.remove('is-active')
  }
}

function toggleHlMode(): void {
  setHighlightMode(!highlightModeActive())
  syncHlLayers()
  for (const fn of [...contextListeners]) fn()
}

// bubble-phase on purpose: the studio's capture-phase esc chain yields to
// an active highlight session, so this handler is the one that ends it
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && highlightModeActive()) toggleHlMode()
})

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
    const curSlide = currentSlideEl()
    const hlCount = curSlide ? (slideHighlights.get(curSlide)?.length ?? 0) : 0
    const withHl = hlCount > 0 ? ` + ${hlCount} highlight${hlCount > 1 ? 's' : ''}` : ''
    tail.textContent = `${what ? ` › ${what}` : ''} + tokens + slide render${withOriginal}${withHl} · ${pinGesture} a minimap slide to pin`
    context.appendChild(tail)
    // shade regions on the slide for the model — drag to add, click to remove
    const hlBtn = document.createElement('button')
    hlBtn.type = 'button'
    hlBtn.className = `dia-cop-chip${highlightModeActive() ? ' is-pinned' : ''}`
    hlBtn.textContent = highlightModeActive() ? 'highlighting… (Esc)' : 'highlight'
    hlBtn.title = 'drag a region on the current slide to focus the copilot on it — click a shaded box to remove it'
    hlBtn.addEventListener('click', toggleHlMode)
    context.appendChild(hlBtn)
  }
  renderContext()
  onContextChange(renderContext)

  state.bus.on((e) => {
    if (e.type === 'selection' || e.type === 'altitude' || e.type === 'current-slide' || e.type === 'slides-changed') {
      renderContext()
      if (e.type === 'current-slide' || e.type === 'slides-changed') syncHlLayers()
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
    await runChatTurn(text, false)
  }

  /** one chat turn. auto=true is the ONE machine-initiated correction round
   * after a turn whose proposals were entirely unusable — it renders as a
   * quiet line, and its own failures never trigger another round. */
  async function runChatTurn(text: string, auto: boolean): Promise<void> {
    if (auto) appendQuiet('asking for corrected proposals…')
    else appendBubble('user', text)
    busy = true
    setComposerEnabled(false)
    const pending = appendPending()

    let assistant: { el: HTMLElement; raw: string } | null = null
    let thinking: { body: HTMLElement; box: HTMLDetailsElement; raw: string } | null = null
    // proposals are HELD until the stream ends: the apply/reject decision
    // belongs after the model's full explanation, not in the middle of it
    const proposals: Array<{ ops: ProposedOp[]; dropped: number }> = []
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
          proposals.push({ ops: ev.ops, dropped: ev.dropped ?? 0 })
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
      busy = false
      setComposerEnabled(true)
      // a chat that failed before producing anything gives the draft back
      if (failed && !produced && !input.value) { input.value = text; autogrow() }
      input.focus()
      void checkHealth(true)
    }

    // proposal cards render AFTER the turn settles, each dry-compiled
    // against the live document so unresolvable ops are marked before the
    // user decides anything
    const troubles: string[] = []
    for (const p of proposals) {
      const dry = compileOps(p.ops)
      appendOpsCard(p.ops, dry)
      if (p.dropped > 0 && p.ops.length === 0) {
        troubles.push(`the proposal payload was malformed — ${p.dropped} item(s) were unreadable and dropped`)
      } else if (p.ops.length > 0 && dry.ops.length === 0) {
        troubles.push(dry.skipped.map((s) => `"${s.op.label}": ${s.reason}`).join('; '))
      }
    }
    // one machine correction round, only for turns whose proposals were
    // ENTIRELY unusable — partial results stay in the user's hands
    if (troubles.length > 0 && !auto) {
      const correction =
        'correction: none of your proposed ops could be applied. ' +
        troubles.join(' · ') +
        ' Re-check the targeting grammar (data-dia-id, "slide N", "slide N <role> [ordinal]", a css selector, or exact text) ' +
        'against the slides in context, and re-propose corrected ops via propose_ops.'
      await runChatTurn(correction, true)
    }
  }

  async function buildContext(): Promise<ChatContext> {
    const deck = state.deck
    // the exact slide set the context chips display: neighbors + pins,
    // size-capped, in logical order — what you see is what it sees
    const slides = slidesInOrder()
    const cap = (el: HTMLElement | undefined): string | null => {
      if (!el) return null
      const html = el.outerHTML
      return html.length > 6000 ? `${html.slice(0, 6000)}\n<!-- …truncated -->` : html
    }
    // the copilot's EYES: the current slide as actually rendered — html
    // shows structure, the image shows what the user is looking at.
    // null (rasterization failed) degrades to text-only, same as before.
    let slideImage: string | null = null
    const current = currentSlideEl()
    const hl = current ? (slideHighlights.get(current) ?? []) : []
    if (current) {
      try {
        slideImage = await rasterizeToDataUrl(current)
        // the model sees the user's shaded regions ON the render
        if (slideImage && hl.length > 0) slideImage = await stampHighlights(slideImage, hl)
      } catch { /* text-only */ }
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
      highlights: hl.length > 0 ? hl : undefined,
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

  /** machine-initiated turns (the correction round) read as process notes,
   * not as something the user said */
  function appendQuiet(text: string): void {
    const q = div('dia-cop-quiet')
    q.textContent = text
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

  /** the slide a proposal lands on — for the preview badge and scroll */
  function affectedSlide(ops: ProposedOp[]): HTMLElement | null {
    const deck = state.deck
    if (!deck) return null
    for (const p of ops) {
      try {
        const el = resolveTarget(p.target, deck.root, slidesInOrder(), state.currentSlide)
        const slide = el?.closest<HTMLElement>('section.dia-slide')
        if (slide) return slide
      } catch { /* keep looking */ }
    }
    return null
  }

  function appendOpsCard(ops: ProposedOp[], dry: ReturnType<typeof compileOps>): void {
    const card = div('dia-cop-card')
    const list = div('dia-cop-card-ops')
    // dry-compile verdicts: the card is honest about what will actually
    // happen BEFORE the user decides — an unresolvable op is marked, with
    // the reason, instead of failing silently at apply time
    const unresolved = new Map(dry.skipped.map((s) => [s.op, s.reason]))
    for (const op of ops) {
      const line = div('dia-cop-card-op')
      const reason = unresolved.get(op)
      if (reason !== undefined) {
        line.classList.add('is-unresolved')
        line.textContent = `⚠ ${op.label}`
        line.title = reason
      } else {
        line.textContent = op.label
      }
      list.appendChild(line)
    }
    if (ops.length === 0) {
      const line = div('dia-cop-card-op is-unresolved')
      line.textContent = '⚠ the model sent no readable proposals'
      list.appendChild(line)
    }
    const status = div('dia-cop-card-note dia-cop-preview-note')
    const actions = div('dia-cop-card-actions')
    const apply = document.createElement('button')
    apply.type = 'button'
    apply.className = 'dn-btn dia-cop-apply'
    apply.textContent = dry.ops.length === ops.length ? 'apply' : `apply ${dry.ops.length}/${ops.length}`
    const previewBtn = document.createElement('button')
    previewBtn.type = 'button'
    previewBtn.className = 'dn-btn'
    previewBtn.textContent = 'preview'
    previewBtn.hidden = true
    const reject = document.createElement('button')
    reject.type = 'button'
    reject.className = 'dn-btn'
    reject.textContent = 'reject'
    actions.append(apply, previewBtn, reject)
    card.append(list, status, actions)
    log.appendChild(card)
    scrollDown()

    let settled = false
    const settle = (note: string) => {
      settled = true
      actions.remove()
      status.remove()
      const done = div('dia-cop-card-note')
      done.textContent = note
      card.appendChild(done)
    }
    if (dry.ops.length === 0) {
      settle(ops.length === 0 ? 'nothing usable arrived' : 'nothing to apply — no target resolved')
      return
    }

    // the proposal PREVIEWS on the live slide the moment the card arrives —
    // the decision is made by looking, not by reading op labels
    let staged = dry.ops
    const preview = (compiled: typeof staged) => {
      staged = compiled
      const slide = affectedSlide(ops)
      startPreview(compiled, slide, (reason) => {
        if (settled) return
        status.textContent = `preview cleared — ${reason} · press preview to stage it again`
        previewBtn.hidden = false
      })
      const idx = slide ? state.slides().indexOf(slide) : -1
      if (idx >= 0) scrollToSlide(idx)
      status.textContent =
        `● previewing${idx >= 0 ? ` on slide ${idx + 1}` : ''} — the dashed frame shows the proposal; apply keeps it, reject restores`
      previewBtn.hidden = true
    }
    preview(dry.ops)

    apply.addEventListener('click', () => {
      let compiled = staged
      let skipped = dry.skipped
      if (previewIsActive(staged)) {
        clearPreview('accepted', false)
      } else {
        // the preview was cleared (document changed) — recompile against NOW
        const fresh = compileOps(ops)
        compiled = fresh.ops
        skipped = fresh.skipped
      }
      if (compiled.length === 0) {
        settle(`nothing to apply — no target resolved (${skipped.map((s) => s.op.label).join(' · ')})`)
        return
      }
      const label = ops.length === 1 ? ops[0].label : `Copilot: ${ops.length} changes`
      state.apply(batch(label, compiled, 'copilot'))
      settle(skipped.length === 0
        ? 'applied · in undo history'
        : `applied ${compiled.length}/${ops.length} · skipped: ${skipped.map((s) => s.op.label).join(' · ')}`)
    })
    previewBtn.addEventListener('click', () => {
      const fresh = compileOps(ops)
      if (fresh.ops.length === 0) {
        status.textContent = 'cannot preview — no target resolves against the current document'
        return
      }
      preview(fresh.ops)
    })
    reject.addEventListener('click', () => {
      if (previewIsActive(staged)) clearPreview('rejected', false)
      settle('rejected — the slide is unchanged')
    })
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
