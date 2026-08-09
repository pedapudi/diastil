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
from the local editor origins: the dev server (`localhost:5199`) and its
own origin (the CLI mounts the built editor at `/editor`, which is
same-origin and needs no entry). Override the list with
`[service] allow_origins = [...]` in `config.toml`.

The standalone `file://` `diastil.html` reads and writes through the
browser's file picker, not the daemon, so its `null` origin is **not** in
the default allowlist (issue #25): `null` is also the opaque origin any
site mints with `<iframe sandbox>`, and allowing it lets a drive-by page
you visit spend your model tokens via `/skills/*`. To let a `file://`
page reach the model skills anyway, add `"null"` to `allow_origins`
yourself, knowing any site can then reach them too. The `/file` and
`/project/file` disk bridges refuse `null` regardless of that list — they
are CLI-only, and the CLI serves the editor same-origin. All local
endpoints that act (disk bridges, `/skills/*`, `/mcp`) also require a
loopback `Host`, so a name that resolves to `127.0.0.1` cannot reach them
by DNS rebinding.

## The `dia` CLI

The package also installs `dia`, the front door for local files:

```sh
dia deck.html            # open the editor on the file; ⌘S writes back;
                         # external edits reload when the editor is clean
dia ingest foreign.html  # open the editor straight into import review
dia present deck.html    # open a saved deck in the browser (it presents itself)
dia validate deck.html…  # profile-validate saved decks; exit 1 on errors
dia compile paper.tex    # LaTeX → PDF with a real engine; exit 1 on errors
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
- `POST /compile` → `{jobId}`; then `GET /compile/{id}/events` (SSE:
  `phase` / `log` / `done`), `GET /compile/{id}/pdf`,
  `GET /compile/{id}/synctex` → `{pages, lines: [{line, page, x, y, w}],
  xSemantics, ySemantics}`, `DELETE /compile/{id}` to cancel.
- `GET /compile/{id}/pages` → `{available, tool, count, pages: [{n, wPt,
  hPt}], ySemantics}` and `GET /compile/{id}/page/{n}.png?dpi=130` → that
  page rasterized by poppler, for previewing a compiled figure inline.
- `POST /tex/install` → SSE progress for the managed tectonic download;
  `POST /tex/refresh` → re-probe the engine ladder.

## LaTeX documents

`GET /health` carries a `tex` block describing what the daemon can compile
with: `{engine, path, version, synctex, downloadable, managed, pageRender}`.
`pageRender` is a separate axis from the rest — it says poppler's `pdftoppm`
is on `PATH`, so a compiled page can be shown as an image — and a machine
can perfectly well have one without the other. Engines
are found in this order — a tectonic the daemon installed itself, tectonic
on `PATH`, `latexmk`, `xelatex`, `pdflatex` — and `[tex] engine` in
`config.toml` pins one. **A pinned engine that is not installed is reported
as missing rather than quietly replaced.**

Nothing installed is a supported state: `engine` is `null`, `downloadable`
says whether we have a pinned tectonic build for this platform, and the
editor offers a one-click install. That download is ~14MB into
`~/.cache/diastil` (`XDG_CACHE_HOME` honored), needs no root, changes no
`PATH`, and is verified against a sha256 compiled into `texdl.py`. There is
deliberately no way to install from a URL of your choosing.

Compiles run in a temp directory — your own directory is never written to.
When the file was opened through the CLI, `TEXINPUTS` is pointed at its
folder so relative `\includegraphics` resolves read-only. Tectonic's first
compile downloads the packages the document asks for, which is why the
default `[tex] timeout_s` is 180.

```sh
dia compile paper.tex                  # → paper.pdf, errors as file:line
dia compile paper.tex --engine xelatex --pdf /tmp/out.pdf
dia export paper.html --pdf out.pdf    # the LaTeX inside a dialect document
```

`GET /compile/{id}/synctex` maps source lines to positions:
`{pages, lines: [{line, page, x, y, w?}], xSemantics, ySemantics}`.

Both axes are **points from the top-left of the paper**, `y` growing
downward and `x` rightward — verified against real compiles rather than
assumed, and reported on the wire as `ySemantics: "topDownPt"` and
`xSemantics: "leftPt"` so no client has to guess an origin. In particular
`x` is measured from the paper's edge, not from TeX's 1in reference point.

`x` is what makes a two-column paper croppable: on a 500pt page with 25pt
margins the left column's records report `x: 25` and the right column's
`x: 255`, so **clustering a block's records on `x` identifies its column**.
`w` is the width of the box the line typeset — the column width for body
text. Treat `w` as a hint and `x` as the signal: a line whose innermost box
is an inline formula or an `\item` label reports that box, so `w` may be a
few points, while `x` is always inside the line's own column.

One record is kept per (line, page): the first box the line opened that
opened no box of its own. A source line owns every box that was still open
when it was current, so the line a page break falls on also owns the page
box (at `x: 72.27`) and the full-width text block (at `x: 25`) — reporting
either would put that line in the wrong column. A line that typeset nothing
on a page keeps its first record and has no `w`.

## Tests

```sh
.venv/bin/pip install -e '.[dev]'
.venv/bin/python -m pytest
```

The compile suite drives a fake engine, so it needs no TeX installation
and no model — it gives the same answer on a bare machine as on a full
TeX Live one.

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
