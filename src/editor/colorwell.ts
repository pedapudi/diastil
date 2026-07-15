/* Native color dialogs anchor to their input element. Every diastil color
 * well lives in a rail or floating bar hugging a screen edge, so the OS
 * picker can open partly or fully OFF-SCREEN. attachPickerProxy() reroutes
 * the gesture through an invisible fixed-position input clamped safely
 * inside the viewport — the dialog opens beside the control, always
 * visible, and the well still receives its normal input/change events. */

const PICKER_W = 360
const PICKER_H = 420

export function attachPickerProxy(well: HTMLInputElement): HTMLInputElement {
  well.addEventListener('click', (e) => {
    // no showPicker (very old engines): keep the native anchor behavior
    if (typeof well.showPicker !== 'function') return
    e.preventDefault()
    const r = well.getBoundingClientRect()
    const proxy = document.createElement('input')
    proxy.type = 'color'
    proxy.value = well.value
    proxy.style.cssText =
      `position: fixed;` +
      `left: ${Math.max(8, Math.min(r.left, innerWidth - PICKER_W))}px;` +
      `top: ${Math.max(8, Math.min(r.top, innerHeight - PICKER_H))}px;` +
      'width: 1px; height: 1px; opacity: 0; padding: 0; border: 0;'
    document.body.appendChild(proxy)
    for (const type of ['input', 'change'] as const) {
      proxy.addEventListener(type, () => {
        well.value = proxy.value
        well.dispatchEvent(new Event(type, { bubbles: true }))
      })
    }
    proxy.addEventListener('change', () => proxy.remove())
    // dismissed without choosing (Esc / click-away)
    proxy.addEventListener('blur', () => setTimeout(() => proxy.remove(), 250))
    try {
      proxy.showPicker()
    } catch {
      proxy.remove()
    }
  })
  return well
}
