/* Load a dialect deck's HTML text into a live shadow-root document. */

import type { Deck } from '../types'

let nextId = 1
export function freshId(prefix = 'n'): string { return `${prefix}${nextId++}` }

/**
 * Parse dialect HTML into a Deck mounted at `host`.
 * - deck theme/style blocks are adopted into the shadow root (scoped: `:root` → `:host`)
 * - every slide + element gets a session-stable data-dia-id (stripped on save)
 */
export function loadDeck(html: string, host: HTMLElement, fileName: string): Deck {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
  root.replaceChildren()

  // collect head extras we must not lose (meta, links other than our own)
  const headExtras = [...doc.head.children]
    .filter((el) => !(el instanceof HTMLTitleElement))
    .filter((el) => !(el instanceof HTMLStyleElement))
    .filter((el) => !(el instanceof HTMLScriptElement))
    .map((el) => el.outerHTML)
    .join('\n')

  // theme style: id="dia-theme", else first style block, else create one
  let themeSrc =
    doc.querySelector<HTMLStyleElement>('style#dia-theme') ??
    doc.querySelector<HTMLStyleElement>('head style, body style')
  const themeStyle = document.createElement('style')
  themeStyle.id = 'dia-theme'
  themeStyle.textContent = scopeToHost(themeSrc?.textContent ?? defaultThemeCss())
  root.appendChild(themeStyle)

  // any further style blocks ride along, scoped
  for (const st of doc.querySelectorAll<HTMLStyleElement>('style')) {
    if (st === themeSrc) continue
    const extra = document.createElement('style')
    extra.textContent = scopeToHost(st.textContent ?? '')
    root.appendChild(extra)
  }

  // base slide layout guarantees inside the editor
  const editorBase = document.createElement('style')
  editorBase.id = 'dia-editor-base'
  editorBase.textContent = `
    :host { display: block; }
    section.dia-slide { position: relative; overflow: hidden; }
  `
  root.appendChild(editorBase)

  // slides: section.dia-slide, else all top-level <section>
  let slides = [...doc.querySelectorAll<HTMLElement>('section.dia-slide')]
  if (slides.length === 0) slides = [...doc.querySelectorAll<HTMLElement>('body > section')]
  for (const s of slides) {
    s.classList.add('dia-slide')
    root.appendChild(document.adoptNode(s))
  }

  // session ids
  for (const el of root.querySelectorAll<HTMLElement>('section.dia-slide, section.dia-slide *')) {
    if (!el.hasAttribute('data-dia-id')) el.setAttribute('data-dia-id', freshId())
  }

  return {
    root,
    themeStyle,
    headExtras,
    title: doc.title || fileName,
    fileName,
    version: doc.documentElement.getAttribute('data-dia-version') ?? '0',
  }
}

/** deck CSS is written against :root/body; inside a shadow root that is :host */
export function scopeToHost(css: string): string {
  return css
    .replaceAll(':root', ':host')
    .replace(/(^|})\s*body\b/g, '$1 :host')
    .replace(/(^|})\s*html\b/g, '$1 :host')
}

export function unscopeFromHost(css: string): string {
  return css.replaceAll(':host', ':root')
}

export function defaultThemeCss(): string {
  return `:host {
  --dia-paper: #fbfaf6;
  --dia-ink: #17242b;
  --dia-ink-soft: #3d4a52;
  --dia-accent: #b4552d;
  --dia-rule: #d9d4c8;
  --dia-face-display: Georgia, "Times New Roman", serif;
  --dia-face-body: Georgia, "Times New Roman", serif;
  --dia-face-label: ui-monospace, "SF Mono", Menlo, monospace;
  --dia-scale-1: 12px;
  --dia-scale-2: 14px;
  --dia-scale-3: 18px;
  --dia-scale-4: 22px;
  --dia-scale-5: 30px;
  --dia-scale-6: 38px;
  --dia-scale-7: 48px;
  --dia-gap: 24px;
  --dia-pad: 48px;
}
section.dia-slide {
  aspect-ratio: 16 / 9;
  background: var(--dia-paper);
  color: var(--dia-ink);
  padding: var(--dia-pad);
  font-family: var(--dia-face-body);
}
.dia-kicker { font-family: var(--dia-face-label); font-size: var(--dia-scale-1);
  letter-spacing: .14em; text-transform: uppercase; color: var(--dia-accent); }
.dia-title { font-family: var(--dia-face-display); font-size: var(--dia-scale-5);
  line-height: 1.14; font-weight: 700; margin: 0; }
.dia-body { font-size: var(--dia-scale-2); line-height: 1.55; color: var(--dia-ink-soft); }
.dia-caption { font-family: var(--dia-face-label); font-size: var(--dia-scale-1);
  color: var(--dia-ink-soft); }
.dia-columns { display: grid; grid-template-columns: 1fr 1fr; gap: var(--dia-gap); }
.dia-stack { display: flex; flex-direction: column; gap: calc(var(--dia-gap) / 2); }
`
}
