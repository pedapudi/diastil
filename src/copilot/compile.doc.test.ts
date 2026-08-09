/* The document half of the copilot: section addressing, set-tex, and the
 * rule that makes the rest safe — every compiled op is WRAPPED, so a
 * proposal can never move the DOM without moving the LaTeX with it. */

import { beforeEach, describe, expect, it } from 'vitest'
import { state } from '../state'
import { exportTex, loadDocFromTex } from '../model/doc'
import { compileOps, resolveDocTarget, texFragmentError } from './compile'
import { clearPreview, startPreview } from './preview'
import type { ProposedOp } from '../types'

const SAMPLE = `\\documentclass{article}
\\begin{document}

\\section{Introduction}\\label{sec:intro}

We begin with a claim, stated \\textbf{plainly}.

A second paragraph of the introduction.

\\section{Methods}\\label{sec:methods}

The method is described here, referring to \\ref{sec:intro}.

\\begin{equation}\\label{eq:e}
e = mc^2
\\end{equation}

\\begin{tikzpicture}
\\draw (0,0) -- (1,1);
\\end{tikzpicture}

\\section{Results}

Results follow.

\\end{document}
`

function mount(tex = SAMPLE) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const doc = loadDocFromTex(tex, host, 'sample.tex')
  state.deck = null
  state.doc = doc
  state.resetLog()
  state.setCurrentBlock(0)
  return doc
}

function op(p: Partial<ProposedOp> & { action: ProposedOp['action']; target: string }): ProposedOp {
  return { label: p.label ?? 'change', value: p.value, extra: p.extra, action: p.action, target: p.target }
}

beforeEach(() => {
  state.deck = null
  state.doc = null
  state.resetLog()
})

describe('resolveDocTarget', () => {
  it('addresses sections by number and by title', () => {
    const doc = mount()
    const find = (t: string, block = 0) => resolveDocTarget(t, doc.article, block)
    expect(find('section 2')?.textContent).toBe('Methods')
    expect(find('section "Methods"')).toBe(find('section 2'))
    expect(find("section 'Results'")?.tagName).toBe('H2')
    expect(find('section 9')).toBeNull()
  })

  it('addresses blocks inside a section, with ordinals', () => {
    const doc = mount()
    const find = (t: string, block = 0) => resolveDocTarget(t, doc.article, block)
    expect(find('section 1 para 2')?.textContent).toContain('second paragraph')
    expect(find('section 1 para')?.textContent).toContain('We begin')
    expect(find('section "Methods" eq 1')?.getAttribute('data-dia-tex')).toContain('mc^2')
    expect(find('section 2 island')?.textContent).toContain('tikzpicture')
  })

  it('"block N" addresses top-level blocks in flow order', () => {
    const doc = mount()
    const blocks = [...doc.article.children]
    expect(resolveDocTarget('block 1', doc.article, 0)).toBe(blocks[0])
    expect(resolveDocTarget('block 3', doc.article, 0)).toBe(blocks[2])
    expect(resolveDocTarget('block 99', doc.article, 0)).toBeNull()
  })

  it('bare descriptors resolve against the current section first', () => {
    const doc = mount()
    const methodsPara = [...doc.article.children].findIndex(
      (el) => (el.textContent ?? '').startsWith('The method'))
    expect(resolveDocTarget('para', doc.article, 0)?.textContent).toContain('We begin')
    expect(resolveDocTarget('para', doc.article, methodsPara)?.textContent).toContain('The method')
  })

  it('ids, selectors and exact text still resolve', () => {
    const doc = mount()
    const id = doc.article.querySelector('p')!.getAttribute('data-dia-id')!
    expect(resolveDocTarget(id, doc.article, 0)?.tagName).toBe('P')
    expect(resolveDocTarget('div.dia-math', doc.article, 0)?.tagName).toBe('DIV')
    expect(resolveDocTarget('"A second paragraph of the introduction."', doc.article, 0)?.tagName).toBe('P')
    expect(resolveDocTarget('nothing here matches', doc.article, 0)).toBeNull()
  })
})

describe('doc-mode compileOps: wrapping', () => {
  it('a text op patches the source and inverts byte-exactly', () => {
    const doc = mount()
    const target = doc.article.querySelector('p')!
    const res = compileOps([op({ action: 'set-inline-html', target: 'section 1 para 1', value: 'Rewritten.' })])
    expect(res.skipped).toEqual([])
    expect(res.ops).toHaveLength(1)

    res.ops[0].apply()
    expect(target.textContent).toBe('Rewritten.')
    // the DOM did not move alone: the source moved with it
    expect(doc.source.text).toContain('Rewritten.')
    expect(doc.source.text).not.toContain('stated \\textbf{plainly}')
    // and every other byte is untouched
    const out = exportTex(doc)
    const head = SAMPLE.indexOf('We begin')
    expect(out.slice(0, head)).toBe(SAMPLE.slice(0, head))

    res.ops[0].invert().apply()
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('ops landing in the same block share one wrapper; different blocks get their own', () => {
    const doc = mount()
    const same = compileOps([
      op({ action: 'set-attr', target: 'section 2 eq 1', extra: { name: 'data-dia-label' }, value: 'eq:x' }),
      op({ action: 'set-attr', target: 'section 2 eq 1', extra: { name: 'data-dia-env' }, value: 'equation' }),
    ])
    expect(same.ops).toHaveLength(1)
    const across = compileOps([
      op({ action: 'set-inline-html', target: 'section 1 para 1', value: 'A.' }),
      op({ action: 'set-inline-html', target: 'section 1 para 2', value: 'B.' }),
    ])
    expect(across.ops).toHaveLength(2)
    for (const o of across.ops) o.apply()
    expect(exportTex(doc)).toContain('A.')
    expect(exportTex(doc)).toContain('B.')
    for (const o of [...across.ops].reverse()) o.invert().apply()
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('a proposal that resolves outside a source-backed block is skipped', () => {
    mount('\\documentclass{article}\\title{T}\\begin{document}\\maketitle\n\nBody text.\n\n\\end{document}\n')
    const res = compileOps([op({ action: 'set-text', target: 'h1.dia-title', value: 'New title' })])
    expect(res.ops).toEqual([])
    expect(res.skipped[0].reason).toContain('not inside a source-backed block')
  })

  it('an unresolvable target is skipped with a reason, never a throw', () => {
    mount()
    const res = compileOps([op({ action: 'set-text', target: 'section 42 para 7', value: 'x' })])
    expect(res.ops).toEqual([])
    expect(res.skipped[0].reason).toContain('did not resolve')
  })
})

describe('doc-mode compileOps: set-tex', () => {
  it('valid math moves the tex and the rendering together', () => {
    const doc = mount()
    const math = doc.article.querySelector<HTMLElement>('div.dia-math')!
    const res = compileOps([op({ action: 'set-tex', target: 'section 2 eq 1', value: 'e = mc^3' })])
    expect(res.skipped).toEqual([])
    res.ops[0].apply()
    expect(math.getAttribute('data-dia-tex')).toBe('e = mc^3')
    expect(math.innerHTML).toContain('<math')
    expect(exportTex(doc)).toContain('\\begin{equation}\\label{eq:e}\ne = mc^3\n\\end{equation}')
    res.ops[0].invert().apply()
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('math that does not render is skipped with the reason, not applied', () => {
    const doc = mount()
    const before = exportTex(doc)
    const res = compileOps([op({ action: 'set-tex', target: 'section 2 eq 1', value: '\\frac{1' })])
    expect(res.ops).toEqual([])
    expect(res.skipped[0].reason).toContain('does not render')
    expect(exportTex(doc)).toBe(before)
  })

  it('an island takes raw LaTeX; malformed LaTeX is refused', () => {
    const doc = mount()
    const good = compileOps([op({
      action: 'set-tex',
      target: 'section 2 island',
      value: '\\begin{tikzpicture}\n\\draw (0,0) -- (2,2);\n\\end{tikzpicture}',
    })])
    expect(good.skipped).toEqual([])
    good.ops[0].apply()
    expect(exportTex(doc)).toContain('\\draw (0,0) -- (2,2);')
    good.ops[0].invert().apply()
    expect(exportTex(doc)).toBe(SAMPLE)

    const bad = compileOps([op({
      action: 'set-tex',
      target: 'section 2 island',
      value: '\\begin{tikzpicture}\n\\draw (0,0) -- (1,1);',
    })])
    expect(bad.ops).toEqual([])
    expect(bad.skipped[0].reason).toContain('never closed')
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('set-tex refuses targets that carry no tex, and set-text refuses math', () => {
    mount()
    expect(compileOps([op({ action: 'set-tex', target: 'section 1 para 1', value: 'x' })])
      .skipped[0].reason).toContain('math block or a LaTeX island')
    expect(compileOps([op({ action: 'set-text', target: 'section 2 eq 1', value: 'x' })])
      .skipped[0].reason).toContain('use set-tex')
  })
})

describe('texFragmentError', () => {
  it('accepts well-formed fragments', () => {
    expect(texFragmentError('\\textbf{hi} and $x^2$')).toBeNull()
    expect(texFragmentError('\\begin{itemize}\\item a\\end{itemize}')).toBeNull()
    // a verbatim body is scanned raw — its braces are not the document's
    expect(texFragmentError('\\begin{verbatim}\n{ unbalanced\n\\end{verbatim}')).toBeNull()
  })

  it('names what is wrong', () => {
    expect(texFragmentError('\\textbf{hi')).toContain('unclosed')
    expect(texFragmentError('hi}')).toContain('never opened')
    expect(texFragmentError('\\begin{a}x\\end{b}')).toContain('closes \\begin{a}')
    expect(texFragmentError('x\\end{center}')).toContain('has no \\begin')
  })
})

describe('doc-mode compileOps: structural actions', () => {
  it('skips what has no source-safe shape yet, with an actionable reason', () => {
    const doc = mount()
    const cases: Array<[ProposedOp, string]> = [
      [op({ action: 'add-slide', target: '', value: '<section class="dia-slide"></section>' }), 'not a deck'],
      [op({ action: 'set-style', target: 'section 1 para 1', extra: { prop: 'color' }, value: 'red' }), 'set-token'],
      [op({ action: 'insert-node', target: 'n1' }), 'deck action'],
      [op({ action: 'move-el', target: 'section 1 para 1' }), 'extra.index'],
      [op({ action: 'move-el', target: '"plainly"', extra: { index: 0 } }), 'whole top-level blocks'],
    ]
    for (const [proposal, reason] of cases) {
      const res = compileOps([proposal])
      expect(res.ops, proposal.action).toEqual([])
      expect(res.skipped[0].reason, proposal.action).toContain(reason)
    }
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('removing INSIDE a block is allowed and stays paired', () => {
    const doc = mount()
    const res = compileOps([op({ action: 'remove', target: '"plainly"' })])
    expect(res.ops).toHaveLength(1)
    res.ops[0].apply()
    expect(exportTex(doc)).not.toContain('\\textbf{plainly}')
    res.ops[0].invert().apply()
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('inserting into an existing block is allowed and stays paired', () => {
    const doc = mount()
    const res = compileOps([op({
      action: 'insert-html', target: 'section 1 para 2', value: '<em>Emphatically.</em>',
    })])
    expect(res.ops).toHaveLength(1)
    res.ops[0].apply()
    expect(exportTex(doc)).toContain('\\emph{Emphatically.}')
    res.ops[0].invert().apply()
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('adds a whole block: the html becomes LaTeX, and the LaTeX becomes the block', () => {
    const doc = mount()
    const res = compileOps([op({
      action: 'insert-html', target: 'document', value: '<h2 class="dia-sec">Related Work</h2>',
      extra: { index: 2 }, label: 'Add a Related Work section',
    })])
    expect(res.skipped).toEqual([])
    res.ops[0].apply()
    expect(doc.source.text).toContain('\\section{Related Work}')
    expect([...doc.article.children][2].textContent).toBe('Related Work')
    // only the new block's bytes are new
    expect(exportTex(doc).replace('\n\n\\section{Related Work}', '')).toBe(SAMPLE)
    res.ops[0].invert().apply()
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('appends when no index is given, and refuses html LaTeX cannot carry', () => {
    const doc = mount()
    const res = compileOps([op({ action: 'insert-html', target: 'document', value: '<p>A closing note.</p>' })])
    res.ops[0].apply()
    expect(exportTex(doc)).toContain('Results follow.\n\nA closing note.\n\n\\end{document}')
    res.ops[0].invert().apply()
    expect(exportTex(doc)).toBe(SAMPLE)

    const bad = compileOps([op({ action: 'insert-html', target: 'document', value: '<p></p>' })])
    expect(bad.ops).toEqual([])
    expect(bad.skipped[0].reason).toContain('no content')
  })

  it('two block inserts in ONE proposal both land', () => {
    // each structural op reads live source offsets, so the second must be
    // built after the first has landed — built upfront it would patch bytes
    // that had already moved
    const doc = mount()
    const res = compileOps([
      op({ action: 'insert-html', target: 'document', value: '<p>First addition.</p>', extra: { index: 1 } }),
      op({ action: 'insert-html', target: 'document', value: '<p>Second addition.</p>', extra: { index: 2 } }),
    ])
    expect(res.skipped).toEqual([])
    for (const o of res.ops) o.apply()
    expect(doc.source.text).toContain('First addition.\n\nSecond addition.')
    expect(exportTex(doc).replace('\n\nFirst addition.\n\nSecond addition.', '')).toBe(SAMPLE)
    for (const o of [...res.ops].reverse()) o.invert().apply()
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('removes a whole block, source slice and separator together', () => {
    const doc = mount()
    const res = compileOps([op({ action: 'remove', target: 'section 1 para 2' })])
    expect(res.skipped).toEqual([])
    res.ops[0].apply()
    expect(exportTex(doc)).not.toContain('A second paragraph of the introduction.')
    expect(exportTex(doc)).toBe(SAMPLE.replace('A second paragraph of the introduction.\n\n', ''))
    res.ops[0].invert().apply()
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('moves a whole block to a position — several hops, one undo step', () => {
    const doc = mount()
    const before = [...doc.article.children].map((el) => el.textContent)
    const res = compileOps([op({ action: 'move-el', target: 'section 1 para 1', extra: { index: 3 } })])
    expect(res.skipped).toEqual([])
    res.ops[0].apply()
    const after = [...doc.article.children].map((el) => el.textContent)
    expect(after[3]).toBe(before[1])
    expect(after.slice().sort()).toEqual(before.slice().sort())
    // the moved slice keeps its bytes; the source is a permutation
    expect(doc.source.text).toContain('We begin with a claim, stated \\textbf{plainly}.')
    res.ops[0].invert().apply()
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('a whole-block proposal previews and reverts like any other', () => {
    const doc = mount()
    const res = compileOps([op({ action: 'insert-html', target: 'document', value: '<p>Previewed.</p>' })])
    startPreview(res.ops, null, () => {})
    expect(doc.article.textContent).toContain('Previewed.')
    clearPreview('rejected', false)
    expect(doc.article.textContent).not.toContain('Previewed.')
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('theme tokens are not source edits — they compile unwrapped', () => {
    const doc = mount()
    const res = compileOps([op({ action: 'set-token', target: '--dia-accent', value: '#123456' })])
    expect(res.skipped).toEqual([])
    res.ops[0].apply()
    expect(exportTex(doc)).toBe(SAMPLE)
  })
})

describe('preview over wrapped doc ops', () => {
  it('accept-then-revert leaves the source byte-consistent', () => {
    const doc = mount()
    const res = compileOps([op({ action: 'set-inline-html', target: 'section 3 para 1', value: 'Rewritten results.' })])
    startPreview(res.ops, null, () => {})
    expect(doc.article.textContent).toContain('Rewritten results.')
    expect(doc.source.text).toContain('Rewritten results.')
    clearPreview('rejected', false)
    expect(doc.article.textContent).not.toContain('Rewritten results.')
    expect(exportTex(doc)).toBe(SAMPLE)
  })

  it('the preview badge never enters the article', () => {
    const doc = mount()
    const block = doc.article.querySelector<HTMLElement>('p')!
    const res = compileOps([op({ action: 'set-inline-html', target: 'section 1 para 1', value: 'x.' })])
    const blocksBefore = doc.article.children.length
    startPreview(res.ops, block, () => {})
    expect(doc.article.children.length).toBe(blocksBefore)
    expect(doc.article.querySelector('.dia-preview-badge')).toBeNull()
    clearPreview('rejected', false)
    expect(doc.root.querySelector('.dia-preview-badge')).toBeNull()
    expect(exportTex(doc)).toBe(SAMPLE)
  })
})
