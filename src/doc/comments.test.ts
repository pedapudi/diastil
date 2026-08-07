/* Comments: the re-anchor ladder, op invertibility, and the promise that a
 * comment is never an edit — the source and the body come out unchanged. */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { state } from '../state'
import { loadDoc, loadDocFromTex, serializeDoc, exportTex, type Doc } from '../model/doc'
import { setInlineHtml } from '../model/ops'
import { validateDocHtml } from '../model/validate'
import { commitDocEdit } from './sync'
import {
  anchorFromRange, bindCommentStore, blockFor, CommentStore, parseThreads,
  rangeForAnchor, type CommentAnchor,
} from './comments'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')

const SAMPLE = `\\documentclass{article}
\\begin{document}

\\section{One}\\label{sec:one}

The tokenizer is the keystone of the whole design.

A second paragraph that says something else entirely.

\\end{document}
`

function mount(tex = SAMPLE, name = 'sample.tex'): Doc {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const doc = loadDocFromTex(tex, host, name)
  state.deck = null
  state.doc = doc
  state.resetLog()
  return doc
}

function mountHtml(html: string, name = 'sample.html'): Doc {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const doc = loadDoc(html, host, name)
  state.deck = null
  state.doc = doc
  state.resetLog()
  return doc
}

function textNodes(root: Node): Text[] {
  const out: Text[] = []
  for (const child of root.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) out.push(child as Text)
    else out.push(...textNodes(child))
  }
  return out
}

/** the range a user would make by selecting `quote` inside `block` */
function selectIn(block: HTMLElement, quote: string): Range {
  for (const node of textNodes(block)) {
    const at = node.data.indexOf(quote)
    if (at < 0) continue
    const range = document.createRange()
    range.setStart(node, at)
    range.setEnd(node, at + quote.length)
    return range
  }
  throw new Error(`no text node in the block holds ${JSON.stringify(quote)}`)
}

function paragraphs(doc: Doc): HTMLElement[] {
  return [...doc.article.querySelectorAll<HTMLElement>('p')]
}

/** anchor a thread on `quote` inside `block` and return the store + id */
function comment(doc: Doc, block: HTMLElement, quote: string, note = 'look at this') {
  const store = bindCommentStore(doc)!
  const anchor = anchorFromRange(doc, selectIn(block, quote))
  if (!anchor) throw new Error('no anchor')
  const { op, id } = store.addThread(anchor, note, 'sunil')
  state.apply(op)
  return { store, id, anchor }
}

beforeEach(() => {
  state.doc = null
  state.deck = null
  state.resetLog()
  bindCommentStore(null)
})

describe('anchoring', () => {
  it('an anchor records offsets, the quote, and its context', () => {
    const doc = mount()
    const p = paragraphs(doc)[0]
    const anchor = anchorFromRange(doc, selectIn(p, 'keystone'))!
    expect(anchor.block).toBe('p:nth-of-type(1)')
    expect(anchor.quote).toBe('keystone')
    expect(p.textContent!.slice(anchor.start, anchor.end)).toBe('keystone')
    expect(anchor.prefix.endsWith('is the ')).toBe(true)
    expect(anchor.suffix.startsWith(' of the')).toBe(true)
  })

  it('resolves back to a live range over the same text', () => {
    const doc = mount()
    const p = paragraphs(doc)[0]
    const anchor = anchorFromRange(doc, selectIn(p, 'keystone'))!
    expect(rangeForAnchor(doc.article, anchor)!.toString()).toBe('keystone')
  })

  it('refuses a whitespace-only selection', () => {
    const doc = mount()
    const p = paragraphs(doc)[0]
    const node = textNodes(p)[0]
    const at = node.data.indexOf(' is')
    const range = document.createRange()
    range.setStart(node, at)
    range.setEnd(node, at + 1)
    expect(anchorFromRange(doc, range)).toBeNull()
  })

  it('creating a thread changes neither the source nor the body', () => {
    const doc = mount()
    const bodyBefore = doc.article.outerHTML
    comment(doc, paragraphs(doc)[0], 'keystone')
    expect(doc.source.text).toBe(SAMPLE)
    expect(exportTex(doc)).toContain(SAMPLE)
    expect(doc.article.outerHTML).toBe(bodyBefore)
  })
})

describe('the re-anchor ladder', () => {
  it('rung 1: untouched text keeps the recorded offsets', () => {
    const doc = mount()
    const { store, id } = comment(doc, paragraphs(doc)[0], 'keystone')
    const before = { ...store.byId(id)!.anchor }
    expect(store.reanchor()).toBe(false)
    expect(store.byId(id)!.anchor).toEqual(before)
    expect(store.byId(id)!.status).toBe('open')
  })

  it('rung 2: an edit ABOVE the anchor in the same block shifts it', () => {
    const doc = mount()
    const p = paragraphs(doc)[0]
    const { store, id } = comment(doc, p, 'keystone')
    const start = store.byId(id)!.anchor.start

    commitDocEdit(doc, p, [setInlineHtml(p,
      'Truly, the tokenizer is the keystone of the whole design.')], 'Edit text')
    expect(store.reanchor()).toBe(true)

    const t = store.byId(id)!
    expect(t.status).toBe('open')
    expect(t.anchor.start).toBe(start + 'Truly, '.length)
    expect(p.textContent!.slice(t.anchor.start, t.anchor.end)).toBe('keystone')
  })

  it('rung 2: context picks the right one of two identical quotes', () => {
    const doc = mount('\\begin{document}\n\nalpha the pin beta the pin gamma\n\n\\end{document}\n')
    const p = paragraphs(doc)[0]
    const store = bindCommentStore(doc)!
    // anchor the SECOND occurrence
    const text = p.textContent!
    const second = text.indexOf('the pin', text.indexOf('the pin') + 1)
    const node = textNodes(p)[0]
    const range = document.createRange()
    range.setStart(node, second)
    range.setEnd(node, second + 'the pin'.length)
    const { op, id } = store.addThread(anchorFromRange(doc, range)!)
    state.apply(op)

    commitDocEdit(doc, p, [setInlineHtml(p, 'XX alpha the pin beta the pin gamma')], 'Edit text')
    store.reanchor()

    const t = store.byId(id)!
    expect(t.status).toBe('open')
    // still the second occurrence, now shifted by the inserted prefix
    expect(t.anchor.start).toBe(second + 3)
    expect(t.anchor.prefix.endsWith('beta ')).toBe(true)
  })

  it('rung 3: a unique quote recovers ACROSS blocks', () => {
    const doc = mount()
    const [first, second] = paragraphs(doc)
    const { store, id } = comment(doc, first, 'keystone')

    // the sentence moves to the other paragraph and leaves the first
    commitDocEdit(doc, first, [setInlineHtml(first, 'Nothing to see here.')], 'Edit text')
    commitDocEdit(doc, second, [setInlineHtml(second,
      'The tokenizer is the keystone of it all.')], 'Edit text')
    expect(store.reanchor()).toBe(true)

    const t = store.byId(id)!
    expect(t.status).toBe('open')
    expect(t.anchor.block).toBe('p:nth-of-type(2)')
    expect(blockFor(doc.article, t.anchor)).toBe(second)
    expect(second.textContent!.slice(t.anchor.start, t.anchor.end)).toBe('keystone')
  })

  it('rung 3 refuses to guess when the quote is no longer unique', () => {
    const doc = mount()
    const [first, second] = paragraphs(doc)
    const { store, id } = comment(doc, first, 'keystone')
    commitDocEdit(doc, first, [setInlineHtml(first, 'gone')], 'Edit text')
    commitDocEdit(doc, second, [setInlineHtml(second, 'keystone here and keystone there')], 'Edit text')
    store.reanchor()
    expect(store.byId(id)!.status).toBe('orphaned')
  })

  it('rung 4: an edit INSIDE the quote orphans the thread — never drops it', () => {
    const doc = mount()
    const p = paragraphs(doc)[0]
    const { store, id } = comment(doc, p, 'keystone')

    commitDocEdit(doc, p, [setInlineHtml(p, 'The tokenizer is the cornerstone of the whole design.')], 'Edit text')
    expect(store.reanchor()).toBe(true)

    const t = store.byId(id)!
    expect(t.status).toBe('orphaned')
    expect(store.list()).toHaveLength(1)
    expect(t.notes[0].text).toBe('look at this')
  })

  it('a whole-block rewrite that keeps the quote re-anchors by search', () => {
    const doc = mount()
    const p = paragraphs(doc)[0]
    const { store, id } = comment(doc, p, 'keystone')
    commitDocEdit(doc, p, [setInlineHtml(p,
      'Everything else about this sentence is different, but keystone survives.')], 'Edit text')
    store.reanchor()
    const t = store.byId(id)!
    expect(t.status).toBe('open')
    expect(p.textContent!.slice(t.anchor.start, t.anchor.end)).toBe('keystone')
  })

  it('an orphan comes back to life when its text returns', () => {
    const doc = mount()
    const p = paragraphs(doc)[0]
    const { store, id } = comment(doc, p, 'keystone')

    commitDocEdit(doc, p, [setInlineHtml(p, 'nothing here')], 'Edit text')
    store.reanchor()
    expect(store.byId(id)!.status).toBe('orphaned')

    commitDocEdit(doc, p, [setInlineHtml(p, 'the keystone is back')], 'Edit text')
    store.reanchor()
    expect(store.byId(id)!.status).toBe('open')
    expect(p.textContent!.slice(store.byId(id)!.anchor.start, store.byId(id)!.anchor.end))
      .toBe('keystone')
  })

  it('a resolved thread stays resolved through re-anchoring', () => {
    const doc = mount()
    const p = paragraphs(doc)[0]
    const { store, id } = comment(doc, p, 'keystone')
    state.apply(store.setStatus(id, 'resolved')!)
    commitDocEdit(doc, p, [setInlineHtml(p, 'Truly, the tokenizer is the keystone here.')], 'Edit text')
    store.reanchor()
    expect(store.byId(id)!.status).toBe('resolved')
  })
})

describe('comment ops', () => {
  it('addNote then undo restores commentsJson exactly', () => {
    const doc = mount()
    const { store, id } = comment(doc, paragraphs(doc)[0], 'keystone')
    const before = doc.commentsJson

    state.apply(store.addNote(id, 'and another thing', 'kim')!)
    expect(doc.commentsJson).not.toBe(before)
    expect(store.byId(id)!.notes).toHaveLength(2)

    state.undo()
    expect(doc.commentsJson).toBe(before)
    expect(store.byId(id)!.notes).toHaveLength(1)

    state.redo()
    expect(store.byId(id)!.notes[1].by).toBe('kim')
  })

  it('status, edit, and delete are all invertible', () => {
    const doc = mount()
    const { store, id } = comment(doc, paragraphs(doc)[0], 'keystone')
    const before = doc.commentsJson

    state.apply(store.setStatus(id, 'resolved')!)
    expect(store.byId(id)!.status).toBe('resolved')
    state.undo()
    expect(doc.commentsJson).toBe(before)

    state.apply(store.editNote(id, 0, 'reworded')!)
    expect(store.byId(id)!.notes[0].text).toBe('reworded')
    state.undo()
    expect(doc.commentsJson).toBe(before)

    state.apply(store.remove(id)!)
    expect(store.list()).toHaveLength(0)
    state.undo()
    expect(doc.commentsJson).toBe(before)
    expect(store.byId(id)).not.toBeNull()
  })

  it('threads sort in document order regardless of creation order', () => {
    const doc = mount()
    const [first, second] = paragraphs(doc)
    const store = bindCommentStore(doc)!
    state.apply(store.addThread(anchorFromRange(doc, selectIn(second, 'entirely'))!).op)
    state.apply(store.addThread(anchorFromRange(doc, selectIn(first, 'keystone'))!).op)
    expect(store.inDocumentOrder().map((t) => t.anchor.quote)).toEqual(['keystone', 'entirely'])
  })

  it('emits comments-changed on apply', () => {
    const doc = mount()
    let seen = 0
    const off = state.bus.on((e) => { if (e.type === 'comments-changed') seen++ })
    comment(doc, paragraphs(doc)[0], 'keystone')
    off()
    expect(seen).toBe(1)
  })
})

describe('the store as the owner of commentsJson', () => {
  it('addThread → save → reload keeps the thread anchored', () => {
    const doc = mount()
    comment(doc, paragraphs(doc)[0], 'keystone', 'tighten this')

    const reloaded = mountHtml(serializeDoc(doc))
    const store = bindCommentStore(reloaded)!
    expect(store.reanchor()).toBe(false) // the ladder's first rung still holds

    const t = store.list()[0]
    expect(t.notes[0]).toEqual({ by: 'sunil', at: t.notes[0].at, text: 'tighten this' })
    const block = blockFor(reloaded.article, t.anchor)!
    expect(block.textContent!.slice(t.anchor.start, t.anchor.end)).toBe('keystone')
  })

  it('addThread → export .tex → reimport keeps the thread anchored', () => {
    const doc = mount()
    comment(doc, paragraphs(doc)[0], 'keystone', 'tighten this')

    const tex = exportTex(doc)
    expect(tex.startsWith(SAMPLE)).toBe(true) // the source itself is untouched
    expect(tex).toContain('% === dia:comments v1 ===')

    const again = mount(tex)
    const store = bindCommentStore(again)!
    expect(store.reanchor()).toBe(false)
    expect(store.list()[0].anchor.quote).toBe('keystone')
    expect(again.source.text).toBe(SAMPLE)
  })

  it('a saved artifact with comments still validates', () => {
    const doc = mount()
    comment(doc, paragraphs(doc)[0], 'keystone')
    const report = validateDocHtml(serializeDoc(doc))
    expect(report.findings.filter((f) => f.level === 'error')).toEqual([])
  })

  it('the read-only runtime ships only when there is something to mark', () => {
    const doc = mount()
    expect(serializeDoc(doc)).not.toContain('dia-doc-runtime')
    comment(doc, paragraphs(doc)[0], 'keystone')
    const html = serializeDoc(doc)
    expect(html).toContain('<script id="dia-doc-runtime">')
    // and the artifact is still byte-stable across a reload
    expect(serializeDoc(mountHtml(html))).toBe(html)
  })
})

describe('tolerant parsing', () => {
  it('unreadable JSON yields no threads instead of throwing', () => {
    expect(parseThreads('{not json')).toEqual([])
    expect(parseThreads('{"version":1}')).toEqual([])
  })

  it('drops thread-shaped junk but keeps the good ones', () => {
    const json = JSON.stringify({
      version: 1,
      threads: [
        null,
        { status: 'open' }, // no id
        { id: 'c-1', status: 'nonsense', anchor: { quote: 'x' }, notes: 'no' },
      ],
    })
    const threads = parseThreads(json)
    expect(threads).toHaveLength(1)
    expect(threads[0].id).toBe('c-1')
    expect(threads[0].status).toBe('open') // unknown status normalizes to open
    expect(threads[0].notes).toEqual([])
  })

  it('rejects a malformed thread at the profile boundary', () => {
    const doc = mount()
    comment(doc, paragraphs(doc)[0], 'keystone')
    const bad = serializeDoc(doc).replace('"status":"open"', '"status":"maybe"')
    const report = validateDocHtml(bad)
    expect(report.findings.some((f) => f.rule === 'doc/comments')).toBe(true)
  })

  it('the Python mirror agrees on every thread-schema case (lockstep)', () => {
    const probe = spawnSync('python3', ['--version'])
    if (probe.status !== 0) return // no python here — the mirror runs in service CI
    const doc = mount()
    comment(doc, paragraphs(doc)[0], 'keystone')
    const good = serializeDoc(doc)
    const swap = (threads: string): string =>
      good.replace(/(id="dia-comments">\n)[^\n]*/, `$1{"version":1,"threads":${threads}}`)

    const cases: string[] = [
      good,
      swap('[7]'),
      swap('[{"status":"open","anchor":{"quote":"x"},"notes":[]}]'),
      swap('[{"id":"c-1","status":"maybe","anchor":{"quote":"x"},"notes":[]}]'),
      swap('[{"id":"c-1","status":"open","notes":[]}]'),
      swap('[{"id":"c-1","status":"open","anchor":{"quote":""},"notes":[]}]'),
      swap('[{"id":"c-1","status":"open","anchor":{"quote":"x"}}]'),
    ]
    // guard against a vacuous pass: every case after the first must really
    // be rejected, or the swap regex stopped matching
    for (const html of cases.slice(1)) {
      expect(validateDocHtml(html).findings.some((f) => f.rule === 'doc/comments')).toBe(true)
    }
    for (const html of cases) {
      const ts = validateDocHtml(html).findings
        .filter((f) => f.level === 'error')
        .map((f) => `${f.rule} ${f.locator}`)
      const r = spawnSync('python3', ['-c', [
        'import sys, json',
        `sys.path.insert(0, ${JSON.stringify(join(repo, 'service'))})`,
        'from dia_service.validate import validate_doc_html',
        'rep = validate_doc_html(sys.stdin.read())',
        'print(json.dumps([f["rule"] + " " + f["locator"] for f in rep["findings"] if f["level"] == "error"]))',
      ].join('\n')], { input: html, encoding: 'utf-8' })
      expect(r.status, r.stderr).toBe(0)
      expect(JSON.parse(r.stdout.trim()), 'python findings match TS').toEqual(ts)
    }
  })
})

describe('locators', () => {
  it('tolerate a leading article > prefix', () => {
    const doc = mount()
    const anchor: CommentAnchor = {
      block: 'article > p:nth-of-type(2)',
      start: 0, end: 1, quote: 'A', prefix: '', suffix: '',
    }
    expect(blockFor(doc.article, anchor)).toBe(paragraphs(doc)[1])
  })

  it('a store on a document with no comments starts empty', () => {
    const doc = mount()
    expect(new CommentStore(doc).list()).toEqual([])
  })
})
