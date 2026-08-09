/* The compiled mirror. Four things are worth holding down:
 *
 *  1. the crop math — now a union over the engine's own boxes, so the
 *     interesting cases are the ones where a box says something the
 *     rectangle alone does not: containment, a column break, a frame;
 *  2. the byte-exactness invariant — a block wearing a crop must still emit
 *     its exact source bytes, and no crop may reach the file;
 *  3. the staleness rule: a picture of source that no longer exists is a
 *     lie, and must be gone the moment the block is edited;
 *  4. the fallbacks, because most of this file's job is degrading well —
 *     a daemon too old to report boxes, a compile synctex knows nothing
 *     about, a block the engine typeset nothing for.
 *
 * The crops of REAL papers are checked in blockmirror.fixture.test.ts,
 * against a captured box tree and — independently — against the ink of the
 * rendered pages. This file holds the pieces, that one holds the pictures.
 *
 * No network: the daemon paths are exercised in the browser, not here. */

import { beforeEach, describe, expect, it } from 'vitest'
import { state } from '../state'
import { loadDocFromTex, serializeDoc } from '../model/doc'
import { emitBlockTex } from '../latex/emit'
import { commitDocEdit } from './sync'
import { setText } from '../model/ops'
import {
  attachMirror, boxOwns, clearMirrors, cropBand, cropsFor, encloses, installBlockMirror,
  isMirrored, isPeeked, lineRangeOf, measureOf, mirrorTargets, normalizeBox, normalizeBoxMap,
  normalizeRecord, openBlock, pageExtent, padded, peekBlock, pruneMirrors, rectOf, toTopDown,
  bibliographyPages, isFillerPage, isInklessSectionMarker, isLayoutOnlySlice,
  type Pass, type SynctexBox,
} from './blockmirror'

const TEX = `\\documentclass{article}
\\begin{document}

\\section{Charts}

A paragraph before the chart.

\\begin{tikzpicture}
\\draw (0,0) -- (1,1);
\\draw (1,1) -- (2,0);
\\end{tikzpicture}

A paragraph after the chart.

\\begin{figure}
\\includegraphics{plot.pdf}
\\caption{A plot}
\\end{figure}

\\end{document}
`

function mount(tex = TEX) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const doc = loadDocFromTex(tex, host, 'charts.tex')
  state.deck = null
  state.doc = doc
  state.resetLog()
  return doc
}

const PNG = 'data:image/png;base64,iVBORw0KGgo='

beforeEach(() => {
  clearMirrors()
  state.doc = null
  state.deck = null
  state.resetLog()
})

/* ---------- the box, and the rectangle it stands for ---------- */

/** one box: x,y is TeX's reference point, so the rectangle runs x..x+w
 * across and y-h..y+d down — the daemon's declared `boxSemantics` */
function box(
  page: number, x: number, y: number, w: number, h: number, d: number,
  src: Array<[number, number]>, parent = -1,
): SynctexBox {
  return { page, x, y, w, h, d, src, parent }
}

describe('rectOf', () => {
  it('reads the box as height ABOVE the reference point and depth below', () => {
    // llama.tex p2, the first line of the paragraph on source lines 163-165
    const r = rectOf(box(2, 71.13, 351.15, 219.09, 7.54, 2.37, [[1, 163]]))
    expect(r.xMin).toBeCloseTo(71.13, 6)
    expect(r.xMax).toBeCloseTo(290.22, 6)
    expect(r.yMin).toBeCloseTo(343.61, 6)
    expect(r.yMax).toBeCloseTo(353.52, 6)
  })
})

describe('boxOwns', () => {
  const b = box(1, 0, 100, 100, 10, 2, [[1, 325], [1, 327]])
  it('is the block the material BEGINS in, not every block it touches', () => {
    // llama.tex's itemize on 327-333: the paragraph before it ends "…on a
    // total of 20 benchmarks:" and TeX broke that paragraph at
    // \begin{itemize}, so this line box reports both lines. It is the
    // paragraph's.
    expect(boxOwns(b, 1, 320, 325)).toBe(true)
    expect(boxOwns(b, 1, 327, 333)).toBe(false)
  })
  it('answers for one input file at a time', () => {
    expect(boxOwns(box(1, 0, 0, 10, 1, 0, [[84, 12]]), 1, 1, 100)).toBe(false)
    expect(boxOwns(box(1, 0, 0, 10, 1, 0, [[84, 12]]), 84, 1, 100)).toBe(true)
    // no main tag known: any file's lines are taken, which is what a
    // single-file document has always effectively done
    expect(boxOwns(box(1, 0, 0, 10, 1, 0, [[84, 12]]), null, 1, 100)).toBe(true)
  })
})

/* ---------- grouping a block's boxes into crops ---------- */

describe('cropsFor', () => {
  it('is one crop for lines of one column', () => {
    const all = [
      box(1, 71, 100, 219, 8, 2, [[1, 5]]),
      box(1, 71, 114, 219, 8, 2, [[1, 5]]),
      box(1, 71, 128, 219, 8, 2, [[1, 5]]),
    ]
    expect(cropsFor(all, [0, 1, 2])).toEqual([
      { page: 1, xMin: 71, xMax: 290, yMin: 92, yMax: 130 },
    ])
  })

  it('splits a paragraph that crossed a column break, one crop per column', () => {
    const all = [
      box(1, 71, 700, 219, 8, 2, [[1, 5]]),
      box(1, 71, 714, 219, 8, 2, [[1, 5]]),
      box(1, 307, 100, 219, 8, 2, [[1, 5]]),
    ]
    expect(cropsFor(all, [0, 1, 2])).toEqual([
      { page: 1, xMin: 71, xMax: 290, yMin: 692, yMax: 716 },
      { page: 1, xMin: 307, xMax: 526, yMin: 92, yMax: 102 },
    ])
  })

  it('splits a page from a page', () => {
    const all = [
      box(1, 71, 700, 219, 8, 2, [[1, 5]]),
      box(2, 71, 100, 219, 8, 2, [[1, 5]]),
    ]
    expect(cropsFor(all, [0, 1]).map((c) => c.page)).toEqual([1, 2])
  })

  it('keeps a hanging \\item label with the line it belongs to, not as a column', () => {
    // llama.tex p26: the bullet at x[101.5, 117.9] shares no column with its
    // item's text at x[122.9, 493.8]. Containment says they are one line.
    const all = [
      box(26, 100.99, 494, 392.8, 12, 2, [[1, 10]], -1),         // the list's vbox
      box(26, 122.9, 157.2, 370.9, 9.8, 0, [[1, 11]], 0),        // the item's line
      box(26, 101.5, 154.8, 16.4, 5, 0, [[1, 11]], 1),           // its bullet
    ]
    const crops = cropsFor(all, [1, 2])
    expect(crops.length).toBe(1)
    expect(crops[0].xMin).toBe(101.5)
  })

  it('cuts a crop where another block\'s line stands between two of ours', () => {
    // llama.tex's abstract sets a \footnote at the FOOT of its own column,
    // 380pt below its last line. One crop would have shown everything in
    // between.
    const all = [
      box(1, 71, 220, 219, 8, 2, [[1, 5]]),
      box(1, 71, 234, 219, 8, 2, [[1, 5]]),
      box(1, 71, 500, 219, 8, 2, [[1, 40]]),   // somebody else's paragraph
      box(1, 71, 772, 219, 8, 2, [[1, 5]]),    // our footnote
    ]
    const others = (): number[] => [2]
    expect(cropsFor(all, [0, 1, 3], others)).toEqual([
      { page: 1, xMin: 71, xMax: 290, yMin: 212, yMax: 236 },
      { page: 1, xMin: 71, xMax: 290, yMin: 764, yMax: 774 },
    ])
  })

  it('clips a crop to the box that encloses it', () => {
    // \includegraphics scales by wrapping the natural-size box in a
    // zero-width one, and synctex reports it UNSCALED: llama.tex's loss
    // curves report x up to 711.09 on a 595pt page.
    const all = [
      box(3, 307.29, 415.36, 219.09, 222.02, 0, [], -1),          // the float
      box(3, 307.29, 345.36, 219.09, 152.02, 0, [[1, 256]], 0),   // the picture's slot
      box(3, 307.29, 345.36, 0, 280.18, 0, [], 1),                // the scaling box
      box(3, 307.29, 345.36, 403.8, 280.18, 0, [[1, 256]], 2),    // the picture, unscaled
    ]
    expect(cropsFor(all, [1, 3])).toEqual([
      { page: 3, xMin: 307.29, xMax: 526.38, yMin: 193.34, yMax: 345.36 },
    ])
  })

  it('drops a box of ours that is a FRAME around somebody else\'s work', () => {
    // framed.sty draws its rules as one flat box and credits it to every
    // \end{framed} on the page — llama.tex p19's last dialogue box claimed
    // a rectangle around the first one's.
    const all = [
      box(19, 71, 330, 455, 175, 0, [[1, 1046], [1, 1113]]),  // the earlier frame's rules
      box(19, 100, 200, 392, 10, 0, [[1, 1030]]),             // a line inside it
      box(19, 71, 750, 455, 140, 0, [[1, 1113]]),             // ours
    ]
    const crops = cropsFor(all, [0, 2], () => [1])
    expect(crops).toEqual([{ page: 19, xMin: 71, xMax: 526, yMin: 610, yMax: 750 }])
  })

  it('keeps an inner box of our own line, whatever line it is credited to', () => {
    // a $…$ inside a paragraph's line box is credited to the source line
    // the formula was typed on; counting it as an intruder threw the whole
    // line away
    const all = [
      box(10, 307, 152, 219, 9.8, 0, [[1, 836], [1, 838]]),
      box(10, 350, 152, 30, 8, 0, [[1, 837]], 0),
    ]
    expect(cropsFor(all, [0], () => [1]).length).toBe(1)
  })
})

describe('encloses', () => {
  it('walks the engine\'s own parent chain', () => {
    const all = [box(1, 0, 0, 10, 1, 0, []), box(1, 0, 0, 5, 1, 0, [], 0), box(1, 0, 0, 2, 1, 0, [], 1)]
    expect(encloses(all, 0, 2)).toBe(true)
    expect(encloses(all, 2, 0)).toBe(false)
  })
})

/* ---------- the page as a whole ---------- */

describe('pageExtent', () => {
  it('is the union of what the engine credited, so a folio is simply not in it', () => {
    // measured: neither thesis.tex nor llama.tex reports a single box below
    // its text block on any page — a page number is painted by the output
    // routine and leaves no box behind
    const boxes = [
      box(3, 90.3, 70.5, 433.7, 7.6, 0, [[1, 1]]),      // the running header
      box(3, 90.3, 732.1, 433.7, 570, 0, [[1, 20]]),    // the text block
      box(3, 0, 0, 0, 0, 0, []),                        // an uncredited frame
    ]
    expect(pageExtent(boxes)).toEqual({ xMin: 90.3, xMax: 524, yMin: 62.9, yMax: 732.1 })
  })
  it('is null for a page with nothing credited on it', () => {
    expect(pageExtent([])).toBeNull()
  })
})

describe('isFillerPage', () => {
  it('is true for the running header a \\cleardoublepage leaves alone on a page', () => {
    // thesis.tex page 14: one box, y[62.9, 70.5]
    expect(isFillerPage([box(14, 90.3, 70.5, 433.7, 7.6, 0, [[1, 270]])])).toBe(true)
  })
  it('is true for a page with nothing on it at all', () => {
    expect(isFillerPage([])).toBe(true)
  })
  it('is false once a page holds real content below the header', () => {
    // thesis.tex page 15: header y[62.9, 70.5], body y[162.2, 732.1]
    expect(isFillerPage([
      box(15, 90.3, 70.5, 433.7, 7.6, 0, [[1, 270]]),
      box(15, 90.3, 732.1, 433.7, 570, 0, [[1, 277]]),
    ])).toBe(false)
  })
})

describe('toTopDown', () => {
  it('leaves a top-down map alone', () => {
    const r = { xMin: 1, xMax: 2, yMin: 10, yMax: 20 }
    expect(toTopDown(r, 800, 'topDownPt')).toBe(r)
  })
  it('mirrors a bottom-up one through the page height, swapping the edges', () => {
    expect(toTopDown({ xMin: 1, xMax: 2, yMin: 10, yMax: 20 }, 800, 'bottomUpPt'))
      .toEqual({ xMin: 1, xMax: 2, yMin: 780, yMax: 790 })
  })
})

describe('padded', () => {
  it('adds a breath of paper and clips to the sheet', () => {
    expect(padded({ xMin: 1, xMax: 100, yMin: 1, yMax: 100 }, 595, 842))
      .toEqual({ xMin: 0, xMax: 102, yMin: 0, yMax: 102 })
    expect(padded({ xMin: 500, xMax: 594, yMin: 700, yMax: 841 }, 595, 842))
      .toEqual({ xMin: 498, xMax: 595, yMin: 698, yMax: 842 })
  })
})

describe('measureOf', () => {
  it('is the median text block, so one freak page cannot shrink the document', () => {
    // llama.tex sets 25 of 27 pages to 455.24pt and puts one rotated table
    // on a page whose largest box is 732.79pt wide
    expect(measureOf([455.24, 455.24, 455.24, 732.79, 564.65])).toBe(455.24)
  })
  it('is zero when the daemon reported no pages', () => {
    expect(measureOf([])).toBe(0)
  })
})

/* ---------- reading the wire ---------- */

describe('normalizeBoxMap', () => {
  it('takes the boxes, the main tag and the measure', () => {
    const map = normalizeBoxMap({
      boxes: [{ page: 1, x: 1, y: 2, w: 3, h: 4, d: 5, src: [[1, 9]], parent: -1 }],
      mainTag: 1,
      pages: [{ n: 1, w: 455.24, h: 700 }],
    })
    expect(map.boxes).toEqual([{ page: 1, x: 1, y: 2, w: 3, h: 4, d: 5, src: [[1, 9]], parent: -1 }])
    expect(map.mainTag).toBe(1)
    expect(map.measure).toBe(455.24)
  })

  it('is empty for a daemon that predates boxes — no crops, never wrong ones', () => {
    const map = normalizeBoxMap({ lines: [{ line: 1, page: 1, y: 10 }], xSemantics: 'leftPt' })
    expect(map.boxes).toEqual([])
    expect(map.mainTag).toBeNull()
    expect(map.measure).toBe(0)
  })

  it('is empty for a response that is not a map at all', () => {
    expect(normalizeBoxMap(null).boxes).toEqual([])
    expect(normalizeBoxMap('nope').boxes).toEqual([])
  })

  it('drops every parent link when any box was refused', () => {
    // the indices are positional: one box short and every link after it
    // points at the wrong box, which is worse than pointing at none
    const map = normalizeBoxMap({
      boxes: [
        { page: 1, x: 0, y: 0, w: 10, h: 1, d: 0, src: [], parent: -1 },
        { page: 1, x: 0, y: 'nope' },
        { page: 1, x: 0, y: 0, w: 5, h: 1, d: 0, src: [], parent: 0 },
      ],
    })
    expect(map.boxes.length).toBe(2)
    expect(map.boxes.every((b) => b.parent === -1)).toBe(true)
  })
})

describe('normalizeBox', () => {
  it('refuses a box missing a coordinate', () => {
    expect(normalizeBox({ page: 1, x: 0, y: 0, w: 1, h: 1 })).toBeNull()
    expect(normalizeBox({ page: 1, x: 0, y: Infinity, w: 1, h: 1, d: 0 })).toBeNull()
    expect(normalizeBox(null)).toBeNull()
  })
  it('keeps only well-formed [tag, line] pairs, and defaults the parent', () => {
    expect(normalizeBox({ page: 1, x: 0, y: 0, w: 1, h: 1, d: 0, src: [[1, 9], [2], 'x'] }))
      .toEqual({ page: 1, x: 0, y: 0, w: 1, h: 1, d: 0, src: [[1, 9]], parent: -1 })
  })
})


/* ---------- reading the wire ---------- */

describe('normalizeRecord', () => {
  it('takes x and w when the daemon reports them', () => {
    expect(normalizeRecord({ line: 3, page: 1, y: 100, x: 72, w: 234 }))
      .toEqual({ line: 3, page: 1, y: 100, x: 72, w: 234 })
  })

  it('drops x and w a daemon does not report, keeping the record', () => {
    expect(normalizeRecord({ line: 3, page: 1, y: 100 })).toEqual({ line: 3, page: 1, y: 100 })
  })

  it('refuses a record missing the three fields the crop needs', () => {
    expect(normalizeRecord({ line: 3, page: 1 })).toBeNull()
    expect(normalizeRecord({ line: 3, page: 1, y: Infinity })).toBeNull()
    expect(normalizeRecord(null)).toBeNull()
  })
})

/* ---------- targets and line ranges ---------- */

describe('mirrorTargets', () => {
  it('takes every top-level block, prose included — the mirror is the document', () => {
    const doc = mount()
    const targets = mirrorTargets(doc.article)
    expect(targets.some((t) => t.matches('p'))).toBe(true)
    expect(targets.some((t) => t.matches('h2.dia-sec'))).toBe(true)
    expect(targets.some((t) => t.matches('div.dia-tex-island'))).toBe(true)
    expect(targets.some((t) => t.matches('figure.dia-figure'))).toBe(true)
  })

  it('leaves the derived header alone — it is not source-backed', () => {
    const doc = mount('\\documentclass{article}\n\\title{T}\n\\begin{document}\n'
      + '\\maketitle\n\nBody text.\n\n\\end{document}\n')
    expect(mirrorTargets(doc.article).some((t) => t.matches('header.dia-doc-header'))).toBe(false)
  })

  it('names the lines a block\'s TEXT is on, not the blank ones around it', () => {
    // a block's slice starts at the newline that ended the block before it;
    // taken literally, every paragraph would claim the line above it
    const doc = mount()
    const heading = mirrorTargets(doc.article).find((t) => t.matches('h2.dia-sec'))!
    const para = mirrorTargets(doc.article).find((t) =>
      t.matches('p') && (t.textContent ?? '').startsWith('A paragraph before'))!
    const lines = doc.source.text.split('\n')
    const h = lineRangeOf(doc, heading)!
    const pr = lineRangeOf(doc, para)!
    expect(lines[h.from - 1]).toContain('\\section{Charts}')
    expect(lines[pr.from - 1]).toContain('A paragraph before')
    expect(pr.from).toBeGreaterThan(h.to)
  })

  it('maps a block to the source lines it occupies', () => {
    const doc = mount()
    const island = mirrorTargets(doc.article).find((t) => t.matches('div.dia-tex-island'))!
    const range = lineRangeOf(doc, island)!
    const lines = doc.source.text.split('\n')
    expect(lines[range.from - 1]).toContain('\\begin{tikzpicture}')
    expect(lines[range.to - 1]).toContain('\\end{tikzpicture}')
  })
})

/* ---------- the byte-exactness invariant ---------- */

describe('a crop is not part of the document', () => {
  it('leaves the island emitting its exact source bytes', () => {
    const doc = mount()
    const island = mirrorTargets(doc.article).find((t) => t.matches('div.dia-tex-island'))!
    const id = island.getAttribute('data-dia-id')!
    const span = doc.source.spanOf(id)!
    const exact = doc.source.text.slice(span.start, span.end)

    expect(emitBlockTex(island)).toBe(exact)
    attachMirror(doc, island, [{ url: PNG }])
    expect(island.querySelector('.de-mirror')).not.toBeNull()
    expect(emitBlockTex(island)).toBe(exact)
  })

  it('leaves mirrored paragraphs and headings emitting their exact source bytes', () => {
    const doc = mount()
    let checked = 0
    for (const block of mirrorTargets(doc.article)) {
      if (!block.matches('p, h2.dia-sec')) continue
      const span = doc.source.spanOf(block.getAttribute('data-dia-id')!)!
      const exact = doc.source.text.slice(span.start, span.end)
      attachMirror(doc, block, [{ url: PNG, widthPct: 52 }])
      expect(emitBlockTex(block)).toBe(exact)
      checked++
    }
    expect(checked).toBeGreaterThan(1)
  })

  it('leaves a mirrored figure emitting its exact source bytes', () => {
    const doc = mount()
    const figure = mirrorTargets(doc.article).find((t) => t.matches('figure.dia-figure'))!
    const span = doc.source.spanOf(figure.getAttribute('data-dia-id')!)!
    const exact = doc.source.text.slice(span.start, span.end)
    attachMirror(doc, figure, [{ url: PNG }])
    expect(emitBlockTex(figure)).toBe(exact)
  })

  it('never reaches the saved artifact', () => {
    const doc = mount()
    for (const t of mirrorTargets(doc.article)) attachMirror(doc, t, [{ url: PNG }])
    const html = serializeDoc(doc)
    expect(html).not.toContain('de-mirror')
    expect(html).not.toContain('the compiled render')
    expect(html).not.toContain('data:image/png')
    // and the source block is untouched
    expect(html).toContain('tikzpicture')
  })

  it('is invisible to the emitter inside a wrapped environment too', () => {
    // an abstract or a center block rebuilds itself from its CHILDREN, and
    // one of those children is now a picture of the PDF
    const doc = mount('\\documentclass{article}\n\\begin{document}\n\n'
      + '\\begin{center}\nCentred prose.\n\\end{center}\n\n\\end{document}\n')
    const wrap = mirrorTargets(doc.article).find((t) => t.matches('div.dia-wrap'))!
    const span = doc.source.spanOf(wrap.getAttribute('data-dia-id')!)!
    const exact = doc.source.text.slice(span.start, span.end)
    attachMirror(doc, wrap, [{ url: PNG }])
    const inner = wrap.querySelector('p')!
    inner.textContent = 'Rewritten centred prose.'
    expect(emitBlockTex(wrap)).toBe(exact.replace('Centred prose.', 'Rewritten centred prose.'))
  })

  it('touches nothing on the block itself — no class, no style, no attribute', () => {
    const doc = mount()
    const para = mirrorTargets(doc.article).find((t) => t.matches('p'))!
    const before = [...para.attributes].map((a) => `${a.name}=${a.value}`).sort()
    attachMirror(doc, para, [{ url: PNG, widthPct: 50 }])
    expect([...para.attributes].map((a) => `${a.name}=${a.value}`).sort()).toEqual(before)
  })
})

/* ---------- lending a block its HTML form back ---------- */

/* A find highlight is a Range over the block's HTML text, and the mirror
 * hides exactly that text — so on a compiled paper the shading landed under
 * a picture. peekBlock is the loan that fixes it; what it must not do is
 * cost the document its crop, or its bytes. */

describe('peekBlock', () => {
  it('reveals the HTML form and hides the crop, both reversibly', () => {
    const doc = mount()
    const para = mirrorTargets(doc.article).find((t) => t.matches('p'))!
    attachMirror(doc, para, [{ url: PNG }])
    const crop = para.querySelector<HTMLElement>('.de-mirror')!

    expect(peekBlock(para)).toBe(true)
    // the class the hiding rule keys on is gone, so the block's own children
    // render; the picture is out of the flow instead
    expect(para.querySelector('.de-mirror')).toBeNull()
    expect(para.querySelector('.de-mirror-peeked')).toBe(crop)
    expect(crop.style.display).toBe('none')
    expect(isPeeked(para)).toBe(true)

    peekBlock(null)
    expect(para.querySelector('.de-mirror')).toBe(crop)
    expect(crop.style.display).toBe('')
    expect(isPeeked(para)).toBe(false)
  })

  it('keeps the crop alive across a whole search — no url is revoked', () => {
    const doc = mount()
    const para = mirrorTargets(doc.article).find((t) => t.matches('p'))!
    attachMirror(doc, para, [{ url: PNG }])
    const crop = para.querySelector<HTMLElement>('.de-mirror')!
    const img = crop.querySelector('img')!.src

    for (let i = 0; i < 20; i++) { peekBlock(para); peekBlock(null) }
    expect(para.querySelector('.de-mirror')).toBe(crop)
    expect(crop.querySelector('img')!.src).toBe(img)
    expect(isMirrored(para)).toBe(true)
  })

  it('lends only one block at a time', () => {
    const doc = mount()
    const [a, b] = mirrorTargets(doc.article).filter((t) => t.matches('p'))
    attachMirror(doc, a, [{ url: PNG }])
    attachMirror(doc, b, [{ url: PNG }])
    peekBlock(a)
    peekBlock(b)
    expect(isPeeked(a)).toBe(false)
    expect(a.querySelector('.de-mirror')).not.toBeNull()
    expect(isPeeked(b)).toBe(true)
  })

  it('a peeked block still emits its exact source bytes and never reaches the file', () => {
    const doc = mount()
    const para = mirrorTargets(doc.article).find((t) => t.matches('p'))!
    const span = doc.source.spanOf(para.getAttribute('data-dia-id')!)!
    const exact = doc.source.text.slice(span.start, span.end)
    attachMirror(doc, para, [{ url: PNG }])
    peekBlock(para)

    expect(emitBlockTex(para)).toBe(exact)
    const html = serializeDoc(doc)
    expect(html).not.toContain('de-mirror')
    expect(html).not.toContain('de-mirror-peeked')
    expect(html).not.toContain('data:image/png')
  })

  it('touches nothing on the block itself, mid-peek', () => {
    const doc = mount()
    const para = mirrorTargets(doc.article).find((t) => t.matches('p'))!
    const before = [...para.attributes].map((a) => `${a.name}=${a.value}`).sort()
    attachMirror(doc, para, [{ url: PNG }])
    peekBlock(para)
    expect([...para.attributes].map((a) => `${a.name}=${a.value}`).sort()).toEqual(before)
  })

  it('a peeked crop is still detached when its source changes', () => {
    const doc = mount()
    const para = mirrorTargets(doc.article).find((t) => t.matches('p'))!
    attachMirror(doc, para, [{ url: 'data:,a' }])
    peekBlock(para)
    commitDocEdit(doc, para, [setText(para, 'A rewritten paragraph.')], 'edit text')
    pruneMirrors()
    // the renamed picture must go with the ordinary one — matching only
    // `de-mirror` would leave it hanging over a revoked url
    expect(para.querySelector('.de-mirror, .de-mirror-peeked')).toBeNull()
    expect(isPeeked(para)).toBe(false)
    expect(isMirrored(para)).toBe(false)
  })

  it('clearMirrors takes the loan back with the crops', () => {
    const doc = mount()
    const para = mirrorTargets(doc.article).find((t) => t.matches('p'))!
    attachMirror(doc, para, [{ url: PNG }])
    peekBlock(para)
    clearMirrors()
    expect(para.querySelector('.de-mirror, .de-mirror-peeked')).toBeNull()
    expect(isPeeked(para)).toBe(false)
  })

  it('a block with no crop is not peekable, and asking leaves the last loan closed', () => {
    const doc = mount()
    const para = mirrorTargets(doc.article).find((t) => t.matches('p'))!
    const bare = mirrorTargets(doc.article).filter((t) => t.matches('p'))[1]
    attachMirror(doc, para, [{ url: PNG }])
    peekBlock(para)
    expect(peekBlock(bare)).toBe(false)
    expect(isPeeked(para)).toBe(false)
    expect(para.querySelector('.de-mirror')).not.toBeNull()
  })
})

/* ---------- staleness ---------- */

describe('crops clear when their source changes', () => {
  it('drops the edited block\'s crop and keeps the others', () => {
    const doc = mount()
    const island = mirrorTargets(doc.article).find((t) => t.matches('div.dia-tex-island'))!
    const figure = mirrorTargets(doc.article).find((t) => t.matches('figure.dia-figure'))!
    attachMirror(doc, island, [{ url: 'data:,a' }])
    attachMirror(doc, figure, [{ url: 'data:,b' }])

    const pre = island.querySelector('pre')!
    commitDocEdit(doc, island, [setText(pre, '\\begin{tikzpicture}\n\\draw (0,0) -- (3,3);\n\\end{tikzpicture}')], 'edit island')
    pruneMirrors()

    expect(island.querySelector('.de-mirror')).toBeNull()
    expect(isMirrored(island)).toBe(false)
    expect(figure.querySelector('.de-mirror')).not.toBeNull()
    expect(isMirrored(figure)).toBe(true)
  })

  it('an edited paragraph is HTML again at once', () => {
    const doc = mount()
    const para = mirrorTargets(doc.article).find((t) => t.matches('p'))!
    attachMirror(doc, para, [{ url: 'data:,a' }])
    commitDocEdit(doc, para, [setText(para, 'A rewritten paragraph.')], 'edit text')
    pruneMirrors()
    expect(para.querySelector('.de-mirror')).toBeNull()
    expect(para.textContent).toContain('A rewritten paragraph.')
  })

  it('drops everything when the whole source is recommitted', () => {
    installBlockMirror()
    const doc = mount()
    for (const t of mirrorTargets(doc.article)) attachMirror(doc, t, [{ url: 'data:,x' }])
    expect(doc.article.querySelectorAll('.de-mirror').length).toBeGreaterThan(0)

    state.bus.emit({ type: 'blocks-changed' })
    expect(doc.article.querySelectorAll('.de-mirror').length).toBe(0)
  })

  it('drops a crop whose block left the document', () => {
    const doc = mount()
    const island = mirrorTargets(doc.article).find((t) => t.matches('div.dia-tex-island'))!
    attachMirror(doc, island, [{ url: 'data:,a' }])
    island.remove()
    pruneMirrors()
    expect(island.querySelector('.de-mirror')).toBeNull()
  })

  it('replaces rather than stacks when a compile refreshes it', () => {
    const doc = mount()
    const island = mirrorTargets(doc.article).find((t) => t.matches('div.dia-tex-island'))!
    attachMirror(doc, island, [{ url: 'data:,a' }])
    attachMirror(doc, island, [{ url: 'data:,b' }])
    expect(island.querySelectorAll('.de-mirror').length).toBe(1)
    expect(island.querySelector('img')?.getAttribute('src')).toBe('data:,b')
  })

  it('says nothing about recompiling when no compile is coming', () => {
    // the compile state in a test process is offline: an edited block is
    // simply an HTML block again, with no promise attached
    const doc = mount()
    const para = mirrorTargets(doc.article).find((t) => t.matches('p'))!
    attachMirror(doc, para, [{ url: 'data:,a' }])
    commitDocEdit(doc, para, [setText(para, 'Rewritten.')], 'edit text')
    pruneMirrors()
    expect(para.querySelector('.de-stale')).toBeNull()
  })
})

/* ---------- rasterizing ---------- */

describe('cropBand', () => {
  it('takes the rectangle exactly, so every block in a column shares a scale', () => {
    const canvas = document.createElement('canvas')
    if (typeof canvas.getContext !== 'function' || !canvas.getContext('2d')) return
    canvas.width = 200
    canvas.height = 100
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 200, 100)
    // one short mark inside the window: the ink trim this used to end with
    // would have cropped tight to it, which is what made two blocks of one
    // column display at two different scales
    ctx.fillStyle = '#000000'
    ctx.fillRect(30, 40, 10, 6)
    const out = cropBand(
      { image: canvas, scale: 1, wPt: 200, hPt: 100 },
      { xMin: 20, xMax: 120, yMin: 0, yMax: 100 },
    )
    expect(out?.width).toBe(100)
    expect(out?.height).toBe(100)
  })

  it('clips a rectangle that reaches off the sheet rather than refusing it', () => {
    const canvas = document.createElement('canvas')
    if (typeof canvas.getContext !== 'function' || !canvas.getContext('2d')) return
    canvas.width = 100
    canvas.height = 100
    const out = cropBand(
      { image: canvas, scale: 1, wPt: 100, hPt: 100 },
      { xMin: -10, xMax: 400, yMin: -10, yMax: 400 },
    )
    expect(out?.width).toBe(100)
    expect(out?.height).toBe(100)
  })
})


/* ---------- the recompiling marker ---------- */

describe('the recompiling marker', () => {
  /* it only appears when a compile is actually coming, so the engine has to
   * be announced first — and once it is inside a <p>, it had better be as
   * invisible to the emitter as the crop is */
  const ENGINE = {
    engine: 'tectonic', path: '/usr/bin/tectonic', version: 'tectonic 0.15.0',
    synctex: true, downloadable: false, managed: false, detail: null,
  }

  it('marks a block the user OPENED and then edited', () => {
    // opening hands the crop back before a single keystroke, so the
    // bookkeeping that watches crops no longer speaks for this block
    window.dispatchEvent(new CustomEvent('dia-service-status', { detail: { online: true, tex: ENGINE } }))
    const doc = mount()
    const para = mirrorTargets(doc.article).find((t) => t.matches('p'))!
    attachMirror(doc, para, [{ url: PNG }])
    openBlock(para)
    expect(para.querySelector('.de-mirror')).toBeNull()
    expect(para.querySelector('.de-stale')).toBeNull() // opened, not yet edited

    commitDocEdit(doc, para, [setText(para, 'Rewritten.')], 'edit text')
    pruneMirrors()
    expect(para.querySelector('.de-stale')).not.toBeNull()
    window.dispatchEvent(new CustomEvent('dia-service-status', { detail: { online: false, tex: null } }))
  })

  it('marks an edited block and leaves its bytes alone', () => {
    window.dispatchEvent(new CustomEvent('dia-service-status', { detail: { online: true, tex: ENGINE } }))
    const doc = mount()
    const para = mirrorTargets(doc.article).find((t) => t.matches('p'))!
    const span = doc.source.spanOf(para.getAttribute('data-dia-id')!)!
    const exact = doc.source.text.slice(span.start, span.end)
    attachMirror(doc, para, [{ url: PNG }])

    commitDocEdit(doc, para, [setText(para, 'A rewritten paragraph.')], 'edit text')
    pruneMirrors()
    expect(para.querySelector('.de-stale')).not.toBeNull()
    expect(emitBlockTex(para)).toBe(exact.replace('A paragraph before the chart.', 'A rewritten paragraph.'))
    expect(serializeDoc(doc)).not.toContain('de-stale')

    // and a fresh crop takes the marker away again
    attachMirror(doc, para, [{ url: PNG }])
    expect(para.querySelector('.de-stale')).toBeNull()
    window.dispatchEvent(new CustomEvent('dia-service-status', { detail: { online: false, tex: null } }))
  })
})

/* ---------- unmirrored-block classification ---------- */

function run(boxes: SynctexBox[], mainTag: number | null = 1): Pass {
  return {
    jobId: 'test', dpi: 130, ySemantics: 'topDownPt',
    boxes, mainTag, dims: new Map(), measure: 0,
    pages: { async rasterize() { return null } }, live: () => true,
  }
}

describe('bibliographyPages', () => {
  const boxes = [
    box(11, 71, 200, 219, 8, 2, [[1, 100]]),
    box(12, 71, 300, 219, 8, 2, [[1, 120]]),
    box(17, 71, 100, 219, 8, 2, [[1, 900]]),
    box(18, 71, 100, 219, 8, 2, [[1, 950]]),
  ]
  it('spans from the last page before the block to the page before the next content', () => {
    expect(bibliographyPages(run(boxes), { from: 894, to: 897 })).toEqual([12, 13, 14, 15, 16])
  })
  it('caps at eight pages and handles a document that ends in references', () => {
    const tail = boxes.slice(0, 2)
    expect(bibliographyPages(run(tail), { from: 894, to: 897 })).toEqual([12, 13, 14, 15, 16, 17, 18, 19])
  })
  it('is empty when nothing precedes the block', () => {
    expect(bibliographyPages(run([]), { from: 5, to: 6 })).toEqual([])
  })
  it('keeps the page the body and the next section both touch', () => {
    // cot.tex: references start mid-page 10 and the appendix resumes on 10
    const shared = [
      box(10, 71, 105, 219, 8, 2, [[1, 1599]]),
      box(10, 71, 752, 219, 8, 2, [[1, 1604]]),
    ]
    expect(bibliographyPages(run(shared), { from: 1600, to: 1601 })).toEqual([10])
  })
  it('issue #22: widens past a filler prev when next is otherwise a degenerate one-page range', () => {
    // thesis.tex's own shape: \backmatter's box lands on 13 (departing
    // page) and 14 (the \cleardoublepage filler, which holds NOTHING but
    // its running header); \appendix's \chapter leaves a closing box on 15
    // — the references' own page — before its own skip to 17. Without the
    // filler rule the range is [14] and page 15 is dropped.
    const thesis = [
      box(13, 90, 732.1, 434, 570, 0, [[1, 270]]),
      box(14, 90, 70.46, 434, 7.6, 0, [[1, 270]]),
      box(15, 90, 732.1, 434, 570, 0, [[1, 277]]),
      box(16, 90, 70.46, 434, 7.6, 0, [[1, 277]]),
      box(17, 90, 181.34, 434, 110, 0, [[1, 277]]),
    ]
    expect(bibliographyPages(run(thesis), { from: 272, to: 273 })).toEqual([14, 15])
  })
  it('does not widen when the range already has room', () => {
    const wide = [
      box(11, 90, 70.46, 434, 7.6, 0, [[1, 100]]),
      box(20, 90, 100, 434, 8, 2, [[1, 900]]),
    ]
    expect(bibliographyPages(run(wide), { from: 894, to: 897 }))
      .toEqual([11, 12, 13, 14, 15, 16, 17, 18])
  })
  it('reads only main.tex\'s lines — the .bbl\'s own are another file\'s', () => {
    const mixed = [
      box(11, 71, 200, 219, 8, 2, [[1, 100]]),
      box(12, 71, 300, 219, 8, 2, [[84, 900]]),  // a bibliography entry
      box(17, 71, 100, 219, 8, 2, [[1, 900]]),
    ]
    expect(bibliographyPages(run(mixed), { from: 894, to: 897 })).toEqual([11, 12, 13, 14, 15, 16])
  })
})


describe('isInklessSectionMarker', () => {
  it('hides a bare beamer \\section', () => {
    expect(isInklessSectionMarker('\\section{Motivation}', 'beamer')).toBe(true)
  })
  it('hides a beamer \\subsection, and one carrying its own \\label', () => {
    expect(isInklessSectionMarker('\\subsection{Detail}', 'beamer')).toBe(true)
    expect(isInklessSectionMarker('\\section{Motivation}\n\\label{sec:motivation}', 'beamer')).toBe(true)
  })
  it('leaves an article or book \\section visible — same slice, different class', () => {
    expect(isInklessSectionMarker('\\section{Motivation}', 'article')).toBe(false)
    expect(isInklessSectionMarker('\\section{Motivation}', 'book')).toBe(false)
    expect(isInklessSectionMarker('\\section{Motivation}', undefined)).toBe(false)
  })
  it('leaves prose alone even under beamer', () => {
    expect(isInklessSectionMarker('\\section{Motivation} and some words', 'beamer')).toBe(false)
  })
})

describe('isLayoutOnlySlice', () => {
  it('recognizes page-break and layout command runs', () => {
    expect(isLayoutOnlySlice('\\clearpage')).toBe(true)
    expect(isLayoutOnlySlice('\\newpage')).toBe(true)
    expect(isLayoutOnlySlice('\\clearpage\n\\appendix\n\\onecolumn\n\\pagenumbering{Roman}')).toBe(true)
    expect(isLayoutOnlySlice('\\bigskip \\noindent')).toBe(true)
  })
  it('never hides real content', () => {
    expect(isLayoutOnlySlice('\\clearpage Some words follow.')).toBe(false)
    expect(isLayoutOnlySlice('Prose only.')).toBe(false)
    expect(isLayoutOnlySlice('\\bibliography{custom}')).toBe(false)
  })
})
