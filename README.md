# diastil

**diastīl** (*die-ah-STYLE* — dia + style, via Latin *stīlus*, the pen;
the ī is the dictionary-key "long i" of *īce*, and it is display-only —
everything machine-facing stays `diastil`/`dia`) — a browser-based
WYSIWYG editor for HTML/CSS/JS slide decks. The condensation mark — three slide-lines
converging to one accent drop — draws the second reading, *distill*:
many sources, one verified document. Brand rules:
[docs/BRAND.md](docs/BRAND.md); visual defaults (light-first, role
tokens, colorful artwork): [docs/HOUSE-STYLE.md](docs/HOUSE-STYLE.md).

*Dia* (the projection slide) + *Stil* (style). The CLI clips to `dia`.

Agent-generated decks arrive as arbitrary HTML. diastil ingests them,
converts them into a normalized, enumerable HTML dialect — the deck
remains a self-contained HTML file any tool can keep editing — and puts
a direct-manipulation editor on top: typesetting, photosetting, and
first-class diagramming, with an inference copilot that emits the same
typed edit operations a human does.

What's inside: the document core (ops, byte-stable round-trip, two
validators in lockstep), a direct-manipulation editor (table + minimap,
scene layer with obstacle-avoiding edge routing, svg studio, storyboard,
native MathML math), verified ingest (a pixel-fidelity metric gates
every conversion and repair), a local inference service with copilot,
CLI, and MCP surfaces, and a corpus ratchet that keeps import quality
from regressing. Architecture: [PLAN.md](PLAN.md). Dialect contract:
[profile/PROFILE.md](profile/PROFILE.md).

## Getting started

```sh
npm install
npm run dev          # → http://localhost:5199
```

The editor opens on the built-in demo deck (six slides, one scene
diagram). Double-click text to edit (`Enter` commits), `Enter`/`Esc` to
move between the table and stage altitudes, drag diagram nodes and watch
edges reroute, `⌘S` to save — the saved file is self-contained HTML that
presents itself when opened. Select any svg artwork and open it in the
**studio** — a full-screen drawing surface with pen/shape/freehand/text
tools, transform handles, layers, deck-token color swatches, and
sanitized svg import — every gesture an undoable op on the document.

To try **conversion**, click `open` and pick any file in
[examples/fixtures/](examples/fixtures/) — eight foreign decks covering
the input taxonomy (reveal-, marp-, remark-, impress-shaped, utility-class
soup, PDF-like, live-canvas, one-visible-at-a-time). Foreign HTML is
detected automatically and routed through the review screen: original vs
converted with a difference overlay and per-slide pixel-fidelity scores.

**No toolchain at all:** `npm run standalone` (once, or in CI) emits
`dist/diastil.html` — the entire editor as one self-contained file
(~330 KB, fonts embedded, zero requests). Open it from anywhere — a
double-click on `file://` works: decks open through the file picker and
save as downloads. The editor becomes what its documents are: a single
HTML file.

The CLI and the optional inference service (model-assisted conversion
repair, diagram lifting, the copilot rail):

```sh
cd service && python3 -m venv .venv && .venv/bin/pip install -e .
dia new talk.html        # scaffold a profile-valid deck (agents start here)
dia deck.html            # edit a local file, ⌘S writes back
dia ingest foreign.html  # convert a foreign deck (.html or .pptx)
dia export deck.html     # render a deck to .pptx (PowerPoint / Keynote / Slides)
dia validate deck.html   # profile-check (stdlib-only, no venv needed)
dia serve                # inference sidecar — see service/README.md
```

Tests: `npm test`. Agent operating manuals: [skills/](skills/README.md).

Coding agents (Claude Code, Codex, opencode, Antigravity, Cursor, …) can
generate dia-native decks and operate everything above — see
[integrations/](integrations/README.md): a Claude Code plugin
(`/plugin marketplace add pedapudi/diastil`) and `dia agents-md` for
every AGENTS.md-reading tool.

## Invariants

1. **The editor is complete without a model.** Text, diagrams, slide
   operations — all inference-free. Inference converts foreign decks and
   assists; it never gates.
2. **The saved deck is plain HTML.** Self-contained, presents itself
   when opened, agent-editable with a text editor. No proprietary format.
3. **Conversion is verified, not trusted.** Ingest proves fidelity with
   a per-slide visual diff against the original, and falls back to
   preserving regions verbatim rather than silently mangling them.
4. **Zero runtime dependencies in the document path.** The editor bundle
   and the embedded deck runtime import nothing. Inference lives in a
   separate local service (`dia serve`, ADK-based) that the editor talks
   to — optional, and never a dependency of the deck itself.
