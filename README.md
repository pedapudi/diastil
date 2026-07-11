# diastil

A browser-based WYSIWYG editor for HTML/CSS/JS slide decks.

*Dia* (the projection slide) + *Stil* (style). The CLI clips to `dia`.

Agent-generated decks arrive as arbitrary HTML. diastil ingests them,
converts them into a normalized, enumerable HTML dialect — the deck
remains a self-contained HTML file any tool can keep editing — and puts
a direct-manipulation editor on top: typesetting, photosetting, and
first-class diagramming, with an inference copilot that emits the same
typed edit operations a human does.

**Status: design phase.** The architecture is in [PLAN.md](PLAN.md);
four candidate editor designs are in
[design/studies/](design/studies/README.md).

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
