/* The prime directive of emission: never rewrite bytes the user did not
 * touch. Unedited blocks re-emit their exact source slice; edited ones
 * reconstruct surgically and re-parse to an equivalent tree. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseLatex } from './parse'
import { renderDoc } from './render'
import { emitBlockTex, emitInlines, escapeTex, replaceCommandGroup, partitionEnv } from './emit'
import { refreshDerived } from '../doc/derived'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')

/** render a source and return the top-level (el, slice) pairs */
function renderPairs(src: string) {
  const doc = parseLatex(src)
  const rendered = renderDoc(doc)
  refreshDerived(rendered.article)
  return rendered.blocks.map((b) => ({ el: b.el, slice: src.slice(b.span.start, b.span.end) }))
}

describe('unedited blocks emit exact bytes', () => {
  it('every top-level block of a real paper', () => {
    const src = readFileSync(join(repo, 'corpus', 'tex', 'llama', 'llama.tex'), 'utf-8')
    for (const { el, slice } of renderPairs(src)) {
      expect(emitBlockTex(el)).toBe(slice)
    }
  })

  it('…including after the derived-ref pass rewrote link texts', () => {
    const src = '\\section{One}\\label{sec:one}\n\nSee \\ref{sec:one} here.\n'
    const pairs = renderPairs(src)
    // the ref now shows "1", not the key — bytes must still be exact
    expect(pairs[1].el.textContent).toContain('See 1 here.')
    expect(emitBlockTex(pairs[1].el)).toBe(pairs[1].slice)
  })
})

describe('edited blocks reconstruct', () => {
  it('paragraph text edit emits parseable LaTeX with styles intact', () => {
    const src = 'Some \\textbf{bold} text with \\cite[p.~9]{knuth84} and $x^2$.\n'
    const [{ el }] = renderPairs(src)
    el.querySelector('strong')!.textContent = 'heavy'
    const out = emitBlockTex(el)
    expect(out).toContain('\\textbf{heavy}')
    expect(out).toContain('\\cite[p.~9]{knuth84}')
    expect(out).toContain('$x^2$')
  })

  it('citep survives re-emission via data-dia-cite-cmd', () => {
    const src = 'As shown \\citep{smith20}.\n'
    const [{ el }] = renderPairs(src)
    el.append(' more')
    expect(emitBlockTex(el)).toContain('\\citep{smith20}')
  })

  it('two-bracket cites re-emit both notes', () => {
    const src = 'See \\citep[][\\textit{inter alia}]{a,b}.'
    const [{ el }] = renderPairs(src)
    el.append(' x')
    expect(emitBlockTex(el)).toContain('\\citep[][\\textit{inter alia}]{a,b}')
  })

  it('pdf graphics render as slots and re-emit their includegraphics', () => {
    const src = '\\begin{figure}\\includegraphics[width=1em]{plot.pdf}\\end{figure}'
    const [{ el }] = renderPairs(src)
    expect(el.querySelector('.dia-graphic-slot')).toBeTruthy()
    expect(el.querySelector('img')).toBeNull()
    // untouched: exact bytes; and full reconstruction keeps the graphic
    expect(emitBlockTex(el)).toBe(src)
  })

  it('section edit is surgical: star, short title, and label bytes survive', () => {
    const src = '\\section*[Short]{Long Title}\\label{sec:x}\n'
    const [{ el }] = renderPairs(src)
    el.prepend('New ')
    const out = emitBlockTex(el)
    expect(out).toBe('\\section*[Short]{New Long Title}\\label{sec:x}')
  })

  it('verbatim body edit keeps the option line', () => {
    const src = '\\begin{lstlisting}[language=C]\nint x;\n\\end{lstlisting}\n'
    const [{ el }] = renderPairs(src)
    el.textContent = 'int y;'
    expect(emitBlockTex(el)).toBe('\\begin{lstlisting}[language=C]\nint y;\n\\end{lstlisting}')
  })

  it('float caption edit leaves placement and graphics bytes alone', () => {
    const src = '\\begin{figure}[htbp]\n\\centering\n\\includegraphics[width=.5\\linewidth]{plot.pdf}\n\\caption{Old caption}\n\\label{fig:p}\n\\end{figure}\n'
    const [{ el }] = renderPairs(src)
    el.querySelector('figcaption')!.textContent = 'New caption'
    expect(emitBlockTex(el)).toBe(src.trim().replace('Old caption', 'New caption'))
  })

  it('wrapper interior edit keeps the frame; untouched siblings keep bytes', () => {
    const src = '\\begin{multicols}{2}\nFirst  paragraph   with\nodd spacing.\n\nSecond.\n\\end{multicols}\n'
    const [{ el }] = renderPairs(src)
    const paras = el.querySelectorAll('p')
    paras[1].textContent = 'Second, edited.'
    const out = emitBlockTex(el)
    expect(out.startsWith('\\begin{multicols}{2}')).toBe(true)
    expect(out.endsWith('\\end{multicols}')).toBe(true)
    // the untouched first paragraph keeps its odd spacing byte-for-byte
    expect(out).toContain('First  paragraph   with\nodd spacing.')
    expect(out).toContain('Second, edited.')
  })

  it('math block edit emits env + label from attributes', () => {
    const src = '\\begin{equation}\\label{eq:z}\nz^2\n\\end{equation}\n'
    const [{ el }] = renderPairs(src)
    el.setAttribute('data-dia-tex', 'z^3')
    expect(emitBlockTex(el)).toBe('\\begin{equation}\\label{eq:z}\nz^3\n\\end{equation}')
  })

  it('list edit reconstructs items; edited output re-parses equivalent', () => {
    const src = '\\begin{itemize}\n\\item alpha\n\\item beta\n\\end{itemize}\n'
    const [{ el }] = renderPairs(src)
    el.querySelectorAll('li')[1].textContent = 'gamma'
    const out = emitBlockTex(el)
    const reparsed = parseLatex(out)
    expect(reparsed.blocks[0].kind).toBe('list')
    expect(out).toContain('\\item gamma')
  })

  it('island text IS the latex — emitted verbatim', () => {
    const src = '\\begin{tikzpicture}\\draw (0,0);\\end{tikzpicture}\n'
    const [{ el }] = renderPairs(src)
    el.querySelector('pre')!.textContent = '\\begin{tikzpicture}\\draw (1,1);\\end{tikzpicture}'
    expect(emitBlockTex(el)).toBe('\\begin{tikzpicture}\\draw (1,1);\\end{tikzpicture}')
  })
})

describe('table cell edits are surgical (issue #10 acceptance)', () => {
  /** the ONLY differing substring between two strings, by longest common
   * prefix/suffix — the acceptance bar is that this substring is exactly
   * the touched cell's old and new text, nothing else in the table */
  function onlyDiff(a: string, b: string): { removed: string; added: string } {
    let p = 0
    while (p < a.length && p < b.length && a[p] === b[p]) p++
    let sa = a.length
    let sb = b.length
    while (sa > p && sb > p && a[sa - 1] === b[sb - 1]) { sa--; sb-- }
    return { removed: a.slice(p, sa), added: b.slice(p, sb) }
  }

  it('llama.tex: editing one cell of a booktabs \\multicolumn/\\multirow table touches only that cell', () => {
    const src = readFileSync(join(repo, 'corpus', 'tex', 'llama', 'llama.tex'), 'utf-8')
    const pairs = renderPairs(src)
    const target = pairs.find(({ slice }) => slice.includes('\\multicolumn{2}{c}{HumanEval}'))!
    expect(target.slice).toContain('\\multicolumn{2}{c}{HumanEval}')
    expect(target.slice).toContain('\\multirow{4}{*}{\\model}')
    const td = [...target.el.querySelectorAll('td')].find((c) => c.textContent?.trim() === '56.2')!
    td.textContent = (td.textContent ?? '').replace('56.2', '99.9')
    const out = emitBlockTex(target.el)
    const { removed, added } = onlyDiff(target.slice, out)
    expect(removed).toBe('56.2')
    expect(added).toBe('99.9')
    // the rules and the spanning cells' specs survive untouched
    expect(out).toContain('\\multicolumn{2}{c}{HumanEval}')
    expect(out).toContain('\\multirow{4}{*}{\\model}')
    expect(out).toContain('\\toprule')
    expect(out).toContain('\\bottomrule')
    // regression (issue #17): this float's caption carries \label{tab:code}
    // INSIDE its group; a cell-only edit must not touch the caption at all,
    // and must not duplicate the label by also reconstructing the caption
    expect(target.slice).toContain('\\label{tab:code}')
    expect(out.match(/\\label\{tab:code\}/g)).toHaveLength(1)
  })

  it('cot.tex: editing one cell under a chained \\cmidrule(lr) run touches only that cell', () => {
    const src = readFileSync(join(repo, 'corpus', 'tex', 'cot', 'cot.tex'), 'utf-8')
    const pairs = renderPairs(src)
    const target = pairs.find(({ slice }) => slice.includes('\\label{tab:all-lm-math}'))!
    expect(target.slice).toContain('\\cmidrule(lr){3-4} \\cmidrule(lr){5-6}')
    const td = [...target.el.querySelectorAll('td')].find((c) => c.textContent?.trim() === '16.6')!
    td.textContent = (td.textContent ?? '').replace('16.6', '77.7')
    const out = emitBlockTex(target.el)
    const { removed, added } = onlyDiff(target.slice, out)
    expect(removed).toBe('16.6')
    expect(added).toBe('77.7')
    expect(out).toContain('\\cmidrule(lr){3-4} \\cmidrule(lr){5-6}')
    expect(out).toContain('\\multicolumn{2}{c}{GSM8K}')
  })
})

describe('caption group edits are surgical (issue #17 acceptance)', () => {
  /** every top-level captioned float in a source, as (el, slice) pairs */
  function captionedFloats(src: string) {
    return renderPairs(src).filter(({ el }) => el.matches('figure.dia-figure') && el.querySelector('figcaption'))
  }

  it('llama.tex: a \\label INSIDE the caption group survives a caption edit, for every captioned float', () => {
    const src = readFileSync(join(repo, 'corpus', 'tex', 'llama', 'llama.tex'), 'utf-8')
    const floats = captionedFloats(src)
    // every caption in this paper writes its \label inside the group —
    // \label must follow \caption to bind the right counter
    expect(floats.length).toBeGreaterThan(5)
    for (const { el, slice } of floats) {
      const cap = el.querySelector('figcaption')!
      const labels = [...slice.matchAll(/\\label\{[^}]*\}/g)].map((m) => m[0])
      expect(labels.length).toBeGreaterThan(0)
      cap.textContent = 'Edited caption.'
      const out = emitBlockTex(el)
      expect(out).toContain('Edited caption.')
      // the label(s), byte-identical, survive exactly once each
      for (const label of labels) expect(out.split(label)).toHaveLength(2)
    }
  })

  it('llama.tex tab:dataset: a % comment inside the group survives too, and only the prose bytes differ', () => {
    const src = readFileSync(join(repo, 'corpus', 'tex', 'llama', 'llama.tex'), 'utf-8')
    const target = captionedFloats(src).find(({ slice }) => slice.includes('\\label{tab:dataset}'))!
    expect(target.slice).toContain('same sampling proportion. %\n  \\label{tab:dataset}\n  }')
    const cap = target.el.querySelector('figcaption')!
    cap.textContent = 'Short caption.'
    const out = emitBlockTex(target.el)
    expect(out).toContain('\\caption{Short caption.%\n  \\label{tab:dataset}\n  }')
  })

  it('palm.tex: a \\label LEADING the caption group (\\caption{\\label{x} Text}) survives too', () => {
    const src = readFileSync(join(repo, 'corpus', 'tex', 'palm.tex'), 'utf-8')
    const target = captionedFloats(src).find(({ slice }) => slice.includes('\\label{fig:toxicity-scaling}'))!
    expect(target.slice).toContain('\\caption{\\label{fig:toxicity-scaling} Toxicity probability')
    const cap = target.el.querySelector('figcaption')!
    cap.textContent = 'Short caption.'
    const out = emitBlockTex(target.el)
    expect(out).toContain('\\caption{\\label{fig:toxicity-scaling} Short caption.}')
  })

  it('bloom.tex: a \\label OUTSIDE the caption group (the other shape) is untouched by a caption edit', () => {
    const src = readFileSync(join(repo, 'corpus', 'tex', 'bloom.tex'), 'utf-8')
    const target = captionedFloats(src).find(({ slice }) => slice.includes('\\label{fig:workinggroups}'))!
    expect(target.slice).toContain('\\caption{Organization of BigScience working groups.}\n\\label{fig:workinggroups}\n\\end{figure}')
    const cap = target.el.querySelector('figcaption')!
    cap.textContent = 'New caption.'
    const out = emitBlockTex(target.el)
    expect(out).toContain('\\caption{New caption.}\n\\label{fig:workinggroups}\n\\end{figure}')
  })

  it('a float edited only through a sibling table cell leaves an untouched caption\'s bytes alone', () => {
    const src = readFileSync(join(repo, 'corpus', 'tex', 'llama', 'llama.tex'), 'utf-8')
    const target = captionedFloats(src).find(({ slice }) => slice.includes('\\label{tab:code}'))!
    const td = [...target.el.querySelectorAll('td')].find((c) => c.textContent?.trim() === '56.2')!
    td.textContent = '99.9'
    const out = emitBlockTex(target.el)
    // the caption's original bytes, label included, are untouched — not
    // reconstructed from the DOM, not duplicated
    expect(out).toContain(target.slice.slice(target.slice.indexOf('\\caption')))
  })
})

describe('inline emission', () => {
  it('escapes special characters and round-trips through the parser', () => {
    const p = document.createElement('p')
    p.textContent = '50% of $5 & #1 _always_ {sure} \\path ~home ^up'
    const out = emitInlines(p.childNodes)
    const doc = parseLatex(out)
    expect(doc.blocks).toHaveLength(1)
    const para = doc.blocks[0] as Extract<typeof doc.blocks[0], { kind: 'para' }>
    const text = para.inline
      .filter((n) => n.kind === 'text')
      .map((n) => (n as { text: string }).text).join('')
    expect(text).toContain('50% of $5 & #1 _always_ {sure}')
  })

  it('escapeTex keeps ordinary prose untouched', () => {
    expect(escapeTex('plain words, punctuation. (parens) [brackets]')).toBe(
      'plain words, punctuation. (parens) [brackets]')
  })

  it('inline math spans emit their tex source', () => {
    const src = 'value $x^2$ here'
    const [{ el }] = renderPairs(src)
    el.append('!')
    expect(emitBlockTex(el)).toBe('value $x^2$ here!')
  })

  it('verb picks a safe delimiter', () => {
    const code = document.createElement('code')
    code.className = 'dia-verb'
    code.textContent = 'a|b'
    const p = document.createElement('p')
    p.append(code)
    expect(emitInlines(p.childNodes)).toBe('\\verb!a|b!')
  })
})

describe('surgical helpers', () => {
  it('replaceCommandGroup respects nesting and escapes', () => {
    expect(replaceCommandGroup('\\caption{a {b} c}', 'caption', 'X')).toBe('\\caption{X}')
    expect(replaceCommandGroup('\\caption{a \\} b}', 'caption', 'X')).toBe('\\caption{X}')
    expect(replaceCommandGroup('no caption here', 'caption', 'X')).toBeNull()
  })

  it('partitionEnv keeps argument groups in the head', () => {
    const part = partitionEnv('\\begin{multicols}{2}\nbody\n\\end{multicols}', 'multicols')!
    expect(part.head).toBe('\\begin{multicols}{2}')
    expect(part.tail).toBe('\\end{multicols}')
  })
})
