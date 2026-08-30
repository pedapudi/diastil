"""Agent-facing scaffolding — stdlib only, like validate.

`dia new` writes a guaranteed profile-valid starting deck: any tool that
can write files can generate dia-native presentations by scaffolding,
editing the HTML, and holding itself to `dia validate`.

`dia agents-md` prints an operating manual ready to paste into the
AGENTS.md / CLAUDE.md / GEMINI.md of any coding agent — the same content
for every tool, because the interface (files + CLI) is tool-agnostic.
"""

from __future__ import annotations

from .themes import DEFAULT_THEME, THEME_NAMES, subject_lines, theme_tokens_css

DECK_TEMPLATE = """<!doctype html>
<html lang="en" data-dia-version="1">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style id="dia-theme">
:root {{
{tokens}
  --dia-face-display: "Source Sans 3", system-ui, sans-serif;
  --dia-face-body: "Source Sans 3", system-ui, sans-serif;
  --dia-face-label: "Source Code Pro", ui-monospace, monospace;
  --dia-scale-1: 12px;
  --dia-scale-2: 15px;
  --dia-scale-3: 18px;
  --dia-scale-4: 22px;
  --dia-scale-5: 30px;
  --dia-scale-6: 38px;
  --dia-scale-7: 48px;
  --dia-gap: 24px;
  --dia-pad: 52px;
}}
section.dia-slide {{
  aspect-ratio: 16 / 9;
  box-sizing: border-box;
  overflow: hidden;
  background: var(--dia-paper);
  color: var(--dia-ink);
  padding: var(--dia-pad);
  font-family: var(--dia-face-body);
}}
.dia-kicker {{ font-family: var(--dia-face-label); font-size: var(--dia-scale-1);
  letter-spacing: .14em; text-transform: uppercase; color: var(--dia-accent);
  margin-bottom: 12px; }}
.dia-title {{ font-family: var(--dia-face-display); font-size: var(--dia-scale-5);
  line-height: 1.14; font-weight: 700; margin: 0 0 14px; }}
.dia-cover-title {{ font-size: var(--dia-scale-7); max-width: 16ch; }}
.dia-body {{ font-size: var(--dia-scale-2); line-height: 1.55; color: var(--dia-ink-soft); }}
.dia-body p {{ margin: 0 0 10px; }}
.dia-caption {{ font-family: var(--dia-face-label); font-size: var(--dia-scale-1);
  color: var(--dia-ink-soft); }}
li::before {{ content: var(--dia-marker, none); color: var(--dia-marker-ink, var(--dia-accent)); margin-right: 0.55em; }}
li:has(> .dia-marker) {{ list-style: none; display: grid; grid-template-columns: auto 1fr; column-gap: 0.55em; align-items: start; }}
.dia-marker {{ color: var(--dia-marker-ink, var(--dia-accent)); }}
.dia-marker > svg, .dia-marker > img {{ width: 1.1em; height: 1.1em; display: block; margin-top: 0.2em; }}
.dia-marker.dia-marker-chip {{ display: inline-grid; place-items: center; width: 1.5em; height: 1.5em;
  border-radius: 999px; background: var(--dia-accent); color: var(--dia-paper); font-size: 0.72em; }}
.dia-columns {{ display: grid; grid-template-columns: 1.05fr 1fr; gap: var(--dia-gap); }}
.dia-stack {{ display: flex; flex-direction: column; gap: calc(var(--dia-gap) / 2); }}
.dia-figure {{ align-self: center; }}
aside.dia-notes {{ display: none; }} /* speaker notes — operator-only */
table {{ border-collapse: collapse; font-size: var(--dia-scale-2); }}
th {{ font-family: var(--dia-face-label); font-size: var(--dia-scale-1);
  text-transform: uppercase; letter-spacing: .08em; color: var(--dia-ink-faint);
  text-align: left; font-weight: 500; padding: 6px 18px 6px 0;
  border-bottom: 1.5px solid var(--dia-ink); }}
td {{ padding: 7px 18px 7px 0; border-bottom: 1px solid var(--dia-rule);
  color: var(--dia-ink-soft); }}
td.num, th.num {{ text-align: right; font-variant-numeric: tabular-nums;
  font-family: var(--dia-face-label); }}
.dia-cover {{ display: grid; align-content: center; }}
.dia-scene {{ width: 100%; }}
.dia-scene .dia-node-shape {{ fill: var(--dia-node-fill, var(--dia-paper)); stroke: var(--dia-node-stroke, var(--dia-ink)); stroke-width: var(--dia-node-stroke-w, 1.3); }}
.dia-scene .dia-node-label {{ font: 12px var(--dia-face-body); fill: var(--dia-node-ink, var(--dia-ink)); }}
.dia-scene .dia-edge-path {{ stroke: var(--dia-edge-stroke, var(--dia-ink)); stroke-width: var(--dia-edge-w, 1.2); fill: none; color: var(--dia-edge-stroke, var(--dia-ink)); }}
.dia-scene .dia-edge-label {{ font: 10px var(--dia-face-label); fill: var(--dia-edge-ink, var(--dia-ink-soft)); }}
.dia-scene [data-dia-emphasis] .dia-node-shape {{ stroke: var(--dia-accent); stroke-width: 2; }}
.dia-draw {{ fill: none; stroke: var(--dia-ink); stroke-linecap: round; stroke-linejoin: round; }}
</style>
</head>
<body>

<section class="dia-slide dia-cover">
  <div class="dia-kicker">kicker</div>
  <h1 class="dia-title dia-cover-title">{title}</h1>
  <div class="dia-body">One line on what this deck argues.</div>
</section>

<section class="dia-slide">
  <div class="dia-kicker">section</div>
  <h2 class="dia-title">A content slide</h2>
  <div class="dia-columns">
    <div class="dia-stack">
      <div class="dia-body">
        <p>Body text lives in <code>.dia-body</code>. Roles bind to the
        scale tokens, so retheming is one edit.</p>
        <p data-dia-step="1">This line reveals second in present mode.</p>
      </div>
    </div>
    <figure class="dia-figure">
      <!-- the data-dia-* attributes are the truth the editor edits and
           re-derives from; the shapes, labels and edge path below are the
           DERIVED rendering, so the scene shows in any browser rather than
           only inside the editor -->
      <svg class="dia-scene" viewBox="0 0 340 220" role="img" aria-label="example diagram">
        <g data-dia-node="input" data-shape="rounded" data-x="20" data-y="24" data-w="120" data-h="40">
          <rect class="dia-node-shape" x="20" y="24" width="120" height="40" rx="6"/>
          <text class="dia-node-label" x="80" y="49" text-anchor="middle">input</text>
        </g>
        <g data-dia-node="output" data-shape="rounded" data-x="200" data-y="140" data-w="120" data-h="40">
          <rect class="dia-node-shape" x="200" y="140" width="120" height="40" rx="6"/>
          <text class="dia-node-label" x="260" y="165" text-anchor="middle">output</text>
        </g>
        <g data-dia-edge="input-&gt;output" data-anchors="S,W" data-route="ortho" data-label="flows">
          <path class="dia-edge-path" d="M80 64V160h120"/>
          <text class="dia-edge-label" x="88" y="120">flows</text>
        </g>
      </svg>
      <figcaption class="dia-caption">fig 1 — scenes route their own edges</figcaption>
    </figure>
  </div>
</section>

<section class="dia-slide">
  <div class="dia-kicker">section</div>
  <h2 class="dia-title">A drawn slide</h2>
  <div class="dia-columns">
    <div class="dia-stack">
      <div class="dia-body">
        <p>Most content slides carry a drawing, not a node diagram. Give
        every named thing an OBJECT MARK — a 24-unit, 3-6 stroke glyph —
        defined once and placed wherever the noun recurs.</p>
      </div>
    </div>
    <figure class="dia-figure">
      <svg viewBox="0 0 340 150" role="img" aria-label="a pool of workers reading one store">
        <defs>
          <symbol id="m-pool" viewBox="0 0 24 24">
            <g fill="none" stroke="currentColor" stroke-width="1.5"
               stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="8" width="14" height="10" rx="2"/>
              <path d="M5 8V5h14v10h-3"/><path d="M8 5V2h14v10h-3"/>
            </g>
          </symbol>
          <symbol id="m-store" viewBox="0 0 24 24">
            <g fill="none" stroke="currentColor" stroke-width="1.5"
               stroke-linecap="round" stroke-linejoin="round">
              <ellipse cx="12" cy="5" rx="8" ry="3"/>
              <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/>
              <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>
            </g>
          </symbol>
        </defs>
        <!-- `color` on the placing group is what lets ONE definition be faint
             here and accent there, with no second copy of the path data -->
        <g color="var(--dia-accent)"><use href="#m-pool" x="46" y="40" width="30" height="30"/></g>
        <g color="var(--dia-ink-faint)"><use href="#m-store" x="230" y="40" width="30" height="30"/></g>
        <path d="M84 55h138" fill="none" stroke="var(--dia-rule)" stroke-width="1.1"/>
        <text x="61" y="94" text-anchor="middle" font-size="10.5"
              fill="var(--dia-accent)" font-family="var(--dia-face-label)">workers</text>
        <text x="245" y="94" text-anchor="middle" font-size="10.5"
              fill="var(--dia-ink-faint)" font-family="var(--dia-face-label)">store</text>
      </svg>
      <figcaption class="dia-caption">fig 2 — one accent, spent on what the slide argues</figcaption>
    </figure>
  </div>
</section>

</body>
</html>
"""


AGENTS_SNIPPET = """## diastil — generate and operate HTML slide decks

diastil decks are plain, self-contained HTML in a small dialect. You do
not need the GUI to create or edit them: write the file, then hold
yourself to the validator. The file is the format — there is no build
step and no private data model.

### Generate a deck

1. Scaffold a guaranteed-valid starting deck:
   `dia new deck.html --title "My talk"`
   (or copy an existing .dia.html and replace its slides)
2. Edit the HTML directly. The grammar:
   - one `<section class="dia-slide">` per slide; body children are ONLY
     slides + the theme `<style id="dia-theme">`
   - text roles: `.dia-kicker` (small label above the title), `.dia-title`,
     `.dia-body` (prose), `.dia-caption`; layout: `.dia-columns` (grid),
     `.dia-stack`, `.dia-figure`, `.dia-cover`
   - every color/size/face comes from the `--dia-*` tokens in the theme
     block — never hard-code values that a token expresses
   - diagrams are scenes: `<svg class="dia-scene" viewBox="…">` with
     `<g data-dia-node="id" data-shape="rounded" data-x data-y data-w data-h>`
     nodes (label = child `<text class="dia-node-label">`) and
     `<g data-dia-edge="a->b" data-anchors="E,W" data-route="ortho">` edges.
     edge `d` is DERIVED from the data-* attrs (the editor re-routes on
     any edit) — but include a plain anchor-to-anchor path.dia-edge-path
     rendering so the scene shows without JS
   - staged reveals: `data-dia-step="1"` (positive int) on any element;
     `data-dia-step-until="N"` exits an element at step N;
     `data-dia-spotlight` on a container recedes already-shown steps;
     speaker notes live in `<aside class="dia-notes">` (hidden when
     presenting); `data-dia-auto="page"` fills "N / N" page furniture
   - charts are data: `<svg class="dia-chart" data-chart="bar|line|scatter"
     data-values="Q1:12, Q2:19" data-max data-unit>` — the editor bakes a
     token-bound rendering; edit the attributes, never the derived group
   - content the dialect can't express (scripts, iframes, live widgets):
     wrap in `<div data-dia-island>` — islands are preserved verbatim and
     exempt from validation
   - no `<script>` and no `on*=` handlers outside islands
3. Follow the HOUSE STYLE (the scaffold already does):
   - CHOOSE A COLOUR SCHEME for the deck's subject, and vary it between
     decks. `dia new --theme NAME` (or the `theme` argument of the MCP
     `dia_new`) writes any of the sixteen zicato palettes; a body of
     decks that are all `paper` reads as one author who stopped
     deciding. paper — technical work, reports, the neutral default ·
     solarized-light — teaching, essays · lunaria-light — design,
     product · belafonte-day — archival and literary · selenized-black
     — systems and terminal subjects · ubuntu — community and
     open-source · solarized-dark — data-heavy evening venues ·
     dracula — developer-culture audiences. NEVER invent a palette:
     warm cream + terracotta + serif is a known LLM tell, and every
     colour comes from the `--dia-*` tokens in the theme block.
   - sans for prose (`--dia-face-display/body`), mono ONLY for labels
     (`--dia-face-label`)
   - VISUALIZE BY DEFAULT: roughly one figure per content slide,
     planned before the prose, in a `<figure class="dia-figure">` with
     one inline `<svg viewBox="…">`. A text-only slide must earn its
     plainness. THREE registers, and the slide's claim picks:
     * a mechanism, a sequence, a structure, an architecture → a
       technical drawing of the real parts in their real arrangement,
       hairline strokes ≈0.9–1.6 in `var(--dia-ink-faint)`, with an
       OBJECT MARK beside every named noun (a ~24-unit, 3–6 stroke line
       glyph: three stacked rects for a pool, a shield with a dot for
       an identity, a cylinder for a store, a hub with three spokes for
       a lookup service, three falling bars for a counter, a folded-
       corner page for a document). Define each once in
       `<defs><symbol viewBox="0 0 24 24">` with `stroke="currentColor"`
       and `<use href="#id">` it wherever the noun recurs — set `color`
       on the placing `<g>` so one definition is faint in most places
       and accent in the one that argues.
     * a scale, a proportion, a rate → draw it to scale and say so.
     * an exception, a trajectory, a tradeoff, and the COVER → an
       evocative metaphor: layered opacity, dashed envelopes, or a
       full-colour pictorial piece (flat faceted planes, a lit and a
       shadow face, recession by lightness). Do not put a metaphor on
       every slide — a technical deck is mostly technical drawings with
       a metaphor at its covers and its turns.
     Spend `var(--dia-accent)` exactly ONCE per figure, on the element
     that carries the meaning — and not always as a line pointing at
     something: a lit face, a differing scale, the one filled form
     among outlines, or a gap all carry an accent, and a picture that
     needs a leader line to be understood usually needs a better
     composition instead.
   - never `border-left` accent stripes on panels/callouts — the
     validator flags them (`style/left-rail`); panels are full hairline
     borders with an accent label
4. Validate after EVERY edit — this is the contract gate:
   `dia validate deck.html`   (exit 1 on errors; advisories name style
   drift — fix those too)

### Operate dia

- `dia ingest <deck.html|deck.pptx>` — convert a foreign deck (HTML or
  PowerPoint) through the review flow
- `dia export <deck.html> [--pptx out]` — render a deck to a native .pptx
  (text boxes, shapes + connectors, vector charts and tables; opens in
  PowerPoint/Keynote, imports to Google Slides as editable objects)
- `dia validate <files…>` — profile check (stdlib-only, no install needed
  beyond the package)
- `dia new <file> [--title t]` — scaffold a valid deck
- `dia present deck.html` — open a deck in a browser; it presents itself
  (arrows navigate, steps reveal)
- `dia deck.html` / `dia edit deck.html` — human-facing WYSIWYG editor
  with save-back (needs the built editor bundle)
- `dia ingest foreign.html` — convert a non-dialect deck through the
  import review
- `dia serve` — the local inference service (copilot/repair skills)
- headless environments: add `--no-open`; every command prints its URL
- `dia mcp` — the same operations as MCP tools over stdio, for agents
  without shell access (inference tools proxy to a running `dia serve`)

### Deeper reference

Everything above is what an agent needs to generate a deck; the fuller
craft guidance lives in the repository's agent-agnostic skills — one
file each for authoring, artwork, scenes/diagrams, validation rules and
fixes, the CLI, the import pipeline, the editor UI, and extending
diastil. Read `skills/README.md` for the index if you have the
repository checked out; over MCP you do not, so treat this manual as
the whole contract. Claude Code users can install the skills as a
plugin: `/plugin marketplace add pedapudi/diastil`.
"""


def deck_html(title: str, theme: str = DEFAULT_THEME) -> str:
    """A profile-valid starting deck in one of the house colour schemes.

    The scheme is an argument rather than a constant because it is an
    authoring decision: every deck coming out in `paper` is the tell of a
    generator that never chose. `themes.palette` raises on an unknown name,
    so a typo cannot quietly produce the default."""
    safe = title.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return DECK_TEMPLATE.format(title=safe, tokens=theme_tokens_css(theme))


DOC_TEMPLATE = r"""\documentclass{article}

\title{__TITLE__}
\author{}

\begin{document}
\maketitle

\begin{abstract}
One paragraph on what this document establishes and why it matters.
\end{abstract}

\section{Introduction}\label{sec:intro}

Start writing. Inline math works anywhere: $e^{i\pi} + 1 = 0$.

\section{Method}

Display math numbers itself and can be referenced from prose:
\begin{equation}\label{eq:main}
f(x) = \int_{-\infty}^{\infty} \hat f(\xi)\, e^{2\pi i \xi x}\, d\xi
\end{equation}

As Equation~\ref{eq:main} shows, Section~\ref{sec:intro} promised nothing
it could not deliver.

\begin{itemize}
\item lists,
\item and \textbf{inline styling},
\item and \texttt{code} all map to the editor's native view.
\end{itemize}

\end{document}
"""


def doc_tex(title: str) -> str:
    """A LaTeX document starter — plain article class, no package baggage,
    so it compiles anywhere and every construct maps to the native view."""
    return DOC_TEMPLATE.replace("__TITLE__", title or "Untitled")
