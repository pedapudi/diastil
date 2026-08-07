/* What the copilot sees when the loaded artifact is a DOCUMENT.
 *
 * A deck turn ships slides; a document turn ships the SECTION the user is
 * in — its rendered markup, the LaTeX bytes behind it (the model reasons
 * natively in tex, and every op it proposes lands in that source), a render
 * of the section, the open comment threads anchored inside it, and the last
 * compile's findings. The wire is unchanged: the render rides in slideImage
 * and the current block in slideIndex, so the service's image loop and the
 * rail's plumbing stay one code path.
 *
 * Nothing here mutates the document. The section render is taken from a
 * detached CLONE mounted offscreen inside the doc's own shadow root — the
 * live article is never reparented, so selections, comment anchors, and the
 * IntersectionObserver that tracks the current block are untouched. */

import type { ChatContext } from '../types'
import type { Doc } from '../model/doc'
import { state } from '../state'
import { rasterizeToDataUrl } from '../ingest/fidelity'
import { compileState } from '../editor/doccompile'
import { blockFor, parseThreads, type CommentThread } from '../doc/comments'

const SECTION_HTML_CAP = 6000
const SOURCE_CAP = 4000
/** a section taller than this rasterizes clipped — a 30-page section is not
 * a more useful image than its first screens, and the canvas has limits */
const RENDER_MAX_PX = 2400

const HEADING = 'h1.dia-sec, h2.dia-sec, h3.dia-sec, h4.dia-sec, h5.dia-sec'

export interface DocSection {
  /** the section's blocks in flow order, heading first when there is one */
  blocks: HTMLElement[]
  /** the heading's dotted number ("2", "2.1"); empty = front matter */
  number: string
  title: string
}

/** the section around a block: from its heading (or the document start)
 * through the block before the next heading at the same or a higher level */
export function sectionAround(article: HTMLElement, block: HTMLElement | null): DocSection {
  const children = [...article.children].filter((c): c is HTMLElement => c instanceof HTMLElement)
  const at = block ? children.indexOf(block) : -1
  const from = at >= 0 ? at : 0

  let head = -1
  for (let i = from; i >= 0; i--) {
    if (children[i].matches(HEADING)) { head = i; break }
  }
  const level = headingLevel(children[head])
  let end = children.length
  for (let i = head + 1; i < children.length; i++) {
    const el = children[i]
    if (el.matches(HEADING) && headingLevel(el) <= level) { end = i; break }
  }
  const start = head >= 0 ? head : 0
  const blocks = children.slice(start, end)

  return {
    blocks,
    number: head >= 0 ? sectionNumber(children, head) : '',
    title: head >= 0 ? (children[head].textContent ?? '').trim() : '',
  }
}

/** the heading's dotted counter, the way LaTeX would number it (derived.ts
 * numbers refs the same way — this is the reader-facing half of it) */
function sectionNumber(children: HTMLElement[], head: number): string {
  const counters = [0, 0, 0, 0]
  for (let i = 0; i <= head; i++) {
    if (!children[i].matches(HEADING)) continue
    const level = headingLevel(children[i]) - 2
    counters[level]++
    for (let j = level + 1; j < counters.length; j++) counters[j] = 0
  }
  return counters.slice(0, headingLevel(children[head]) - 1).join('.')
}

/** front matter (no heading above it) ends at the FIRST heading of any
 * level, so it is addressed as its own region rather than swallowing §1 */
function headingLevel(el: HTMLElement | undefined): number {
  return el ? Number(el.tagName[1]) || 2 : Number.MAX_SAFE_INTEGER
}

/** the context line's honest short description: "section 2 › Methods" */
export function describeDocContext(): string {
  const doc = state.doc
  if (!doc) return 'no document'
  const section = sectionAround(doc.article, state.blocks()[state.currentBlock] ?? null)
  if (!section.number) return 'front matter'
  const title = section.title.replace(/\s+/g, ' ').trim()
  return `section ${section.number}${title ? ` › ${title}` : ''}`
}

/** everything a document turn adds to the ChatContext; merged over the base
 * by the rail. Every field degrades independently — a failed raster or an
 * unreadable comments block never costs the turn its markup. */
export async function buildDocContext(): Promise<Partial<ChatContext>> {
  const doc = state.doc
  if (!doc) return {}
  const current = state.blocks()[state.currentBlock] ?? null
  const section = sectionAround(doc.article, current)

  let slideImage: string | null = null
  try {
    slideImage = await renderSection(doc, section.blocks)
  } catch { /* text-only */ }

  return {
    docMode: true,
    sectionHtml: sectionHtml(section.blocks),
    sourceExcerpt: sourceExcerpt(doc, section.blocks, current),
    slideImage,
    selectionHtml: docSelectionHtml(doc),
    comments: sectionComments(doc, section.blocks),
    compileErrors: compileErrors(),
  }
}

/* ---------- markup ---------- */

function sectionHtml(blocks: HTMLElement[]): string | null {
  if (blocks.length === 0) return null
  let out = ''
  for (const el of blocks) {
    const html = el.outerHTML
    if (out.length + html.length > SECTION_HTML_CAP) {
      out += '\n<!-- …section truncated -->'
      break
    }
    out += (out ? '\n' : '') + html
  }
  return out
}

/* ---------- source ---------- */

/** the contiguous LaTeX behind the section — one slice, so inter-block
 * bytes (comments, spacing) the model must not clobber are visible, and
 * what it reads is exactly what the file says. Over the cap the window
 * centers on the current block, and the clipping is marked. */
function sourceExcerpt(doc: Doc, blocks: HTMLElement[], current: HTMLElement | null): string | null {
  const spans = blocks
    .map((el) => el.getAttribute('data-dia-id'))
    .map((id) => (id ? doc.source.spanOf(id) : null))
    .filter((s): s is { start: number; end: number } => s !== null)
  if (spans.length === 0) return null
  const from = Math.min(...spans.map((s) => s.start))
  const to = Math.max(...spans.map((s) => s.end))
  if (to - from <= SOURCE_CAP) return doc.source.text.slice(from, to)

  const id = current?.getAttribute('data-dia-id')
  const focus = (id && doc.source.spanOf(id)) || spans[0]
  const mid = Math.round((focus.start + focus.end) / 2)
  const start = Math.max(from, Math.min(mid - Math.floor(SOURCE_CAP / 2), to - SOURCE_CAP))
  const end = Math.min(to, start + SOURCE_CAP)
  return `${start > from ? '% …earlier in this section, omitted\n' : ''}`
    + doc.source.text.slice(start, end)
    + `${end < to ? '\n% …rest of this section, omitted' : ''}`
}

/* ---------- the render ---------- */

/** rasterize a CLONE of the section, mounted offscreen in the document's own
 * shadow root so it inherits the same theme CSS as the live article.
 * Returns null in any environment without layout (tests, occluded tabs). */
async function renderSection(doc: Doc, blocks: HTMLElement[]): Promise<string | null> {
  if (blocks.length === 0) return null
  const width = doc.article.offsetWidth || doc.article.getBoundingClientRect().width
  if (!width) return null
  // the OFFSCREEN offset lives on a wrapper, never on the rasterized element
  // itself: the rasterizer inlines the element's computed styles onto its
  // clone, so a `left:-20000px` stage would paint 20000px outside the
  // foreignObject viewport — a blank PNG that looks like a working render
  const off = document.createElement('div')
  off.className = 'dia-editor-artifact'
  off.setAttribute('aria-hidden', 'true')
  off.style.cssText = `position:absolute;left:-20000px;top:0;width:${Math.round(width)}px;`
  const stage = document.createElement('article')
  stage.className = 'dia-doc'
  stage.style.cssText = `width:100%;max-height:${RENDER_MAX_PX}px;overflow:hidden;padding-top:0;`
  for (const el of blocks) stage.appendChild(el.cloneNode(true))
  off.appendChild(stage)
  doc.root.appendChild(off)
  try {
    return await rasterizeToDataUrl(stage)
  } finally {
    off.remove()
  }
}

/* ---------- selection ---------- */

/** the user's live text selection when it lands inside the article — the
 * DOM Selection, not state.selection, because prose selection is a range */
function docSelectionHtml(doc: Doc): string | null {
  const sel = state.selection
  if (sel.kind === 'element' && doc.article.contains(sel.el)) return sel.el.outerHTML
  let range: Range | null = null
  try {
    const live = (doc.root as unknown as { getSelection?: () => Selection | null }).getSelection?.()
      ?? document.getSelection()
    range = live && live.rangeCount > 0 && !live.isCollapsed ? live.getRangeAt(0) : null
  } catch { return null }
  if (!range) return null
  const anchor = range.startContainer.nodeType === Node.ELEMENT_NODE
    ? range.startContainer
    : range.startContainer.parentNode
  if (!anchor || !doc.article.contains(anchor)) return null
  const wrap = document.createElement('div')
  wrap.appendChild(range.cloneContents())
  const html = wrap.innerHTML.trim()
  return html || null
}

/* ---------- comments ---------- */

/** open threads anchored inside the section, newest note first — a comment
 * IS a request ("address c-3" has to be a one-liner). Read straight from
 * doc.commentsJson so a document loaded without the comment rail still
 * carries its threads. */
function sectionComments(doc: Doc, blocks: HTMLElement[]): ChatContext['comments'] {
  let threads: CommentThread[] = []
  try {
    threads = parseThreads(doc.commentsJson)
  } catch { return undefined }
  const inSection = new Set<Element>(blocks)
  const out: NonNullable<ChatContext['comments']> = []
  for (const t of threads) {
    if (t.status !== 'open') continue
    const block = blockFor(doc.article, t.anchor)
    if (!block || !inSection.has(block)) continue
    const last = t.notes[t.notes.length - 1]
    out.push({ id: t.id, quote: t.anchor.quote, note: last?.text ?? '' })
  }
  return out.length > 0 ? out : undefined
}

/* ---------- compile errors ---------- */

function compileErrors(): ChatContext['compileErrors'] {
  const s = compileState()
  if (s.status !== 'failed' || s.errors.length === 0) return undefined
  return s.errors.slice(0, 12).map((e) => ({ line: e.line, message: e.message }))
}
