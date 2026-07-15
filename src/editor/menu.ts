/* The context-menu RENDERER, shared by the deck editor and the studio:
 * a clamped fixed panel of verb buttons. Callers own the entries; every
 * item must route through an existing action — the menu is a faster
 * path, never a second implementation. */

export interface Item {
  label: string
  run: () => void
  danger?: boolean
}

export const SEP: unique symbol = Symbol('sep')
export type Entry = Item | typeof SEP

let menuEl: HTMLElement | null = null

export function openMenu(x: number, y: number, entries: Entry[]): void {
  closeMenu()
  const menu = document.createElement('div')
  menu.className = 'de-menu dn-panel'
  menu.setAttribute('role', 'menu')
  for (const entry of entries) {
    if (entry === SEP) {
      // collapse doubled/leading separators as entries vary by context
      if (menu.lastElementChild && menu.lastElementChild.tagName !== 'HR') menu.appendChild(document.createElement('hr'))
      continue
    }
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = entry.label
    if (entry.danger) b.className = 'is-danger'
    b.addEventListener('click', () => { closeMenu(); entry.run() })
    menu.appendChild(b)
  }
  if (menu.lastElementChild?.tagName === 'HR') menu.lastElementChild.remove()
  document.body.appendChild(menu)
  const r = menu.getBoundingClientRect()
  menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`
  menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`
  menuEl = menu

  const off = new AbortController()
  const dismiss = (ev: Event): void => {
    if (ev.type === 'keydown' && (ev as KeyboardEvent).key !== 'Escape') return
    if (ev.type === 'pointerdown' && ev.composedPath().includes(menu)) return
    off.abort()
    closeMenu()
  }
  window.addEventListener('pointerdown', dismiss, { capture: true, signal: off.signal })
  window.addEventListener('keydown', dismiss, { capture: true, signal: off.signal })
  window.addEventListener('scroll', dismiss, { capture: true, signal: off.signal })
  window.addEventListener('resize', dismiss, { signal: off.signal })
}

export function closeMenu(): void {
  menuEl?.remove()
  menuEl = null
}

export function menuIsOpen(): boolean {
  return menuEl !== null
}
