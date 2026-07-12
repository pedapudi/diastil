/* IMPORT REVIEW — full-screen fix/validate compare between the executed
 * original (the live iframe from execute.ts) and the converted dialect deck.
 * zicato chrome: role tokens only, mono labels, one accent on the signal
 * (accept import). Keyboard: ←/→ slides, Esc cancels. */

import './ingest.css'
import type { ImportReport } from '../types'
import { validateDeckHtml } from '../model/validate'
import { service } from '../service/client'
import type { ExecuteResult } from './execute'
import { EXEC_W, EXEC_H } from './execute'
import type { Extraction } from './extract'
import { findSlideRoots, forceVisible } from './extract'
import { scoreSlideFidelity, REPAIR_THRESHOLD } from './fidelity'

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

type Mode = 'side' | 'overlay'

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
  private acceptSlideBtn!: HTMLButtonElement
  private retryBtn!: HTMLButtonElement
  private repairBtn!: HTMLButtonElement
  private liftBtn!: HTMLButtonElement
  private retryWrap!: HTMLElement
  private hover!: HTMLElement
  private segButtons: HTMLButtonElement[] = []
  private origRoots: HTMLElement[] = []
  /** restore fn for the original slide the compare pane force-revealed */
  private unforceOrig: (() => void) | null = null

  /** decks that hide non-current slides (any root without a layout box) —
   * for these the review controls slide visibility outright */
  private oneAtATime(): boolean {
    return this.origRoots.length > 1 && this.origRoots.some((r) => r.offsetWidth === 0)
  }

  private onKey = (e: KeyboardEvent): void => {
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
    const cancelBtn = btn('cancel', 'dn-btn')
    cancelBtn.addEventListener('click', () => this.cancel())
    const acceptBtn = btn('accept import', 'dn-btn dn-btn-accent')
    acceptBtn.addEventListener('click', () => this.accept())
    head.append(title, spacer, cancelBtn, acceptBtn)

    // body: strip + main
    const body = h('div', 'dia-review-body')
    this.strip = h('aside', 'dia-review-strip')
    const main = h('div', 'dia-review-main')

    // toggle row
    const tools = h('div', 'dia-review-tools')
    const seg = h('div', 'dn-seg')
    for (const [label, mode] of [['side-by-side', 'side'], ['overlay', 'overlay']] as const) {
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
    this.cmp.append(orig.pane, conv.pane)

    // original = the live executed iframe (reparenting reloads srcdoc, so
    // slide roots are re-located once the moved document settles)
    this.origFrame = execution.iframe
    this.origFrame.classList.remove('dia-ingest-exec')
    this.origFrame.addEventListener('load', () => {
      window.setTimeout(() => {
        const d = this.origFrame.contentDocument
        if (d) this.origRoots = findSlideRoots(d).roots
        this.layout()
        this.origReady = true
        void this.maybeRunFidelity()
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
    this.retryWrap = h('span', 'dia-retry-wrap')
    this.retryBtn = btn('retry with service', 'dn-btn')
    this.retryBtn.disabled = true
    this.retryBtn.addEventListener('click', () => void this.retry())
    this.repairBtn = btn('repair with service', 'dn-btn')
    this.repairBtn.disabled = true
    this.repairBtn.addEventListener('click', () => void this.repairSlide(this.current))
    this.liftBtn = btn('lift diagrams', 'dn-btn')
    this.liftBtn.disabled = true
    this.liftBtn.addEventListener('click', () => void this.liftDiagrams())
    this.retryWrap.append(this.retryBtn, this.repairBtn, this.liftBtn)
    this.retryWrap.addEventListener('mouseenter', () => {
      if (!this.serviceOk) this.showHover(this.retryWrap, 'requires the dia service')
    })
    this.retryWrap.addEventListener('mouseleave', () => this.hideHover())
    this.verdictMsg = h('span', 'dia-verdict-msg')
    verdict.append(this.acceptSlideBtn, islandBtn, this.retryWrap, this.verdictMsg)

    // region notes
    this.notesEl = h('div', 'dia-notes')

    main.append(tools, this.cmp, verdict, this.notesEl)
    body.append(this.strip, main)

    // hovercard (chrome idiom from base.css, locally owned instance)
    this.hover = h('div', 'dn-hovercard')

    this.overlay.append(head, body, this.hover)
    document.body.appendChild(this.overlay)
    this.overlay.focus()
    window.addEventListener('keydown', this.onKey, true)
    window.addEventListener('resize', this.onResize)

    this.healthCheck = service.health().then((r) => {
      this.serviceOk = r.ok
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
    this.acceptSlideBtn.textContent = c.accepted ? 'slide accepted ✓' : 'accept slide'
    this.retryBtn.disabled = !this.serviceOk
    this.repairBtn.disabled = !this.serviceOk || c.fidelity === undefined
    this.liftBtn.disabled = !this.serviceOk || !this.hasLiftableSvg(this.current)
    if (this.serviceOk) this.hideHover()
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
    this.hint.textContent = mode === 'overlay' ? 'difference — matched regions read dark' : ''
    requestAnimationFrame(() => this.layout())
  }

  private go(i: number): void {
    const n = this.conversions.length
    this.current = Math.max(0, Math.min(i, n - 1))
    this.renderStrip()
    this.renderNotes()
    this.renderVerdict()
    this.verdictMsg.textContent = ''
    this.layout()
  }

  /** reassemble the converted doc after a per-slide change */
  private rebuild(): void {
    this.convFrame.srcdoc = this.deckHtml()
    this.setMode(this.mode)
    this.renderStrip()
    this.renderNotes()
    this.renderVerdict()
  }

  private deckHtml(): string {
    const { name, extraction } = this.input
    const title = name.replace(/\.html?$/, '')
    return assembleDeck(this.conversions.map((c) => c.html), extraction.tokens, title)
  }

  /* ---------- geometry: crop each pane to the current slide ---------- */

  private layout(): void {
    requestAnimationFrame(() => {
      // hidden-slide decks: the review OWNS visibility — show exactly the
      // compared slide. Revealing it while the deck's runtime keeps its own
      // current slide shown would ghost two slides over each other (they
      // share the same absolutely-positioned stage).
      const orig = this.origRoots[this.current] ?? null
      if (this.oneAtATime()) {
        this.origRoots.forEach((r, i) => {
          r.style.display = i === this.current ? 'block' : 'none'
          if (i === this.current) r.style.visibility = 'visible'
        })
      } else {
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
      const html = await service.translateSlide(slide.sourceHtml, tokensToCss(this.input.extraction.tokens))
      this.conversions[index] = revalidateSlide(slide, index, html)
      this.rebuild()
    } catch {
      this.verdictMsg.textContent = 'service translation failed — slide unchanged'
    } finally {
      this.retryBtn.textContent = 'retry with service'
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
    for (let i = 0; i < this.conversions.length && !this.closed; i++) {
      await this.measureSlide(i)
    }
    if (!(await this.healthCheck) || this.closed) return
    for (let i = 0; i < this.conversions.length && !this.closed; i++) {
      for (let round = 1; round <= MAX_AUTO_REPAIR_ROUNDS && !this.closed; round++) {
        const c = this.conversions[i]
        if (c.fidelity == null || c.fidelity >= REPAIR_THRESHOLD) break
        this.verdictMsg.textContent = `repairing slide ${i + 1} — round ${round}…`
        const improved = await this.repairSlide(i, true)
        if (!improved) break
      }
    }
    this.verdictMsg.textContent = ''
  }

  private convRoots(): HTMLElement[] {
    const cd = this.convFrame.contentDocument
    return cd ? [...cd.querySelectorAll<HTMLElement>('section.dia-slide')] : []
  }

  private async measureSlide(i: number): Promise<void> {
    const orig = this.origRoots[i]
    const conv = this.convRoots()[i]
    // one-visible-at-a-time decks hide non-current slides — reveal for the raster
    const unforce = orig ? forceVisible(orig) : null
    let score = null
    try {
      score = orig && conv ? await scoreSlideFidelity(orig, conv) : null
    } finally {
      unforce?.()
    }
    this.conversions[i].fidelity = score ? score.score : null
    this.renderStrip()
    if (i === this.current) { this.renderNotes(); this.renderVerdict() }
  }

  /** One service repair round for slide i; the result is kept only when it
   * re-measures at least as high as the current candidate. Returns true when
   * the repair improved the score (the auto loop's continue signal). */
  private async repairSlide(i: number, auto = false): Promise<boolean> {
    const before = this.conversions[i]
    const slide = this.input.extraction.slides[i]
    this.repairBtn.disabled = true
    let improved = false
    try {
      const html = await service.repairFidelity(
        slide.sourceHtml, before.html, tokensToCss(this.input.extraction.tokens), this.describeMismatch(i))
      const repaired = revalidateSlide(slide, i, html)
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
    } catch {
      this.conversions[i] = before
      if (!auto) this.verdictMsg.textContent = 'service repair failed — slide unchanged'
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
    let lifted = 0
    for (const svg of svgs) {
      try {
        const out = await service.liftDiagram(svg.outerHTML)
        const scene = new DOMParser().parseFromString(out, 'text/html').querySelector('svg.dia-scene')
        if (!scene || !this.sceneIsValid(scene.outerHTML)) continue
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
    if (before.fidelity != null && (this.conversions[i].fidelity ?? -1) < before.fidelity) {
      this.conversions[i] = before
      await this.rebuildAndWait()
      this.verdictMsg.textContent = 'lift changed the rendering — discarded (still available manually later)'
    } else {
      this.verdictMsg.textContent = `lifted ${lifted} diagram${lifted > 1 ? 's' : ''} into editable scenes`
    }
    this.renderStrip(); this.renderNotes(); this.renderVerdict()
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
      deckHtml: this.deckHtml(),
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
