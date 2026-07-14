/* IMPORT REVIEW — full-screen fix/validate compare between the executed
 * original (the live iframe from execute.ts) and the converted dialect deck.
 * zicato chrome: role tokens only, mono labels, one accent on the signal
 * (accept import). Keyboard: ←/→ slides, Esc cancels. */

import './ingest.css'
import type { ImportReport } from '../types'
import { mountThemePicker, mountTypePicker } from '../chrome/pickers'
import { renderMarkdown } from '../copilot/markdown'
import { validateDeckHtml } from '../model/validate'
import { service } from '../service/client'
import type { ExecuteResult } from './execute'
import { EXEC_W, EXEC_H, shimFrameHistory } from './execute'
import type { Extraction } from './extract'
import { findSlideRoots, forceVisible } from './extract'
import { DeckNavigator } from './navigate'
import {
  scoreSlideFidelityDetailed, rasterizeRegion, rasterizeToDataUrl, diffHeatmapDataUrl,
  REPAIR_THRESHOLD, type SlideDiff,
} from './fidelity'

/** cap on automatic service repair rounds per slide (more is manual) */
const MAX_AUTO_REPAIR_ROUNDS = 3
import {
  assembleDeck,
  buildReport,
  islandEntireSlide,
  revalidateSlide,
  tokensToCss,
  type SlideConversion,
} from './convert'

export interface ReviewInput {
  name: string
  execution: ExecuteResult
  extraction: Extraction
  conversions: SlideConversion[]
}

export interface ReviewOutcome {
  accepted: boolean
  deckHtml: string
  report: ImportReport
}

export function openReview(input: ReviewInput): Promise<ReviewOutcome> {
  return new Promise((resolve) => { new ReviewController(input, resolve).mount() })
}

/** one line in the per-slide model transcript */
type ModelLogEntry =
  | { who: 'user' | 'assistant' | 'quiet'; text: string }
  | { who: 'detail'; label: string; text: string; images?: string[]; mono?: boolean; open?: boolean }

/** transcripts keep full requests/responses but cap pathological payloads */
const LOG_TEXT_CAP = 6000

type Mode = 'side' | 'overlay' | 'heatmap'

class ReviewController {
  private current = 0
  private mode: Mode = 'side'
  private serviceOk = false
  private closed = false
  private origReady = false
  private convReady = false
  private fidelityRan = false
  private healthCheck: Promise<boolean> = Promise.resolve(false)

  private overlay!: HTMLElement
  private strip!: HTMLElement
  private cmp!: HTMLElement
  private hint!: HTMLElement
  private origViewport!: HTMLElement
  private convViewport!: HTMLElement
  private origFrame!: HTMLIFrameElement
  private convFrame!: HTMLIFrameElement
  private notesEl!: HTMLElement
  private verdictMsg!: HTMLElement
  private liftDecision!: HTMLElement
  private copLog!: HTMLElement
  private copModel!: HTMLElement
  private copInput!: HTMLTextAreaElement
  private copSend!: HTMLButtonElement
  private copBusy = false
  /** per-slide model conversation: what was asked, what came back — the
   * FULL transcript (requests with images, reasoning, returned html), not
   * one-line summaries */
  private modelLog: Array<Array<ModelLogEntry>> = []
  /** a lift that re-measured lower, awaiting the reviewer's keep/revert call */
  private pendingLift: { index: number; before: SlideConversion; prev: number | null; after: number | null } | null = null
  private acceptSlideBtn!: HTMLButtonElement
  private retryBtn!: HTMLButtonElement
  private liftBtn!: HTMLButtonElement
  private hover!: HTMLElement
  private segButtons: HTMLButtonElement[] = []
  /** per-slide measurement detail (regions + heatmap) from the SAME rasters
   * as the fidelity score — refreshed on every measure */
  private slideDiffs: Array<SlideDiff | null> = []
  private heatImg!: HTMLImageElement
  private heatEmpty!: HTMLElement
  private origRoots: HTMLElement[] = []
  /** restore fn for the original slide the compare pane force-revealed */
  private unforceOrig: (() => void) | null = null

  /** decks that hide non-current slides (any root without a layout box) —
   * for these the review must NAVIGATE the deck rather than force styles */
  private oneAtATime(): boolean {
    return this.origRoots.length > 1 && this.origRoots.some((r) => r.offsetWidth === 0)
  }

  /** shared probe-ladder navigator, rebuilt when the frame's roots change */
  private nav: DeckNavigator | null = null
  private navRoots: HTMLElement[] | null = null
  /** the original pane is style-forced — activation state unknown */
  private navForced = false

  /** Present slide i in the original pane THROUGH the deck's own runtime —
   * activation often does more than display (split layouts, reveals,
   * lazily-drawn figures), so forcing styles under-renders the original.
   * The probing/learning lives in DeckNavigator (shared with extraction);
   * when nothing works, styles are forced and the review says so. */
  private async showOriginal(i: number): Promise<void> {
    const doc = this.origFrame.contentDocument
    if (!doc || !this.origRoots[i] || !this.oneAtATime()) return
    if (!this.nav || this.navRoots !== this.origRoots) {
      this.nav = new DeckNavigator(doc, this.origRoots)
      this.navRoots = this.origRoots
    }
    await this.nav.show(i)
    if (this.nav.forced !== this.navForced) {
      // a score computed against a forced render must not read as ground truth
      this.navForced = this.nav.forced
      this.renderNotes()
    }
  }

  private onKey = (e: KeyboardEvent): void => {
    // typing owns its keys: this is a CAPTURE listener, so a bubble-phase
    // stopPropagation in the composer can never protect it — arrows must
    // move the caret, not the slide, and Esc leaves the field, not the review
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) {
      if (e.key === 'Escape') { e.preventDefault(); t.blur() }
      return
    }
    if (e.key === 'Escape') { e.preventDefault(); this.cancel() }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); this.go(this.current - 1) }
    else if (e.key === 'ArrowRight') { e.preventDefault(); this.go(this.current + 1) }
  }
  private onResize = (): void => this.layout()

  constructor(
    private input: ReviewInput,
    private resolve: (o: ReviewOutcome) => void,
  ) {}

  /* ---------- mount ---------- */

  mount(): void {
    const { name, execution, conversions } = this.input

    this.overlay = h('div', 'dia-review')
    this.overlay.setAttribute('role', 'dialog')
    this.overlay.setAttribute('aria-modal', 'true')
    this.overlay.tabIndex = -1

    // header
    const head = h('header', 'dia-review-head')
    const title = h('span', 'dia-review-title')
    title.append(
      dim('import review'),
      dim(' · '),
      h('span', '', name),
      dim(' · '),
      dim(`${conversions.length} slides`),
    )
    const spacer = h('div', 'dia-review-spacer')
    // the chrome theme/type pickers ride along — reviewing shouldn't mean
    // losing the pickers under a full-screen overlay
    const pickers = h('span', 'dia-review-pickers')
    mountThemePicker(pickers)
    mountTypePicker(pickers)
    const cancelBtn = btn('cancel', 'dn-btn')
    cancelBtn.addEventListener('click', () => this.cancel())
    const acceptBtn = btn('accept import', 'dn-btn dn-btn-accent')
    acceptBtn.addEventListener('click', () => this.accept())
    head.append(title, spacer, pickers, cancelBtn, acceptBtn)

    // body: strip + main + per-slide model conversation
    const body = h('div', 'dia-review-body')
    this.strip = h('aside', 'dia-review-strip')
    const main = h('div', 'dia-review-main')

    // toggle row
    const tools = h('div', 'dia-review-tools')
    const seg = h('div', 'dn-seg')
    for (const [label, mode] of [['side-by-side', 'side'], ['overlay', 'overlay'], ['heatmap', 'heatmap']] as const) {
      const b = document.createElement('button')
      b.textContent = label
      b.addEventListener('click', () => this.setMode(mode))
      seg.appendChild(b)
      this.segButtons.push(b)
    }
    this.hint = h('span', 'dia-cmp-hint')
    tools.append(seg, this.hint)

    // compare panes
    this.cmp = h('div', 'dia-cmp')
    this.cmp.dataset.mode = 'side'
    const orig = this.buildPane('original', '')
    const conv = this.buildPane('converted', 'is-converted')
    this.origViewport = orig.viewport
    this.convViewport = conv.viewport
    // heatmap pane: the measurement's own diff image, for human eyes —
    // the same picture the VLM receives in repair rounds
    const heat = h('div', 'dia-cmp-heat dn-panel')
    heat.appendChild(h('div', 'dia-cmp-label', 'difference heatmap'))
    const heatBody = h('div', 'dia-cmp-heat-body')
    this.heatImg = document.createElement('img')
    this.heatImg.alt = 'difference heatmap — red marks content that differs from the original'
    this.heatEmpty = h('div', 'dia-cop-quiet', 'not measured yet — the heatmap appears once this slide has been scored')
    heatBody.append(this.heatImg, this.heatEmpty)
    heat.appendChild(heatBody)
    heat.appendChild(h('div', 'dia-cmp-hint dia-cmp-heat-caption', 'red = content that differs from the original'))
    this.cmp.append(orig.pane, conv.pane, heat)

    // original = the live executed iframe (reparenting reloads srcdoc, so
    // slide roots are re-located once the moved document settles)
    this.origFrame = execution.iframe
    this.origFrame.classList.remove('dia-ingest-exec')
    this.origFrame.addEventListener('load', () => {
      // the reparent reloaded srcdoc into a FRESH window — the history shim
      // from execution is gone and must be re-applied before navigation
      shimFrameHistory(this.origFrame.contentWindow)
      window.setTimeout(() => {
        const d = this.origFrame.contentDocument
        if (d) this.origRoots = findSlideRoots(d).roots
        void this.showOriginal(this.current).then(() => {
          this.layout()
          this.origReady = true
          void this.maybeRunFidelity()
        })
      }, 350)
    })
    this.origViewport.appendChild(this.origFrame)

    // converted = srcdoc of the full converted document
    this.convFrame = document.createElement('iframe')
    this.convFrame.setAttribute('sandbox', 'allow-same-origin')
    this.convFrame.addEventListener('load', () => {
      this.layout()
      this.convReady = true
      void this.maybeRunFidelity()
    })
    this.convViewport.appendChild(this.convFrame)

    // per-slide verdict row
    const verdict = h('div', 'dia-verdict')
    this.acceptSlideBtn = btn('accept slide', 'dn-btn')
    this.acceptSlideBtn.addEventListener('click', () => {
      this.conversions[this.current].accepted = true
      this.go(this.current + 1)
      this.renderStrip()
      this.renderVerdict()
    })
    const islandBtn = btn('island entire slide', 'dn-btn')
    islandBtn.addEventListener('click', () => {
      this.conversions[this.current] = islandEntireSlide(this.input.extraction.slides[this.current], this.current)
      this.rebuild()
    })
    this.verdictMsg = h('span', 'dia-verdict-msg')
    this.liftDecision = h('span', 'dia-lift-decision')
    verdict.append(this.acceptSlideBtn, islandBtn, this.liftDecision, this.verdictMsg)

    // region notes
    this.notesEl = h('div', 'dia-notes')

    main.append(tools, this.cmp, verdict, this.notesEl)
    body.append(this.strip, main)

    // THE model panel: everything model-facing lives here — the per-slide
    // conversation, retranslate/lift actions, and the composer. Sending a
    // message runs a repair round with it; every message you've sent for
    // the slide also rides along with retranslate and lift as feedback.
    const cop = h('aside', 'dia-cop dia-review-cop')
    const copHead = h('div', 'dia-cop-header')
    const copTitle = h('div', 'dia-cop-title', 'copilot')
    this.copModel = h('div', 'dia-cop-model', '…')
    copHead.append(copTitle, this.copModel)
    const copHint = h('div', 'dia-cop-context',
      'per-slide conversation — send a note to repair; retranslate/lift reuse your notes')
    this.copLog = h('div', 'dia-cop-log')
    const actions = h('div', 'dia-cop-actions')
    this.retryBtn = btn('retranslate slide', 'dn-btn')
    this.retryBtn.disabled = true
    this.retryBtn.title = 'full model re-translation of this slide (your notes ride along)'
    this.retryBtn.addEventListener('click', () => void this.retry())
    this.liftBtn = btn('lift diagrams', 'dn-btn')
    this.liftBtn.disabled = true
    this.liftBtn.title = 'lift static svgs into editable scenes (pixel-gated)'
    this.liftBtn.addEventListener('click', () => void this.liftDiagrams())
    actions.append(this.retryBtn, this.liftBtn)
    // composer: the textarea owns the full panel width; send sits UNDER it
    const copComposer = h('div', 'dia-cop-composer dia-cop-composer-stack')
    this.copInput = document.createElement('textarea')
    this.copInput.className = 'dia-cop-input'
    this.copInput.rows = 3
    this.copInput.placeholder = 'what should the model fix or preserve on this slide?'
    this.copSend = btn('send', 'dn-btn dn-btn-accent')
    this.copSend.addEventListener('click', () => void this.chatRepair())
    this.copInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void this.chatRepair() }
      e.stopPropagation() // arrows in the composer must not change slides
    })
    const sendRow = h('div', 'dia-cop-sendrow')
    sendRow.append(h('span', 'dia-cop-sendhint', 'enter sends · runs a repair round'), this.copSend)
    copComposer.append(this.copInput, sendRow)
    // the divider ABOVE the action row resizes the whole bottom block
    // (actions + composer) against the conversation log
    const grip = h('div', 'dia-cop-grip')
    grip.title = 'drag to resize the message area'
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      const startY = e.clientY
      const startH = this.copInput.offsetHeight
      const ac = new AbortController()
      window.addEventListener('pointermove', (ev) => {
        const px = Math.min(Math.max(startH + (startY - ev.clientY), 40), Math.round(cop.clientHeight * 0.6))
        this.copInput.style.height = `${px}px`
      }, { signal: ac.signal })
      window.addEventListener('pointerup', () => ac.abort(), { signal: ac.signal })
      window.addEventListener('pointercancel', () => ac.abort(), { signal: ac.signal })
    })
    // the panel itself resizes horizontally: drag its left edge (persisted)
    const wgrip = h('div', 'dia-cop-wgrip')
    wgrip.title = 'drag to resize the copilot panel'
    wgrip.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      const ac = new AbortController()
      window.addEventListener('pointermove', (ev) => {
        const w = Math.min(Math.max(window.innerWidth - ev.clientX, 240), 640)
        cop.style.width = `${Math.round(w)}px`
      }, { signal: ac.signal })
      const done = (): void => {
        ac.abort()
        try { localStorage.setItem('dia-review-cop-w', cop.style.width) } catch { /* private mode */ }
      }
      window.addEventListener('pointerup', done, { signal: ac.signal })
      window.addEventListener('pointercancel', done, { signal: ac.signal })
    })
    try {
      const savedW = localStorage.getItem('dia-review-cop-w')
      if (savedW) cop.style.width = savedW
    } catch { /* private mode */ }
    cop.append(wgrip, copHead, copHint, this.copLog, grip, actions, copComposer)
    body.append(cop)

    // hovercard (chrome idiom from base.css, locally owned instance)
    this.hover = h('div', 'dn-hovercard')

    this.overlay.append(head, body, this.hover)
    document.body.appendChild(this.overlay)
    this.overlay.focus()
    window.addEventListener('keydown', this.onKey, true)
    window.addEventListener('resize', this.onResize)

    this.healthCheck = service.health().then((r) => {
      this.serviceOk = r.ok
      this.copModel.textContent = r.ok ? (r.model ?? '') : 'offline'
      this.copModel.classList.toggle('is-off', !r.ok)
      if (!r.ok) {
        this.logModel(this.current, 'quiet',
          'service offline — retry, repair, lift, and this composer need it. start it with `dia serve`')
      }
      this.renderVerdict()
      return r.ok
    })

    this.rebuild()
  }

  private buildPane(label: string, extra: string): { pane: HTMLElement; viewport: HTMLElement } {
    const pane = h('div', `dia-cmp-pane dn-panel${extra ? ` ${extra}` : ''}`)
    pane.appendChild(h('div', 'dia-cmp-label', label))
    const viewport = h('div', 'dia-cmp-viewport')
    pane.appendChild(viewport)
    return { pane, viewport }
  }

  private get conversions(): SlideConversion[] { return this.input.conversions }

  /* ---------- rendering ---------- */

  private renderStrip(): void {
    this.strip.replaceChildren()
    this.conversions.forEach((c, i) => {
      const row = document.createElement('button')
      row.className = `dia-strip-row${i === this.current ? ' is-current' : ''}`
      row.appendChild(h('span', 'dia-strip-num', String(i + 1).padStart(2, '0')))
      if (c.accepted) row.appendChild(h('span', 'dia-strip-ok', '✓'))
      if (c.islands > 0) row.appendChild(h('span', 'dia-pill', 'island'))
      const conf = h('span', `dia-strip-conf dn-num ${c.confidence >= 0.95 ? 'is-good' : 'is-caution'}`, c.confidence.toFixed(2))
      row.appendChild(conf)
      if (c.fidelity !== undefined) {
        const fid = c.fidelity === null
          ? h('span', 'dia-strip-conf dn-num is-caution', '·—')
          : h('span', `dia-strip-conf dn-num ${c.fidelity >= REPAIR_THRESHOLD ? 'is-good' : 'is-caution'}`, c.fidelity.toFixed(2))
        fid.title = c.fidelity === null ? 'slide would not rasterize' : 'pixel-verified fidelity'
        row.appendChild(fid)
      }
      row.addEventListener('click', () => this.go(i))
      this.strip.appendChild(row)
    })
  }

  private renderNotes(): void {
    this.notesEl.replaceChildren()
    this.notesEl.appendChild(h('div', 'dn-subhead', 'region notes'))
    const c = this.conversions[this.current]
    if (this.navForced) {
      const row = h('div', 'dia-note is-warning')
      row.append(
        h('span', 'dia-note-kind', 'original'),
        h('span', '', 'shown without runtime activation — this deck’s navigation was not detected, so the original pane (and fidelity scores) may under-represent the true original'),
      )
      this.notesEl.appendChild(row)
    }
    if (c.fidelity !== undefined) {
      const row = h('div', `dia-note${c.fidelity !== null && c.fidelity >= REPAIR_THRESHOLD ? '' : ' is-warning'}`)
      const text = c.fidelity === null
        ? 'slide would not rasterize — visual match unverified; compare by eye'
        : `pixel-verified fidelity ${c.fidelity.toFixed(3)}${c.repairRounds ? ` after ${c.repairRounds} repair round${c.repairRounds > 1 ? 's' : ''}` : ''}`
      row.append(h('span', 'dia-note-kind', 'fidelity'), h('span', '', text))
      this.notesEl.appendChild(row)
    }
    for (const w of c.warnings) {
      const row = h('div', 'dia-note is-warning')
      row.append(h('span', 'dia-note-kind', 'warning'), h('span', '', w))
      this.notesEl.appendChild(row)
    }
    for (const n of c.notes) {
      const row = h('div', 'dia-note')
      row.append(h('span', 'dia-note-kind', n.kind), h('span', '', n.note), h('span', 'dia-note-loc', n.locator))
      this.notesEl.appendChild(row)
    }
    if (c.notes.length === 0 && c.warnings.length === 0) {
      this.notesEl.appendChild(h('div', 'dia-note is-empty', 'none — clean structural conversion'))
    }
  }

  private renderVerdict(): void {
    const c = this.conversions[this.current]
    const pendingHere = this.pendingLift?.index === this.current
    this.acceptSlideBtn.textContent = c.accepted ? 'slide accepted ✓' : 'accept slide'
    this.retryBtn.disabled = !this.serviceOk || this.copBusy || pendingHere
    this.liftBtn.disabled = !this.serviceOk || this.copBusy || !this.hasLiftableSvg(this.current) || pendingHere
    this.copSend.disabled = !this.serviceOk || this.copBusy || pendingHere
    if (this.serviceOk) this.hideHover()

    // a lift that re-measured lower waits for the reviewer, not a veto:
    // the pane is SHOWING the lifted version — keep it or revert it
    this.liftDecision.replaceChildren()
    if (pendingHere && this.pendingLift) {
      const p = this.pendingLift
      const fmtF = (v: number | null) => (v == null ? '—' : v.toFixed(3))
      this.liftDecision.append(
        h('span', 'dia-lift-q', `lift re-measured lower (${fmtF(p.prev)} → ${fmtF(p.after)}) — keep it?`),
      )
      const keep = btn('keep lift', 'dn-btn')
      keep.addEventListener('click', () => {
        this.pendingLift = null
        this.verdictMsg.textContent = 'lift kept — editable scenes retained despite the pixel delta'
        this.renderStrip(); this.renderNotes(); this.renderVerdict()
      })
      const revert = btn('revert', 'dn-btn')
      revert.addEventListener('click', () => {
        void (async () => {
          this.conversions[p.index] = p.before
          this.pendingLift = null
          await this.rebuildAndWait()
          this.verdictMsg.textContent = 'lift reverted — previous candidate restored'
          this.renderStrip(); this.renderNotes(); this.renderVerdict()
        })()
      })
      this.liftDecision.append(keep, revert)
    }
  }

  private hasLiftableSvg(i: number): boolean {
    const doc = new DOMParser().parseFromString(this.conversions[i].html, 'text/html')
    return [...doc.querySelectorAll('svg')]
      .some((s) => !s.classList.contains('dia-scene') && !s.closest('[data-dia-island]'))
  }

  private setMode(mode: Mode): void {
    this.mode = mode
    this.cmp.dataset.mode = mode
    this.segButtons[0].classList.toggle('dn-on', mode === 'side')
    this.segButtons[1].classList.toggle('dn-on', mode === 'overlay')
    this.segButtons[2].classList.toggle('dn-on', mode === 'heatmap')
    this.hint.textContent =
      mode === 'overlay' ? 'difference — matched regions read dark' :
      mode === 'heatmap' ? 'the measured diff — exactly what the fidelity score scored' : ''
    this.renderHeatmap()
    requestAnimationFrame(() => this.layout())
  }

  /** the heatmap pane shows the CURRENT slide's stored measurement */
  private renderHeatmap(): void {
    if (this.mode !== 'heatmap') return
    const url = this.slideDiffs[this.current]?.heatmapUrl ?? null
    this.heatImg.hidden = !url
    this.heatEmpty.hidden = !!url
    if (url && this.heatImg.src !== url) this.heatImg.src = url
  }

  /** track slide i in every surface WITHOUT navigating the original deck —
   * for loops whose next step performs the navigation itself */
  private follow(i: number): void {
    if (this.current === i) return
    this.current = i
    this.renderStrip()
    this.renderNotes()
    this.renderVerdict()
    this.renderModelLog()
    this.renderHeatmap()
    this.layout()
  }

  private go(i: number): void {
    const n = this.conversions.length
    this.current = Math.max(0, Math.min(i, n - 1))
    this.renderStrip()
    this.renderNotes()
    this.renderVerdict()
    this.renderModelLog()
    this.renderHeatmap()
    this.verdictMsg.textContent = ''
    this.layout()
    // one-at-a-time decks: drive the original's own runtime, then re-crop
    void this.showOriginal(this.current).then(() => this.layout())
  }

  /** reassemble the converted doc after a per-slide change */
  private rebuild(): void {
    this.convFrame.srcdoc = this.deckHtml()
    this.setMode(this.mode)
    this.renderStrip()
    this.renderNotes()
    this.renderVerdict()
  }

  /** withOriginals: the ACCEPTED deck carries its reference originals —
   * implementation and content of what each slide was converted from stays
   * consultable. The preview iframe rebuilds constantly and skips them. */
  private deckHtml(withOriginals = false): string {
    const { name, extraction } = this.input
    const title = name.replace(/\.html?$/, '')
    return assembleDeck(
      this.conversions.map((c) => c.html), extraction.tokens, title,
      withOriginals ? extraction.slides.map((s) => s.originalHtml) : [])
  }

  /* ---------- geometry: crop each pane to the current slide ---------- */

  private layout(): void {
    requestAnimationFrame(() => {
      const orig = this.origRoots[this.current] ?? null
      if (!this.oneAtATime()) {
        // flow decks: reveal the compared slide if it happens to be hidden
        this.unforceOrig?.()
        this.unforceOrig = orig ? forceVisible(orig) : null
      }
      this.layoutPane(this.origFrame, this.origViewport, orig, EXEC_W)
      // render the converted doc at the source slide's width so both panes
      // scale identically — keeps the difference overlay comparable
      const srcW = this.input.extraction.slides[this.current]?.rect.w
      const cd = this.convFrame.contentDocument
      const convRoots = cd ? [...cd.querySelectorAll<HTMLElement>('section.dia-slide')] : []
      this.layoutPane(this.convFrame, this.convViewport, convRoots[this.current] ?? null,
        srcW && srcW > 100 ? Math.round(srcW) : EXEC_W)
    })
  }

  private layoutPane(frame: HTMLIFrameElement, viewport: HTMLElement, slideEl: HTMLElement | null, frameW: number): void {
    const doc = frame.contentDocument
    if (!doc || !slideEl) return
    frame.style.width = `${frameW}px`
    frame.style.height = `${Math.max(doc.documentElement.scrollHeight, EXEC_H)}px`
    const win = doc.defaultView
    const r = slideEl.getBoundingClientRect()
    const rect = {
      left: r.left + (win?.scrollX ?? 0),
      top: r.top + (win?.scrollY ?? 0),
      width: r.width,
      height: r.height,
    }
    if (rect.width < 1 || rect.height < 1) return
    const vw = viewport.clientWidth
    const vh = viewport.clientHeight
    if (vw < 1 || vh < 1) return
    const k = Math.min(vw / rect.width, vh / rect.height)
    const ox = (vw - rect.width * k) / 2
    const oy = (vh - rect.height * k) / 2
    frame.style.transform = `translate(${ox}px, ${oy}px) scale(${k}) translate(${-rect.left}px, ${-rect.top}px)`
    // mask everything but the current slide (neighbors would otherwise show
    // in the letterbox slack); clip-path is in pre-transform local coords
    const fw = frame.clientWidth || EXEC_W
    const fh = frame.clientHeight || EXEC_H
    frame.style.clipPath =
      `inset(${rect.top}px ${Math.max(0, fw - rect.left - rect.width)}px ${Math.max(0, fh - rect.top - rect.height)}px ${rect.left}px)`
  }

  /* ---------- actions ---------- */

  private async retry(): Promise<void> {
    const slide = this.input.extraction.slides[this.current]
    const index = this.current
    this.retryBtn.disabled = true
    this.retryBtn.textContent = 'retrying…'
    this.verdictMsg.textContent = ''
    try {
      // a vision model should SEE the original it must reproduce
      await this.showOriginal(index)
      const png = this.origRoots[index] ? await rasterizeToDataUrl(this.origRoots[index]) : null
      const feedback = this.feedbackFor(index)
      this.logModel(index, 'user', 'retranslate: full model re-translation of this slide')
      this.logDetail(index, `sent → translate-slide${png ? ' · 1 image (original render)' : ''}`,
        `source slide html (${slide.sourceHtml.length} chars)${feedback ? `\n\nreviewer feedback:\n${feedback}` : ''}\n\n${slide.sourceHtml}`,
        { images: png ? [png] : [], mono: true })
      const result = await service.translateSlide(
        slide.sourceHtml, tokensToCss(this.input.extraction.tokens),
        png ? [png] : [], feedback)
      if (result.thinking) this.logDetail(index, 'model thinking', result.thinking)
      this.logDetail(index, 'received → translated slide html', result.output, { mono: true })
      this.conversions[index] = revalidateSlide(slide, index, result.output)
      this.logModel(index, 'assistant', 'retranslated — re-measuring fidelity')
      this.rebuild()
    } catch {
      this.verdictMsg.textContent = 'service translation failed — slide unchanged'
      this.logModel(index, 'quiet', 'retranslation failed — slide unchanged')
    } finally {
      this.retryBtn.textContent = 'retranslate slide'
      this.renderVerdict()
    }
  }

  /* ---------- fidelity loop: measure → repair → re-measure ---------- */

  /** Runs once, when both panes are live: score every slide, then repair
   * under-threshold slides through the service — up to MAX_AUTO_REPAIR_ROUNDS
   * per slide, stopping early when a round stops improving (keep-best). */
  private async maybeRunFidelity(): Promise<void> {
    if (this.fidelityRan || !this.origReady || !this.convReady || this.closed) return
    this.fidelityRan = true
    const n = this.conversions.length
    for (let i = 0; i < n && !this.closed; i++) {
      // BOTH panes follow the slide being worked on — the original deck
      // navigates itself for sampling, and the converted pane's crop must
      // track it, or the right side appears frozen on slide 1. follow()
      // syncs the UI without triggering a second navigation (measureSlide
      // navigates; a racing go() would double-send arrow keys).
      this.follow(i)
      this.verdictMsg.textContent = `measuring slide ${i + 1} of ${n}…`
      await this.measureSlide(i)
    }
    if (!(await this.healthCheck) || this.closed) {
      this.verdictMsg.textContent = ''
      await this.showOriginal(this.current) // back to the slide under review
      this.layout()
      return
    }
    for (let i = 0; i < n && !this.closed; i++) {
      for (let round = 1; round <= MAX_AUTO_REPAIR_ROUNDS && !this.closed; round++) {
        const c = this.conversions[i]
        if (c.fidelity == null || c.fidelity >= REPAIR_THRESHOLD) break
        this.follow(i)
        this.verdictMsg.textContent = `repairing slide ${i + 1} — round ${round}…`
        const beforeScore = c.fidelity
        const improved = await this.repairSlide(i, true)
        const afterScore = this.conversions[i].fidelity
        this.logModel(i, 'quiet',
          `auto-repair round ${round}: ${beforeScore.toFixed(3)} → ${afterScore == null ? '—' : afterScore.toFixed(3)}${improved ? '' : ' — kept the previous candidate'}`)
        if (!improved) break
      }
    }
    this.verdictMsg.textContent = ''
    await this.showOriginal(this.current)
    this.layout()
  }

  private convRoots(): HTMLElement[] {
    const cd = this.convFrame.contentDocument
    return cd ? [...cd.querySelectorAll<HTMLElement>('section.dia-slide')] : []
  }

  private async measureSlide(i: number): Promise<void> {
    const orig = this.origRoots[i]
    const conv = this.convRoots()[i]
    // present the slide through the deck's own runtime (true activation
    // state — reveals, split layouts) before rasterizing it
    await this.showOriginal(i)
    const unforce = orig && !this.oneAtATime() ? forceVisible(orig) : null
    let detail: SlideDiff | null = null
    try {
      detail = orig && conv ? await scoreSlideFidelityDetailed(orig, conv) : null
    } finally {
      unforce?.()
    }
    this.conversions[i].fidelity = detail ? detail.score.score : null
    this.slideDiffs[i] = detail
    this.renderStrip()
    if (i === this.current) { this.renderNotes(); this.renderVerdict(); this.renderHeatmap() }
  }

  /** PNG bundle for a vision-capable repair round: [original render,
   * candidate render, diff heatmap]. Empty when either side won't rasterize —
   * the skill call then degrades to text-only, same as before. */
  private async repairImages(i: number): Promise<string[]> {
    const orig = this.origRoots[i]
    const conv = this.convRoots()[i]
    if (!orig || !conv) return []
    await this.showOriginal(i)
    const unforce = !this.oneAtATime() ? forceVisible(orig) : null
    try {
      const [origPng, convPng, origBmp, convBmp] = await Promise.all([
        rasterizeToDataUrl(orig), rasterizeToDataUrl(conv),
        rasterizeRegion(orig), rasterizeRegion(conv),
      ])
      if (!origPng || !convPng) return []
      const images = [origPng, convPng]
      const heat = origBmp && convBmp ? diffHeatmapDataUrl(origBmp, convBmp) : null
      if (heat) images.push(heat)
      return images
    } finally {
      unforce?.()
    }
  }

  /** One service repair round for slide i; the result is kept only when it
   * re-measures at least as high as the current candidate. Returns true when
   * the repair improved the score (the auto loop's continue signal). */
  private async repairSlide(i: number, auto = false, note = ''): Promise<boolean> {
    const before = this.conversions[i]
    const slide = this.input.extraction.slides[i]
    let improved = false
    const feedback = [this.feedbackFor(i), note].filter(Boolean).join('\n')
    try {
      const mismatch = this.describeMismatch(i)
      const images = await this.repairImages(i)
      this.logDetail(i, `sent → repair-fidelity${images.length ? ` · ${images.length} images (original · candidate · diff)` : ''}`,
        `${mismatch}${feedback ? `\n\nreviewer feedback:\n${feedback}` : ''}`,
        { images })
      const result = await service.repairFidelity(
        slide.sourceHtml, before.html, tokensToCss(this.input.extraction.tokens),
        mismatch, images, feedback)
      if (result.thinking) this.logDetail(i, 'model thinking', result.thinking)
      this.logDetail(i, 'received → repaired slide html', result.output, { mono: true })
      const repaired = revalidateSlide(slide, i, result.output)
      repaired.repairRounds = (before.repairRounds ?? 0) + 1
      this.conversions[i] = repaired
      await this.rebuildAndWait()
      await this.measureSlide(i)
      const after = this.conversions[i].fidelity
      if (before.fidelity != null && (after ?? -1) < before.fidelity) {
        this.conversions[i] = { ...before, repairRounds: repaired.repairRounds }
        await this.rebuildAndWait()
        if (!auto) this.verdictMsg.textContent = 'repair scored lower — kept the previous candidate'
      } else {
        improved = before.fidelity == null || (after ?? 0) > before.fidelity
      }
    } catch (err) {
      this.conversions[i] = before
      if (!auto) this.verdictMsg.textContent = 'service repair failed — slide unchanged'
      this.renderStrip(); this.renderNotes(); this.renderVerdict()
      // the conversational path must SEE the failure, not a false success
      if (note) throw err
      return improved
    }
    this.renderStrip(); this.renderNotes(); this.renderVerdict()
    return improved
  }

  /** Lift every static (non-scene) SVG on the current slide into the scene
   * vocabulary via the service. Each lift is verified — profile-validated,
   * text-checked, and fidelity-re-measured — or discarded. */
  private async liftDiagrams(): Promise<void> {
    const i = this.current
    const before = this.conversions[i]
    const slide = this.input.extraction.slides[i]
    const doc = new DOMParser().parseFromString(before.html, 'text/html')
    const svgs = [...doc.querySelectorAll('svg')]
      .filter((s) => !s.classList.contains('dia-scene') && !s.closest('[data-dia-island]'))
    if (svgs.length === 0) return
    this.liftBtn.disabled = true
    this.verdictMsg.textContent = `lifting ${svgs.length} diagram${svgs.length > 1 ? 's' : ''}…`
    // live counterparts in the converted iframe (same filter, same document
    // order) — rasterized so a vision model sees the diagram it is lifting
    const liveSvgs = [...(this.convRoots()[i]?.querySelectorAll('svg') ?? [])]
      .filter((s) => !s.classList.contains('dia-scene') && !s.closest('[data-dia-island]'))
    let lifted = 0
    for (const [k, svg] of svgs.entries()) {
      try {
        const png = liveSvgs[k] ? await rasterizeToDataUrl(liveSvgs[k]) : null
        this.logDetail(i, `sent → lift-diagram ${k + 1}/${svgs.length}${png ? ' · 1 image (diagram render)' : ''}`,
          svg.outerHTML, { images: png ? [png] : [], mono: true })
        const result = await service.liftDiagram(svg.outerHTML, png ? [png] : [], this.feedbackFor(i))
        if (result.thinking) this.logDetail(i, 'model thinking', result.thinking)
        this.logDetail(i, `received → lifted scene ${k + 1}/${svgs.length}`, result.output, { mono: true })
        const scene = new DOMParser().parseFromString(result.output, 'text/html').querySelector('svg.dia-scene')
        if (!scene || !this.sceneIsValid(scene.outerHTML)) {
          this.logModel(i, 'quiet', `lift ${k + 1}/${svgs.length}: returned scene failed validation — kept the original svg`)
          continue
        }
        svg.replaceWith(doc.importNode(scene, true))
        lifted++
      } catch { break }
    }
    if (lifted === 0) {
      this.verdictMsg.textContent = 'no diagram lifted cleanly — slide unchanged'
      this.renderVerdict()
      return
    }
    const section = doc.querySelector('section.dia-slide') ?? doc.body
    const liftedConv = revalidateSlide(slide, i, section.outerHTML)
    liftedConv.repairRounds = before.repairRounds
    this.conversions[i] = liftedConv
    await this.rebuildAndWait()
    await this.measureSlide(i)
    const after = this.conversions[i].fidelity ?? null
    if (before.fidelity != null && (after ?? -1) < before.fidelity) {
      // the pane shows the lifted version — ask the reviewer instead of
      // silently reverting (router-drawn edges rarely match source pixels
      // exactly, so a strict gate would discard nearly every semantic lift)
      this.pendingLift = { index: i, before, prev: before.fidelity, after }
      this.verdictMsg.textContent = ''
      this.logModel(i, 'assistant',
        `lifted ${lifted} diagram${lifted > 1 ? 's' : ''}, but fidelity re-measured lower (${before.fidelity.toFixed(3)} → ${after == null ? '—' : after.toFixed(3)}) — keep or revert in the verdict row`)
    } else {
      this.verdictMsg.textContent = `lifted ${lifted} diagram${lifted > 1 ? 's' : ''} into editable scenes`
      this.logModel(i, 'assistant', `lifted ${lifted} diagram${lifted > 1 ? 's' : ''} into editable scenes`)
    }
    this.renderStrip(); this.renderNotes(); this.renderVerdict()
  }

  /* ---------- per-slide model conversation ---------- */

  private logModel(i: number, who: 'user' | 'assistant' | 'quiet', text: string): void {
    ;(this.modelLog[i] ??= []).push({ who, text })
    if (i === this.current) this.renderModelLog()
  }

  /** a collapsible transcript entry: request payloads, model reasoning,
   * returned html — with image thumbnails when images rode along */
  private logDetail(
    i: number, label: string, text: string,
    opts: { images?: string[]; mono?: boolean; open?: boolean } = {},
  ): void {
    const capped = text.length > LOG_TEXT_CAP
      ? `${text.slice(0, LOG_TEXT_CAP)}\n… (${text.length - LOG_TEXT_CAP} more characters truncated)`
      : text
    ;(this.modelLog[i] ??= []).push({ who: 'detail', label, text: capped, ...opts })
    if (i === this.current) this.renderModelLog()
  }

  /** everything the reviewer has SAID about slide i — the standing feedback
   * that rides along with retranslate, repair, and lift */
  private feedbackFor(i: number): string {
    return (this.modelLog[i] ?? [])
      .filter((e) => e.who === 'user')
      .map((e) => e.text)
      .filter((t) => !t.startsWith('retry:'))
      .join('\n')
  }

  private renderModelLog(): void {
    this.copLog.replaceChildren()
    const entries = this.modelLog[this.current] ?? []
    if (entries.length === 0) {
      const empty = h('div', 'dia-cop-quiet',
        'no model activity for this slide yet — low-fidelity slides repair automatically when the service is up')
      this.copLog.appendChild(empty)
    }
    for (const e of entries) {
      if (e.who === 'detail') {
        const box = document.createElement('details')
        box.className = 'dia-cop-think'
        if (e.open) box.open = true
        const sum = document.createElement('summary')
        sum.textContent = e.label
        box.appendChild(sum)
        if (e.images && e.images.length > 0) {
          const shots = h('div', 'dia-cop-shots')
          for (const src of e.images) {
            const im = document.createElement('img')
            im.src = src
            im.loading = 'lazy'
            shots.appendChild(im)
          }
          box.appendChild(shots)
        }
        const body = h('div', 'dia-cop-think-body')
        if (e.mono) {
          const pre = document.createElement('pre')
          pre.className = 'dia-md-pre'
          pre.textContent = e.text
          body.appendChild(pre)
        } else {
          body.replaceChildren(renderMarkdown(e.text))
        }
        box.appendChild(body)
        this.copLog.appendChild(box)
      } else if (e.who === 'quiet') {
        const q = h('div', 'dia-cop-quiet')
        q.replaceChildren(renderMarkdown(e.text))
        this.copLog.appendChild(q)
      } else {
        const b = h('div', `dia-cop-msg dia-cop-${e.who === 'user' ? 'user' : 'assistant'}`)
        b.replaceChildren(renderMarkdown(e.text))
        this.copLog.appendChild(b)
      }
    }
    this.copLog.scrollTop = this.copLog.scrollHeight
  }

  /** composer → one repair round with the message as reviewer feedback */
  private async chatRepair(): Promise<void> {
    const msg = this.copInput.value.trim()
    if (!msg || this.copBusy) return
    if (!this.serviceOk) {
      this.logModel(this.current, 'quiet', 'service offline — start it with `dia serve`, then send again')
      return
    }
    const i = this.current
    this.copInput.value = ''
    this.copBusy = true
    this.renderVerdict()
    this.logModel(i, 'user', msg)
    const before = this.conversions[i].fidelity
    try {
      const improved = await this.repairSlide(i, false, msg)
      const after = this.conversions[i].fidelity
      const fmtF = (v: number | null | undefined) => (v == null ? '—' : v.toFixed(3))
      this.logModel(i, 'assistant', improved || (after ?? -1) >= (before ?? -1)
        ? `repaired with your note — fidelity ${fmtF(before)} → ${fmtF(after)}`
        : `the repair re-measured lower (${fmtF(before)} → kept the previous candidate)`)
    } catch {
      this.logModel(i, 'quiet', 'repair failed — slide unchanged')
    } finally {
      this.copBusy = false
      this.renderVerdict()
      this.copInput.focus()
    }
  }

  /** validate a lifted scene by planting it in a minimal probe deck */
  private sceneIsValid(sceneHtml: string): boolean {
    const probe =
      '<!doctype html><html data-dia-version="1"><head><style id="dia-theme">:root{--dia-p:0}</style></head>' +
      `<body><section class="dia-slide">${sceneHtml}</section><script id="dia-runtime"></script></body></html>`
    return validateDeckHtml(probe).ok
  }

  private describeMismatch(i: number): string {
    const c = this.conversions[i]
    const lines: string[] = []
    lines.push(c.fidelity != null
      ? `pixel diff: ${Math.round((1 - c.fidelity) * 100)}% of sampled pixels differ between the source render and the converted render.`
      : 'pixel diff unavailable (slide would not rasterize) — rely on the structural notes below.')
    // WHERE the miss is — measured regions from the same rasters as the
    // score, so a targeted repair can aim at the offending area only
    const regions = this.slideDiffs[i]?.regions ?? []
    if (regions.length > 0) {
      lines.push('mismatch regions (fractions of the slide, origin top-left; fix THESE areas, leave the rest untouched):')
      for (const r of regions) {
        lines.push(
          `- x=${r.x.toFixed(2)} y=${r.y.toFixed(2)} w=${r.w.toFixed(2)} h=${r.h.toFixed(2)}` +
          ` — ${Math.round(r.frac * 100)}% of its content differs`)
      }
    }
    for (const w of c.warnings) lines.push(w)
    for (const n of c.notes) lines.push(`${n.kind} at ${n.locator}: ${n.note}`)
    return lines.join('\n')
  }

  private rebuildAndWait(): Promise<void> {
    return new Promise((resolve) => {
      this.convFrame.addEventListener('load', () => resolve(), { once: true })
      this.rebuild()
    })
  }

  private accept(): void {
    if (this.closed) return
    const { name, extraction } = this.input
    const outcome: ReviewOutcome = {
      accepted: true,
      deckHtml: this.deckHtml(true),
      report: buildReport(extraction, name, this.conversions),
    }
    this.close()
    this.resolve(outcome)
  }

  private cancel(): void {
    if (this.closed) return
    const { name, extraction } = this.input
    const outcome: ReviewOutcome = {
      accepted: false,
      deckHtml: '',
      report: buildReport(extraction, name, this.conversions),
    }
    this.close()
    this.resolve(outcome)
  }

  private close(): void {
    this.closed = true
    this.unforceOrig?.()
    this.unforceOrig = null
    window.removeEventListener('keydown', this.onKey, true)
    window.removeEventListener('resize', this.onResize)
    this.overlay.remove()
  }

  /* ---------- hovercard ---------- */

  private showHover(anchor: HTMLElement, text: string): void {
    const r = anchor.getBoundingClientRect()
    this.hover.textContent = text
    this.hover.style.left = `${r.left}px`
    this.hover.style.top = `${r.top - 34}px`
    this.hover.classList.add('dn-hovercard-on')
  }

  private hideHover(): void {
    this.hover.classList.remove('dn-hovercard-on')
  }
}

/* ---------- dom helpers ---------- */


function h(tag: string, cls?: string, text?: string): HTMLElement {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  if (text !== undefined) el.textContent = text
  return el
}

function dim(text: string): HTMLElement {
  return h('span', 'dim', text)
}

function btn(label: string, cls: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = cls
  b.textContent = label
  return b
}
