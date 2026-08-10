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
const CHART_KINDS = new Set(['bar', 'line', 'scatter'])
/** data-values grammar: label:number entries split on , or ; */
const CHART_VALUES = /^\s*[^:;,]+:\s*-?\d+(?:\.\d+)?\s*([,;]\s*[^:;,]+:\s*-?\d+(?:\.\d+)?\s*)*$/
const ANCHOR_SIDES = new Set(['N', 'S', 'E', 'W', 'auto'])

/** persisted dialect data-dia-* vocabulary (profile §7) */
const DIA_ATTRS = new Set([
  'data-dia-version', 'data-dia-node', 'data-dia-edge', 'data-dia-step',
  'data-dia-step-until', // element EXITS when this step arrives
  'data-dia-spotlight', // container: shown steps recede behind the current
  'data-dia-part', // talk section name, on a slide
  'data-dia-auto', // runtime-owned furniture; value 'page' = "N / N"
  'data-dia-emphasis', 'data-dia-island', 'data-dia-transition',
  'data-dia-tex', // LaTeX source of a .dia-math element; content is MathML
])
/** session-only attrs the serializer must strip (error in a saved doc) */
const EDITOR_ONLY_ATTRS = new Set([
  'data-dia-id', 'data-dia-selected', 'data-dia-current', 'data-dia-step-shown',
])

/** persisted document-profile attributes beyond the deck set (DOC-PROFILE §3) */
export const DOC_ATTRS = new Set([
  'data-dia-doc-version',
  'data-dia-float', // figure|table — a float's kind
  'data-dia-label', // \label key, on floats/sections/math (and its dia-label span form)
  'data-dia-env', // source environment name, on math blocks and wrappers
  'data-dia-ref', 'data-dia-ref-cmd', // \ref target key + command variant
  'data-dia-ref-from', 'data-dia-ref-to', // \crefrange's two ends — a RANGE, never a key list
  'data-dia-cite', 'data-dia-cite-opt', 'data-dia-cite-pre', 'data-dia-cite-cmd', // \cite keys + post/pre notes + command variant
  'data-dia-graphic-path', // pdf/eps graphic slot path (browsers cannot <img> those)
  'data-dia-graphic-opts', // \includegraphics options, carried verbatim
  'data-dia-colspec', // tabular column spec, carried verbatim
  'data-dia-expand', // display-only expansion of a text-macro island (CSS ::after)
  'data-dia-rule', // tr: rule command(s) (\toprule…, a \cmidrule(lr){…} chain) before this row, verbatim
  'data-dia-trailing-rule', // table: rule command(s) after the last row's \\, verbatim
  'data-dia-colspan-spec', // td: a \multicolumn cell's own {spec} argument, verbatim
  'data-dia-rowspan-width', // td: a \multirow cell's own {width} argument, verbatim
])
const DOC_FLOATS = new Set(['figure', 'table'])
const THREAD_STATUSES = new Set(['open', 'resolved', 'orphaned'])

/** Validate serialized dialect HTML (a saved document). */
export function validateDeckHtml(html: string): ProfileReport {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return validateDocument(doc)
}

/** Validate a serialized LaTeX-backed document artifact (DOC-PROFILE.md). */
export function validateDocHtml(html: string): ProfileReport {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const findings: ProfileFinding[] = []
  const add = (level: FindingLevel, rule: string, locator: string, message: string) =>
    findings.push({ level, rule, locator, message })

  /* ---- frame ---- */
  const version = doc.documentElement.getAttribute('data-dia-doc-version')
  if (version === null)
    add('error', 'doc/version', '', 'missing data-dia-doc-version on <html>')
  if (doc.documentElement.hasAttribute('data-dia-version'))
    add('error', 'doc/version-exclusive', '', 'a file is a deck or a document, never both — data-dia-version and data-dia-doc-version are mutually exclusive')

  const themes = doc.querySelectorAll('style#dia-theme')
  if (themes.length !== 1)
    add('error', 'frame/theme', '', themes.length === 0
      ? 'missing <style id="dia-theme">'
      : `${themes.length} theme blocks — exactly one expected`)

  const articles = doc.querySelectorAll('article.dia-doc')
  if (articles.length !== 1)
    add('error', 'doc/root', '', articles.length === 0
      ? 'no <article class="dia-doc"> found'
      : `${articles.length} document roots — exactly one expected`)

  for (const child of [...doc.body.children]) {
    const isArticle = child.matches('article.dia-doc')
    const isStyle = child instanceof HTMLStyleElement
    const isRuntime = child.matches('script#dia-doc-runtime')
    if (!isArticle && !isStyle && !isRuntime)
      add('error', 'doc/stray-content', pathOf(child),
        `unexpected <${child.tagName.toLowerCase()}> at body top level`)
  }

  /* ---- source block ---- */
  const sources = doc.querySelectorAll('script#dia-source')
  if (sources.length !== 1) {
    add('error', 'doc/source', '', sources.length === 0
      ? 'missing <script id="dia-source"> — the LaTeX truth'
      : `${sources.length} source blocks — exactly one expected`)
  } else {
    if (sources[0].getAttribute('type') !== 'application/json')
      add('error', 'doc/source', '', 'script#dia-source must have type="application/json"')
    try {
      const j = JSON.parse(sources[0].textContent ?? '') as { version?: unknown; tex?: unknown }
      if (typeof j.tex !== 'string' || j.tex.length === 0)
        add('error', 'doc/source', '', '#dia-source carries no LaTeX text')
      if (j.version !== 1)
        add('error', 'doc/source', '', `#dia-source version ${String(j.version)} — expected 1`)
    } catch {
      add('error', 'doc/source', '', '#dia-source is not valid JSON')
    }
  }

  /* ---- comments block ---- */
  const comments = doc.querySelectorAll('script#dia-comments')
  if (comments.length > 1)
    add('error', 'doc/comments', '', `${comments.length} comments blocks — at most one expected`)
  else if (comments.length === 1) {
    try {
      const j = JSON.parse(comments[0].textContent ?? '') as { threads?: unknown }
      if (!Array.isArray(j.threads)) {
        add('error', 'doc/comments', '', '#dia-comments has no threads array')
      } else {
        j.threads.forEach((raw, i) => {
          const where = `threads[${i}]`
          if (typeof raw !== 'object' || raw === null) {
            add('error', 'doc/comments', where, 'thread is not an object')
            return
          }
          const t = raw as Record<string, unknown>
          if (typeof t.id !== 'string' || t.id === '')
            add('error', 'doc/comments', where, 'thread has no id')
          if (!THREAD_STATUSES.has(t.status as string))
            add('error', 'doc/comments', where, `status ${JSON.stringify(t.status)} is not open · resolved · orphaned`)
          const a = t.anchor as Record<string, unknown> | undefined
          if (typeof a !== 'object' || a === null)
            add('error', 'doc/comments', where, 'thread has no anchor')
          else if (typeof a.quote !== 'string' || a.quote === '')
            add('error', 'doc/comments', where, 'anchor carries no quote — nothing to re-anchor to')
          if (!Array.isArray(t.notes))
            add('error', 'doc/comments', where, 'thread has no notes array')
        })
      }
    } catch {
      add('error', 'doc/comments', '', '#dia-comments is not valid JSON')
    }
  }

  /* ---- content ---- */
  const article = articles[0] ?? null
  const labels = new Set<string>()
  if (article) {
    for (const el of article.querySelectorAll('[data-dia-label]'))
      labels.add(el.getAttribute('data-dia-label') ?? '')

    for (const el of [article, ...article.querySelectorAll<Element>('*')]) {
      if (inIsland(el, article)) continue

      if (el instanceof HTMLScriptElement)
        add('error', 'content/script', pathOf(el), 'script in a dialect region — behavior must be data-dia-* attributes')
      if (/^(iframe|object|embed)$/i.test(el.tagName))
        add('error', 'content/embed', pathOf(el), `<${el.tagName.toLowerCase()}> outside an island`)

      for (const attr of el.attributes) {
        if (/^on[a-z]/.test(attr.name))
          add('error', 'content/event-handler', pathOf(el), `inline handler ${attr.name}`)
        else if (EDITOR_ONLY_ATTRS.has(attr.name) || attr.name === 'contenteditable')
          add('error', 'content/editor-artifact', pathOf(el), `editor session attribute ${attr.name} leaked into the document`)
        else if (attr.name.startsWith('data-dia-') && !DIA_ATTRS.has(attr.name) && !DOC_ATTRS.has(attr.name))
          add('error', 'content/unknown-dia-attr', pathOf(el), `unknown dialect attribute ${attr.name}`)
      }

      const float = el.getAttribute('data-dia-float')
      if (float !== null && !DOC_FLOATS.has(float))
        add('error', 'doc/float', pathOf(el), `data-dia-float="${float}" is not figure · table`)

      const ref = el.getAttribute('data-dia-ref')
      if (ref !== null && !labels.has(ref))
        add('advisory', 'doc/ref-known', pathOf(el), `\\ref{${ref}} has no matching label in the document`)

      const style = el.getAttribute('style')
      if (style && /(#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\()/i.test(style))
        add('advisory', 'content/inline-color', pathOf(el), 'inline literal color — prefer var(--dia-…) tokens')
    }
  }

  return { ok: !findings.some((f) => f.level === 'error'), findings, slideCount: 0, version }
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
  if (themes.length === 1) {
    for (const m of (themes[0].textContent ?? '').matchAll(/border-left\s*:\s*([^;}]+)/gi)) {
      if (isLeftRail(m[1]))
        add('advisory', 'style/left-rail', 'style#dia-theme',
          `theme rule draws a left-rail highlight (border-left: ${m[1].trim()}) — the house language has no accent stripes; use a full hairline panel with an accent label (docs/HOUSE-STYLE.md)`)
    }
  }

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

      const until = el.getAttribute('data-dia-step-until')
      if (until !== null && !/^[1-9]\d*$/.test(until))
        add('error', 'behavior/step-until', pathOf(el), `data-dia-step-until="${until}" is not a positive integer`)

      const auto = el.getAttribute('data-dia-auto')
      if (auto !== null && auto !== 'page')
        add('error', 'behavior/auto', pathOf(el), `data-dia-auto="${auto}" — only "page" is defined`)

      if (el.hasAttribute('data-dia-part') && !el.matches('section.dia-slide'))
        add('error', 'behavior/part', pathOf(el), 'data-dia-part belongs on a slide section')

      const transition = el.getAttribute('data-dia-transition')
      if (transition !== null && !/^(none|fade|slide|rise)$/.test(transition))
        add('error', 'behavior/transition', pathOf(el), `data-dia-transition="${transition}" is not one of none · fade · slide · rise`)

      const style = el.getAttribute('style')
      if (style && /(#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\()/i.test(style))
        add('advisory', 'content/inline-color', pathOf(el), 'inline literal color — prefer var(--dia-…) tokens')

      const bl = style ? /border-left\s*:\s*([^;]+)/i.exec(style) : null
      if (bl && isLeftRail(bl[1]))
        add('advisory', 'style/left-rail', pathOf(el),
          'left-rail highlight — the house language has no border-left stripes; use a full hairline panel with an accent label (docs/HOUSE-STYLE.md)')
    }

    /* ---- charts ---- */
    for (const chart of slide.querySelectorAll<SVGSVGElement>('svg.dia-chart')) {
      if (inIsland(chart, slide)) continue
      const kind = chart.getAttribute('data-chart')
      if (kind === null || !CHART_KINDS.has(kind))
        add('error', 'chart/type', pathOf(chart),
          kind === null ? 'svg.dia-chart is missing data-chart' : `data-chart="${kind}" is not bar · line · scatter`)
      const vals = chart.getAttribute('data-values')
      if (vals === null || !CHART_VALUES.test(vals))
        add('error', 'chart/values', pathOf(chart),
          vals === null ? 'svg.dia-chart is missing data-values' : `data-values="${vals}" is not "label:number, …"`)
      const max = chart.getAttribute('data-max')
      if (max !== null && !(Number.isFinite(Number(max)) && Number(max) > 0))
        add('error', 'chart/max', pathOf(chart), `data-max="${max}" is not a positive number`)
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
        const via = edge.getAttribute('data-via')
        if (via !== null && !/^\s*-?[\d.]+\s*,\s*-?[\d.]+\s*$/.test(via))
          add('error', 'scene/edge-via', pathOf(edge), `data-via="${via}" is not an "x,y" waypoint`)
      }
    }
  }

  return { ok: !findings.some((f) => f.level === 'error'), findings, slideCount: slides.length, version }
}

/** a border-left value that reads as a rail HIGHLIGHT: accent-colored at
 * any width, or ≥2px in any color. A thin var(--dia-rule) divider (the
 * research-preview pill idiom) passes. */
function isLeftRail(value: string): boolean {
  const v = value.toLowerCase()
  if (v.includes('var(--dia-accent')) return true
  const m = /(\d+(?:\.\d+)?)px/.exec(v)
  return m !== null && parseFloat(m[1]) >= 2
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
