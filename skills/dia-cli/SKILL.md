---
name: dia-cli
description: Use the dia command-line tool — edit a deck with save-back, ingest a foreign file, present, validate, run the inference service, run skill evals. Includes setup (venv install, editor bundle discovery) and which commands work without any dependencies. Use when operating diastil from a terminal or scripting it.
---

# The `dia` CLI

## Setup

```sh
cd service
python3 -m venv .venv
.venv/bin/pip install -e .          # installs `dia` and `dia-serve`
```

Two commands need **nothing installed** beyond Python 3.11 stdlib and can
run without the venv: `dia validate` and `dia present`. The rest need the
installed service; `edit`/`ingest` also need the built editor bundle —
`npm run build` in the repo (produces `dist/`), or point
`DIA_EDITOR_DIST` at a dist directory.

## Commands

```sh
dia deck.html            # edit (sugar for `dia edit deck.html`)
dia edit deck.html       # host service + editor at 127.0.0.1:8317/editor,
                         #   open the browser on the file; ⌘S writes back;
                         #   external file changes reload when the editor is clean
dia ingest foreign.html  # same, but opens straight into import review
dia present deck.html    # open the saved deck in the browser — it presents
                         #   itself (runtime embedded), works off file://
dia validate a.html b…   # profile-validate; prints rule-id findings;
                         #   exit 1 on any error-level finding (stdlib-only)
dia serve                # inference service alone on 127.0.0.1:8317
dia eval [--skill NAME] [--strict]
                         # run golden skill evals against the configured
                         #   endpoint; scores → service/evals/results.json;
                         #   --strict exits 1 on any failing case
```

## How edit-mode file access works

The service only reads/writes files the CLI explicitly opened (an
allowlist behind `GET/PUT /file`), binds to 127.0.0.1 only, and sends no
telemetry — the only outbound traffic is to the model endpoint you
configured. Save-back relies on byte-stable serialization: "editor is
clean" is checked exactly, so disk-watch reloads never clobber unsaved
work (unsaved edits win until you save).

## Typical flows

- Try the editor with zero setup: `npm run dev` → http://localhost:5199
  (demo deck loads; no venv, no service — copilot shows offline).
- Convert a deck someone sent you: `dia ingest their-deck.html`, review,
  accept, `⌘S` — the converted `.dia.html` is yours.
- CI check on generated decks: `dia validate out/*.html`.
- Measure a prompt/model change: edit `service/config.toml` or a skill
  prompt, `dia eval`, diff `service/evals/results.json`.
