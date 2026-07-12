---
name: dia-import
description: Convert foreign HTML decks (reveal.js, Marp, remark, impress, Tailwind-styled, bespoke JS decks, PDF-like exports) into the diastil dialect — run the import pipeline, read the review UI, interpret confidence/fidelity scores, decide accept vs island vs repair. Use when importing any non-dialect presentation or diagnosing a poor conversion.
---

# Importing foreign decks

Ingest is a compile with a proof: execute → extract → convert → verify.
The original runs in a sandboxed iframe to its settled state (JS-built
content included), slides and tokens are extracted deterministically,
conversion is structural with **text copied verbatim — never regenerated**,
and every slide is pixel-diffed against the original's rendering.

## Running an import

- Editor: `open` and pick the file — foreign HTML is detected automatically
  and routed through conversion (dialect files just load).
- CLI: `dia ingest foreign.html` opens the editor straight into review.
- Programmatic (dev): `window.__diaImport(html, name)`.
- Headless (no UI): `runPipeline(html, name)` in `src/ingest/pipeline.ts`.

## What to expect per input class

| input | expected result |
| --- | --- |
| semantic HTML + plain CSS | full dialect, confidence ≈ 1.0 |
| reveal / Marp / remark / impress | full dialect; framework chrome stripped, nav replaced by the dia runtime; reveal vertical stacks flatten |
| one-visible-at-a-time bespoke decks (runtime hides non-current slides, state class like `slide on`) | detected and converted; hidden slides are force-revealed for sampling and fidelity |
| utility-class styling (Tailwind-shaped) | class soup dissolved into token-bound roles |
| JS-built static content (d3, mermaid output) | executed, captured; SVGs kept as figures, liftable to scenes |
| genuinely interactive JS (canvas animations, sims) | **island** — preserved verbatim, still runs |
| absolute-positioned "PDF-like" pages | converted, flagged low-structure |

## The review UI

Full-screen compare after every import — original (live, JS running)
beside converted, per slide. `←`/`→` move between slides, `Esc` cancels.

- **side-by-side / overlay** toggle — overlay is a blend-difference:
  matched regions read dark, mismatches glow.
- **strip** (left): per slide — structural confidence, pixel fidelity,
  island pill, ✓ when accepted.
- **fidelity** = 1 − differing-pixel fraction at 384×216 (`·—` means the
  slide would not rasterize — verify by eye). Structural **confidence** =
  mapped text chars / total, ×0.9 where islands remain.
- Per-slide verdict row: **accept slide** · **island entire slide**
  (keep the original subtree verbatim) · **retry with service** (fresh
  model translation) · **repair with service** (one fidelity-loop round) ·
  **lift diagrams** (static SVGs → scenes, verified or discarded).
- With the service online, slides under fidelity 0.85 get up to 3
  automatic repair rounds; a repair is kept only when it re-measures
  higher (keep-best).
- **accept import** loads the deck into the editor; the report (scores,
  region notes, profile findings) rides in the table gutter.

## Judgment guide

- Low fidelity + low confidence → island the slide; islands are honest.
- Low fidelity + confidence 1.0 → usually layout, not content: try
  repair (needs service), or accept and fix in the editor.
- Text-missing warnings are the serious ones — conversion never drops
  text silently, so a warning means the source hid it from extraction.
- Every import report also carries profile-validator findings; `profile
  error` lines mean the converted output itself is out of contract
  (should not happen — report as a bug).
