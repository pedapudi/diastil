# dia service

Local inference sidecar for the diastil editor. It hosts the ingest
skills (`translate-slide`, `repair-fidelity`, `lift-diagram`,
`discover-island-params`) and the `copilot` agent behind a small HTTP/SSE
API on `127.0.0.1:8317`.

**The editor works fully without this service.** Every editing feature —
selection, ops, undo, scenes, serialization — is plain browser code with
zero dependencies. Install the service only if you want inference:
model-assisted ingest and the copilot rail. When it is not running, the
rail shows a quiet offline line and everything else is unaffected.

## Setup

Python 3.11+. Always use a venv — never install into the system Python:

```sh
cd service
python3 -m venv .venv
.venv/bin/pip install -e .
```

Copy the example config and point it at your endpoint:

```sh
cp config.example.toml config.toml
$EDITOR config.toml
```

## Run

```sh
.venv/bin/dia-serve
# or, equivalently:
.venv/bin/uvicorn dia_service.main:app --port 8317
```

The service binds to `127.0.0.1:8317` and accepts browser requests only
from the local editor origins: the dev server (`localhost:5199`), its own
origin (the CLI mounts the built editor at `/editor`), and `null` — a
`file://` page, i.e. the standalone `diastil.html`. Override the list
with `[service] allow_origins = [...]` in `config.toml`.

## The `dia` CLI

The package also installs `dia`, the front door for local files:

```sh
dia deck.html            # open the editor on the file; ⌘S writes back;
                         # external edits reload when the editor is clean
dia ingest foreign.html  # open the editor straight into import review
dia present deck.html    # open a saved deck in the browser (it presents itself)
dia validate deck.html…  # profile-validate saved decks; exit 1 on errors
dia serve                # the inference service alone
dia eval [--skill s]     # run skill evals; scores → evals/results.json
```

`dia validate` and `dia present` run on the standard library alone — no
venv needed. `dia <file>` / `dia ingest` / `dia serve` need the installed
service; editing also needs the built editor bundle (`npm run build` in
the repo, or `DIA_EDITOR_DIST=/path/to/dist`).

Commands that open a browser take `--no-open`, and skip the browser
automatically when there is no display (no `DISPLAY`/`WAYLAND_DISPLAY`,
e.g. an ssh session) — the printed URL is the one to port-forward:
`ssh -L 8317:127.0.0.1:8317 host`, then open it locally.

## Endpoints (the model kind)

Any OpenAI-compatible URL works — hosted APIs, OpenRouter, or fully
local servers. `[endpoint]` in `config.toml` sets the default;
`[skills.<name>]` tables override per skill (heavyweight model for
translation, a fast local one for repair iterations, whatever you like).

```toml
# local ollama
[endpoint]
base_url = "http://localhost:11434/v1"
model = "openai/qwen2.5-coder:14b"
api_key_env = "DIA_API_KEY"        # local servers accept any value

# local vllm
[endpoint]
base_url = "http://localhost:8000/v1"
model = "openai/your-served-model"
api_key_env = "DIA_API_KEY"

# hosted via openrouter
[endpoint]
base_url = "https://openrouter.ai/api/v1"
model = "openai/deepseek/deepseek-chat"
api_key_env = "OPENROUTER_API_KEY"
```

`api_key_env` names the environment variable that holds the key; the key
itself never lives in config.

## API surface

- `GET /health` → `{ok, model}` (`ok:false` with a detail when
  `google-adk` is not installed — the service still starts and answers).
- `POST /chat` → SSE stream of ChatEvent frames for the copilot rail.
- `POST /skills/translate-slide` → `{slideHtml}` single-shot translation.
- `POST /skills/repair-fidelity` → `{slideHtml}` one fidelity-loop round.
- `POST /skills/lift-diagram` → `{sceneHtml}` raw SVG → scene vocabulary.
- `GET/PUT /file` → read/write local files, allowlisted to paths the CLI
  opened — the editor's save-back channel for `dia <deck.html>`.
- `POST /export/pptx` → the deck rendered to a native `.pptx` download
  (text boxes, shapes + connectors, vector charts and tables — stays
  editable in PowerPoint / Keynote / Google Slides).

## Privacy

No telemetry. The only outbound traffic is to the endpoint you configured.

## Skills

Prompts are managed artifacts in `dia_service/skills/*.md` — versioned,
reviewed, and diffed like code, never inlined at call sites.

## Evals

`evals/<skill>/<case>/` holds golden cases; `dia eval` runs each against
the configured endpoint and scores the output with the same deterministic
gates the pipeline enforces (profile validation, text-sacred coverage,
scene semantics). Scores land in `evals/results.json`, so a prompt or
model change is a measurable diff, not a vibe. `--strict` exits non-zero
on any failure; `--skill <name>` filters.
