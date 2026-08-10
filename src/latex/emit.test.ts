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

  it('a multi-key \\cref survives an edit to the paragraph around it', () => {
    // the keys ride comma-joined on data-dia-ref, exactly as one key did
    const src = 'See \\cref{fig:a,fig:b} and \\ref{sec:one} for detail.\n'
    const [{ el }] = renderPairs(src)
    el.firstChild!.textContent = 'Read '
    const out = emitBlockTex(el)
    expect(out).toContain('\\cref{fig:a,fig:b}')
    expect(out).toContain('\\ref{sec:one}')
    expect(out.startsWith('Read ')).toBe(true)
  })

  it('an edit around a \\crefrange keeps both of its keys, in order', () => {
    // the two groups are a RANGE, not a list: they ride on their own
    // from/to attributes, so nothing can reorder or comma-join them
    const src = 'See \\crefrange{fig:a}{fig:c} and \\Crefrange{eq:x}{eq:z} now.\n'
    const [{ el }] = renderPairs(src)
    el.firstChild!.textContent = 'Read '
    const out = emitBlockTex(el)
    expect(out).toContain('\\crefrange{fig:a}{fig:c}')
    expect(out).toContain('\\Crefrange{eq:x}{eq:z}')
    expect(out.startsWith('Read ')).toBe(true)
  })

  it('an edit around a \\subcaptionbox keeps its caption, options and panel', () => {
    const src = '\\begin{figure}\n\\centering\n'
      + '\\subcaptionbox{Left\\label{sub:a}}[3cm][c]{\\includegraphics{a.png}}\n'
      + '\\caption{Outer}\n\\end{figure}\n'
    const [{ el }] = renderPairs(src)
    // :scope > — the panel's own figcaption comes FIRST in the DOM
    const cap = el.querySelector(':scope > figcaption')!
    cap.textContent = 'Outer caption'
    const out = emitBlockTex(el)
    expect(out).toContain('\\subcaptionbox{Left\\label{sub:a}}[3cm][c]{\\includegraphics{a.png}}')
    expect(out).toContain('\\caption{Outer caption}')
  })

  it('an edited \\subcaptionbox sub-caption patches its BRACE, keeping the \\label', () => {
    // \subcaptionbox's caption is the first BRACE group — the mirror image
    // of \subfloat's bracket — so the patch has to find a different group
    const src = '\\begin{figure}\n\\centering\n'
      + '\\subcaptionbox{Left\\label{sub:a}}[3cm]{\\includegraphics{a.png}}\n'
      + '\\caption{Outer}\n\\end{figure}\n'
    const [{ el }] = renderPairs(src)
    const sub = el.querySelector('figure.dia-figure figcaption')!
    sub.textContent = 'Right'
    const out = emitBlockTex(el)
    expect(out).toContain('\\subcaptionbox{Right\\label{sub:a}}[3cm]{\\includegraphics{a.png}}')
    expect(out).toContain('\\caption{Outer}')
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

  it('palm2.tex: a \\subfigure panel shows its bracket sub-caption, and an edit patches THAT bracket', () => {
    const src = readFileSync(join(repo, 'corpus', 'tex', 'palm2.tex'), 'utf-8')
    const target = renderPairs(src).find(({ slice }) => slice.includes('\\label{fig:palm2-canary-training-data}'))!
    const panels = [...target.el.querySelectorAll<HTMLElement>(':scope > figure.dia-figure')]
    expect(panels).toHaveLength(2)
    expect(panels[0].querySelector('figcaption')!.textContent)
      .toBe('Canary extraction rate. We use all available canaries inserted for a language.')
    panels[1].querySelector('figcaption')!.textContent = 'Extraction rate.'
    const out = emitBlockTex(target.el)
    expect(out).toContain('\\subfigure[Extraction rate.]{\\includegraphics[width=0.48\\linewidth]{figs/memorization/palm2_mem_size_final.pdf}}')
    // the OTHER panel and the float's own caption are byte-untouched
    expect(out).toContain('\\subfigure[Canary extraction rate. We use all available canaries inserted for a language.]')
    expect(out).toBe(target.slice.replace('Training data extraction rate.', 'Extraction rate.'))
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

describe('float interior edits reach the source', () => {
  /** the ONLY differing substring between two strings — see the table-cell
   * suite above; the bar for a float child is the same as for a cell */
  function onlyDiff(a: string, b: string): { removed: string; added: string } {
    let p = 0
    while (p < a.length && p < b.length && a[p] === b[p]) p++
    let sa = a.length
    let sb = b.length
    while (sa > p && sb > p && a[sa - 1] === b[sb - 1]) { sa--; sb-- }
    return { removed: a.slice(p, sa), added: b.slice(p, sb) }
  }

  it('an edited paragraph inside a float changes exactly its own bytes', () => {
    const src = '\\begin{figure}[t]\n\\centering\n\\includegraphics[width=.5\\linewidth]{plot.png}\nA descriptive note that lives inside the float.\n\\caption{The caption.}\n\\label{fig:x}\n\\end{figure}\n'
    const [{ el }] = renderPairs(src)
    const p = el.querySelector('p')!
    expect(p.textContent).toContain('A descriptive note')
    // no shared prefix or suffix with the original, so onlyDiff pins the
    // touched bytes exactly
    p.textContent = 'Rewritten note'
    const out = emitBlockTex(el)
    const { removed, added } = onlyDiff(src.trim(), out)
    expect(removed).toBe('A descriptive note that lives inside the float.')
    expect(added).toBe('Rewritten note')
  })

  it('an edited island inside a float reaches the source, placement intact', () => {
    const src = '\\begin{figure}[htbp]\n\\centering\n\\begin{tikzpicture}\n\\draw (0,0);\n\\end{tikzpicture}\n\\caption{Cap.}\n\\end{figure}\n'
    const [{ el }] = renderPairs(src)
    el.querySelector('.dia-tex-island pre')!.textContent = '\\begin{tikzpicture}\n\\draw (1,1);\n\\end{tikzpicture}'
    const out = emitBlockTex(el)
    expect(out).toBe(src.trim().replace('\\draw (0,0);', '\\draw (1,1);'))
  })

  it('a paragraph nested in a float\'s minipage reaches the source; siblings keep bytes', () => {
    const src = '\\begin{figure}\n\\centering\n\\begin{minipage}{0.45\\textwidth}\nLeft   panel  prose.\n\\end{minipage}\n\\begin{minipage}{0.45\\textwidth}\nRight panel prose.\n\\end{minipage}\n\\caption{Two panels.}\n\\end{figure}\n'
    const [{ el }] = renderPairs(src)
    el.querySelectorAll('p')[1].textContent = 'Right panel, edited.'
    const out = emitBlockTex(el)
    expect(out).toContain('Right panel, edited.')
    // the untouched sibling keeps its odd spacing, and the float's own
    // furniture (placement-less begin, \centering, caption) is byte-intact
    expect(out).toContain('Left   panel  prose.')
    expect(out).toContain('\\begin{minipage}{0.45\\textwidth}')
    expect(out).toContain('\\centering')
    expect(out).toContain('\\caption{Two panels.}')
  })

  it('a caption edit and a body edit in one float both land', () => {
    const src = '\\begin{figure}\n\\includegraphics{f.png}\nBody note.\n\\caption{Old caption}\n\\end{figure}\n'
    const [{ el }] = renderPairs(src)
    el.querySelector('p')!.textContent = 'New note.'
    el.querySelector('figcaption')!.textContent = 'New caption'
    const out = emitBlockTex(el)
    expect(out).toBe('\\begin{figure}\n\\includegraphics{f.png}\nNew note.\n\\caption{New caption}\n\\end{figure}')
  })

  it('an unedited float with body prose still emits its exact bytes', () => {
    const src = '\\begin{figure}\n\\centering\n\\includegraphics{f.png}\n\nA note.  With  spacing.\n\n\\caption{C}\n\\end{figure}\n'
    const [{ el, slice }] = renderPairs(src)
    expect(emitBlockTex(el)).toBe(slice)
  })

  it('palm2.tex: a paragraph two levels inside a float changes only its own bytes', () => {
    // the prose sits in a tcolorbox INSIDE the figure, beside an
    // lstlisting and further paragraphs — on the pre-fix parser the commit
    // was accepted and the export came back byte-identical
    const src = readFileSync(join(repo, 'corpus', 'tex', 'palm2.tex'), 'utf-8')
    const target = renderPairs(src).find(({ el }) =>
      el.matches('figure.dia-figure') && el.querySelector('p'))!
    const p = target.el.querySelector('p')!
    expect(p.textContent).toContain('can you fix this code with a bug')
    p.textContent = 'Edited float prose.'
    const out = emitBlockTex(target.el)
    const { removed, added } = onlyDiff(target.slice, out)
    expect(removed).toBe('can you fix this code with a bug and add line by line comments in Korean')
    expect(added).toBe('Edited float prose')
    // the sibling verbatim and the box's own frame keep their bytes
    expect(out).toContain('\\begin{lstlisting}[style=py,language=Python]')
    expect(out).toContain('\\begin{tcolorbox}[nobeforeafter, title=Fixing a bug with comments in Korean, colback=white]')
  })
})

describe('tables behind a brace group are editable end to end (issue #21)', () => {
  /** a real llama.tex float whose tabular sits inside a bare `{ … }` — it
   * was invisible before the float scanner learned to descend, so this
   * guards the whole path: parse → render → cell edit → surgical emission */
  function braceGroupFloat(file: string, marker: string) {
    const src = readFileSync(join(repo, 'corpus', 'tex', ...file.split('/')), 'utf-8')
    const target = renderPairs(src).find(({ el, slice }) =>
      el.matches('figure.dia-figure') && slice.includes(marker))!
    expect(target, `no float containing ${marker}`).toBeTruthy()
    return target
  }

  /** retype one cell and return (emission, expected) — expected is the
   * float's own slice with exactly that cell's source bytes swapped, so the
   * assertion is "one cell moved and nothing else did" */
  function retypeCell(target: { el: HTMLElement; slice: string }, was: string, now: string) {
    const td = [...target.el.querySelectorAll('td')].find((c) => c.textContent?.trim() === was)!
    expect(td, `no cell reading ${was}`).toBeTruthy()
    const original = td.textContent!
    expect(target.slice.split(original)).toHaveLength(2)
    td.textContent = original.replace(was, now)
    return { out: emitBlockTex(target.el), want: target.slice.replace(original, td.textContent) }
  }

  it('llama.tex: the bare-group table renders, and a cell edit reaches only that cell', () => {
    const target = braceGroupFloat('llama/llama.tex', '\\label{tab:nqa}')
    expect(target.el.querySelector('table')).toBeTruthy()
    // untouched: the float still emits its exact bytes, brace group included
    expect(emitBlockTex(target.el)).toBe(target.slice)
    const { out, want } = retypeCell(target, '29.9', '99.9')
    expect(out).toBe(want)
  })

  it('bloom.tex: a \\resizebox table edits the same way, dimensions untouched', () => {
    const target = braceGroupFloat('bloom.tex', '\\label{tab:language_families}')
    expect(target.slice).toContain('\\resizebox{\\textwidth}{!}')
    expect(target.el.querySelector('table')).toBeTruthy()
    const { out, want } = retypeCell(target, 'Akan', 'Akaan')
    expect(out).toBe(want)
    // the width/height arguments are never reconstructed — they ride along
    // in the untouched bytes around the spliced cell
    expect(out).toContain('\\resizebox{\\textwidth}{!}')
  })

  it('editing a bare-group table leaves the caption bytes alone', () => {
    const target = braceGroupFloat('llama/llama.tex', '\\label{tab:nqa}')
    const { out } = retypeCell(target, '31.9', '77.7')
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

  it('partitionEnv keeps a frame\'s optional [..]{title} in the head (issue #20)', () => {
    const part = partitionEnv('\\begin{frame}[fragile]{Block Size}\nbody\n\\end{frame}', 'frame')!
    expect(part.head).toBe('\\begin{frame}[fragile]{Block Size}')
    expect(part.tail).toBe('\\end{frame}')
  })

  it('partitionEnv does not swallow a titleless frame\'s bare-group body into the head', () => {
    // the head must stop at the begin tag when the next group starts on a
    // new line — this is what emitEnvWithChildren relies on to leave a
    // frame body's leading {...} group to the rebuilt interior
    const part = partitionEnv('\\begin{frame}\n  {\\centering fig}\n\\end{frame}', 'frame')!
    expect(part.head).toBe('\\begin{frame}')
    expect(part.tail).toBe('\\end{frame}')
  })
})

describe('beamer round-trips (issue #20 acceptance)', () => {
  it('every top-level block of the beamer fixture, unedited, emits exact bytes', () => {
    const src = readFileSync(join(repo, 'corpus', 'tex', 'beamer', 'beamer.tex'), 'utf-8')
    for (const { el, slice } of renderPairs(src)) {
      expect(emitBlockTex(el)).toBe(slice)
    }
  })

  it('an edited frame re-emits \\begin{frame}{Title} with the original title bytes preserved', () => {
    const src = '\\begin{frame}{\\model{} in One Slide}\nOld body.\n\\end{frame}'
    const [{ el }] = renderPairs(src)
    el.querySelector('p:not(.dia-wrap-title)')!.textContent = 'New body.'
    const out = emitBlockTex(el)
    expect(out.startsWith('\\begin{frame}{\\model{} in One Slide}')).toBe(true)
    expect(out).toContain('New body.')
    expect(out.trim().endsWith('\\end{frame}')).toBe(true)
  })

  it('a frame title is SHOWN, and editing it reaches the \\begin line', () => {
    // the title argument rides in no block: consuming it without rendering
    // it deleted every slide heading from the reading surface
    const src = '\\begin{frame}[fragile]{Block Size, By Layer}\nBody.\n\\end{frame}'
    const [{ el }] = renderPairs(src)
    const title = el.querySelector('p.dia-wrap-title')!
    expect(title.textContent).toBe('Block Size, By Layer')
    title.textContent = 'Block Size'
    const out = emitBlockTex(el)
    // only the title group changed — the [fragile] option survives, and the
    // title is not duplicated into the body it was consumed from
    expect(out.startsWith('\\begin{frame}[fragile]{Block Size}')).toBe(true)
    expect(out).toContain('Body.')
    expect(out).not.toContain('Block Size, By Layer')
    expect(out.trim().endsWith('\\end{frame}')).toBe(true)
  })

  it('a block\'s title is its own, and its prose is real structure', () => {
    const src = '\\begin{block}{This talk}\nA training \\emph{recipe}.\n\\end{block}'
    const [{ el }] = renderPairs(src)
    expect(el.querySelector('p.dia-wrap-title')!.textContent).toBe('This talk')
    expect(el.querySelector('p:not(.dia-wrap-title)')!.textContent!.trim()).toBe('A training recipe.')
    expect(emitBlockTex(el)).toBe(src)
  })

  it('a title edit and a body edit in the same frame both land', () => {
    // the child cursor starts past the begin line; shortening the title
    // moves that line's end, and a cursor left behind would drop the body
    // edit without a word
    const src = '\\begin{frame}{A Very Long Slide Heading}\n  Body prose.\n\\end{frame}'
    const [{ el }] = renderPairs(src)
    el.querySelector('p.dia-wrap-title')!.textContent = 'Short'
    el.querySelector('p:not(.dia-wrap-title)')!.textContent = '\n  New prose.\n'
    expect(emitBlockTex(el)).toBe('\\begin{frame}{Short}\n  New prose.\n\\end{frame}')
  })

  it('editing prose two levels down a frame changes ONLY that prose', () => {
    // the block's body is newly-visible content (it used to be one island);
    // reaching it must not reflow the slide around it — the second block,
    // the comment, and every blank line stay exactly as written
    const src = '\\begin{frame}{Limits}\n  % a note\n  \\begin{block}{One}\n    First prose.\n  \\end{block}\n\n  \\begin{alertblock}{Two}\n    Second prose.\n  \\end{alertblock}\n\\end{frame}'
    const [{ el }] = renderPairs(src)
    const target = [...el.querySelectorAll('p:not(.dia-wrap-title)')]
      .find((p) => p.textContent!.includes('First prose.'))!
    target.textContent = '\n    Rewritten prose.\n  '
    expect(emitBlockTex(el)).toBe(src.replace('First prose.', 'Rewritten prose.'))
  })

  it('a beamer column\'s width argument is NOT mistaken for a title', () => {
    const src = '\\begin{column}{0.5\\textwidth}\nPanel prose.\n\\end{column}'
    const [{ el }] = renderPairs(src)
    expect(el.querySelector('p.dia-wrap-title')).toBeNull()
    el.querySelector('p')!.textContent = 'New prose.'
    const out = emitBlockTex(el)
    expect(out.startsWith('\\begin{column}{0.5\\textwidth}')).toBe(true)
    expect(out).toContain('New prose.')
  })
})

/* Overlay specifications are the one construct whose bytes have nowhere
 * obvious to live: `<1->` sits BETWEEN a command and its arguments, so a
 * reader that consumed it and a writer that did not know about it would
 * delete it from the user's file on the first edit — silently, and only in
 * the .tex, since the reading surface would look right either way. Every
 * test here is that byte-loss guard, one per position the spec can occupy. */
describe('overlay specifications survive editing (beamer)', () => {
  it('an edited list keeps every item\'s overlay spec', () => {
    const src = '\\begin{itemize}\n  \\item<1-> First point.\n  \\item<2-> Second point.\n\\end{itemize}'
    const [{ el }] = renderPairs(src)
    const items = [...el.querySelectorAll('li')]
    items[0].textContent = 'Rewritten point.'
    const out = emitBlockTex(el)
    expect(out).toContain('\\item<1->')
    expect(out).toContain('\\item<2->')
    expect(out).toContain('Rewritten point.')
    expect(out).toContain('Second point.')
  })

  it('an edited frame keeps the overlay spec on its \\begin line', () => {
    const src = '\\begin{frame}<2->{Later Slide}\n  Body prose.\n\\end{frame}'
    const [{ el }] = renderPairs(src)
    expect(el.querySelector('p.dia-wrap-title')!.textContent).toBe('Later Slide')
    el.querySelector('p:not(.dia-wrap-title)')!.textContent = '\n  New prose.\n'
    const out = emitBlockTex(el)
    expect(out.startsWith('\\begin{frame}<2->{Later Slide}')).toBe(true)
    expect(out).toContain('New prose.')
  })

  it('an edited frame title keeps the overlay spec beside it', () => {
    const src = '\\begin{block}<3>{Old Heading}\n  Prose.\n\\end{block}'
    const [{ el }] = renderPairs(src)
    el.querySelector('p.dia-wrap-title')!.textContent = 'New Heading'
    const out = emitBlockTex(el)
    expect(out.startsWith('\\begin{block}<3>{New Heading}')).toBe(true)
  })

  it('an edited paragraph keeps a style command\'s overlay spec', () => {
    const src = 'Reveal \\textbf<2>{this word} on the second step.\n'
    const [{ el }] = renderPairs(src)
    el.querySelector('strong')!.textContent = 'that word'
    expect(emitBlockTex(el)).toContain('\\textbf<2>{that word}')
  })

  it('an unedited overlay-bearing document emits byte-identical LaTeX', () => {
    const src = '\\begin{frame}<1->{T}\n  \\begin{itemize}<+->\n    \\item<1-> A \\alert<2>{word}.\n  \\end{itemize}\n  \\onslide<4->{tail}\n\\end{frame}'
    for (const { el, slice } of renderPairs(src)) expect(emitBlockTex(el)).toBe(slice)
  })
})

/* A custom \item label is an argument the DOM had no node for, so an edited
 * itemize dropped it from the file — the same byte-loss class as the overlay
 * specs above. beamer.tex writes `\item[$\to$]` for exactly one bullet. */
describe('a custom \\item bullet survives editing', () => {
  it('an edited itemize keeps \\item[$\\to$]', () => {
    const src = '\\begin{itemize}\n  \\item Plain point.\n  \\item[$\\to$] Marked point.\n\\end{itemize}'
    const [{ el }] = renderPairs(src)
    const items = [...el.querySelectorAll('li')]
    items[0].textContent = 'Rewritten point.'
    const out = emitBlockTex(el)
    expect(out).toContain('\\item[$\\to$]')
    expect(out).toContain('Marked point.')
  })

  it('the custom bullet is SHOWN, not silently carried', () => {
    const src = '\\begin{itemize}\n  \\item[$\\to$] Marked point.\n\\end{itemize}'
    const [{ el }] = renderPairs(src)
    expect(el.querySelector('li > .dia-item-label')).not.toBeNull()
  })

  it('unedited, it emits exact bytes', () => {
    const src = '\\begin{itemize}\n  \\item[$\\to$] Marked point.\n\\end{itemize}'
    for (const { el, slice } of renderPairs(src)) expect(emitBlockTex(el)).toBe(slice)
  })
})

