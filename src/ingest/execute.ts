/* EXECUTE — step 1 of ingest. Render foreign HTML in a sandboxed, offscreen
 * iframe so runtime-built content (JS-rendered lists, d3 passes, framework
 * decks) exists in the DOM before extraction. Settling: load event +
 * document.fonts.ready + a MutationObserver quiet window (≥300ms) under a
 * hard cap (4000ms). Pages that never go quiet are classified live and
 * reported — extraction still proceeds on the capped state. */

export const EXEC_W = 1280
export const EXEC_H = 720

const QUIET_MS = 300
const CAP_MS = 4000

export interface ExecuteResult {
  /** the live executed iframe — kept alive for the review compare pane */
  iframe: HTMLIFrameElement
  /** the live rendered document (computed styles + layout available) */
  doc: Document
  /** deep-cloned snapshot of the rendered document at settle time */
  snapshot: Document
  /** true when the page never went mutation-quiet before the cap */
  live: boolean
  warnings: string[]
}

/** Decks that manage a URL hash (history.pushState/replaceState with an
 * absolute or fragment URL) THROW SecurityError inside a srcdoc sandbox —
 * an uncaught throw mid-navigation can leave the deck's runtime wedged and
 * floods the console during activated sampling. Make both calls no-throw.
 * MUST be re-applied after every load of the frame: reparenting an iframe
 * (the review does) reloads srcdoc into a fresh window without the shim. */
export function shimFrameHistory(win: Window | null): void {
  if (!win) return
  const history = win.history
  for (const m of ['pushState', 'replaceState'] as const) {
    if (!/native code/.test(String(history[m]))) continue // already shimmed
    const orig = history[m].bind(history)
    try {
      Object.defineProperty(history, m, {
        value: (...args: Parameters<History['pushState']>) => {
          try { orig(...args) } catch { /* srcdoc frames refuse URLs — ignore */ }
        },
      })
    } catch { /* history not configurable in this engine — leave as is */ }
  }
}

export async function executeSource(html: string): Promise<ExecuteResult> {
  const iframe = document.createElement('iframe')
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin')
  iframe.className = 'dia-ingest-exec'
  iframe.srcdoc = html
  document.body.appendChild(iframe)

  // load event, with a cap so a stalled subresource cannot hang the import
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = () => { if (!settled) { settled = true; resolve() } }
    iframe.addEventListener('load', finish, { once: true })
    window.setTimeout(finish, CAP_MS)
  })

  const doc = iframe.contentDocument
  if (!doc) {
    iframe.remove()
    throw new Error('ingest: sandboxed document unavailable after load')
  }

  shimFrameHistory(doc.defaultView)

  try { await doc.fonts.ready } catch { /* fonts API unavailable in this document */ }

  const live = await waitMutationQuiet(doc)
  const warnings: string[] = []
  if (live) {
    warnings.push(
      `source never went mutation-quiet within ${CAP_MS}ms — classified as live; ` +
      'still-animating regions may convert with lower fidelity',
    )
  }

  const snapshot = doc.cloneNode(true) as Document
  return { iframe, doc, snapshot, live, warnings }
}

/** Resolve false once the document has been mutation-free for QUIET_MS,
 * true (= live) when CAP_MS elapses without ever going quiet. */
function waitMutationQuiet(doc: Document): Promise<boolean> {
  return new Promise((resolve) => {
    let quietTimer = 0
    let done = false
    const observer = new MutationObserver(() => armQuiet())
    const capTimer = window.setTimeout(() => finish(true), CAP_MS)

    function finish(live: boolean): void {
      if (done) return
      done = true
      observer.disconnect()
      window.clearTimeout(quietTimer)
      window.clearTimeout(capTimer)
      resolve(live)
    }
    function armQuiet(): void {
      window.clearTimeout(quietTimer)
      quietTimer = window.setTimeout(() => finish(false), QUIET_MS)
    }

    try {
      observer.observe(doc.documentElement, {
        subtree: true, childList: true, attributes: true, characterData: true,
      })
    } catch { /* document detached — treat as settled */ }
    armQuiet()
  })
}
