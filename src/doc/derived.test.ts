/* The words \autoref and \cref print, when the DOCUMENT renames them.
 *
 * The .aux records a label's kind and never the word, so these come from
 * derived.ts's measured tables — and any preamble may overwrite those
 * tables (\crefname{figure}{diagram}{diagrams}, \renewcommand{\section
 * autorefname}{Chapter}) or move the whole document into a language they
 * were never measured in. parse.ts mines the declarations; the meta is
 * constructed by hand here so this file pins the CONTRACT rather than the
 * parser, and so the absent-keys case — every document that declares none
 * of this — is tested as its own state. */

import { beforeEach, describe, expect, it } from 'vitest'
import { parseLatex } from '../latex/parse'
import { renderDoc } from '../latex/render'
import { emitBlockTex } from '../latex/emit'
import { refDisplay, refreshDerived, setRefNames, type RefNameMeta } from './derived'
import { parseAux, setAuxLabels, clearAuxLabels } from './auxnumbers'

beforeEach(() => {
  clearAuxLabels()
  setRefNames(undefined)
})

const shows = (cmd: string, kind: string) => refDisplay(cmd, kind, '1', null, 'k')

/* ---------- no declarations: the state of nearly every document ---------- */

describe('a document that declares nothing', () => {
  it('keeps the measured hyperref and cleveref defaults', () => {
    expect(shows('autoref', 'figure')).toBe('Figure 1')
    expect(shows('autoref', 'section')).toBe('section 1')
    expect(shows('cref', 'figure')).toBe('fig. 1')
    expect(shows('Cref', 'section')).toBe('Section 1')
  })

  it('is what setRefNames(undefined) and an empty meta both mean', () => {
    setRefNames({})
    expect(shows('cref', 'figure')).toBe('fig. 1')
    setRefNames({ crefNames: {}, refNames: {}, language: undefined })
    expect(shows('cref', 'figure')).toBe('fig. 1')
  })
})

/* ---------- \crefname / \Crefname ---------- */

describe('the preamble renames cleveref\u2019s words', () => {
  it('\\crefname{figure}{diagram}{diagrams} replaces the default', () => {
    setRefNames({ crefNames: { figure: { sg: 'diagram', pl: 'diagrams' } } })
    expect(shows('cref', 'figure')).toBe('diagram 1')
    // untouched kinds keep the measured defaults — a rename is per type
    expect(shows('cref', 'table')).toBe('table 1')
  })

  it('\\Cref uppercases a \\crefname the document gave only in lowercase', () => {
    setRefNames({ crefNames: { figure: { sg: 'diagram', pl: 'diagrams' } } })
    expect(shows('Cref', 'figure')).toBe('Diagram 1')
  })

  it('an explicit \\Crefname wins over that uppercasing', () => {
    setRefNames({ crefNames: { figure: { sg: 'diagram', Sg: 'DIAGRAM' } } })
    expect(shows('cref', 'figure')).toBe('diagram 1')
    expect(shows('Cref', 'figure')).toBe('DIAGRAM 1')
  })

  it('\\Crefname alone never lowercases itself into \\cref', () => {
    // downcasing is safe only in English; in German the noun is capital by
    // grammar. So \cref falls back to its own default instead.
    setRefNames({ crefNames: { figure: { Sg: 'Abbildung' } } })
    expect(shows('Cref', 'figure')).toBe('Abbildung 1')
    expect(shows('cref', 'figure')).toBe('fig. 1')
  })

  it('renaming a kind does not renumber or reparenthesize it', () => {
    setRefNames({ crefNames: { equation: { sg: 'formula' } } })
    // cleveref parenthesizes equation numbers whatever they are called
    expect(shows('cref', 'equation')).toBe('formula (1)')
  })

  it('leaves \\ref, \\eqref and \\pageref alone — they print no word', () => {
    setRefNames({ crefNames: { figure: { sg: 'diagram' } }, refNames: { figure: 'Diagram' } })
    expect(refDisplay('ref', 'figure', '1', null, 'k')).toBe('1')
    expect(refDisplay('eqref', 'equation', '1', null, 'k')).toBe('(1)')
    expect(refDisplay('pageref', 'figure', '1', '7', 'k')).toBe('7')
  })
})

/* ---------- \<type>autorefname ---------- */

describe('the preamble renames hyperref\u2019s words', () => {
  it('\\renewcommand{\\sectionautorefname}{Chapter} is honoured', () => {
    setRefNames({ refNames: { section: 'Chapter' } })
    expect(shows('autoref', 'section')).toBe('Chapter 1')
    expect(shows('autoref', 'figure')).toBe('Figure 1')
  })

  it('the two vocabularies stay separate — \\cref is not \\autoref', () => {
    setRefNames({ refNames: { figure: 'Diagram' } })
    expect(shows('autoref', 'figure')).toBe('Diagram 1')
    expect(shows('cref', 'figure')).toBe('fig. 1')
  })
})

/* ---------- a declared language ---------- */

describe('a declared language', () => {
  it('English (babel, any dialect) keeps the measured tables', () => {
    for (const lang of ['english', 'american', 'UKenglish', 'British']) {
      setRefNames({ language: lang })
      expect(shows('autoref', 'figure')).toBe('Figure 1')
      expect(shows('cref', 'figure')).toBe('fig. 1')
    }
  })

  it('any other language drops the WORD and keeps the number', () => {
    // We do not have babel's translations and will not type them from
    // memory: "Figure 1" inside German prose is wrong in a way that reads
    // as the author's own text, while "1" is merely incomplete.
    setRefNames({ language: 'ngerman' })
    expect(shows('autoref', 'figure')).toBe('1')
    expect(shows('cref', 'figure')).toBe('1')
    expect(shows('Cref', 'section')).toBe('1')
    // the number-only commands are untouched, including the parens cleveref
    // puts round an equation regardless of language
    expect(refDisplay('ref', 'section', '2.1', null, 'k')).toBe('2.1')
    expect(shows('cref', 'equation')).toBe('(1)')
  })

  it('…unless the document declares the words itself, which it may', () => {
    setRefNames({
      language: 'ngerman',
      crefNames: { figure: { sg: 'Abbildung', pl: 'Abbildungen' } },
      refNames: { section: 'Abschnitt' },
    })
    expect(shows('cref', 'figure')).toBe('Abbildung 1')
    expect(shows('Cref', 'figure')).toBe('Abbildung 1')
    expect(shows('autoref', 'section')).toBe('Abschnitt 1')
    // and the kinds it did NOT name still degrade to the number
    expect(shows('cref', 'table')).toBe('1')
  })
})

/* ---------- the vocabulary belongs to the document, not the session ---------- */

describe('setRefNames replaces, never merges', () => {
  it('a second document does not inherit the first\u2019s words', () => {
    setRefNames({ crefNames: { figure: { sg: 'diagram' } }, language: 'ngerman' })
    expect(shows('cref', 'figure')).toBe('diagram 1')
    setRefNames(undefined)
    expect(shows('cref', 'figure')).toBe('fig. 1')
    expect(shows('autoref', 'table')).toBe('Table 1')
  })
})

/* ---------- through the whole pass, on a real document ---------- */

const DOC_TEX = `\\documentclass{article}
\\begin{document}
\\section{Alpha}\\label{sec:a}
\\begin{figure}\\caption{One}\\label{fig:one}\\end{figure}
See \\cref{fig:one} and \\autoref{sec:a}.
\\end{document}
`

const refTexts = (article: HTMLElement) =>
  [...article.querySelectorAll('a.dia-ref')].map((a) => a.textContent ?? '')

describe('refreshDerived over the document', () => {
  it('applies the preamble\u2019s words to our own counters', () => {
    setRefNames({ crefNames: { figure: { sg: 'diagram' } }, refNames: { section: 'Chapter' } })
    const { article } = renderDoc(parseLatex(DOC_TEX))
    refreshDerived(article)
    expect(refTexts(article)).toEqual(['diagram 1', 'Chapter 1'])
  })

  it('and to the engine\u2019s numbers — the .aux carries kinds, never words', () => {
    setRefNames({ crefNames: { figure: { sg: 'diagram' } }, refNames: { section: 'Chapter' } })
    const { article } = renderDoc(parseLatex(DOC_TEX))
    refreshDerived(article)
    setAuxLabels(parseAux(
      '\\newlabel{fig:one}{{4}{2}{One}{figure.4}{}}\n'
      + '\\newlabel{fig:one@cref}{{[figure][4][]4}{[2][2][]2}}\n'
      + '\\newlabel{sec:a}{{S-3}{1}{Alpha}{section.1}{}}\n',
    ), null)
    refreshDerived(article)
    expect(refTexts(article)).toEqual(['diagram 4', 'Chapter S-3'])
  })

  it('the derived-text invariant holds: the block still emits its bytes', () => {
    const src = '\\section{One}\\label{sec:one}\n\nSee \\cref{sec:one}.\n'
    setRefNames({ crefNames: { section: { sg: 'clause' } } })
    const rendered = renderDoc(parseLatex(src))
    refreshDerived(rendered.article)
    const body = rendered.blocks[1]
    expect(body.el.textContent).toContain('See clause 1.')
    expect(emitBlockTex(body.el)).toBe(src.slice(body.span.start, body.span.end))

    // and again after the vocabulary changes under a live document
    setRefNames({ language: 'ngerman' })
    refreshDerived(rendered.article)
    expect(body.el.textContent).toContain('See 1.')
    expect(emitBlockTex(body.el)).toBe(src.slice(body.span.start, body.span.end))
  })

  it('a meta typed to the contract is all this module needs', () => {
    // the seam model/doc.ts passes across: three optional keys, nothing else
    const meta: RefNameMeta = { crefNames: { table: { sg: 'tbl.', Sg: 'Tbl.' } } }
    setRefNames(meta)
    expect(shows('cref', 'table')).toBe('tbl. 1')
    expect(shows('Cref', 'table')).toBe('Tbl. 1')
  })
})
