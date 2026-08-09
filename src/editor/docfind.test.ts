/* Find & replace over the native document view.
 *
 * Three lines are held here: the matcher is pure and whitespace-honest, a
 * search is DECORATION (it must not move one byte of the document), and a
 * replace is an EDIT that round-trips through LaTeX escaping and undoes in
 * one step. */

import { beforeEach, describe, expect, it } from 'vitest'
import { state } from '../state'
import { exportTex, loadDoc, loadDocFromTex, serializeDoc } from '../model/doc'
import {
  buildReplaceOp, closeDocFind, collectDocMatches, docFindOwnsKey, findInText, mountDocFind,
  openDocFind, replaceAllIn,
} from './docfind'

const SAMPLE = `\\documentclass{article}
\\begin{document}

\\section{One}\\label{sec:one}

First paragraph, with \\textbf{style}   and
  deliberate    odd whitespace.

\\begin{equation}\\label{eq:e}
e = mc^2
\\end{equation}

Inline $\\alpha + \\sin x$ inside prose, and \\verb|code_here| too.

\\hspace{1cm} raw island line.

\\begin{verbatim}
verbatim body with foo
\\end{verbatim}

Second paragraph references \\ref{sec:one} and \\ref{eq:e}.

\\end{document}
`

function mount(tex = SAMPLE, name = 'sample.tex') {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const doc = loadDocFromTex(tex, host, name)
  state.deck = null
  state.doc = doc
  state.resetLog()
  return doc
}

beforeEach(() => {
  state.doc = null
  state.resetLog()
})

/* ---------- the matcher ---------- */

describe('findInText', () => {
  it('finds every literal occurrence, case-insensitively by default', () => {
    expect(findInText('Foo foo FOO', 'foo')).toEqual([
      { start: 0, end: 3 }, { start: 4, end: 7 }, { start: 8, end: 11 },
    ])
  })

  it('honours case sensitivity', () => {
    expect(findInText('Foo foo', 'foo', { caseSensitive: true })).toEqual([{ start: 4, end: 7 }])
  })

  it('whole word skips embedded occurrences', () => {
    const hits = findInText('cat concatenate cat-like cat_x', 'cat', { wholeWord: true })
    expect(hits.map((h) => h.start)).toEqual([0, 16])
  })

  it('never returns overlapping hits', () => {
    expect(findInText('aaaa', 'aa').map((h) => h.start)).toEqual([0, 2])
  })

  it('an empty needle matches nothing', () => {
    expect(findInText('anything', '')).toEqual([])
  })

  it('matches across the whitespace the renderer collapses', () => {
    // the DOM text carries the source's newline and run of spaces; the
    // reader sees one space, so that is what they will type
    const hits = findInText('style   and\n  deliberate', 'and deliberate')
    expect(hits).toHaveLength(1)
    expect('style   and\n  deliberate'.slice(hits[0].start, hits[0].end)).toBe('and\n  deliberate')
  })

  it('collapses whitespace in the needle too', () => {
    expect(findInText('a b', 'a  b')).toHaveLength(1)
  })
})

describe('replaceAllIn (the source view\'s replace)', () => {
  it('replaces every occurrence and reports the count', () => {
    expect(replaceAllIn('a foo b foo', 'foo', 'bar')).toEqual({ text: 'a bar b bar', count: 2 })
  })

  it('the replacement is literal — $& and \\1 are not patterns', () => {
    expect(replaceAllIn('x', 'x', '$& \\1').text).toBe('$& \\1')
  })
})

/* ---------- what "a match" means in a rendered document ---------- */

describe('collectDocMatches', () => {
  it('matches prose and reports the containing block', () => {
    const doc = mount()
    const { matches } = collectDocMatches(doc, 'paragraph')
    expect(matches).toHaveLength(2)
    expect(matches.every((m) => m.replaceable)).toBe(true)
    expect(matches[0].block?.tagName).toBe('P')
  })

  it('never matches the RENDERED glyphs of math — its truth is data-dia-tex', () => {
    const doc = mount()
    // temml renders \sin as the glyphs "sin" and \alpha as "α"; matching
    // those would let a replace mangle a formula that never held them
    expect(collectDocMatches(doc, 'sin').matches).toHaveLength(0)
    expect(collectDocMatches(doc, 'α').matches).toHaveLength(0)
  })

  it('counts math hits against the TeX truth and reports them as elsewhere', () => {
    const doc = mount()
    const r = collectDocMatches(doc, '\\sin')
    expect(r.matches).toHaveLength(0)
    expect(r.elsewhere).toBe(1)
  })

  it('a tex island is raw LaTeX: findable, never replaceable here', () => {
    const doc = mount('\\documentclass{article}\n\\begin{document}\n\n'
      + '\\begin{tikzpicture}\n\\draw (0,0) -- (1,1);\n\\end{tikzpicture}\n\n'
      + 'Prose with draw in it.\n\n\\end{document}\n')
    const { matches } = collectDocMatches(doc, 'draw')
    expect(matches).toHaveLength(2)
    expect(matches.filter((m) => m.replaceable)).toHaveLength(1)
  })

  it('a derived ref number is not writable text', () => {
    const doc = mount()
    const { matches } = collectDocMatches(doc, '1')
    expect(matches.length).toBeGreaterThan(0)
    expect(matches.some((m) => m.replaceable)).toBe(false)
  })

  it('a match never crosses an element boundary', () => {
    const doc = mount()
    // "with style and" reads as one phrase but the emphasis splits it
    expect(collectDocMatches(doc, 'with style').matches).toHaveLength(0)
    expect(collectDocMatches(doc, 'style').matches).toHaveLength(1)
  })
})

/* ---------- decoration, not content ---------- */

describe('a search moves nothing', () => {
  it('leaves the article DOM, the artifact and the .tex byte-identical', () => {
    const doc = mount()
    const beforeHtml = doc.article.innerHTML
    const beforeFile = serializeDoc(doc)
    const beforeTex = exportTex(doc)
    for (const term of ['paragraph', 'e', 'the', 'foo', 'draw']) collectDocMatches(doc, term)
    expect(doc.article.innerHTML).toBe(beforeHtml)
    expect(serializeDoc(doc)).toBe(beforeFile)
    expect(exportTex(doc)).toBe(beforeTex)
  })

  it('the artifact reloads to itself with a search in flight', () => {
    const doc = mount()
    collectDocMatches(doc, 'paragraph')
    const html = serializeDoc(doc)
    const host = document.createElement('div')
    document.body.appendChild(host)
    expect(serializeDoc(loadDoc(html, host, 'x.html'))).toBe(html)
  })
})

/* ---------- replace is an edit ---------- */

describe('buildReplaceOp', () => {
  it('patches the source and undoes byte-exactly', () => {
    const doc = mount()
    const { matches } = collectDocMatches(doc, 'deliberate')
    const op = buildReplaceOp(doc, matches, 'intentional', 'Replace')
    expect(op).not.toBeNull()
    state.apply(op!)
    expect(exportTex(doc)).toContain('intentional')
    state.undo()
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('replace-all across many blocks is ONE undo step', () => {
    const doc = mount()
    const { matches } = collectDocMatches(doc, 'paragraph')
    expect(new Set(matches.map((m) => m.block)).size).toBe(2)
    state.apply(buildReplaceOp(doc, matches, 'passage', 'Replace all')!)
    const out = exportTex(doc)
    expect(out).toContain('First passage')
    expect(out).toContain('Second passage')
    state.undo()
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('several hits inside one text node all land', () => {
    const doc = mount('\\documentclass{article}\n\\begin{document}\n\n'
      + 'ab ab ab.\n\n\\end{document}\n')
    const { matches } = collectDocMatches(doc, 'ab')
    state.apply(buildReplaceOp(doc, matches, 'xy', 'Replace all')!)
    expect(doc.source.text).toContain('xy xy xy.')
  })

  it('a hit inside inline markup keeps the markup', () => {
    const doc = mount()
    const { matches } = collectDocMatches(doc, 'style')
    state.apply(buildReplaceOp(doc, matches, 'flair', 'Replace')!)
    expect(doc.source.text).toContain('\\textbf{flair}')
  })

  it('hits in the same block, one nested inside the other\'s host', () => {
    const doc = mount('\\documentclass{article}\n\\begin{document}\n\n'
      + 'zed and \\textbf{zed} again.\n\n\\end{document}\n')
    const { matches } = collectDocMatches(doc, 'zed')
    expect(matches).toHaveLength(2)
    state.apply(buildReplaceOp(doc, matches, 'qux', 'Replace all')!)
    expect(doc.source.text).toContain('qux and \\textbf{qux} again.')
  })

  it('refuses the unwritable ones and replaces the rest', () => {
    const doc = mount('\\documentclass{article}\n\\begin{document}\n\n'
      + '\\begin{tikzpicture}\n\\draw (0,0);\n\\end{tikzpicture}\n\n'
      + 'Prose with draw in it.\n\n\\end{document}\n')
    const { matches } = collectDocMatches(doc, 'draw')
    state.apply(buildReplaceOp(doc, matches, 'sketch', 'Replace all')!)
    expect(doc.source.text).toContain('Prose with sketch in it.')
    expect(doc.source.text).toContain('\\draw (0,0);')
  })

  it('nothing replaceable yields no op (an empty undo step is a lie)', () => {
    const doc = mount()
    const { matches } = collectDocMatches(doc, 'α')
    expect(buildReplaceOp(doc, matches, 'beta', 'Replace')).toBeNull()
  })
})

/* ---------- escaping: the replacement survives export and re-parse ---------- */

describe('replacement escaping', () => {
  /** the characters emit.ts's escapeTex escapes with a leading backslash —
   * the ones a replacement is most likely to carry, and the ones that
   * silently change what LaTeX compiles if they get through raw */
  const HOSTILE = ['%', '_', '&', '#', '$', '{', '}']

  const roundTrip = (replacement: string): string => {
    const doc = mount()
    const { matches } = collectDocMatches(doc, 'deliberate')
    state.apply(buildReplaceOp(doc, matches, replacement, 'Replace')!)
    const host = document.createElement('div')
    document.body.appendChild(host)
    return loadDocFromTex(exportTex(doc), host, 's.tex').article.textContent ?? ''
  }

  it('every hostile character round-trips through export and re-parse', () => {
    for (const ch of HOSTILE) {
      expect(roundTrip(`a${ch}b`), `char ${ch}`).toContain(`a${ch}b`)
    }
  })

  /* Two characters do NOT survive, and neither failure belongs to this
   * module — both are in the shared escape/parse pair, which this change
   * does not own. They are pinned here as `fails` so the day someone fixes
   * them, this test turns red and gets promoted into the one above.
   *
   *  - `\` : escapeTex substitutes `\textbackslash{}` and then its own NEXT
   *    pass escapes the braces it just wrote, so the export carries
   *    `\textbackslash\{\}` — bytes that set "\{}" in the PDF. The parser is
   *    fine: `a\textbackslash{}b` reads back as `a\b`. Every edit path has
   *    this bug (typing a backslash into a paragraph does the same), not
   *    just replace.
   *  - `~` and `^` : escapeTex writes correct LaTeX (`\textasciitilde{}`,
   *    `\textasciicircum{}`) so the EXPORT compiles right, but parse.ts's
   *    SYMBOL_CMD table does not carry those two macros, so reopening the
   *    file shows the macro name as literal text. */
  it.fails('KNOWN GAP: a literal backslash survives (escapeTex double-escapes it)', () => {
    expect(roundTrip('a\\b')).toContain('a\\b')
  })

  it.fails('KNOWN GAP: tilde and caret survive re-parse (SYMBOL_CMD has neither)', () => {
    expect(roundTrip('a~b')).toContain('a~b')
  })

  it('property: random hostile strings survive a full round trip', () => {
    const alphabet = [...HOSTILE, 'a', 'Z', '9', ' ', '-']
    let seed = 20260809
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    for (let i = 0; i < 40; i++) {
      const len = 1 + rnd(8)
      let repl = ''
      for (let j = 0; j < len; j++) repl += alphabet[rnd(alphabet.length)]
      repl = repl.trim()
      if (!repl) continue
      const doc = mount()
      const { matches } = collectDocMatches(doc, 'deliberate')
      state.apply(buildReplaceOp(doc, matches, repl, 'Replace')!)
      const host = document.createElement('div')
      document.body.appendChild(host)
      const back = loadDocFromTex(exportTex(doc), host, 's.tex')
      expect(back.article.textContent, `replacement ${JSON.stringify(repl)}`).toContain(repl)
    }
  })
})

/* ---------- the bar, driven ---------- */

describe('the find bar', () => {
  let host: HTMLElement

  const field = (i: number): HTMLInputElement =>
    host.querySelectorAll<HTMLInputElement>('.de-find-row .dn-input')[i]
  const countEl = (): HTMLElement => host.querySelector('.de-find-count')!
  const noteEl = (): HTMLElement => host.querySelector('.de-find-note')!
  const btn = (label: string): HTMLButtonElement =>
    [...host.querySelectorAll<HTMLButtonElement>('.de-find button')].find((b) => b.textContent === label)!
  const type = (f: HTMLInputElement, v: string): void => {
    f.value = v
    f.dispatchEvent(new Event('input', { bubbles: true }))
  }

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    mountDocFind(host, () => true)
  })

  it('counts, steps and wraps', () => {
    mount()
    openDocFind()
    type(field(0), 'paragraph')
    expect(countEl().textContent).toBe('1/2')
    btn('›').click()
    expect(countEl().textContent).toBe('2/2')
    btn('›').click()
    expect(countEl().textContent).toBe('1/2')
    btn('‹').click()
    expect(countEl().textContent).toBe('2/2')
  })

  it('says where the matches it will not touch are', () => {
    mount()
    openDocFind()
    type(field(0), '\\sin')
    expect(countEl().textContent).toBe('0')
    expect(noteEl().hidden).toBe(false)
    expect(noteEl().textContent).toContain('1 more in math')
  })

  it('replace rewrites the current match; replace-all takes the rest in one op', () => {
    const doc = mount()
    openDocFind(true)
    type(field(0), 'paragraph')
    type(field(1), 'passage')
    btn('replace').click()
    expect(doc.source.text).toContain('First passage')
    expect(doc.source.text).toContain('Second paragraph')
    expect(countEl().textContent).toBe('1/1')
    btn('all').click()
    expect(doc.source.text).toContain('Second passage')
    expect(countEl().textContent).toBe('0')
    state.undo()
    state.undo()
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('closing drops the matches', () => {
    mount()
    openDocFind()
    type(field(0), 'paragraph')
    closeDocFind()
    expect(host.querySelector<HTMLElement>('.de-find')!.hidden).toBe(true)
  })

  it('an edit from elsewhere re-runs the search rather than holding dead nodes', () => {
    const doc = mount()
    openDocFind()
    type(field(0), 'paragraph')
    expect(countEl().textContent).toBe('1/2')
    const { matches } = collectDocMatches(doc, 'Second paragraph')
    state.apply(buildReplaceOp(doc, matches, 'Second passage', 'Replace')!)
    expect(countEl().textContent).toBe('1/1')
  })
})

/* ---------- whose keystroke is it ---------- */

describe('docFindOwnsKey', () => {
  const barHost = document.createElement('div')
  document.body.appendChild(barHost)
  mountDocFind(barHost, () => true)

  /** composedPath is only readable while the event is being dispatched */
  const ownsFrom = (target: Element): boolean => {
    let owns = false
    const listen = (ev: Event): void => { owns = docFindOwnsKey(ev as KeyboardEvent) }
    window.addEventListener('keydown', listen)
    target.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'f', ctrlKey: true, bubbles: true, composed: true,
    }))
    window.removeEventListener('keydown', listen)
    return owns
  }

  it('leaves the browser its own find when no document is open', () => {
    state.doc = null
    expect(ownsFrom(document.body)).toBe(false)
  })

  it('claims the key over the document surface', () => {
    mount()
    expect(ownsFrom(document.body)).toBe(true)
  })

  it('claims it mid-edit inside the article — that is still the document', () => {
    const doc = mount()
    const p = doc.article.querySelector('p')!
    p.setAttribute('contenteditable', 'true')
    expect(ownsFrom(p)).toBe(true)
  })

  it('yields to a rail field', () => {
    mount()
    const rail = document.createElement('aside')
    rail.className = 'de-rail'
    const field = document.createElement('input')
    rail.append(field)
    document.body.append(rail)
    expect(ownsFrom(field)).toBe(false)
  })

  it('yields to the source view, which runs its own find', () => {
    mount()
    const src = document.createElement('div')
    src.className = 'de-src'
    const ta = document.createElement('textarea')
    src.append(ta)
    document.body.append(src)
    expect(ownsFrom(ta)).toBe(false)
  })
})
