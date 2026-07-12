// chrome/hovercard.ts — the SINGLETON hovercard, per the zicato idiom.
//
// One shared .dn-hovercard element (styles in base.css) serves every tip in
// the chrome. `hov(el, tip)` wires mouseenter/mouseleave + focus/blur on the
// target; showing positions the card near the pointer (or the element, for
// keyboard focus), clamped to the viewport. The card is pointer-events:none
// so it never steals hover from its target. Mounted lazily into document.body
// on first use — importing this module costs nothing until a tip shows.

let card: HTMLDivElement | null = null

function ensureCard(): HTMLDivElement {
  if (!card) {
    card = document.createElement('div')
    card.className = 'dn-hovercard'
    card.setAttribute('role', 'tooltip')
    card.setAttribute('aria-hidden', 'true')
    document.body.appendChild(card)
  }
  return card
}

// Show the shared card with `tip` near viewport point (x, y), clamped so it
// never leaves the viewport; flips above the pointer when it would overflow
// the bottom edge. Newlines in `tip` become stacked lines.
function show(tip: string, x: number, y: number): void {
  const c = ensureCard()
  c.textContent = ''
  for (const line of tip.split('\n')) {
    const p = document.createElement('div')
    p.className = 'dn-hovercard-line'
    p.textContent = line
    c.appendChild(p)
  }
  // make it measurable before clamping
  c.classList.add('dn-hovercard-on')
  c.setAttribute('aria-hidden', 'false')
  const pad = 8
  const w = c.offsetWidth
  const h = c.offsetHeight
  let left = x + 12
  let top = y + 14
  if (left + w > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - pad - w)
  if (top + h > window.innerHeight - pad) top = Math.max(pad, y - h - 10)
  c.style.left = `${left}px`
  c.style.top = `${top}px`
}

function hide(): void {
  if (!card) return
  card.classList.remove('dn-hovercard-on')
  card.setAttribute('aria-hidden', 'true')
}

// Attach a hovercard tip to `el`. Mouse shows near the pointer; keyboard
// focus shows under the element. One shared card — a new show simply retargets
// it, so overlapping enter/leave order can never strand a stale tip.
export function hov(el: Element, tip: string): void {
  el.addEventListener('mouseenter', (ev) => {
    const e = ev as MouseEvent
    show(tip, e.clientX, e.clientY)
  })
  el.addEventListener('mouseleave', hide)
  el.addEventListener('focus', () => {
    const r = el.getBoundingClientRect()
    show(tip, r.left, r.bottom)
  })
  el.addEventListener('blur', hide)
}
