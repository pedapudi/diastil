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

  // collect head extras we must not lose (meta, links other than our own);
  // charset + viewport are the serializer's own frame — keeping them here
  // would duplicate them on every save and break round-trip stability
  const headExtras = [...doc.head.children]
    .filter((el) => !(el instanceof HTMLTitleElement))
    .filter((el) => !(el instanceof HTMLStyleElement))
    // executable scripts are dropped; the inert text/x-dia-original data
    // block (the import's embedded reference originals) must survive saves
    .filter((el) => !(el instanceof HTMLScriptElement) || el.getAttribute('type') === 'text/x-dia-original')
    .filter((el) => !el.matches('meta[charset], meta[name="viewport"]'))
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
  container-type: inline-size; /* cqw-sized type scales with the slide */
  position: relative; /* slides anchor absolutely-positioned decorations */
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
.dia-figure { align-self: center; }
.dia-scene { width: 100%; }
.dia-scene .dia-node-shape { fill: var(--dia-node-fill, var(--dia-paper)); stroke: var(--dia-node-stroke, var(--dia-ink)); stroke-width: var(--dia-node-stroke-w, 1.3); }
.dia-scene .dia-node-label { font: 12px var(--dia-face-body); fill: var(--dia-node-ink, var(--dia-ink)); }
.dia-scene .dia-edge-path { stroke: var(--dia-edge-stroke, var(--dia-ink)); stroke-width: var(--dia-edge-w, 1.2); fill: none; color: var(--dia-edge-stroke, var(--dia-ink)); }
.dia-scene .dia-edge-label { font: 10px var(--dia-face-label); fill: var(--dia-edge-ink, var(--dia-ink-soft)); }
.dia-scene [data-dia-emphasis] .dia-node-shape { stroke: var(--dia-accent); stroke-width: 2; }
.dia-draw { fill: none; stroke: var(--dia-ink); stroke-linecap: round; stroke-linejoin: round; }
`
}
