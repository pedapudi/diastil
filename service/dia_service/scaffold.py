"""Agent-facing scaffolding — stdlib only, like validate.

`dia new` writes a guaranteed profile-valid starting deck: any tool that
can write files can generate dia-native presentations by scaffolding,
editing the HTML, and holding itself to `dia validate`.

`dia agents-md` prints an operating manual ready to paste into the
AGENTS.md / CLAUDE.md / GEMINI.md of any coding agent — the same content
for every tool, because the interface (files + CLI) is tool-agnostic.
"""

from __future__ import annotations

DECK_TEMPLATE = """<!doctype html>
<html lang="en" data-dia-version="1">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style id="dia-theme">
:root {{
  --dia-paper: #F2EEDE;
  --dia-ink: #1A1A1A;
  --dia-ink-soft: #33312B;
  --dia-ink-faint: #85837A;
  --dia-accent: #1E6FCC;
  --dia-rule: #C6C3B6;
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
      <svg class="dia-scene" viewBox="0 0 340 220" role="img" aria-label="example diagram">
        <g data-dia-node="input" data-shape="rounded" data-x="20" data-y="24" data-w="120" data-h="40">
          <text class="dia-node-label">input</text>
        </g>
        <g data-dia-node="output" data-shape="rounded" data-x="200" data-y="140" data-w="120" data-h="40">
          <text class="dia-node-label">output</text>
        </g>
        <g data-dia-edge="input->output" data-anchors="S,W" data-route="ortho" data-label="flows"></g>
      </svg>
      <figcaption class="dia-caption">fig 1 — scenes route their own edges</figcaption>
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
   - light zicato palettes — the scaffold's tokens ARE the default
     (paper #F2EEDE · ink #1A1A1A · accent #1E6FCC); never invent warm
     cream + terracotta + serif palettes (a known LLM tell)
   - sans for prose (`--dia-face-display/body`), mono ONLY for labels
     (`--dia-face-label`)
   - VISUALIZE BY DEFAULT: nearly every content slide carries a
     hand-drawn `<figure class="dia-figure">` with one inline
     `<svg viewBox="…">` — evocative token-bound line art (hairline
     strokes ≈0.9–1.6 in var(--dia-ink-faint), layered opacity, dashed
     envelopes) with the ACCENT spent on the one element that carries
     the meaning. A text-only slide must earn its plainness.
   - never `border-left` accent stripes on panels/callouts — the
     validator flags them (`style/left-rail`); panels are full hairline
     borders with an accent label
4. Validate after EVERY edit — this is the contract gate:
   `dia validate deck.html`   (exit 1 on errors; advisories name style
   drift — fix those too)

### Operate dia

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

The repository ships agent-agnostic skills in `skills/` — one file each
for authoring, scenes/diagrams, validation rules and fixes, the CLI, the
import pipeline, the editor UI, and extending diastil. Read
`skills/README.md` for the index. Claude Code users can install these as
a plugin: `/plugin marketplace add pedapudi/diastil`.
"""


def deck_html(title: str) -> str:
    safe = title.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return DECK_TEMPLATE.format(title=safe)
