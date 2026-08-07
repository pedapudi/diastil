/* LaTeX block tree → dialect document DOM.
 *
 * DETERMINISTIC: the same tree renders to byte-identical markup, which is
 * what makes serializeDoc(loadDoc(x)) === x hold. Math reuses the deck
 * convention exactly — TeX truth on data-dia-tex, temml MathML as content,
 * zero runtime dependency in the saved file. Constructs the tree marked as
 * islands render their raw source in mono, so the document stays complete
 * and honest even where structure wasn't understood. */

import temml from 'temml'
import { setsNoType } from './parse'
import type { LxBlock, LxDoc, LxInline, PreambleMeta } from './parse'

export interface RenderedBlock {
  el: HTMLElement
  /** top-level source span, for DocSource binding (session-only) */
  span: { start: number; end: number }
}

/** session memo for every rendered block element: its exact source slice
 * and its pristine rendered markup (captured before id stamping). emit.ts
 * uses it to re-emit UNEDITED blocks byte-identically — the html snapshot
 * is the tamper seal: while cleanClone(el).outerHTML still equals it, the
 * slice is still the truth. */
export interface BlockMemo { slice: string; html: string }
export const blockMemo = new WeakMap<HTMLElement, BlockMemo>()

/** one original tabular cell, in source order, mapped to its rendered <td>
 * (or null for a \multirow-covered placeholder, which never gets a <td> —
 * see the tabular render case). start/end are offsets into the table's OWN
 * blockMemo slice, so emit.ts can splice an edited cell back in without
 * disturbing anything else in the row: rules, alignment specs, whitespace,
 * every other cell. pristineHtml mirrors blockMemo's tamper seal, at cell
 * grain, captured before session id-stamping so it stays comparable. */
export interface TabCellSlot { start: number; end: number; td: HTMLElement | null; pristineHtml: string | null }
export const tabularCellMemo = new WeakMap<HTMLElement, TabCellSlot[]>()

/** a figcaption's pristine rendered markup, captured the same way as
 * blockMemo's html — before session id-stamping. A caption edit (setText,
 * setInlineHtml, …) blows away any inline nodes the caption's prose had no
 * business owning alone, e.g. a \label rendered as span.dia-label; emit.ts
 * uses this to tell "genuinely edited" apart from "float changed elsewhere"
 * (a sibling table cell), so an untouched caption's SOURCE bytes — prose,
 * \label, comments — are never disturbed just because the float was. */
export const captionMemo = new WeakMap<HTMLElement, string>()

export interface RenderedDoc {
  article: HTMLElement
  blocks: RenderedBlock[]
  meta: PreambleMeta
}

/** render a parsed document into a fresh article.dia-doc */
export function renderDoc(doc: LxDoc): RenderedDoc {
  const article = document.createElement('article')
  article.className = 'dia-doc'
  let meta: PreambleMeta = {}
  const blocks: RenderedBlock[] = []

  for (const b of doc.blocks) {
    if (b.kind === 'preamble') {
      meta = b.meta
      const header = renderHeader(b.meta)
      if (header) article.appendChild(header)
      continue
    }
    if (b.kind === 'postamble') continue
    const el = renderBlock(b, doc.src)
    article.appendChild(el)
    blocks.push({ el, span: { start: b.span.start, end: b.span.end } })
  }
  return { article, blocks, meta }
}

/** derived document header from preamble metadata — not bound to a span;
 * editing it is a preamble edit (source view in v1) */
function renderHeader(meta: PreambleMeta): HTMLElement | null {
  if (!meta.title) return null
  const header = document.createElement('header')
  header.className = 'dia-doc-header'
  const h1 = document.createElement('h1')
  h1.className = 'dia-title'
  h1.append(...renderTexFragmentText(meta.title))
  header.appendChild(h1)
  if (meta.author) {
    const by = document.createElement('div')
    by.className = 'dia-doc-authors'
    by.append(...renderTexFragmentText(meta.author))
    header.appendChild(by)
  }
  return header
}

/** preamble meta strings carry author-block furniture (\and, \thanks,
 * \footnotemark, spacing) — strip what is provably furniture, keep unknown
 * macros visible (no macro expansion means hiding them would lose names) */
function renderTexFragmentText(tex: string): Node[] {
  // escapes first, or the comment strip eats a literal \% and the brace
  // strip eats a literal \{ — parked as BEL+code and restored at the end
  let text = tex.replace(/\\([%&_#${}])/g, (_, c: string) => `${c.charCodeAt(0)};`)
  text = text.replace(/%[^\n]*/g, ' ')
  text = stripBalanced(text, ['thanks', 'footnote'])
  const clean = text
    .replace(/\\href\{[^}]*\}/g, '') // keep the display argument
    .replace(/\\(?:url|texttt|textbf|textit|textsc|textsf|textrm|textup|textmd|textnormal|emph|mbox|underline)\b\s*/g, '')
    .replace(/\\(?:bfseries|itshape|scshape|ttfamily|sffamily|rmfamily|normalfont|Large|LARGE|large|huge|Huge|small|footnotesize|normalsize)\b/g, ' ')
    .replace(/\\(and|AND)\b/g, ' · ')
    .replace(/\\\\(\[[^\]]*\])?/g, ' ')
    .replace(/\\footnotemark(\[[^\]]*\])?/g, '')
    .replace(/\\(vspace|hspace)\*?\{[^}]*\}/g, ' ')
    .replace(/\\(vspace|hspace)\*?-?[\d.]+\w*/g, ' ')
    .replace(/\\phantoms?(\{[^}]*\})?/g, ' ')
    .replace(/\\(quad|qquad|smallskip|medskip|bigskip|centering)\b/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/~/g, ' ')
    .replace(/\x07(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim()
  return [document.createTextNode(clean)]
}

/** a block that is \maketitle plus, at most, commands that set no type of
 * their own (\thispagestyle{empty} rides along on real papers) */
function isMaketitleSlice(slice: string): boolean {
  const s = slice.trim()
  return /\\maketitle\b/.test(s) && setsNoType(s.replace(/\\maketitle\b/, ''))
}

/** remove \name{…} with BALANCED braces — \thanks routinely nests \url{} */
function stripBalanced(text: string, names: string[]): string {
  let out = text
  for (const name of names) {
    for (;;) {
      const at = out.indexOf(`\\${name}{`)
      if (at < 0) break
      const open = at + name.length + 1
      let depth = 0
      let end = out.length
      for (let i = open; i < out.length; i++) {
        if (out[i] === '\\') { i++; continue }
        if (out[i] === '{') depth++
        else if (out[i] === '}' && --depth === 0) { end = i + 1; break }
      }
      out = out.slice(0, at) + out.slice(end)
    }
  }
  return out
}

export function renderBlock(b: LxBlock, src: string): HTMLElement {
  const el = renderBlockInner(b, src)
  blockMemo.set(el, { slice: src.slice(b.span.start, b.span.end), html: el.outerHTML })
  return el
}

function renderBlockInner(b: LxBlock, src: string): HTMLElement {
  switch (b.kind) {
    case 'preamble':
    case 'postamble': {
      // never rendered inline — loadDoc handles the header; reaching here
      // is a programming error, keep it visible rather than throwing
      const el = document.createElement('div')
      el.className = 'dia-tex-island'
      el.setAttribute('data-dia-island', 'tex')
      el.appendChild(pre(src.slice(b.span.start, b.span.end)))
      return el
    }
    case 'section': {
      const h = document.createElement(`h${Math.min(b.level + 1, 5)}`)
      h.className = 'dia-sec'
      if (b.label) h.setAttribute('data-dia-label', b.label)
      h.append(...renderInlines(b.inline, src))
      return h
    }
    case 'para': {
      // a paragraph that IS \maketitle maps to the derived header above
      if (isMaketitleSlice(src.slice(b.span.start, b.span.end))) {
        const marker = document.createElement('div')
        marker.className = 'dia-maketitle'
        return marker
      }
      const p = document.createElement('p')
      p.append(...renderInlines(b.inline, src))
      return p
    }
    case 'abstract': {
      const sec = document.createElement('section')
      sec.className = 'dia-abstract'
      for (const child of b.body) sec.appendChild(renderBlock(child, src))
      return sec
    }
    case 'wrapper': {
      const div = document.createElement('div')
      div.className = `dia-wrap dia-wrap-${b.env}`
      div.setAttribute('data-dia-env', b.env)
      for (const child of b.body) div.appendChild(renderBlock(child, src))
      return div
    }
    case 'list': {
      if (b.env === 'description') {
        const dl = document.createElement('dl')
        for (const item of b.items) {
          const dt = document.createElement('dt')
          if (item.term) dt.append(...renderInlines(item.term, src))
          const dd = document.createElement('dd')
          appendItemBlocks(dd, item.blocks, src)
          dl.append(dt, dd)
        }
        return dl
      }
      const list = document.createElement(b.env === 'enumerate' ? 'ol' : 'ul')
      if (b.srcEnv) list.setAttribute('data-dia-env', b.srcEnv)
      for (const item of b.items) {
        const li = document.createElement('li')
        appendItemBlocks(li, item.blocks, src)
        list.appendChild(li)
      }
      return list
    }
    case 'float': {
      const fig = document.createElement('figure')
      fig.className = 'dia-figure'
      fig.setAttribute('data-dia-float', b.env)
      if (b.label) fig.setAttribute('data-dia-label', b.label)
      for (const g of b.graphics) {
        // browsers cannot show pdf/eps in <img>; a labeled slot is honest
        // where a broken-image icon is just noise — the PDF export still
        // resolves the real graphic through the compile
        if (/\.(pdf|eps|ps)$/i.test(g.path.trim())) {
          const slot = document.createElement('div')
          slot.className = 'dia-graphic dia-graphic-slot'
          slot.setAttribute('data-dia-graphic-path', g.path)
          if (g.opts) slot.setAttribute('data-dia-graphic-opts', g.opts)
          slot.textContent = g.path
          fig.appendChild(slot)
          continue
        }
        const img = document.createElement('img')
        img.className = 'dia-graphic'
        img.setAttribute('src', g.path)
        img.setAttribute('alt', g.path)
        if (g.opts) img.setAttribute('data-dia-graphic-opts', g.opts)
        fig.appendChild(img)
      }
      for (const child of b.body) fig.appendChild(renderBlock(child, src))
      if (b.caption) {
        const cap = document.createElement('figcaption')
        cap.append(...renderInlines(b.caption, src))
        captionMemo.set(cap, cap.outerHTML)
        fig.appendChild(cap)
      }
      return fig
    }
    case 'tabular': {
      const table = document.createElement('table')
      table.setAttribute('data-dia-colspec', b.colspec)
      if (b.trailingRule) table.setAttribute('data-dia-trailing-rule', b.trailingRule)
      const tbody = document.createElement('tbody')
      // a \multirow covers grid positions in the rows below it; multirow's
      // convention leaves those source cells EMPTY, and HTML wants them
      // absent — a covered position consumes its empty placeholder cell
      const coveredUntil = new Map<number, number>() // column -> last covered row
      const slots: TabCellSlot[] = []
      b.rows.forEach((row, r) => {
        const tr = document.createElement('tr')
        if (row.rule) tr.setAttribute('data-dia-rule', row.rule)
        let col = 0
        for (const cell of row.cells) {
          const slotSpan = { start: cell.contentSpan.start - b.span.start, end: cell.contentSpan.end - b.span.start }
          const empty = cell.inline.length === 0 && !cell.colspan && !cell.rowspan
          if (empty && (coveredUntil.get(col) ?? -1) >= r) {
            slots.push({ ...slotSpan, td: null, pristineHtml: null })
            col++
            continue
          }
          while ((coveredUntil.get(col) ?? -1) >= r) col++
          const td = document.createElement('td')
          if (cell.colspan) {
            td.setAttribute('colspan', String(cell.colspan))
            if (cell.colspanSpec !== undefined) td.setAttribute('data-dia-colspan-spec', cell.colspanSpec)
          }
          if (cell.rowspan) {
            td.setAttribute('rowspan', String(cell.rowspan))
            if (cell.rowspanWidth !== undefined) td.setAttribute('data-dia-rowspan-width', cell.rowspanWidth)
            for (let c = 0; c < (cell.colspan ?? 1); c++) coveredUntil.set(col + c, r + cell.rowspan - 1)
          }
          td.append(...renderInlines(cell.inline, src))
          tr.appendChild(td)
          slots.push({ ...slotSpan, td, pristineHtml: td.outerHTML })
          col += cell.colspan ?? 1
        }
        tbody.appendChild(tr)
      })
      table.appendChild(tbody)
      tabularCellMemo.set(table, slots)
      return table
    }
    case 'math':
      return renderMathBlock(b.tex, b.env, b.label)
    case 'verbatim': {
      const el = pre(b.text)
      el.className = 'dia-verbatim'
      if (b.env) el.setAttribute('data-dia-env', b.env)
      return el
    }
    case 'island': {
      const raw = src.slice(b.span.start, b.span.end)
      // \maketitle IS the derived header the renderer already emitted —
      // mapping it to an empty marker is truthful, not hiding
      if (isMaketitleSlice(raw)) {
        const el = document.createElement('div')
        el.className = 'dia-maketitle'
        return el
      }
      const el = document.createElement('div')
      el.className = 'dia-tex-island'
      if (setsNoType(raw)) el.classList.add('dia-tex-quiet')
      el.setAttribute('data-dia-island', 'tex')
      el.appendChild(pre(raw))
      return el
    }
  }
}

/** a list item with one paragraph renders inline; anything richer nests */
function appendItemBlocks(host: HTMLElement, blocks: LxBlock[], src: string): void {
  if (blocks.length === 1 && blocks[0].kind === 'para') {
    host.append(...renderInlines(blocks[0].inline, src))
    return
  }
  for (const b of blocks) host.appendChild(renderBlock(b, src))
}

/* ---------- math ---------- */

/** environments temml can take verbatim inside display math */
const TEMML_NATIVE_ENVS = new Set(['aligned', 'gathered', 'cases', 'split', 'array', 'matrix'])

export function renderMathBlock(tex: string, env: string | undefined, label: string | undefined): HTMLElement {
  const el = document.createElement('div')
  el.className = 'dia-math'
  el.setAttribute('data-dia-tex', tex)
  if (env) el.setAttribute('data-dia-env', env)
  if (label) el.setAttribute('data-dia-label', label)
  const mathml = mathToMathml(tex, env, true)
  if (mathml !== null) {
    el.innerHTML = mathml
    return el
  }
  // unrenderable math is still document content — carry the source in mono
  el.classList.add('dia-math-src')
  el.appendChild(pre(tex))
  return el
}

/** TeX → MathML, adapting environment sources temml can't take top-level;
 * null when it will not render (caller falls back to source) */
export function mathToMathml(tex: string, env: string | undefined, display: boolean): string | null {
  const cleaned = tex.replace(/\\label\{[^}]*\}/g, '').trim()
  const base = env ? env.replace(/\*$/, '') : undefined
  const candidates: string[] = []
  if (!base || base === 'equation' || base === 'displaymath') {
    candidates.push(cleaned)
  } else if (TEMML_NATIVE_ENVS.has(base)) {
    candidates.push(`\\begin{${base}}${cleaned}\\end{${base}}`)
  } else {
    // align/gather/multline/eqnarray → aligned is the faithful-enough shape
    candidates.push(`\\begin{aligned}${cleaned}\\end{aligned}`, cleaned)
  }
  for (const c of candidates) {
    try {
      return temml.renderToString(c, { displayMode: display, throwOnError: true })
    } catch {
      /* try the next shape */
    }
  }
  return null
}

/* ---------- inline ---------- */

export function renderInlines(inlines: LxInline[], src: string): Node[] {
  const out: Node[] = []
  for (const node of inlines) out.push(renderInline(node, src))
  return out
}

const STYLE_TAG: Record<string, string> = { bf: 'strong', it: 'i', em: 'em', tt: 'code', ul: 'u', sc: 'span', sf: 'span' }

function renderInline(node: LxInline, src: string): Node {
  switch (node.kind) {
    case 'text':
      // `~` is a non-breaking space (a bare ~ is never an escape here —
      // `\~` arrives as a cs token, not text); everything else stays as typed
      return document.createTextNode(node.text.replace(/~/g, ' '))
    case 'style': {
      const el = document.createElement(STYLE_TAG[node.cmd] ?? 'span')
      if (node.cmd === 'sc') el.className = 'dia-smallcaps'
      if (node.cmd === 'sf') el.className = 'dia-sans'
      el.append(...renderInlines(node.inner, src))
      return el
    }
    case 'math': {
      const el = document.createElement('span')
      el.className = 'dia-math dia-math-inline'
      el.setAttribute('data-dia-tex', node.tex)
      const mathml = mathToMathml(node.tex, undefined, false)
      if (mathml !== null) el.innerHTML = mathml
      else {
        el.classList.add('dia-math-src')
        el.textContent = node.tex
      }
      return el
    }
    case 'ref': {
      const a = document.createElement('a')
      a.className = 'dia-ref'
      a.setAttribute('data-dia-ref', node.key)
      a.setAttribute('data-dia-ref-cmd', node.cmd)
      // text is DERIVED — refreshDerived resolves numbers; the key is the
      // honest placeholder until then
      a.textContent = node.key
      return a
    }
    case 'cite': {
      const a = document.createElement('a')
      a.className = 'dia-cite'
      a.setAttribute('data-dia-cite', node.keys.join(','))
      // the command variant (citep/citet/parencite…) changes typeset output —
      // it must survive to re-emission
      if (node.cmd !== 'cite') a.setAttribute('data-dia-cite-cmd', node.cmd)
      if (node.pre !== undefined) a.setAttribute('data-dia-cite-pre', node.pre)
      if (node.opt) a.setAttribute('data-dia-cite-opt', node.opt)
      a.textContent = `[${node.keys.join(', ')}]`
      return a
    }
    case 'footnote': {
      const el = document.createElement('span')
      el.className = 'dia-footnote'
      el.append(...renderInlines(node.inner, src))
      return el
    }
    case 'url': {
      const a = document.createElement('a')
      a.className = 'dia-url'
      a.setAttribute('href', node.url)
      if (node.inner) a.append(...renderInlines(node.inner, src))
      else a.textContent = node.url
      return a
    }
    case 'label': {
      const el = document.createElement('span')
      el.className = 'dia-label'
      el.setAttribute('data-dia-label', node.key)
      return el
    }
    case 'break':
      return document.createElement('br')
    case 'verb': {
      const el = document.createElement('code')
      el.className = 'dia-verb'
      el.textContent = node.text
      return el
    }
    case 'island': {
      const el = document.createElement('span')
      el.className = 'dia-tex-island'
      el.setAttribute('data-dia-island', 'tex')
      const raw = src.slice(node.span.start, node.span.end)
      el.textContent = raw
      // reading-surface treatment, byte-exact underneath: emit reads the
      // island's textContent, so the source never changes — only how it
      // shows. \looseness=-1 and friends set no type, so show nothing; a
      // known parameterless text macro shows its expansion via CSS
      // ::after while the raw source hides inside an inner span.
      const bare = /^\\([a-zA-Z]+)\s*(?:\{\})?$/.exec(raw.trim())
      if (setsNoType(raw) || (bare !== null && renderQuiet.has(bare[1]))) {
        el.classList.add('dia-tex-quiet')
      } else {
        const m = bare
        const body = m ? renderMacros.get(m[1]) : undefined
        if (body !== undefined) {
          el.classList.add('dia-tex-macro')
          el.setAttribute('data-dia-expand', body)
          el.textContent = ''
          const src2 = document.createElement('span')
          src2.className = 'dia-tex-src'
          src2.textContent = raw
          el.appendChild(src2)
        }
      }
      return el
    }
  }
}

/** the current document's safe text macros — set at load, consulted only
 * for DISPLAY (data-dia-expand); the island's textContent stays the source */
let renderMacros = new Map<string, string>()
/** macros whose bodies set no type — their bare calls render quiet */
let renderQuiet = new Set<string>()

export function setRenderMacros(
  macros: Record<string, string> | undefined,
  quiet?: string[],
): void {
  renderMacros = new Map(Object.entries(macros ?? {}))
  renderQuiet = new Set(quiet ?? [])
}

function pre(text: string): HTMLPreElement {
  const el = document.createElement('pre')
  el.textContent = text
  return el
}
