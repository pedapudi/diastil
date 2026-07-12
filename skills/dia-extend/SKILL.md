---
name: dia-extend
description: Extend diastil — add a slide-detection extractor for a new deck shape, add corpus fixtures, add skill eval cases, run and write tests, verify changes end-to-end in the browser. Use when a deck imports badly, when adding support for a new framework, or when changing prompts/models and needing measurement.
---

# Extending diastil

## Add an extractor (new deck shape)

Highest-ROI ingest work: one deterministic module per deck shape in
`src/ingest/extractors/`, tried in registry order (framework markers
first, generic layout heuristic last, whole-body fallback).

```ts
// src/ingest/extractors/myframework.ts
import type { SlideExtractor } from './index'
export const myframework: SlideExtractor = {
  name: 'myframework',
  detect(doc) {
    const roots = [...doc.querySelectorAll<HTMLElement>('.myfw-slide')]
    return roots.length > 0 ? roots : null
  },
}
```

Register it in `extractors/index.ts` (`EXTRACTORS` array — order matters).
Rules of the surface: detection runs on the EXECUTED document (layout and
computed styles available; elements are in the iframe's realm, so use
tagName checks, never `instanceof`); return roots in presentation order;
strip framework chrome by extending `CHROME_SEL` in `src/ingest/convert.ts`.

The generic `siblings` extractor already handles: repeated same-tag+class
viewport-scale siblings, state-class variants (`slide on` folds into
`slide`), one-visible-at-a-time decks (hidden majority accepted; hidden
slides are force-revealed during sampling), two-page stacked decks, and
prefers the largest qualifying group over shallow wrappers.

## Add corpus fixtures

`examples/fixtures/foreign-*.html` — one self-contained file per input
class (no CDN loads, everything inline). Pin the fixture with a detection
test in `src/ingest/extractors/extractors.test.ts` (DOMParser-based when
detection is structural; simulated `getBoundingClientRect` when it needs
layout), and verify through the real pipeline in a browser:

```js
const { runPipeline } = await import('/src/ingest/pipeline.ts')
const html = await fetch('/examples/fixtures/foreign-x.html').then(r => r.text())
const res = await runPipeline(html, 'foreign-x.html'); res.cleanup()
// inspect res.report: slideCount, confidence, regions, warnings
```

## Add eval cases

`service/evals/<skill>/<case-name>/`:

- `translate-slide/<name>/input.html` (+ optional `tokens.css`)
- `repair-fidelity/<name>/source.html` + `candidate.html` + `mismatch.txt`
- `lift-diagram/<name>/input.svg` (+ `meta.toml`: `min_nodes`, `min_edges`)

Expectations are derived, not hand-written: text coverage comes from the
input's own visible texts, structure checks from the profile validator.
Run `dia eval --skill translate-slide`; diff `service/evals/results.json`.

## Tests & verification

```sh
npm test          # vitest + happy-dom (~55 tests)
npx tsc --noEmit  # types
npm run build     # tsc + vite build → dist/ (the CLI serves this)
python3 -m py_compile service/dia_service/*.py
```

Test suites and what they hold: `roundtrip` (byte-stable serialization —
the invariant the CLI's disk-watch relies on), `validate` (every profile
rule fires), `ops` (seeded random op sequences undo/redo exactly),
`route` (ortho routing avoids obstacles, stays orthogonal), `extractors`,
`convert` (islands verbatim + confidence math), `fidelity` (diff math).

Keep the TS and Python validators in lockstep — same rule ids, same
levels — whenever either changes (`src/model/validate.ts` ↔
`service/dia_service/validate.py`, contract in `profile/PROFILE.md`).

End-to-end: `npm run dev`, drive imports with `window.__diaImport` (DEV
hook), and check the review strip/notes rather than screenshots while the
review overlay is open (capture can stall until it closes).
