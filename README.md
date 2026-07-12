# diastil

A browser-based WYSIWYG editor for HTML/CSS/JS slide decks.

*Dia* (the projection slide) + *Stil* (style). The CLI clips to `dia`.

Agent-generated decks arrive as arbitrary HTML. diastil ingests them,
converts them into a normalized, enumerable HTML dialect — the deck
remains a self-contained HTML file any tool can keep editing — and puts
a direct-manipulation editor on top: typesetting, photosetting, and
first-class diagramming, with an inference copilot that emits the same
typed edit operations a human does.

**Status: implemented through M6** — document core, editor (table/stage
+ minimap per [design/DECISION.md](design/DECISION.md)), scene layer
with obstacle-avoiding edge routing, verified ingest with a
pixel-fidelity loop, copilot + inference service, and the `dia` CLI.
Architecture: [PLAN.md](PLAN.md). Dialect contract:
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
presents itself when opened.

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
dia deck.html            # edit a local file, ⌘S writes back
dia ingest foreign.html  # convert a foreign deck
dia validate deck.html   # profile-check (stdlib-only, no venv needed)
dia serve                # inference sidecar — see service/README.md
```

Tests: `npm test`. Agent operating manuals: [skills/](skills/README.md).

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
