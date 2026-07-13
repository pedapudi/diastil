/* Deck navigation for one-visible-at-a-time decks — shared by EXTRACTION
 * (sampling must observe every slide in its true activated state: split
 * layouts, reveals, lazily-drawn figures) and the REVIEW's original pane.
 *
 * Arrow keys are a convention, not a contract: the deck's navigation is
 * PROBED (framework APIs → key conventions → its own controls → hash) and
 * every attempt is verified by whether the target slide actually became
 * visible. The first method that works is remembered for the deck; when
 * nothing works, styles are forced and `forced` says so — a consumer must
 * treat a forced presentation as an approximation, never ground truth. */

/** One way a deck might navigate. goto() ATTEMPTS the move; the caller
 * verifies by visibility — no method is trusted, only observed. */
interface NavMethod {
  name: string
  applicable(win: Window, doc: Document, cur: number, target: number): boolean
  goto(win: Window, doc: Document, cur: number, target: number): void
}

/** keydown with keyCode/which shimmed — synthetic KeyboardEvents report 0
 * and legacy deck handlers check the numeric codes */
function sendKey(win: Window, doc: Document, key: string, code: number): void {
  for (const target of [doc, win] as const) {
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'keyCode', { get: () => code })
    Object.defineProperty(ev, 'which', { get: () => code })
    target.dispatchEvent(ev)
  }
}

function keyMethod(name: string, fwd: [string, number], back: [string, number]): NavMethod {
  return {
    name,
    applicable: (_w, _d, cur, target) => cur >= 0 && cur !== target,
    goto(win, doc, cur, target) {
      const [key, code] = target > cur ? fwd : back
      for (let k = 0; k < Math.abs(target - cur); k++) sendKey(win, doc, key, code)
    },
  }
}

const NEXT_CONTROLS = '.navigate-right, .next, .nav-next, .btn-next, [data-next], [aria-label*="next" i]'
const PREV_CONTROLS = '.navigate-left, .prev, .nav-prev, .btn-prev, [data-prev], [aria-label*="prev" i]'

/** Probe order: exact framework APIs, then input conventions, then the
 * deck's own controls, then hash routing. Hash is last because it dirties
 * the srcdoc frame's URL (about:srcdoc#n breaks capture/devtools access) —
 * goto() strips the fragment again via replaceState when the frame allows. */
const NAV_METHODS: NavMethod[] = [
  {
    name: 'reveal-api',
    applicable: (win) => typeof (win as { Reveal?: { slide?: unknown } }).Reveal?.slide === 'function',
    goto: (win, _d, _c, target) => (win as unknown as { Reveal: { slide(i: number): void } }).Reveal.slide(target),
  },
  {
    name: 'impress-api',
    applicable: (win) => typeof (win as { impress?: unknown }).impress === 'function',
    goto: (win, _d, _c, target) =>
      (win as unknown as { impress(): { goto(i: number): void } }).impress().goto(target),
  },
  keyMethod('arrow-keys', ['ArrowRight', 39], ['ArrowLeft', 37]),
  keyMethod('page-keys', ['PageDown', 34], ['PageUp', 33]),
  {
    name: 'controls',
    applicable: (_w, doc, cur, target) =>
      cur >= 0 && cur !== target &&
      doc.querySelector(target > cur ? NEXT_CONTROLS : PREV_CONTROLS) !== null,
    goto(win, doc, cur, target) {
      const el = doc.querySelector<HTMLElement>(target > cur ? NEXT_CONTROLS : PREV_CONTROLS)
      for (let k = 0; k < Math.abs(target - cur); k++) {
        el?.dispatchEvent(new (win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent('click', { bubbles: true, cancelable: true }))
      }
    },
  },
  {
    name: 'hash',
    // NEVER in srcdoc frames: the fragment lands on about:srcdoc and cannot
    // be stripped (replaceState refuses), permanently breaking capture and
    // devtools access to the page — worse than not navigating at all
    applicable: (win) => !win.location.href.startsWith('about:srcdoc'),
    goto(win, _d, _c, target) {
      win.location.hash = `#${target + 1}`
      // restore a fragment-free URL once the router has seen the change
      win.setTimeout(() => {
        try {
          win.history.replaceState(null, '', win.location.pathname + win.location.search)
        } catch { /* some frames refuse; the deck still navigated */ }
      }, 250)
    },
  },
]

export class DeckNavigator {
  /** learned by probing (locked in on first success); null = nothing works */
  private method: (typeof NAV_METHODS)[number] | null | undefined
  /** the last show() had to force styles — activation state is UNKNOWN */
  forced = false

  constructor(private doc: Document, private roots: HTMLElement[]) {}

  /** decks that hide non-current slides (any root without a layout box) */
  oneAtATime(): boolean {
    return this.roots.length > 1 && this.roots.some((r) => r.offsetWidth === 0)
  }

  /** Present slide i through the deck's own runtime; returns true when the
   * runtime did it, false when styles had to be forced (`forced` mirrors). */
  async show(i: number): Promise<boolean> {
    const win = this.doc.defaultView
    const root = this.roots[i]
    if (!win || !root || !this.oneAtATime()) return true
    // undo any earlier forcing so the runtime is in charge again
    for (const r of this.roots) {
      r.style.removeProperty('display')
      r.style.removeProperty('visibility')
    }
    if (root.offsetWidth > 0) { this.forced = false; return true }

    const attempt = async (m: NavMethod): Promise<boolean> => {
      const cur = this.roots.findIndex((r) => r.offsetWidth > 0)
      if (!m.applicable(win, this.doc, cur, i)) return false
      try { m.goto(win, this.doc, cur, i) } catch { return false }
      await pause(380)
      if (root.offsetWidth > 0) return true
      // slow slide transitions: one more beat before judging the method dead
      await pause(300)
      return root.offsetWidth > 0
    }

    if (this.method && (await attempt(this.method))) { this.forced = false; return true }
    if (this.method !== null) {
      for (const m of NAV_METHODS) {
        if (m === this.method) continue
        if (await attempt(m)) {
          this.method = m
          this.forced = false
          return true
        }
      }
      this.method = null
    }
    // last resort — geometry without activation styling, flagged honestly
    this.roots.forEach((r, j) => { r.style.display = j === i ? 'block' : 'none' })
    root.style.visibility = 'visible'
    this.forced = true
    return false
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
