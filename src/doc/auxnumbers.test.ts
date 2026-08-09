/* parseAux over .aux text produced by REAL compiles (managed tectonic
 * 0.15.0, `-X compile --synctex --keep-logs --keep-intermediates`), and the
 * ref texts those entries resolve to — each expectation below was read back
 * out of the same run's PDF with pdftotext, not reasoned about.
 *
 * The point of the module is the gap between what LaTeX numbers and what a
 * counter model in TypeScript can guess, so the first test here is that
 * gap, measured. */

import { beforeEach, describe, expect, it } from 'vitest'
import { parseLatex } from '../latex/parse'
import { renderDoc } from '../latex/render'
import { emitBlockTex } from '../latex/emit'
import { PROVISIONAL_CLASS, refreshDerived, setNumberSource } from './derived'
import { auxRefText, parseAux, setAuxLabels, clearAuxLabels } from './auxnumbers'

/* ---------- fixtures: verbatim output of real compiles ---------- */

/** The probe that started this: five \section labels, four of which the
 * counter model gets wrong. Compiled from PROBE_TEX below. No hyperref, so
 * every entry is the bare {number}{page} pair. */
const PROBE_TEX = `\\documentclass{article}
\\usepackage{amsmath}
\\begin{document}
\\section{Alpha}\\label{sec:a}
\\renewcommand{\\thesection}{S-\\arabic{section}}
\\section{Renamed}\\label{sec:r}
\\setcounter{section}{9}
\\section{Jumped}\\label{sec:j}
\\appendix
\\section{Appendix}\\label{sec:app}
\\section*{Starred}\\label{sec:star}
\\begin{figure}\\caption{Fig one}\\label{fig:one}\\end{figure}
\\begin{equation}\\label{eq:one} a = b \\end{equation}
See \\ref{sec:a}, \\ref{sec:r}, \\ref{sec:j}, \\ref{sec:app}, \\ref{sec:star},
\\ref{fig:one}, \\eqref{eq:one}, page \\pageref{sec:app}.
\\end{document}
`

const PROBE_AUX = `\\relax
\\newlabel{fig:one}{{1}{1}}
\\newlabel{sec:a}{{1}{1}}
\\newlabel{sec:r}{{S-2}{1}}
\\newlabel{sec:j}{{S-10}{1}}
\\newlabel{sec:app}{{A}{1}}
\\newlabel{sec:star}{{A}{1}}
\\newlabel{eq:one}{{1}{1}}
\\gdef \\@abspage@last{1}
`

/** The same document with hyperref and cleveref loaded: five fields per
 * entry, plus a `@cref` companion. The preamble block at the top is
 * hyperref's own, and it contains the TOKEN "newlabel" three times — a
 * parser that matches loosely invents labels out of it. */
const HYPERREF_AUX = `\\relax
\\providecommand\\hyper@newdestlabel[2]{}
\\HyperFirstAtBeginDocument{\\ifx\\hyper@anchor\\@undefined
\\global\\let\\oldnewlabel\\newlabel
\\gdef\\newlabel#1#2{\\newlabelxx{#1}#2}
\\gdef\\newlabelxx#1#2#3#4#5#6{\\oldnewlabel{#1}{{#2}{#3}}}
\\AtEndDocument{\\ifx\\hyper@anchor\\@undefined
\\let\\newlabel\\oldnewlabel
\\fi}
\\fi}
\\newlabel{fig:one}{{1}{1}{Fig one}{figure.1}{}}
\\newlabel{fig:one@cref}{{[figure][1][]1}{[1][1][]1}}
\\newlabel{tab:one}{{1}{1}{Tab one}{table.1}{}}
\\newlabel{tab:one@cref}{{[table][1][]1}{[1][1][]1}}
\\newlabel{sec:a}{{1}{1}{Alpha}{section.1}{}}
\\newlabel{sec:a@cref}{{[section][1][]1}{[1][1][]1}}
\\newlabel{sec:sub}{{1.1}{1}{Sub}{subsection.1.1}{}}
\\newlabel{sec:sub@cref}{{[subsection][1][1]1.1}{[1][1][]1}}
\\newlabel{eq:one}{{1}{1}{Sub}{equation.1.1}{}}
\\newlabel{eq:one@cref}{{[equation][1][]1}{[1][1][]1}}
\\newlabel{sec:app}{{A}{1}{Appendix}{appendix.A}{}}
\\newlabel{sec:app@cref}{{[appendix][1][2147483647]A}{[1][1][]1}}
`

/** corpus/tex/multifile compiled for real: every \input'd chapter's label
 * lands in the ROOT aux (there is exactly one .aux in the workdir), and one
 * hyperref title carries a nested brace group. */
const MULTIFILE_AUX = `\\newlabel{sec:intro}{{1}{1}{Introduction}{section.1}{}}
\\newlabel{sec:method}{{2}{1}{Method}{section.2}{}}
\\newlabel{eq:reuse}{{1}{2}{A residency model}{equation.2.1}{}}
\\newlabel{tab:buffer}{{1}{2}{Buffer size against measured miss rate and normalized throughput on the \\textsc {tpch-q3} workload}{table.1}{}}
\\newlabel{sec:results}{{3}{2}{Results}{section.3}{}}
\\bibcite{balkesen2013}{1}
\\newlabel{sec:conclusion}{{4}{3}{Conclusion}{section.4}{}}
`

beforeEach(() => {
  clearAuxLabels()
})

/* ---------- the parser ---------- */

describe('parseAux', () => {
  it('reads the number and the page from a plain {number}{page} entry', () => {
    const labels = parseAux(PROBE_AUX)
    expect(labels.get('sec:r')).toEqual({ number: 'S-2', page: '1', anchorKind: null, crefKind: null })
    expect(labels.get('sec:j')?.number).toBe('S-10')
    expect(labels.get('sec:app')?.number).toBe('A')
    // \section* takes no number of its own, so LaTeX resolved this label to
    // the section that was current — "A", not "5". The .aux is the truth
    // even when the truth is surprising.
    expect(labels.get('sec:star')?.number).toBe('A')
  })

  it("does not invent labels out of hyperref's preamble block", () => {
    const labels = parseAux(HYPERREF_AUX)
    for (const key of labels.keys()) expect(key).not.toContain('#')
    expect(labels.size).toBe(6)
  })

  it('takes the kind from the anchor, and cleveref\u2019s own kind from @cref', () => {
    const labels = parseAux(HYPERREF_AUX)
    expect(labels.get('fig:one')).toEqual({
      number: '1', page: '1', anchorKind: 'figure', crefKind: 'figure' })
    expect(labels.get('sec:sub')?.anchorKind).toBe('subsection')
    // the two vocabularies disagree on purpose: hyperref anchors an
    // appendix section as `appendix.A`, cleveref calls it `appendix`
    expect(labels.get('sec:app')).toEqual({
      number: 'A', page: '1', anchorKind: 'appendix', crefKind: 'appendix' })
  })

  it('keeps the @cref companions out of the label map', () => {
    const labels = parseAux(HYPERREF_AUX)
    expect([...labels.keys()].some((k) => k.endsWith('@cref'))).toBe(false)
  })

  it('survives a nested brace group inside a hyperref title', () => {
    const labels = parseAux(MULTIFILE_AUX)
    expect(labels.get('tab:buffer')).toEqual({
      number: '1', page: '2', anchorKind: 'table', crefKind: null })
    // the entry AFTER the nested one is the one a naive brace scan loses
    expect(labels.get('sec:results')?.number).toBe('3')
  })

  it('multi-file: every \\input\u2019d chapter\u2019s label is in the root aux', () => {
    const labels = parseAux(MULTIFILE_AUX)
    // sec:intro/sec:method/eq:reuse live in chapters/*.tex, sec:conclusion
    // in the root — one file holds them all
    for (const k of ['sec:intro', 'sec:method', 'eq:reuse', 'sec:conclusion']) {
      expect(labels.has(k)).toBe(true)
    }
  })

  it('ignores everything that is not a \\newlabel', () => {
    expect(parseAux(MULTIFILE_AUX).has('balkesen2013')).toBe(false)
    expect(parseAux('').size).toBe(0)
  })
})

/* ---------- what each command prints ----------
 * Every expectation here is pdftotext output from the compile that produced
 * HYPERREF_AUX; hyperref's mixed casing ("Figure 1" but "section 1") and
 * cleveref's abbreviations ("fig. 1" but "Figure 1" for \Cref) are not
 * guessable, only measurable. */

describe('auxRefText renders what the engine printed', () => {
  const labels = parseAux(HYPERREF_AUX)
  const t = (cmd: string, key: string) => auxRefText(labels, cmd, key, null)

  it('\\ref is the number', () => {
    expect(t('ref', 'sec:sub')).toBe('1.1')
    expect(t('ref', 'sec:app')).toBe('A')
  })

  it('\\eqref parenthesizes it', () => {
    expect(t('eqref', 'eq:one')).toBe('(1)')
  })

  it('\\pageref is the page — the field nothing on this side can compute', () => {
    expect(t('pageref', 'sec:app')).toBe('1')
  })

  it('\\autoref names the kind by hyperref\u2019s casing', () => {
    expect(t('autoref', 'sec:a')).toBe('section 1')
    expect(t('autoref', 'sec:sub')).toBe('subsection 1.1')
    expect(t('autoref', 'fig:one')).toBe('Figure 1')
    expect(t('autoref', 'tab:one')).toBe('Table 1')
    expect(t('autoref', 'eq:one')).toBe('Equation 1')
    expect(t('autoref', 'sec:app')).toBe('Appendix A')
  })

  it('\\cref abbreviates, \\Cref does not, and only equations get parens', () => {
    expect(t('cref', 'sec:a')).toBe('section 1')
    expect(t('cref', 'sec:sub')).toBe('section 1.1')
    expect(t('cref', 'fig:one')).toBe('fig. 1')
    expect(t('cref', 'tab:one')).toBe('table 1')
    expect(t('cref', 'eq:one')).toBe('eq. (1)')
    expect(t('Cref', 'sec:a')).toBe('Section 1')
    expect(t('Cref', 'fig:one')).toBe('Figure 1')
    expect(t('Cref', 'eq:one')).toBe('Equation (1)')
  })

  it('a label this compile never saw resolves to null, not to a guess', () => {
    expect(t('ref', 'sec:typed-just-now')).toBeNull()
  })

  it('falls back to the DOM kind when the aux carries no hyperref anchor', () => {
    const plain = parseAux(PROBE_AUX)
    expect(auxRefText(plain, 'autoref', 'fig:one', 'figure')).toBe('Figure 1')
    expect(auxRefText(plain, 'autoref', 'fig:one', null)).toBe('1')
  })
})

/* ---------- the whole pass, against the document ---------- */

function mount(src: string) {
  const rendered = renderDoc(parseLatex(src))
  refreshDerived(rendered.article)
  return rendered
}

/** every ref's text, keyed "cmd key" — a key can carry more than one
 * command in the same document (\ref{sec:app} and \pageref{sec:app} both
 * appear in the probe) and they print different things */
const refTexts = (article: HTMLElement) =>
  Object.fromEntries([...article.querySelectorAll('a.dia-ref')]
    .map((a) => [
      `${a.getAttribute('data-dia-ref-cmd') ?? 'ref'} ${a.getAttribute('data-dia-ref') ?? ''}`,
      a.textContent ?? '',
    ]))

describe('the .aux replaces the counter model', () => {
  it('the measured before: four of six \\ref texts wrong offline', () => {
    const { article } = mount(PROBE_TEX)
    const before = refTexts(article)
    expect(before['ref sec:a']).toBe('1')      // agrees with LaTeX
    expect(before['ref sec:r']).toBe('2')      // LaTeX prints S-2
    expect(before['ref sec:j']).toBe('3')      // LaTeX prints S-10
    expect(before['ref sec:app']).toBe('4')    // LaTeX prints A
    expect(before['ref sec:star']).toBe('5')   // LaTeX prints A
  })

  it('the after: the engine\u2019s own numbers, on the same DOM', () => {
    const { article } = mount(PROBE_TEX)
    setAuxLabels(parseAux(PROBE_AUX), null)
    refreshDerived(article)
    const after = refTexts(article)
    expect(after['ref sec:a']).toBe('1')
    expect(after['ref sec:r']).toBe('S-2')
    expect(after['ref sec:j']).toBe('S-10')
    expect(after['ref sec:app']).toBe('A')
    expect(after['ref sec:star']).toBe('A')
    expect(after['ref fig:one']).toBe('1')
    expect(after['eqref eq:one']).toBe('(1)')
    expect(after['pageref sec:app']).toBe('1')
  })

  it('\\pageref goes from unanswerable to answered', () => {
    const { article } = mount(PROBE_TEX)
    // offline there is no page to know, so the key stands — never the
    // section number, which is what the old counter model handed back
    const page = [...article.querySelectorAll('a.dia-ref')]
      .find((a) => a.getAttribute('data-dia-ref-cmd') === 'pageref')
    expect(page?.textContent).toBe('sec:app')
    setAuxLabels(parseAux(PROBE_AUX), null)
    refreshDerived(article)
    expect(page?.textContent).toBe('1')
  })
})

describe('provisional marking', () => {
  it('offline, every ref says it is provisional', () => {
    const { article } = mount(PROBE_TEX)
    const refs = [...article.querySelectorAll('a.dia-ref')]
    expect(refs.length).toBeGreaterThan(0)
    for (const r of refs) {
      expect(r.classList.contains(PROVISIONAL_CLASS)).toBe(true)
      expect(r.getAttribute('title')).toContain('provisional')
    }
  })

  it('an engine-backed number drops the marking', () => {
    const { article } = mount(PROBE_TEX)
    setAuxLabels(parseAux(PROBE_AUX), null)
    refreshDerived(article)
    const resolved = [...article.querySelectorAll('a.dia-ref')]
      .find((a) => a.getAttribute('data-dia-ref') === 'sec:r')
    expect(resolved?.classList.contains(PROVISIONAL_CLASS)).toBe(false)
    expect(resolved?.hasAttribute('title')).toBe(false)
  })

  it('a label the compile never saw stays provisional beside resolved ones', () => {
    const src = '\\section{A}\\label{sec:a}\n\nSee \\ref{sec:a} and \\ref{sec:new}.\n'
    const { article } = mount(src)
    setAuxLabels(parseAux('\\newlabel{sec:a}{{7}{2}}\n'), null)
    refreshDerived(article)
    const [known, unknown] = [...article.querySelectorAll('a.dia-ref')]
    expect(known.textContent).toBe('7')
    expect(known.classList.contains(PROVISIONAL_CLASS)).toBe(false)
    expect(unknown.textContent).toBe('sec:new')
    expect(unknown.classList.contains(PROVISIONAL_CLASS)).toBe(true)
  })

  it('numbers from a compile of DIFFERENT source stay shown, but provisional', () => {
    const src = '\\section{A}\\label{sec:a}\n\nSee \\ref{sec:a}.\n'
    const { article } = mount(src)
    // no live document in this test, so drive the staleness rule directly:
    // a source string that cannot match anything live
    setNumberSource((_cmd, key) => (key === 'sec:a' ? { text: '7', provisional: true } : null))
    refreshDerived(article)
    const ref = article.querySelector('a.dia-ref')
    expect(ref?.textContent).toBe('7')
    expect(ref?.classList.contains(PROVISIONAL_CLASS)).toBe(true)
  })
})

describe('the derived-text invariant survives all of it', () => {
  it('an unedited block still emits its exact source bytes', () => {
    const src = '\\section{One}\\label{sec:one}\n\nSee \\ref{sec:one} on page \\pageref{sec:one}.\n'
    const doc = parseLatex(src)
    const rendered = renderDoc(doc)
    refreshDerived(rendered.article)
    setAuxLabels(parseAux('\\newlabel{sec:one}{{S-4}{9}}\n'), null)
    refreshDerived(rendered.article)

    const body = rendered.blocks[1]
    expect(body.el.textContent).toContain('See S-4 on page 9.')
    expect(emitBlockTex(body.el)).toBe(src.slice(body.span.start, body.span.end))
  })

  it('…and again after the numbers go back to provisional', () => {
    const src = '\\section{One}\\label{sec:one}\n\nSee \\ref{sec:one}.\n'
    const rendered = renderDoc(parseLatex(src))
    refreshDerived(rendered.article)
    setAuxLabels(parseAux('\\newlabel{sec:one}{{S-4}{9}}\n'), null)
    refreshDerived(rendered.article)
    clearAuxLabels()
    refreshDerived(rendered.article)

    const body = rendered.blocks[1]
    expect(body.el.textContent).toContain('See 1.')
    expect(emitBlockTex(body.el)).toBe(src.slice(body.span.start, body.span.end))
  })
})
