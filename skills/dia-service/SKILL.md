---
name: dia-service
description: Configure and operate the dia inference service — model endpoints (Ollama, vLLM, OpenRouter, any OpenAI-compatible URL), per-skill routing, the copilot, managed skill prompts, HTTP API, and evals. Use when setting up inference, switching models, editing skill prompts, or debugging why the copilot/import-repair is offline.
---

# The dia service (inference sidecar)

**The editor never needs it.** Every editing feature is plain browser
code; the service adds model-assisted ingest (translate/repair/lift) and
the copilot rail. When it's down, the rail shows a quiet offline line and
nothing else changes.

## Run

```sh
cd service && .venv/bin/dia-serve        # or: dia serve
# binds 127.0.0.1:8317; accepts the editor origins only; no telemetry
```

`GET /health` → `{ok, model}`. `ok:false` with "adk not installed" means
the venv install is missing or broken.

## Endpoint configuration (`service/config.toml`)

Any OpenAI-compatible URL works. The API key is named by env var, never
stored in config:

```toml
[endpoint]                              # default for every skill
base_url = "http://localhost:11434/v1"  # ollama
model = "openai/qwen2.5-coder:14b"
api_key_env = "DIA_API_KEY"

[skills.translate-slide]                # per-skill override — heavyweight
model = "openai/deepseek/deepseek-chat" #   model for translation, fast
base_url = "https://openrouter.ai/api/v1"  # local one for repair, etc.
api_key_env = "OPENROUTER_API_KEY"
```

Copy `config.example.toml` → `config.toml`; the service reads it from the
working directory first, then the service directory.

## Skills (managed prompts)

One versioned instruction file per skill in `dia_service/skills/*.md` —
edit these like code, never inline prompts:

| skill | job | endpoint |
| --- | --- | --- |
| `translate-slide` | source slide → dialect slide (structure only; the pipeline re-checks text) | `POST /skills/translate-slide` |
| `repair-fidelity` | one fidelity-loop round: mismatch description → corrected slide | `POST /skills/repair-fidelity` |
| `lift-diagram` | raw SVG → scene vocabulary, positions exact | `POST /skills/lift-diagram` |
| `discover-island-params` | surface an island's config literal as editable properties | (not yet wired) |
| `copilot` | the agentic chat skill; proposes ops via a tool, never edits directly | `POST /chat` (SSE) |

Model output is never trusted: translations/repairs/lifts are
profile-validated and text-checked by deterministic pipeline code before
they touch a deck, and fenced output is unfenced server-side.

## Copilot

Right-rail chat, one ADK session per deck (turn 30 remembers turn 3).
It receives editor context (altitude, slide, selection HTML, tokens) and
responds with text and/or **proposed ops** rendered as accept/reject
cards; accepted ops join the same undo history as manual edits.

## Evals

`dia eval` runs the golden cases in `service/evals/<skill>/<case>/`
against the configured endpoint and scores deterministically (profile
validation, text-sacred coverage ≥0.98, scene node/edge minimums).
Results land in `service/evals/results.json` — diff it across prompt or
model changes. See `dia-extend` for adding cases.
