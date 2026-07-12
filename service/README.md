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
from the local editor dev origin (`localhost:5199`).

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

## Privacy

No telemetry. The only outbound traffic is to the endpoint you configured.

## Skills

Prompts are managed artifacts in `dia_service/skills/*.md` — versioned,
reviewed, and diffed like code, never inlined at call sites.
