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

import { blockMemo, captionMemo, tabularCellMemo, wrapTitleMemo } from './render'
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

  if (el.matches('h1.dia-sec, h2.dia-sec, h3.dia-sec, h4.dia-sec, h5.dia-sec')) {
    const title = emitInlines(el.childNodes)
    if (memo) {
      const patched = replaceSectionTitle(memo.slice, title)
      if (patched !== null) return patched
    }
    const cmd = ['chapter', 'section', 'subsection', 'subsubsection', 'paragraph'][Number(el.tagName[1]) - 1] ?? 'section'
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
 * original begin line (with its argument groups) and end line survive.
 *
 * A titled environment (beamer's frame/block/…) renders its heading as a
 * p.dia-wrap-title that is NOT a body block: its bytes live in the begin
 * line's own argument. So it is kept out of the interior, and patched into
 * that argument only when the title itself changed — the same rule, and the
 * same reason, as a float's \caption. */
function emitEnvWithChildren(el: HTMLElement, slice: string | null, env: string): string {
  const title = el.querySelector<HTMLElement>(':scope > p.dia-wrap-title')
  const titleTex = title !== null && cleanOuter(title) !== wrapTitleMemo.get(title)
    ? emitInlines(title.childNodes)
    : null
  const part = slice ? partitionEnv(slice, env) : null

  // SURGICAL first, the same way a float reconstructs: patch the title into
  // the \begin line's own argument and every EDITED child into its own
  // original bytes, so unedited siblings — and the whitespace, comments and
  // islands between them — keep the bytes they had. A beamer frame carries
  // a whole slide; reflowing all of it because one paragraph inside one
  // block changed is exactly the diff nobody asked for. The child cursor
  // starts past the begin line so a child can never be matched against the
  // title's bytes (a one-word title and a one-word paragraph do collide).
  if (slice && part) {
    let out = slice
    // the cursor must move with the patch: a title edit that SHORTENS the
    // begin line would otherwise leave the cursor inside the first child's
    // bytes, and a child the search cannot find is a child whose edit is
    // silently dropped. The patch is confined to the head, so the head's
    // length shifts by exactly the patch's length delta.
    let headLen = part.head.length
    if (titleTex !== null) {
      const patched = replaceLastBraceArg(slice, env, titleTex)
      if (patched !== null) { headLen += patched.length - slice.length; out = patched }
    }
    out = spliceEditedChildren(el, out, headLen)
    if (out !== slice) return out
  }

  // fallback: an edit the splice could not account for — a child added or
  // removed, loose text of the environment's own that no child block owns
  const inner = [...el.children]
    .filter((c) => c !== title && !c.classList.contains('dia-editor-artifact'))
    .map((c) => emitBlockTex(c as HTMLElement))
    .join('\n\n')
  if (part) {
    const head = titleTex !== null ? replaceLastBraceArg(part.head, env, titleTex) ?? part.head : part.head
    return `${head}\n${inner}\n${part.tail}`
  }
  const arg = title ? `{${emitInlines(title.childNodes)}}` : ''
  return `\\begin{${env}}${arg}\n${inner}\n\\end{${env}}`
}

/** replace the content of the LAST brace argument hugging `\begin{env}` in
 * an environment's head — where a titled environment keeps its title. The
 * scan mirrors partitionEnv's own argument walk exactly, so head and patch
 * can never disagree about which group that is. */
function replaceLastBraceArg(head: string, env: string, replacement: string): string | null {
  const beginTag = `\\begin{${env}`
  if (!head.startsWith(beginTag)) return null
  let i = head.indexOf('}', beginTag.length)
  if (i < 0) return null
  i++
  let last: { open: number; close: number } | null = null
  for (;;) {
    if (head[i] === '[') {
      const c = head.indexOf(']', i)
      if (c < 0) break
      i = c + 1
      continue
    }
    if (head[i] === '{') {
      let depth = 0
      let j = i
      for (; j < head.length; j++) {
        if (head[j] === '\\') { j++; continue }
        if (head[j] === '{') depth++
        else if (head[j] === '}' && --depth === 0) break
      }
      if (j >= head.length) break
      last = { open: i, close: j }
      i = j + 1
      continue
    }
    break
  }
  return last ? head.slice(0, last.open + 1) + replacement + head.slice(last.close) : null
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

/** floats reconstruct surgically: patch the \caption group, then splice
 * every EDITED child's own reconstruction into the original slice, leaving
 * everything else (placement, centering, graphics, sizing, \subfloat
 * wrappers, comments, anything the parser islanded) byte-intact.
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
      // a \subfloat panel keeps its caption in a BRACKET, so it has no
      // \caption group to patch — try that shape before concluding the
      // float never had a caption at all
      const patched = replaceCaptionGroup(out, 'caption', capTex) ?? replaceSubfloatCaption(out, capTex)
      if (patched !== null) {
        out = patched
      } else {
        // no \caption in the original — append one before \end
        const env = el.getAttribute('data-dia-float') ?? 'figure'
        const at = out.lastIndexOf(`\\end{${env}`)
        if (at >= 0) out = `${out.slice(0, at)}\\caption{${capTex}}\n${out.slice(at)}`
      }
    }
    return spliceEditedChildren(el, out)
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

/** an edited child's own reconstruction replaces its ORIGINAL bytes inside
 * the float's slice. Every rendered block carries a memo (render.ts), child
 * blocks included, so a child is found by searching for its memo slice —
 * safe because a child's span is disjoint from the caption group the step
 * above may have just patched (\caption's group is consumed at float level,
 * so nothing inside it is ever a body block).
 *
 * The search runs a CURSOR forward across the children in DOM order, which
 * is source order for a float's body: two identical siblings (the same
 * one-line \includegraphics island twice, a repeated note) would otherwise
 * both resolve to the first one's bytes and the wrong panel would change.
 * Unedited children advance the cursor without being touched.
 *
 * The walk descends through elements that carry NO memo of their own — a
 * list's <li>, a table's <tr>, the <figcaption> — so a block nested inside
 * one is still reached at its own grain. An edited child with no memo (a
 * fresh insert that never came from a parse) has no bytes to replace and is
 * left alone; the source view is the escape hatch, as for structural table
 * edits. */
function spliceEditedChildren(host: HTMLElement, slice: string, from = 0): string {
  let out = slice
  const visit = (parent: HTMLElement) => {
    for (const child of parent.children) {
      if (!(child instanceof HTMLElement) || child.classList.contains('dia-editor-artifact')) continue
      const memo = blockMemo.get(child)
      if (!memo) { visit(child); continue }
      const at = out.indexOf(memo.slice, from)
      if (at < 0) continue
      if (cleanOuter(child) === memo.html) { from = at + memo.slice.length; continue }
      const tex = reseat(memo.slice, emitEditedChild(child, memo.slice))
      out = out.slice(0, at) + tex + out.slice(at + memo.slice.length)
      from = at + tex.length
    }
  }
  visit(host)
  return out
}

/** an edited child's LaTeX. A container whose own emitter REBUILDS its
 * interior (a wrapper's, a list's — children re-joined with fresh blank
 * lines) gets the float's treatment first: patch only the edited
 * descendants' spans inside the container's own original bytes, so an edit
 * two levels down costs nothing above it. The rebuild is the fallback for
 * an edit that is NOT confined to memoized descendants — a container's own
 * loose text, an added or removed child. Every other block kind emits
 * itself surgically already (a table by cell, a nested float by caption). */
function emitEditedChild(child: HTMLElement, slice: string): string {
  if (child.matches('div.dia-wrap, section.dia-abstract, ul, ol, dl')) {
    const patched = spliceEditedChildren(child, slice)
    if (patched !== slice) return patched
  }
  return emitBlockTex(child)
}

/** put a reconstruction back in the whitespace its original span carried —
 * the same rule model/ops reseated() applies to a top-level block, for the
 * same reason: a block's span starts and ends where its TOKENS do, so a
 * paragraph inside a float owns the newline before \caption. Emitting the
 * reconstruction raw would glue the two into one line. */
function reseat(slice: string, emitted: string): string {
  const lead = /^\s*/.exec(slice)?.[0] ?? ''
  const tail = /\s*$/.exec(slice.slice(lead.length))?.[0] ?? ''
  return lead + emitted.replace(/^\s+/, '').replace(/\s+$/, '') + tail
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

/** every character that cannot stand for itself in a LaTeX text run, and what
 * it becomes. U+00A0 is in the table for a reason: a source `~` parses to a
 * real non-breaking space, so that character round-trips as one — which is
 * also why a TYPED tilde (U+007E) can safely become \textasciitilde{} without
 * turning anyone's `Fig.~\ref{...}` into a literal squiggle. */
const TEX_ESCAPE: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '%': '\\%', '$': '\\$', '&': '\\&', '#': '\\#', '_': '\\_',
  '{': '\\{', '}': '\\}',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
  '\u00a0': '~',
}

/** ONE pass, because a chain re-reads its own output: escaping `\` first wrote
 * \textbackslash{} into the string, and the brace rule that ran next escaped
 * the braces it had just produced, so typing `a\b` left the editor as
 * a\textbackslash\{\}b — wrong in the FILE, not merely on screen; the PDF set
 * `a\{}b`. A single regex over a table cannot re-enter what it emits. */
export function escapeTex(text: string): string {
  return text.replace(/[\\%$&#_{}~^\u00a0]/g, (c) => TEX_ESCAPE[c])
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

/** A `\subfloat[caption]{panel}` / `\subfigure[caption]{panel}` slice: the
 * caption is the OPTIONAL BRACKET, and replacing it is what makes an edit
 * to a sub-caption reach the file. A panel written without one gets the
 * bracket inserted after the command name, which is where the grammar puts
 * it. Bracket depth is counted (and `\x` skipped) so a caption holding its
 * own `[…]` closes at the right place; null when the slice is not a
 * sub-float at all, so the caller can fall through. */
function replaceSubfloatCaption(slice: string, prose: string): string | null {
  const m = /^\s*\\(?:subfloat|subfigure)\*?\s*/.exec(slice)
  if (!m) return null
  const at = m[0].length
  if (slice[at] !== '[') return `${slice.slice(0, at)}[${prose}]${slice.slice(at)}`
  let depth = 0
  for (let i = at + 1; i < slice.length; i++) {
    const c = slice[i]
    if (c === '\\') { i++; continue }
    if (c === '[') depth++
    else if (c === ']') {
      if (depth === 0) return slice.slice(0, at + 1) + prose + slice.slice(i)
      depth--
    }
  }
  return null
}

/** the main {title} group of a heading slice — after the command name, an
 * optional star, and an optional [short title] */
function replaceSectionTitle(slice: string, title: string): string | null {
  const m = slice.match(/^\\(chapter|(sub){0,2}(section|paragraph))/)
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
  // argument groups hugging \begin{env}: [..] and balanced {..} — a
  // frame's {\model{} in One Slide} title nests a macro call, so this
  // must count brace depth rather than stop at the first `}` (issue #20)
  for (;;) {
    if (slice[i] === '[') {
      const c = slice.indexOf(']', i)
      if (c < 0 || slice.slice(i, c).includes('\n')) break
      i = c + 1
      continue
    }
    if (slice[i] === '{') {
      let depth = 0
      let j = i
      for (; j < slice.length; j++) {
        if (slice[j] === '\\') { j++; continue }
        if (slice[j] === '{') depth++
        else if (slice[j] === '}' && --depth === 0) break
      }
      if (j >= slice.length || slice.slice(i, j + 1).includes('\n')) break
      i = j + 1
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
