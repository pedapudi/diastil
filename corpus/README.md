# Import regression corpus

The guard on the import-quality ratchet. Real decks go in, their pipeline
output is captured as a fixture, and `src/ingest/corpus.test.ts` asserts
forever after that the stored baselines stay structurally sound: the
assembled deck profile-valid, per-slide confidence floors intact, embedded
reference originals present, islands bounded.

Import quality is existential for diastil — this corpus exists so a
conversion "improvement" that silently regresses a real deck fails CI
instead of shipping.

## Layout

- `decks/` — golden source decks, committed verbatim (e.g. `ambit.html`).
  Prefer real-world decks over synthetic ones; every importer bug so far
  was found on a real deck.
- `fixtures/` — captured pipeline output per deck, committed JSON
  (`<name>.json`, schema = `CorpusFixture` in `src/ingest/corpus.ts`).

## Capturing a fixture

Extraction needs a real browser (computed styles, activated navigation),
so fixtures are captured in the running editor, not in CI:

1. Start the dev server and open `http://localhost:5199/`.
2. In the devtools console:

   ```js
   const html = await (await fetch('/corpus/decks/NAME.html')).text()
   copy(await window.__diaCorpus.capture(html, 'NAME'))
   ```

   (`copy()` puts the fixture JSON on the clipboard; `__diaCorpus` is a
   dev-only hook installed by `src/main.ts`. Decks under `corpus/` are
   served by Vite when placed under `public/corpus/` or via a symlink —
   alternatively paste the deck html inline.)
3. Save the JSON as `corpus/fixtures/NAME.json` and commit it together
   with the deck.

## The ratchet rules

- **Floors only move up.** Re-capture a fixture when conversion genuinely
  improves and commit the diff as the new baseline. A re-capture that
  LOWERS any slide's confidence, adds warnings, or grows islands is a
  regression — it needs a reviewed decision, not a drive-by re-baseline.
- **Profile validity is non-negotiable.** A fixture whose `deckHtml` stops
  validating fails the suite no matter what else improved.
- **Fixtures are evidence, not decoration.** When an import bug is fixed,
  add the deck that exposed it.

## Running the checks

```sh
npx vitest run src/ingest/corpus.test.ts
```

An empty `fixtures/` directory passes with an informative skip — a young
corpus is a valid state, an armed one is better.
