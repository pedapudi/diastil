/* Dialect profile validator — profile/PROFILE.md as executable rules.
 * A deck either validates, or the findings say exactly which regions are
 * out-of-profile and why. Pure DOM-in / data-out; no editor state. */

export type FindingLevel = 'error' | 'advisory'

export interface ProfileFinding {
  level: FindingLevel
  /** rule id from profile/PROFILE.md, e.g. "scene/edge-endpoint" */
  rule: string
  /** css-path-ish locator of the offending node ('' for document-level) */
  locator: string
  message: string
}

export interface ProfileReport {
  /** true when no error-level findings (advisories allowed) */
  ok: boolean
  findings: ProfileFinding[]
  slideCount: number
  version: string | null
}

const NODE_SHAPES = new Set([
  'rect', 'rounded', 'pill', 'ellipse', 'diamond',
  'cylinder', 'hex', 'parallelogram', 'triangle', 'cloud', 'note', 'path',
])
/** loose SVG path-data check for data-path (shape "path"): must start with a
 * moveto and contain only path commands/numbers */
const PATH_DATA = /^[Mm][0-9MmLlHhVvCcSsQqTtAaZz\s,.+eE-]+$/
const EDGE_ROUTES = new Set(['straight', 'ortho', 'curve'])
const ANCHOR_SIDES = new Set(['N', 'S', 'E', 'W', 'auto'])

/** persisted dialect data-dia-* vocabulary (profile §7) */
const DIA_ATTRS = new Set([
  'data-dia-version', 'data-dia-node', 'data-dia-edge', 'data-dia-step',
  'data-dia-emphasis', 'data-dia-island',
])
/** session-only attrs the serializer must strip (error in a saved doc) */
const EDITOR_ONLY_ATTRS = new Set([
  'data-dia-id', 'data-dia-selected', 'data-dia-current', 'data-dia-step-shown',
])

/** Validate serialized dialect HTML (a saved document). */
export function validateDeckHtml(html: string): ProfileReport {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return validateDocument(doc)
}

export function validateDocument(doc: Document): ProfileReport {
  const findings: ProfileFinding[] = []
  const add = (level: FindingLevel, rule: string, locator: string, message: string) =>
    findings.push({ level, rule, locator, message })

  /* ---- frame ---- */
  const version = doc.documentElement.getAttribute('data-dia-version')
  if (version === null)
    add('error', 'frame/version', '', 'missing data-dia-version on <html>')

  const themes = doc.querySelectorAll('style#dia-theme')
  if (themes.length !== 1)
    add('error', 'frame/theme', '', themes.length === 0
      ? 'missing <style id="dia-theme">'
      : `${themes.length} theme blocks — exactly one expected`)
  else if (!/--dia-[a-z-]+\s*:/.test(themes[0].textContent ?? ''))
    add('advisory', 'frame/theme-tokens', 'style#dia-theme',
      'theme defines no --dia-* tokens; token-level editing is unavailable')

  if (!doc.querySelector('script#dia-runtime'))
    add('advisory', 'frame/runtime', '', 'no embedded runtime — the deck will not present standalone')

  const slides = [...doc.querySelectorAll<HTMLElement>('section.dia-slide')]
  if (slides.length === 0)
    add('error', 'frame/slides', '', 'no <section class="dia-slide"> found')

  for (const child of [...doc.body.children]) {
    const isSlide = child instanceof HTMLElement && child.matches('section.dia-slide')
    const isRuntime = child.matches('script#dia-runtime')
    const isStyle = child instanceof HTMLStyleElement
    if (!isSlide && !isRuntime && !isStyle)
      add('error', 'frame/stray-content', pathOf(child),
        `unexpected <${child.tagName.toLowerCase()}> at body top level`)
  }

  /* ---- slide content ---- */
  for (const slide of slides) {
    for (const el of [slide, ...slide.querySelectorAll<Element>('*')]) {
      if (inIsland(el, slide)) continue

      if (el instanceof HTMLScriptElement)
        add('error', 'content/script', pathOf(el), 'script in a dialect region — behavior must be data-dia-* attributes')
      if (/^(iframe|object|embed)$/i.test(el.tagName))
        add('error', 'content/embed', pathOf(el), `<${el.tagName.toLowerCase()}> outside an island`)

      for (const attr of el.attributes) {
        if (/^on[a-z]/.test(attr.name))
          add('error', 'content/event-handler', pathOf(el), `inline handler ${attr.name}`)
        else if (EDITOR_ONLY_ATTRS.has(attr.name) || attr.name === 'contenteditable')
          add('error', 'content/editor-artifact', pathOf(el), `editor session attribute ${attr.name} leaked into the document`)
        else if (attr.name.startsWith('data-dia-') && !DIA_ATTRS.has(attr.name))
          add('error', 'content/unknown-dia-attr', pathOf(el), `unknown dialect attribute ${attr.name}`)
      }

      const step = el.getAttribute('data-dia-step')
      if (step !== null && !/^[1-9]\d*$/.test(step))
        add('error', 'behavior/step', pathOf(el), `data-dia-step="${step}" is not a positive integer`)

      const style = el.getAttribute('style')
      if (style && /(#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\()/i.test(style))
        add('advisory', 'content/inline-color', pathOf(el), 'inline literal color — prefer var(--dia-…) tokens')
    }

    /* ---- scenes ---- */
    for (const scene of slide.querySelectorAll<SVGSVGElement>('svg.dia-scene')) {
      if (inIsland(scene, slide)) continue
      const ids = new Set<string>()
      for (const node of scene.querySelectorAll<SVGGElement>('[data-dia-node]')) {
        const id = node.getAttribute('data-dia-node') ?? ''
        if (ids.has(id))
          add('error', 'scene/node-id-duplicate', pathOf(node), `duplicate node id "${id}"`)
        ids.add(id)
        for (const g of ['data-x', 'data-y', 'data-w', 'data-h']) {
          const v = node.getAttribute(g)
          if (v !== null && !Number.isFinite(Number(v)))
            add('error', 'scene/node-geometry', pathOf(node), `${g}="${v}" is not a finite number`)
        }
        const rotate = node.getAttribute('data-rotate')
        if (rotate !== null && !Number.isFinite(Number(rotate)))
          add('error', 'scene/node-rotate', pathOf(node), `data-rotate="${rotate}" is not a finite number`)
        const shape = node.getAttribute('data-shape')
        if (shape !== null && !NODE_SHAPES.has(shape))
          add('error', 'scene/node-shape', pathOf(node), `unknown shape "${shape}"`)
        if (shape === 'path') {
          const d = node.getAttribute('data-path')
          if (!d || !PATH_DATA.test(d.trim()))
            add('error', 'scene/node-path', pathOf(node),
              d ? 'data-path is not SVG path data' : 'shape "path" requires data-path')
        }
      }
      for (const edge of scene.querySelectorAll<SVGGElement>('[data-dia-edge]')) {
        const spec = edge.getAttribute('data-dia-edge') ?? ''
        const m = spec.match(/^(.+?)->(.+)$/)
        if (!m) {
          add('error', 'scene/edge-format', pathOf(edge), `data-dia-edge="${spec}" is not "a->b"`)
        } else {
          for (const end of [m[1], m[2]]) {
            if (!ids.has(end))
              add('error', 'scene/edge-endpoint', pathOf(edge), `edge endpoint "${end}" names no node in this scene`)
          }
        }
        const route = edge.getAttribute('data-route')
        if (route !== null && !EDGE_ROUTES.has(route))
          add('error', 'scene/edge-route', pathOf(edge), `unknown route "${route}"`)
        const anchors = edge.getAttribute('data-anchors')
        if (anchors !== null && !anchors.split(',').every((s) => ANCHOR_SIDES.has(s.trim())))
          add('error', 'scene/edge-anchors', pathOf(edge), `data-anchors="${anchors}" — sides are N,S,E,W,auto`)
      }
    }
  }

  return { ok: !findings.some((f) => f.level === 'error'), findings, slideCount: slides.length, version }
}

/** islands are exempt from content rules; the island element itself is dialect */
function inIsland(el: Element, stopAt: Element): boolean {
  let cur = el.parentElement
  while (cur && cur !== stopAt) {
    if (cur.hasAttribute('data-dia-island')) return true
    cur = cur.parentElement
  }
  return false
}

/** css-path-ish locator, rooted at the slide (or body for frame findings) */
function pathOf(el: Element): string {
  const parts: string[] = []
  let cur: Element | null = el
  while (cur && !(cur instanceof HTMLBodyElement)) {
    const tag = cur.tagName.toLowerCase()
    if (tag === 'section' && cur.classList.contains('dia-slide')) {
      const siblings = cur.parentElement ? [...cur.parentElement.children].filter((c) => c.matches('section.dia-slide')) : [cur]
      parts.unshift(`section.dia-slide:nth-of-type(${siblings.indexOf(cur) + 1})`)
      break
    }
    const parent: Element | null = cur.parentElement
    const idx = parent ? [...parent.children].indexOf(cur) + 1 : 1
    parts.unshift(`${tag}:nth-child(${idx})`)
    cur = parent
  }
  return parts.join(' > ')
}
