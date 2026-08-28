/* Where the compiler broke the document, applied to the semantic surface.
 *
 * The semantic view is a continuous scroll of HTML; the compiled view is a
 * stack of page pictures. This module is what lets the first one show the
 * second one's page boundaries — so the two surfaces disagree on fidelity
 * (real type vs. an HTML projection) and agree on where a page ends.
 *
 * The breaks are the ENGINE'S, never the browser's. TeX breaks a paragraph
 * by optimizing the whole thing at once and hyphenates by its own patterns;
 * a browser fills lines greedily with the fonts it happens to have. Two
 * layouts of the same prose therefore break in different places, so a
 * browser-decided sheet boundary could not be labelled with a page number
 * without lying about it. What is on screen here comes from synctex, via
 * `documentLayout()` — the same box map the compiled view crops from.
 *
 * That map is per-compile state, so it goes stale. The doctrine is the one
 * doc/auxnumbers.ts already applies to \ref numbers: a stale answer shown as
 * current is worse than a provisional one shown as provisional. The last
 * known breaks stay on screen once the source moves on — they are still the
 * best answer anyone has — and say that they are provisional.
 *
 * Granularity is a block. Synctex reports that a paragraph's material stands
 * on pages 3 and 4; it does not report which of its lines broke. So a block
 * the engine split sits whole on the sheet where it STARTS, and that sheet
 * is marked as continuing from the page before. Splitting it here would mean
 * asking the browser where the line broke, which is the thing this module
 * exists not to do. */

import type { DocumentLayout } from './pagelayout'

/** the blocks the engine set on one page */
export interface PageGroup {
  /** the number the engine printed on this page */
  page: number
  blocks: HTMLElement[]
  /** the engine broke inside the block this group starts with, so the page
   * before this one holds some of the same prose */
  straddled: boolean
}

/** Group `blocks` by the page their material starts on.
 *
 * A block with no boxes of its own — a label, a `\clearpage`, anything that
 * typesets nothing — rides with its neighbours rather than opening a page:
 * it has no ink, so it cannot be evidence of where a page began. */
export function pageGroups(
  blocks: readonly HTMLElement[],
  layout: DocumentLayout | null,
): PageGroup[] {
  if (!layout) return []
  const groups: PageGroup[] = []
  // blocks before the first inked one have no page to belong to yet
  let pending: HTMLElement[] = []
  let lastInked = 0
  for (const block of blocks) {
    const id = block.getAttribute('data-dia-id')
    const rects = id ? layout.byBlock.get(id) ?? [] : []
    if (rects.length === 0) {
      if (groups.length === 0) pending.push(block)
      else groups[groups.length - 1].blocks.push(block)
      continue
    }
    let first = Infinity
    let last = 0
    for (const r of rects) {
      if (r.page < first) first = r.page
      if (r.page > last) last = r.page
    }
    const open = groups[groups.length - 1]
    if (open === undefined || first > open.page) {
      groups.push({
        page: first,
        blocks: [...pending, block],
        straddled: first <= lastInked,
      })
      pending = []
    } else {
      open.blocks.push(block)
    }
    if (last > lastInked) lastInked = last
  }
  // trailing blocks with no ink still have to be somewhere on screen
  if (pending.length > 0 && groups.length > 0) groups[0].blocks.unshift(...pending)
  return groups
}

/** Has the document moved since the compile these breaks came from?
 *
 * An unknown source counts as current: the layout was handed over for this
 * article and there is nothing better to compare it against. */
export function breaksAreCurrent(layout: DocumentLayout | null, source: string | undefined): boolean {
  if (layout === null) return false
  if (layout.source === undefined || source === undefined) return true
  return layout.source === source
}

/** The stylesheet that opens a gap in the article at each page break.
 *
 * Positional rules, not classes: a class would have to go on a block, and a
 * block belongs to the saved file. `:nth-child` reaches the same elements
 * from a stylesheet that is an editor artifact and never serialized, so the
 * document on disk does not learn that the editor is drawing pages.
 *
 * The article's own paper goes transparent because the sheets behind it are
 * the paper now; without that, one white column would run straight through
 * every gap. */
export function pageBreakCss(article: HTMLElement, groups: PageGroup[]): string {
  const children = [...article.children]
  const starts: string[] = []
  for (let i = 1; i < groups.length; i++) {
    const first = groups[i].blocks.find((b) => children.includes(b))
    const n = first === undefined ? -1 : children.indexOf(first) + 1
    if (n > 0) starts.push(`article.dia-doc > :nth-child(${n})`)
  }
  const gap = starts.length === 0
    ? ''
    : `\n${starts.join(',\n')} { margin-top: var(--de-page-gap, 46px); }`
  return `article.dia-doc { background: transparent; padding-top: 0; padding-bottom: 0; }${gap}\n`
}
