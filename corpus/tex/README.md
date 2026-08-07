# tex corpus — real papers for the LaTeX parser ratchet

Real arXiv papers, flattened to single files (`\input`s inlined), that the
structural parser (`src/latex/`) must handle FOREVER without violating its
span invariants. `src/latex/corpus.test.ts` replays them and holds
per-fixture floors on structure quality (island ratio); floors only move up.
Prefer real papers over synthetic ones — every parser bug so far that
mattered was the kind only a real preamble produces.

All fixtures carry redistribution-compatible licenses; attribution:

| file | paper | arXiv | license |
|---|---|---|---|
| llama.tex | LLaMA: Open and Efficient Foundation Language Models (Touvron et al.) | 2302.13971 | CC BY 4.0 |
| flan.tex | Scaling Instruction-Finetuned Language Models (Chung et al.) | 2210.11416 | CC BY 4.0 |
| cot.tex | Chain-of-Thought Prompting Elicits Reasoning in LLMs (Wei et al.) | 2201.11903 | CC BY 4.0 |
| palm.tex | PaLM: Scaling Language Modeling with Pathways (Chowdhery et al.) | 2204.02311 | CC BY 4.0 |
| bloom.tex | BLOOM: A 176B-Parameter Open-Access Multilingual LM (BigScience) | 2211.05100 | CC BY 4.0 |
| palm2.tex | PaLM 2 Technical Report (Anil et al.) | 2305.10403 | CC BY-SA 4.0 |

Sources were fetched from arXiv e-print and flattened by inlining
`\input{...}` files recursively; content is otherwise unmodified.

To add a fixture: pick a REAL document (check its license permits
redistribution), flatten it, drop it here, run the corpus test, and commit
the new floors it prints. To lower a floor: don't — unless a deliberate
parser change makes structure honestly coarser, in which case lower it in
the same commit with a comment saying why.

## Authored fixtures (document-family breadth)

The six papers above are all article-class, mostly two-column conference
layouts — every heuristic in `src/latex/` had only ever been hardened
against that one shape. issue #8 broadens the corpus to other document
FAMILIES a real user will open: a thesis, a beamer deck, a biblatex
document, a math-heavy monograph. Real papers of these shapes are much
harder to source under a redistribution-compatible license (theses and
decks are rarely CC-licensed), so these four are authored — fictional
content, plainly fictional authorship ("A. Author"), real LaTeX structure
(real sectioning, cross-references, citations, floats, theorem
environments, overlays). They hold the same ratchets as the arXiv six.

| dir | class/packages | exercises |
|---|---|---|
| thesis/ | book, twoside | `\chapter`, front/back matter, `\tableofcontents`, double-page headers, appendix |
| beamer/ | beamer | frames, overlays (`\pause`, `\onslide`, `\item<n->`), `\section` nav markup |
| biblatex/ | biblatex (backend=bibtex) | `\printbibliography`, `\autocite`/`\parencite`/`\textcite` incl. sentence-case |
| theorems/ | amsthm, amsmath | theorem/lemma/proof environments, numbered display math, `align`/`cases` |
