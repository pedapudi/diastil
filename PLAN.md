# diastil — project plan

## 1. What it is

A browser-based WYSIWYG editor for HTML/CSS/JS slide decks. The primary
input is a deck someone else's tool generated — arbitrary HTML, arbitrary
CSS, sometimes JS-built slides and diagrams. diastil converts that into a
normalized dialect it can edit with full direct manipulation, proves the
conversion didn't change how the deck looks, and gives the user a modern
editor: typesetting, photosetting, diagramming, slide management, plus an
inference copilot docked in the right rail.

### Product invariants

1. **Editing never requires inference.** Text edits, diagram edits, slide
   create/move/delete all work with no model configured. Inference has two
   jobs only: converting foreign decks at ingest, and assisted editing on
   request.
2. **The document is a self-contained HTML file** that presents itself when
   opened and stays legible to any agent or text editor. diastil has no
   private format; the dialect *is* HTML.
3. **Ingest is a compile with a proof.** Every converted slide is
   pixel-diffed against the original's rendering. Drift is repaired or the
   region is preserved verbatim as an island. The user gets a fidelity
   report, never a silent maybe.
4. **Zero runtime dependencies.** `package.json` carries devDependencies
   only (vite, typescript). Parsers, scene layer, runtime, inference
   adapters are all first-party. All model I/O is `fetch`.

## 2. The dialect (the IR)

The IR is HTML — but a closed, enumerable profile of it. The live DOM in
the editor is the document; save is serialization. What the profile pins
down:

- **Document frame.** One `<style id="dia-theme">` block of custom
  properties (palette, type scale, spacing, grid) — every rule in the deck
  refers to tokens. One `<script id="dia-runtime">` — the embedded runtime
  (see §5). Slides are `<section class="dia-slide">`, one per slide,
  16:9 by default with explicit aspect declared on the deck.
- **Layout vocabulary.** A small set of containers over CSS grid/flex:
  stack, columns, split, grid-area regions. Enough to express real deck
  layouts; small enough that the editor understands every layout it meets.
- **Text roles.** `dia-title`, `dia-kicker`, `dia-body`, `dia-caption`,
  `dia-footnote`, each bound to a scale step and a face token. Roles are
  what the inspector edits; the cascade stays legible.
- **Media.** Figures carry explicit crop/focal-point as CSS
  (`object-fit`/`object-position` or `--dia-focal-*`), so photosetting is
  attribute editing, and exports never re-encode pixels.
- **Diagrams.** SVG plus semantics — the scene vocabulary (§4).
- **Behavior is data, not code.** Navigation, build steps, reveal
  sequences, hover linkage: declarative `data-dia-*` attributes the
  runtime interprets. No arbitrary author JS in dialect regions.
- **Islands.** The escape hatch for what the dialect can't express: a
  region preserved verbatim (own shadow root or sandboxed iframe, original
  JS intact). Islands render and run; they get coarse editing (move,
  resize, replace, delete) and optional inference-mediated parameter
  editing, and can be lifted into the dialect later per-region.

The profile ships as both documentation and a validation schema
(`profile/`): a deck either validates, or the validator says exactly which
regions are out-of-profile. Round-trip guarantee: serialize(parse(deck))
is byte-stable, attribute order fixed, so agent diffs stay clean.

## 3. Ingest — wide-variety HTML → dialect

This is the hardest engineering in the project and it is staged, not
monolithic. The pipeline:

```
original.html
  │  1. execute      sandboxed iframe, JS runs to settled state
  ▼
rendered DOM + computed styles + per-slide screenshots   (ground truth)
  │  2. deterministic pass      no model
  ▼
slides, tokens, type scale, palette, grid, region taxonomy
  │  3. translation pass        model, per slide, schema-constrained
  ▼
candidate dialect deck
  │  4. fidelity loop           render → screenshot → pixel-diff → repair
  ▼
verified deck + per-slide fidelity report (+ islands where conversion lost)
```

**Step 1 — execute, don't parse.** Agent decks routinely build content at
runtime (reveal.js-style frameworks, d3 diagrams, mermaid render passes,
hand-rolled navigation). The rendered, settled DOM is what the deck
*looks like*, so it is the input to conversion. Settling: wait for load +
fonts + rAF-quiet + a mutation-observer quiet window, with a timeout and
a "still animating" classification for regions that never settle (those
become islands). Each slide state is captured — including build steps if
navigation exposes them.

**Step 2 — deterministic extraction.** Everything that needs no judgment:

- *Slide boundaries*: structural repetition (sibling sections, uniform
  aspect containers, framework markers — reveal, impress, remark, Marp,
  bespoke `class="slide"` variants), scroll/step navigation detection.
- *Tokens*: existing custom properties harvested; hardcoded values
  clustered — font sizes → a scale, colors → a palette, spacing → a grid.
- *Region taxonomy*: for each subtree, classify — static text / static
  image / SVG / JS-rendered-static (canvas or SVG that stopped mutating) /
  live-interactive / framework chrome (navigation UI to strip, since the
  dialect runtime replaces it).

**Step 3 — translation.** Per slide, the model receives the rendered DOM
outline, computed-style summary, and the extracted tokens; it emits the
slide in the dialect: roles assigned, layout mapped to profile containers,
styles rebound to tokens. Output is schema-constrained (the profile is a
grammar) and validated before it touches the deck. Diagrams get their own
lifting pass (§4). Content text is copied verbatim by the pipeline, not
regenerated by the model — the model outputs structure referencing content
slots, which the pipeline fills from the source DOM. A mislabel can
misplace a paragraph; it cannot rewrite one.

**Step 4 — fidelity loop.** The candidate slide renders headless beside
the original screenshot; pixel-diff (with anti-aliasing tolerance and
font-fallback awareness) scores it. Over threshold → the model gets the
diff image + both renderings and proposes a repair, up to N rounds.
Non-convergent regions are islanded — the *original* subtree (with its
styles, pre-execution source where static, post-execution where not) is
preserved verbatim inside the dialect deck. The report ships with the
deck: per slide, a fidelity score and what was islanded and why.

**Input taxonomy and expected outcomes** (what "wide variety" means):

| input class | strategy | expected result |
| --- | --- | --- |
| semantic HTML + plain CSS (typical agent output) | direct translation | full dialect, near-1.0 fidelity |
| framework decks (reveal/remark/Marp/impress) | per-framework slide extraction; strip chrome; keep content | full dialect; framework nav replaced by dia runtime |
| utility-class styling (Tailwind CDN) | computed-style capture → re-expressed as token-bound rules | full dialect; class soup dissolved into tokens |
| JS-built static content (d3 charts, mermaid) | execute, capture output, lift SVG | dialect scene diagrams (§4) |
| genuinely interactive JS (sims, live data) | island | preserved verbatim, coarse + parameter editing |
| canvas-rendered content | island (raster snapshot offered as fallback figure) | island or static figure, user's choice |
| absolute-positioned "PDF-like" output | translate positions to grid where regular; else keep absolute (in-dialect but low-structure) | editable, flagged low-structure |
| pathological (framesets, quirks-mode, MB-scale inline data) | detect early, degrade honestly | partial ingest with an explicit report |

The per-framework extractors are small, deterministic, and the highest
ingest ROI — agent tools converge on a handful of deck shapes. They're a
plugin surface (`ingest/extractors/`) so new shapes are cheap to add.

## 4. The scene layer — diagrams

Diagramming is a headline capability, not a shape palette bolted on. The
scene vocabulary is SVG plus semantics in attributes:

- **Nodes** — `data-dia-node="id"`; geometry as attributes; shape from a
  library (rect, rounded, pill, ellipse, diamond, cylinder, custom path)
  with text content laid out *inside* the shape (wrapped, padded,
  vertically centered — text-in-shape is table stakes and SVG gives it to
  us for free via foreignObject or measured tspans; we measure).
- **Edges** — `data-dia-edge="a->b"` with anchor sides (auto or pinned),
  routing style (straight, orthogonal, curved), arrowheads, labels bound
  to the edge midpoint. **The runtime computes paths**: move a node and
  its edges reroute. This single behavior is what separates a diagram
  editor from a shape editor, and it is the scene layer's reason to exist.
- **Groups & constraints** — alignment/distribution as editable
  relationships; containers (a lane, a boundary box) that nodes belong to.
- **Behaviors** — declarative: `data-dia-step` build sequences,
  `data-dia-highlight` hover-linkage groups, pan/zoom flags for dense
  diagrams in present mode.

Editor affordances (the "top-notch" bar — measured against tldraw/Figma,
not against PowerPoint): drag with live edge rerouting; snapping to node
edges/centers and to a canvas grid; smart guides (equal spacing, aligned
centers); connector handles on hover with anchor re-pointing; box-select,
group/ungroup, align/distribute toolbar; double-click text-in-shape
editing; keyboard nudge with modifiers; z-order; marquee-zoom. All pure
DOM/SVG mutation through the op log — no inference in the loop.

Ingested diagrams arrive three ways:

1. **Static SVG** → lift: recover node/edge/label semantics (inference,
   validated by the fidelity loop — lifted diagram must render where the
   pixels were).
2. **JS-generated SVG** → execute, capture, lift; the generator source is
   read to translate interactivity (a mouseover handler → a highlight
   group; a click sequence → build steps).
3. **Opaque interactive programs** → island, with inference-discovered
   parameter panels (the config literal in the island's JS surfaces as
   editable properties; edits patch the literal only).

Lifting is aggressive by default for diagrams (worth inference spend),
and every lift is verified or discarded — a diagram that won't lift
faithfully stays an island the user can lift manually later.

## 5. The runtime

A single first-party script (~10–20 KB, versioned) embedded in every
saved deck:

- present mode: keyboard/touch navigation, build steps, highlight
  linkage, hash-addressable slides, speaker-notes window;
- scene support: edge routing (also used live by the editor), behavior
  interpretation;
- editor mode flag: navigation inert, steps expanded, ids exposed.

The runtime never phones home, has no options soup, and its versioning is
part of the dialect version (a deck states `data-dia-version`; the editor
migrates old decks forward explicitly).

## 6. The editor

- **Document = live DOM** in the canvas iframe. Typed ops — `SetText`,
  `SetToken`, `SetProp`, `Insert/Move/Delete`, `MoveNode`, `RetargetEdge`,
  `SetFocalPoint`, … — compile to DOM mutations; the op log is undo/redo;
  serialization is pretty-printed, attribute-order-stable.
- **Write-target discipline** for style edits: token if bound → class rule
  if solely owned → element rule → inline as last resort; the inspector
  *shows* the target before the edit lands and a modifier forces
  "just this one."
- **Typesetting**: role-based controls bound to scale steps; real optical
  controls (tracking, leading, measure, hanging punctuation, optical
  margin alignment where the platform allows); token edits preview
  deck-wide live.
- **Photosetting**: place, crop, focal point, object-fit, filters as
  tokens; images stored adjacent or data-URI per user choice.
- **Slides**: filmstrip/light-table, create from layout templates,
  duplicate, reorder, section grouping.
- **Copilot** (right rail, per the zicato `.dn-bld-chat` idiom):
  selection-aware context; responds with ops rendered as a live preview
  diff, accept/reject; accepted ops join the same undo history. Chat is
  session state, never document state.

## 7. Inference layer

One interface: `infer(request, schema) → validated JSON`, plus a
streaming variant for chat. Thin first-party adapters behind it:

- **openai-compatible** (covers OpenAI, OpenRouter, Together, Groq, vLLM,
  LM Studio, Ollama, …);
- **messages-style** APIs;
- **generic HTTP** template adapter (user-supplied request/response
  mapping) for anything else.

Config = base URL + model id + key + headers, stored locally. Structured
output uses the endpoint's schema mode when present, else
prompt-and-parse with one repair retry. Ingest results cache by content
hash. No agent framework and no provider SDK: call shapes here are
single-shot schema-constrained translations inside *deterministic*
first-party loops (the fidelity loop owns control flow, not the model),
so a framework would add a server, dependencies, and abstractions without
removing any code. Revisit only if the copilot grows genuine multi-step
tool use, and even then tool-call support lands in the adapters, not as a
framework import.

## 8. UI

The UI follows the zicato design language (docs/design/DESIGN-LANGUAGE.md
in the zicato repo): the token role contract (paper/panel/ink/rule/
good/bad/accent), monospace-forward voice, one-accent discipline, Tufte
line-art, hairline rules, hovercards for detail, digest-gated rendering,
reduced-motion respect. diastil takes its own brand accent and wordmark
(TBD) but speaks the same language. Panels are neutral `--rule` bordered;
accent is spent on signal only.

Four candidate designs are in `design/studies/` for review before any
editor code is written: **01-bench** (classic three-pane),
**02-console** (dense observatory, structure tree + ops log),
**03-stage** (canvas-first minimal chrome, contextual toolbars),
**04-lichttisch** (continuous light-table scroll). The chosen direction —
possibly a hybrid — gets locked in `design/DECISION.md` before M2.

## 9. Milestones

- **M0 — design lock.** UI study reviewed; dialect profile v0 written as
  schema + docs; scene vocabulary v0; this plan revised.
- **M1 — document core.** Parser/serializer with byte-stable round-trip;
  op log + undo; profile validator. (No UI yet; golden-file tests.)
- **M2 — editor shell.** Canvas iframe, selection, filmstrip, inspector
  on the chosen design; text editing + slide ops end-to-end on
  dialect-native decks. *The editor is usable for born-dia decks here.*
- **M3 — scene layer.** Diagram model, edge routing, full direct
  manipulation, behaviors in the runtime. *The headline demo.*
- **M4 — ingest v1.** Execute + deterministic pass + translation +
  fidelity loop for the top input classes (semantic HTML, reveal/Marp,
  static SVG diagrams); islands; fidelity report UI.
- **M5 — copilot + inference config.** Adapters, endpoint settings, chat
  rail emitting op-diffs; diagram lifting for JS-generated SVG.
- **M6 — CLI host.** `dia <deck.html>` opens the editor on a local file,
  watches, writes back; `dia present`, `dia validate`, `dia ingest`
  headless.

Each milestone lands with tests (golden round-trips, op-log property
tests, fidelity-loop fixtures from real agent decks — a corpus we start
collecting now).

## 10. Risks, named

- **Ingest breadth is unbounded.** Mitigation: the taxonomy + extractor
  plugin surface + honest islanding; the corpus drives priorities; we
  never promise universal conversion, we promise verified conversion or
  verbatim preservation.
- **Edge routing quality.** Orthogonal routing with obstacle avoidance is
  genuinely hard; v1 ships straight/curved + simple orthogonal, obstacle
  avoidance later. The attribute format is routing-algorithm-neutral.
- **Fidelity loop cost/latency.** Per-slide caching, batch calls,
  screenshot diffing tuned to bail early on clean slides; conservative
  mode for weird layout (island early rather than burn rounds).
- **contenteditable.** Scoped: text editing happens *within* a role
  element (plain text + inline marks only), never across structure —
  structure edits are ops. This dodges most of contenteditable's swamp.
- **Serializer stability vs. hand edits.** Decks edited outside diastil
  re-enter through the parser; the validator classifies damage; islands
  catch what no longer fits the profile.
