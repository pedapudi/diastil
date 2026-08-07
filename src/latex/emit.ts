/* Dialect document DOM → LaTeX, for EDITED blocks only.
 *
 * The prime directive: never rewrite bytes the user did not touch. Every
 * rendered block carries a memo (render.ts blockMemo) of its exact source
 * slice and its pristine markup; while the markup still matches, the slice
 * is re-emitted verbatim. Only genuinely edited constituents reconstruct,
 * and reconstruction is SURGICAL where the source has parts the DOM does
 * not carry (a section's star and short title, a verbatim's option line,
 * a float's placement) — those bytes are preserved from the memo slice and
 * only the edited region inside them is replaced.
 *
 * Contract (tested): emitBlockTex(render(parse(x))) === slice(x) unedited,
 * and for edited blocks the emission re-parses to an equivalent tree. */

import { blockMemo, captionMemo, tabularCellMemo } from './render'
import { setsNoType } from './parse'

const EDITOR_ATTRS = ['data-dia-id', 'contenteditable', 'spellcheck', 'data-dia-selected', 'data-dia-current']

/** pristine-comparable markup: editor session attributes stripped */
export function cleanOuter(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement
  for (const node of [clone, ...clone.querySelectorAll<HTMLElement>('*')]) {
    for (const a of EDITOR_ATTRS) node.removeAttribute(a)
    if (node.classList.contains('dia-editor-artifact')) node.remove()
  }
  return clone.outerHTML
}

/** LaTeX for a rendered block element — memo bytes when unedited,
 * reconstruction when not.
 *
 * An UNEDITED block emits its slice entire, separators and all. A rebuilt
 * one emits the block and nothing else, because the separators belong to
 * whoever is placing it: a nested child is placed by its environment's own
 * joining, and a top-level block by the source patch (model/ops
 * syncedBlockOp), which re-seats it in the whitespace its span had. */
export function emitBlockTex(el: HTMLElement): string {
  const memo = blockMemo.get(el)
  if (memo && cleanOuter(el) === memo.html) return memo.slice

  if (el.matches('div.dia-maketitle')) return memo?.slice ?? '\\maketitle'

  if (el.matches('p')) return emitInlines(el.childNodes)

  if (el.matches('h2.dia-sec, h3.dia-sec, h4.dia-sec, h5.dia-sec')) {
    const title = emitInlines(el.childNodes)
    if (memo) {
      const patched = replaceSectionTitle(memo.slice, title)
      if (patched !== null) return patched
    }
    const cmd = ['section', 'subsection', 'subsubsection', 'paragraph'][Number(el.tagName[1]) - 2] ?? 'section'
    const label = el.getAttribute('data-dia-label')
    return `\\${cmd}{${title}}${label ? `\\label{${label}}` : ''}`
  }

  if (el.matches('section.dia-abstract')) {
    return emitEnvWithChildren(el, memo?.slice ?? null, 'abstract')
  }

  if (el.matches('div.dia-wrap')) {
    const env = el.getAttribute('data-dia-env') ?? 'center'
    return emitEnvWithChildren(el, memo?.slice ?? null, env)
  }

  if (el.matches('ul, ol, dl')) return emitList(el)

  if (el.matches('figure.dia-figure')) return emitFloat(el, memo?.slice ?? null)

  if (el.matches('table')) return emitTabular(el)

  if (el.matches('div.dia-math')) {
    const tex = el.getAttribute('data-dia-tex') ?? ''
    const env = el.getAttribute('data-dia-env')
    const label = el.getAttribute('data-dia-label')
    if (env) return `\\begin{${env}}${label ? `\\label{${label}}` : ''}\n${tex}\n\\end{${env}}`
    return `\\[\n${tex}\n\\]`
  }

  if (el.matches('pre.dia-verbatim')) {
    const env = el.getAttribute('data-dia-env') ?? 'verbatim'
    const body = el.textContent ?? ''
    if (memo) {
      const part = partitionVerbatim(memo.slice, env)
      if (part) return part.head + body + part.tail
    }
    return `\\begin{${env}}\n${body}\n\\end{${env}}`
  }

  if (el.matches('div.dia-tex-island')) {
    // the island renders its raw source as text — the text IS the LaTeX
    return el.querySelector('pre')?.textContent ?? el.textContent ?? ''
  }

  // unknown block shape (pasted content): treat children as inline flow
  return emitInlines(el.childNodes)
}

/* ---------- block helpers ---------- */

/** \begin{env}…\end{env} with the interior rebuilt from child blocks; the
 * original begin line (with its argument groups) and end line survive */
function emitEnvWithChildren(el: HTMLElement, slice: string | null, env: string): string {
  const inner = [...el.children]
    .filter((c) => !c.classList.contains('dia-editor-artifact'))
    .map((c) => emitBlockTex(c as HTMLElement))
    .join('\n\n')
  if (slice) {
    const part = partitionEnv(slice, env)
    if (part) return `${part.head}\n${inner}\n${part.tail}`
  }
  return `\\begin{${env}}\n${inner}\n\\end{${env}}`
}

function emitList(el: HTMLElement): string {
  if (el.matches('dl')) {
    const parts: string[] = []
    const children = [...el.children]
    for (let i = 0; i < children.length; i++) {
      if (!children[i].matches('dt')) continue
      const term = emitInlines(children[i].childNodes)
      const dd = children[i + 1]?.matches('dd') ? children[i + 1] : null
      const body = dd ? emitItemBody(dd as HTMLElement) : ''
      parts.push(`\\item[${term}] ${body}`.trimEnd())
    }
    return `\\begin{description}\n${parts.join('\n')}\n\\end{description}`
  }
  // an aliased list (itemizepacked…) keeps its original environment name
  const env = el.getAttribute('data-dia-env') ?? (el.matches('ol') ? 'enumerate' : 'itemize')
  const items = [...el.children]
    .filter((c) => c.matches('li'))
    .map((li) => `\\item ${emitItemBody(li as HTMLElement)}`.trimEnd())
  return `\\begin{${env}}\n${items.join('\n')}\n\\end{${env}}`
}

/** an item body is inline flow unless it holds nested block elements */
function emitItemBody(host: HTMLElement): string {
  const blockish = [...host.children].some((c) =>
    c.matches('ul, ol, dl, figure, table, div.dia-math, pre.dia-verbatim, div.dia-tex-island, p'))
  if (!blockish) return emitInlines(host.childNodes)
  const parts: string[] = []
  let inlineRun: Node[] = []
  const flush = () => {
    if (inlineRun.length) {
      const tex = emitInlines(inlineRun)
      if (tex.trim()) parts.push(tex)
      inlineRun = []
    }
  }
  for (const node of host.childNodes) {
    if (node instanceof HTMLElement && node.matches('ul, ol, dl, figure, table, div.dia-math, pre.dia-verbatim, div.dia-tex-island, p')) {
      flush()
      parts.push(emitBlockTex(node))
    } else {
      inlineRun.push(node)
    }
  }
  flush()
  return parts.join('\n')
}

/** floats reconstruct surgically: the caption and any embedded tabular are
 * the natively editable parts in v1, so patch the \caption group and splice
 * any edited table's own reconstruction into the original slice, leaving
 * everything else (placement, centering, graphics, sizing) byte-intact.
 *
 * A caption is only touched when IT changed (captionMemo, cell-grain-style)
 * — a float whose ONLY edit is a sibling table cell must leave the caption's
 * source bytes, \label and comments included, completely alone. Only when
 * the caption itself was edited do we reconstruct it from the DOM, and even
 * then surgically (replaceCaptionGroup) so a \label the edit's DOM op wiped
 * (setText replaces all of a caption's children, span.dia-label included)
 * is restored from the original slice rather than lost. */
function emitFloat(el: HTMLElement, slice: string | null): string {
  const cap = el.querySelector<HTMLElement>(':scope > figcaption')
  if (slice) {
    let out = slice
    if (cap && cleanOuter(cap) !== captionMemo.get(cap)) {
      const capTex = emitInlines(cap.childNodes)
      const patched = replaceCaptionGroup(out, 'caption', capTex)
      if (patched !== null) {
        out = patched
      } else {
        // no \caption in the original — append one before \end
        const env = el.getAttribute('data-dia-float') ?? 'figure'
        const at = out.lastIndexOf(`\\end{${env}`)
        if (at >= 0) out = `${out.slice(0, at)}\\caption{${capTex}}\n${out.slice(at)}`
      }
    }
    return spliceEditedTables(el, out)
  }
  const env = el.getAttribute('data-dia-float') ?? 'figure'
  const label = el.getAttribute('data-dia-label')
  const lines: string[] = [`\\begin{${env}}[h]`, '\\centering']
  for (const img of el.querySelectorAll(':scope > .dia-graphic')) {
    const opts = img.getAttribute('data-dia-graphic-opts')
    const path = img.getAttribute('src') ?? img.getAttribute('data-dia-graphic-path') ?? ''
    lines.push(`\\includegraphics${opts ? `[${opts}]` : ''}{${path}}`)
  }
  for (const child of el.children) {
    if (child.matches('table')) lines.push(emitTabular(child as HTMLElement))
  }
  const capTex = cap ? emitInlines(cap.childNodes) : null
  if (capTex !== null) lines.push(`\\caption{${capTex}}`)
  if (label) lines.push(`\\label{${label}}`)
  lines.push(`\\end{${env}}`)
  return lines.join('\n')
}

/** an edited table's own reconstruction replaces its ORIGINAL bytes inside
 * the float's slice — found by a plain text search, safe because a table's
 * memo slice is disjoint from the caption group the step above may have
 * just patched. An unedited table (or one with no memo — a fresh insert
 * outside any parse) is left as whatever the slice already carries. */
function spliceEditedTables(el: HTMLElement, slice: string): string {
  let out = slice
  for (const table of el.querySelectorAll<HTMLElement>('table')) {
    const tmemo = blockMemo.get(table)
    if (!tmemo || cleanOuter(table) === tmemo.html) continue
    const at = out.indexOf(tmemo.slice)
    if (at < 0) continue
    out = out.slice(0, at) + emitTabular(table) + out.slice(at + tmemo.slice.length)
  }
  return out
}

/** tabular reconstruction is cell-grain: an unedited cell — a row's rule
 * commands, a spanning cell's exact alignment spec / multirow width, every
 * OTHER cell, all whitespace between them — re-emits from the table's own
 * memo slice untouched; only a cell whose rendered markup diverged from its
 * pristine snapshot re-serializes. A cell edit's diff is therefore exactly
 * that cell's bytes. Structural edits (add/remove a row or column) are out
 * of scope for now — the source view is the escape hatch. */
function emitTabular(el: HTMLElement): string {
  const memo = blockMemo.get(el)
  const slots = tabularCellMemo.get(el)
  if (!memo || !slots) return emitTabularFresh(el)

  let out = ''
  let cursor = 0
  for (const slot of slots) {
    out += memo.slice.slice(cursor, slot.start)
    out += slot.td === null || (slot.pristineHtml !== null && cleanOuter(slot.td) === slot.pristineHtml)
      ? memo.slice.slice(slot.start, slot.end)
      : emitInlines(slot.td.childNodes)
    cursor = slot.end
  }
  out += memo.slice.slice(cursor)
  return out
}

/** from-scratch reconstruction — reachable only when a table carries no
 * render memo (it never came from a parse, e.g. programmatically inserted).
 * Rules/specs/widths come from the data-dia-* attributes render.ts stamps,
 * falling back to the loose defaults a bare \multicolumn/\multirow accepts. */
function emitTabularFresh(el: HTMLElement): string {
  const colspec = el.getAttribute('data-dia-colspec') ?? 'l'
  const rows = [...el.querySelectorAll(':scope > tbody > tr, :scope > tr')]
    .map((tr) => {
      const rule = tr.getAttribute('data-dia-rule')
      const cells = [...tr.children].map((td) => {
        let cell = emitInlines(td.childNodes)
        const rs = Number(td.getAttribute('rowspan') ?? 1)
        const cs = Number(td.getAttribute('colspan') ?? 1)
        if (rs > 1) cell = `\\multirow{${rs}}{${td.getAttribute('data-dia-rowspan-width') ?? '*'}}{${cell}}`
        if (cs > 1) cell = `\\multicolumn{${cs}}{${td.getAttribute('data-dia-colspan-spec') ?? 'c'}}{${cell}}`
        return cell
      }).join(' & ')
      return rule ? `${rule} ${cells}` : cells
    })
  const trailing = el.getAttribute('data-dia-trailing-rule')
  return `\\begin{tabular}{${colspec}}\n${rows.join(' \\\\\n')}${trailing ? `\n${trailing}` : ''}\n\\end{tabular}`
}

/* ---------- inline emission ---------- */

export function emitInlines(nodes: Iterable<Node>): string {
  let out = ''
  for (const node of nodes) out += emitInline(node)
  return out
}

function emitInline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeTex(node.textContent ?? '')
  if (!(node instanceof HTMLElement)) return ''
  // editor artifacts (a compiled-mirror crop, a staleness marker) are not
  // content: the memo comparison already strips them, and reconstruction
  // has to be blind to them for the same reason
  if (node.classList.contains('dia-editor-artifact')) return ''

  if (node.matches('span.dia-math')) return `$${node.getAttribute('data-dia-tex') ?? ''}$`
  if (node.matches('a.dia-ref')) {
    const cmd = node.getAttribute('data-dia-ref-cmd') ?? 'ref'
    return `\\${cmd}{${node.getAttribute('data-dia-ref') ?? ''}}`
  }
  if (node.matches('a.dia-cite')) {
    const cmd = node.getAttribute('data-dia-cite-cmd') ?? 'cite'
    const opt = node.getAttribute('data-dia-cite-opt')
    const pre = node.getAttribute('data-dia-cite-pre')
    // a pre-note only exists in the two-bracket form: [pre][post]
    const opts = pre !== null ? `[${pre}][${opt ?? ''}]` : opt ? `[${opt}]` : ''
    return `\\${cmd}${opts}{${node.getAttribute('data-dia-cite') ?? ''}}`
  }
  if (node.matches('span.dia-footnote')) return `\\footnote{${emitInlines(node.childNodes)}}`
  if (node.matches('a.dia-url')) {
    const href = node.getAttribute('href') ?? ''
    const inner = emitInlines(node.childNodes)
    return inner === escapeTex(href) || inner === href ? `\\url{${href}}` : `\\href{${href}}{${inner}}`
  }
  if (node.matches('span.dia-label')) return `\\label{${node.getAttribute('data-dia-label') ?? ''}}`
  if (node.matches('span.dia-tex-island')) return node.textContent ?? ''
  if (node.matches('code.dia-verb')) return emitVerb(node.textContent ?? '')
  if (node.matches('span.dia-smallcaps')) return `\\textsc{${emitInlines(node.childNodes)}}`
  if (node.matches('span.dia-sans')) return `\\textsf{${emitInlines(node.childNodes)}}`
  if (node.matches('br')) return ' \\\\ '

  const wrap: Record<string, string> = { STRONG: 'textbf', B: 'textbf', EM: 'emph', I: 'textit', CODE: 'texttt', U: 'underline' }
  const cmd = wrap[node.tagName]
  if (cmd) return `\\${cmd}{${emitInlines(node.childNodes)}}`

  // unknown inline element (pasted span/mark/…): transparent
  return emitInlines(node.childNodes)
}

/** \verb needs a delimiter absent from the body; fall back to \texttt with
 * escaping when none of the candidates fits */
function emitVerb(text: string): string {
  for (const d of ['|', '!', '+', '=', '@', '#', '^']) {
    if (!text.includes(d)) return `\\verb${d}${text}${d}`
  }
  return `\\texttt{${escapeTex(text)}}`
}

export function escapeTex(text: string): string {
  return text
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([%$&#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/ /g, '~')
}

/* ---------- surgical slice helpers ---------- */

/** locate the balanced {…} group of \cmd within a slice: the index of its
 * opening brace and of its matching closing brace */
function findCommandGroup(slice: string, cmd: string): { open: number; close: number } | null {
  const at = slice.indexOf(`\\${cmd}`)
  if (at < 0) return null
  let i = at + cmd.length + 1
  if (slice[i] === '*') i++
  // optional [..] between command and group
  while (slice[i] === ' ' || slice[i] === '\t') i++
  if (slice[i] === '[') {
    const close = slice.indexOf(']', i)
    if (close < 0) return null
    i = close + 1
  }
  while (slice[i] === ' ' || slice[i] === '\t') i++
  if (slice[i] !== '{') return null
  const open = i
  let depth = 0
  for (let j = open + 1; j < slice.length; j++) {
    const c = slice[j]
    if (c === '\\') { j++; continue }
    if (c === '{') depth++
    else if (c === '}') {
      if (depth === 0) return { open, close: j }
      depth--
    }
  }
  return null
}

/** find the balanced {…} group of \cmd within a slice; replace its content
 * wholesale — used where the group carries nothing the DOM does not, e.g. a
 * heading's title group */
export function replaceCommandGroup(slice: string, cmd: string, replacement: string): string | null {
  const g = findCommandGroup(slice, cmd)
  if (!g) return null
  return slice.slice(0, g.open + 1) + replacement + slice.slice(g.close)
}

/** the main {title} group of a heading slice — after the command name, an
 * optional star, and an optional [short title] */
function replaceSectionTitle(slice: string, title: string): string | null {
  const m = slice.match(/^\\(sub){0,2}(section|paragraph)/)
  if (!m) return null
  return replaceCommandGroup(slice, m[0].slice(1), title)
}

/** find the balanced {…} group of \cmd and replace only its PROSE span,
 * preserving the "furniture" the DOM carries no node for: a \label{…}
 * written inside the group — LEADING (\caption{\label{x} Text…}) or
 * TRAILING (the more common \caption{Text…\label{x}} — the idiom exists
 * because \label must follow \caption to bind the right counter), a %
 * comment, a bare \centering, \vspace{…}, and the whitespace around them */
export function replaceCaptionGroup(slice: string, cmd: string, prose: string): string | null {
  const g = findCommandGroup(slice, cmd)
  if (!g) return null
  const { lead, tail } = splitCaptionFurniture(slice.slice(g.open + 1, g.close))
  return slice.slice(0, g.open + 1) + lead + prose + tail + slice.slice(g.close)
}

/** split a caption group's raw content into a leading furniture run, the
 * prose span, and a trailing furniture run. The content is tokenized at
 * brace-depth 0 into runs of ordinary text and furniture — a %-comment to
 * end of line, or a command (with its argument groups) that setsNoType,
 * e.g. \label{…}, \centering, \vspace{…} — then the longest LEADING and
 * longest TRAILING runs of tokens that are furniture or pure whitespace are
 * peeled off. What's left between them, even if it also contains furniture
 * tokens sandwiched in real text, is the prose: an edit replaces it whole. */
function splitCaptionFurniture(content: string): { lead: string; prose: string; tail: string } {
  type Tok = { furniture: boolean; text: string }
  const toks: Tok[] = []
  let depth = 0
  let otherStart = 0
  let i = 0
  const flushOther = (end: number) => {
    if (end > otherStart) toks.push({ furniture: false, text: content.slice(otherStart, end) })
  }
  while (i < content.length) {
    const c = content[i]
    if (c === '\\' && depth === 0) {
      const m = /^\\[a-zA-Z@]+\*?/.exec(content.slice(i))
      if (m) {
        const end = consumeCommandArgs(content, i + m[0].length)
        if (setsNoType(content.slice(i, end))) {
          flushOther(i)
          toks.push({ furniture: true, text: content.slice(i, end) })
          otherStart = end
          i = end
          continue
        }
      }
      i += 2
      continue
    }
    if (c === '\\') { i += 2; continue }
    if (c === '{') { depth++; i++; continue }
    if (c === '}') { if (depth > 0) depth--; i++; continue }
    if (c === '%' && depth === 0) {
      flushOther(i)
      let j = i
      while (j < content.length && content[j] !== '\n') j++
      toks.push({ furniture: true, text: content.slice(i, j) })
      otherStart = j
      i = j
      continue
    }
    i++
  }
  flushOther(content.length)

  const isPeelable = (t: Tok) => t.furniture || t.text.trim() === ''
  let start = 0
  while (start < toks.length && isPeelable(toks[start])) start++
  let end = toks.length
  while (end > start && isPeelable(toks[end - 1])) end--
  const join = (from: number, to: number) => toks.slice(from, to).map((t) => t.text).join('')
  return { lead: join(0, start), prose: join(start, end), tail: join(end, toks.length) }
}

/** past a command's directly-attached [..] and balanced {..} argument
 * groups — mirrors parse.ts's own consumeArgs so setsNoType is asked about
 * exactly the span it would see during parsing */
function consumeCommandArgs(s: string, from: number): number {
  let i = from
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i++
    if (s[i] === '[') {
      const close = s.indexOf(']', i)
      if (close < 0) return s.length
      i = close + 1
      continue
    }
    if (s[i] === '{') {
      let depth = 0
      let j = i
      for (; j < s.length; j++) {
        if (s[j] === '\\') { j++; continue }
        if (s[j] === '{') depth++
        else if (s[j] === '}' && --depth === 0) break
      }
      i = j < s.length ? j + 1 : s.length
      continue
    }
    return i
  }
}

/** split an env slice into the begin line (with argument groups) and the
 * \end line, so a rebuilt interior never touches them */
export function partitionEnv(slice: string, env: string): { head: string; tail: string } | null {
  const beginTag = `\\begin{${env}`
  const endTag = `\\end{${env}`
  if (!slice.startsWith(beginTag)) return null
  let i = slice.indexOf('}', beginTag.length)
  if (i < 0) return null
  i++
  // argument groups hugging \begin{env}: [..] and {..}
  for (;;) {
    if (slice[i] === '[') {
      const c = slice.indexOf(']', i)
      if (c < 0 || slice.slice(i, c).includes('\n')) break
      i = c + 1
      continue
    }
    if (slice[i] === '{') {
      const c = slice.indexOf('}', i)
      if (c < 0 || slice.slice(i, c).includes('\n')) break
      i = c + 1
      continue
    }
    break
  }
  const endAt = slice.lastIndexOf(endTag)
  if (endAt < 0 || endAt < i) return null
  return { head: slice.slice(0, i), tail: slice.slice(endAt) }
}

/** verbatim partition: head = begin line incl. same-line args + its
 * newline; tail = newline + \end line. The body between is replaceable. */
function partitionVerbatim(slice: string, env: string): { head: string; tail: string } | null {
  const part = partitionEnv(slice, env)
  if (!part) return null
  let head = part.head
  const afterHead = slice.slice(head.length)
  const nl = afterHead.indexOf('\n')
  if (nl >= 0 && afterHead.slice(0, nl).trim() === '') head += afterHead.slice(0, nl + 1)
  let tail = part.tail
  const beforeTail = slice.slice(0, slice.length - tail.length)
  if (beforeTail.endsWith('\n')) tail = '\n' + tail
  return { head, tail }
}
