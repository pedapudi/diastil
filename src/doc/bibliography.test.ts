/* parseBbl over real .bbl fixtures, and citeText's natbib rendering.
 * The display-only guarantee (data-dia-cite stays the emit truth) is
 * pinned in emit.test.ts and doc.roundtrip.test.ts, not here — this file
 * is only about what applyBibliography WRITES into a.dia-cite's text. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseLatex } from '../latex/parse'
import { renderDoc } from '../latex/render'
import { applyBibliography, citeText, parseBbl } from './bibliography'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const read = (rel: string) => readFileSync(join(repo, 'corpus', 'tex', rel), 'utf-8')

describe('parseBbl on real corpus fixtures', () => {
  it('llama.bbl: plain "et al." entries and a single-author one', () => {
    const bib = parseBbl(read('llama/llama.bbl'))
    expect(bib.get('austin2021program')).toEqual({ authors: 'Austin et al.', year: '2021' })
    expect(bib.get('bahl1983maximum')).toEqual({ authors: 'Bahl et al.', year: '1983' })
    expect(bib.get('elman1990finding')).toEqual({ authors: 'Elman', year: '1990' })
  })

  it('llama/acl2023.bbl: the short author form, accents in the full list ignored', () => {
    const bib = parseBbl(read('llama/acl2023.bbl'))
    // Karafi{\'a}t, Cernock{\`y} etc. are past the year — full-list-only, never shown
    expect(bib.get('mikolov2010recurrent')).toEqual({ authors: 'Mikolov et al.', year: '2010' })
    expect(bib.get('scao2022bloom')).toEqual({ authors: 'Scao et al.', year: '2022' })
  })

  it('cot/neurips_2022.bbl: a two-author entry with no "et al." and an accent', () => {
    const bib = parseBbl(read('cot/neurips_2022.bbl'))
    expect(bib.get('wiegreffe2021teach')).toEqual({ authors: 'Wiegreffe and Marasović', year: '2021' })
  })

  it('cot/neurips_2022.bbl: a braced collaboration name with no "et al."', () => {
    const bib = parseBbl(read('cot/neurips_2022.bbl'))
    expect(bib.get('bigbench')).toEqual({ authors: 'BIG-bench collaboration', year: '2021' })
  })

  it('flan/main.bbl: two-author entry, and \\natexlab disambiguates same-year dupes', () => {
    const bib = parseBbl(read('flan/main.bbl'))
    expect(bib.get('baumler-rudinger-2022-recognition'))
      .toEqual({ authors: 'Baumler and Rudinger', year: '2022' })
    expect(bib.get('borkan_nuanced')).toEqual({ authors: 'Borkan et al.', year: '2019a' })
    expect(bib.get('civilcomments')).toEqual({ authors: 'Borkan et al.', year: '2019b' })
  })

  it('every \\bibitem in a real bbl resolves to an entry', () => {
    const text = read('llama/llama.bbl')
    const count = (text.match(/\\bibitem/g) ?? []).length
    expect(parseBbl(text).size).toBe(count)
  })
})

describe('citeText: natbib rendering from a resolved bib map', () => {
  const bib = new Map([
    ['brown2020', { authors: 'Brown et al.', year: '2020' }],
    ['elman1990', { authors: 'Elman', year: '1990' }],
  ])

  it('citep is parenthetical, author comma year', () => {
    expect(citeText('citep', ['brown2020'], null, null, bib)).toBe('(Brown et al., 2020)')
  })

  it('citet is textual, year in its own parens', () => {
    expect(citeText('citet', ['brown2020'], null, null, bib)).toBe('Brown et al. (2020)')
  })

  it('bare \\cite renders the citep shape', () => {
    expect(citeText('cite', ['brown2020'], null, null, bib)).toBe('(Brown et al., 2020)')
  })

  it('multiple keys join with "; "', () => {
    expect(citeText('citep', ['brown2020', 'elman1990'], null, null, bib))
      .toBe('(Brown et al., 2020; Elman, 1990)')
    expect(citeText('citet', ['brown2020', 'elman1990'], null, null, bib))
      .toBe('Brown et al. (2020); Elman (1990)')
  })

  it('a single-bracket optional arg is a post-note', () => {
    expect(citeText('citep', ['brown2020'], null, 'p. 9', bib)).toBe('(Brown et al., 2020, p. 9)')
    expect(citeText('citet', ['brown2020'], null, 'p. 9', bib)).toBe('Brown et al. (2020, p. 9)')
  })

  it('the two-bracket form places a pre-note before the author', () => {
    expect(citeText('citep', ['brown2020'], 'see', 'and refs therein', bib))
      .toBe('(see Brown et al., 2020, and refs therein)')
    expect(citeText('citet', ['brown2020'], 'see', null, bib))
      .toBe('see Brown et al. (2020)')
  })

  it('an empty post-note in the two-bracket form adds no trailing comma', () => {
    expect(citeText('citep', ['brown2020'], 'see', '', bib)).toBe('(see Brown et al., 2020)')
  })

  it('an unknown key keeps the WHOLE group as the honest [key] placeholder', () => {
    expect(citeText('citep', ['nope'], null, null, bib)).toBe('[nope]')
    expect(citeText('citep', ['brown2020', 'nope'], null, null, bib)).toBe('[brown2020, nope]')
  })

  it('no bibliography at all keeps [key], today\'s default', () => {
    expect(citeText('citep', ['brown2020'], null, null, new Map())).toBe('[brown2020]')
  })
})

describe('applyBibliography rewrites a.dia-cite text in the rendered article', () => {
  it('resolves a citep and leaves an unknown-key citet alone', () => {
    const src = 'As shown \\citep{brown2020gpt3} and \\citet{ghost2099}.\n'
    const rendered = renderDoc(parseLatex(src))
    const bib = new Map([['brown2020gpt3', { authors: 'Brown et al.', year: '2020' }]])
    applyBibliography(rendered.article, bib)
    const cites = [...rendered.article.querySelectorAll('a.dia-cite')]
    expect(cites[0].textContent).toBe('(Brown et al., 2020)')
    expect(cites[1].textContent).toBe('[ghost2099]')
    // the truth never moves — this is the whole point of "display only"
    expect(cites[0].getAttribute('data-dia-cite')).toBe('brown2020gpt3')
  })
})

describe('a note is prose, not its own source', () => {
  it('renders LaTeX markup inside a pre/post note', () => {
    // \citep[see][\textit{inter alia}]{a} — cot.tex writes exactly this, and
    // a note shown as raw \textit{…} is the unrendered-tex defect
    const bib = new Map([['a', { key: 'a', label: 'Author et al.(2020)Author', authors: 'Author et al.', year: '2020' }]])
    const out = citeText('citep', ['a'], null, '\\textit{inter alia}', bib)
    expect(out).toBe('(Author et al., 2020, inter alia)')
    expect(out).not.toContain('\\textit')
  })
})
