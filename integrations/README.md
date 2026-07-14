# Integrations — dia for coding agents

diastil is agent-operable by design: decks are plain HTML files, the
grammar is enforced by a stdlib-only validator, and every operation is a
CLI command. Any tool that can write files and run commands can generate
dia-native presentations. What follows is the packaging per tool family —
the *content* is identical everywhere, because the interface is the same.

## The universal loop (every tool)

```sh
pip install -e service/          # once — installs the `dia` CLI
dia new talk.html --title "My talk"   # profile-valid starting deck
$EDITOR talk.html                # the agent edits the html directly
dia validate talk.html           # the contract gate — exit 1 on errors
dia present talk.html            # it presents itself in a browser
```

Deep reference lives in [`skills/`](../skills/) — one agent-agnostic file
each for authoring, scenes/diagrams, validation rules, the CLI, the
import pipeline, the editor UI, and extending diastil.

## Claude Code

Install the skills as a plugin:

```
/plugin marketplace add pedapudi/diastil
/plugin install dia@diastil
```

The plugin ships the `skills/` library (`dia-authoring`, `dia-scenes`,
`dia-validate`, `dia-cli`, `dia-import`, `dia-editor`, `dia-service`,
`dia-extend`); Claude Code loads whichever is relevant to the task.

## Codex · opencode · Antigravity · Cursor · Gemini CLI · anything AGENTS.md

These tools read a project (or global) instructions file — `AGENTS.md`
for most, `GEMINI.md` for Gemini CLI. Emit the dia section into it:

```sh
dia agents-md >> AGENTS.md       # project-level
dia agents-md >> ~/.codex/AGENTS.md   # Codex, global
```

The snippet teaches the generate-validate loop, the dialect grammar in
brief, and points at `skills/` for depth. It is generated from the same
source as everything else, so it never drifts from the validator.

## MCP (any client, no shell required)

```sh
claude mcp add dia -- dia mcp        # Claude Code
# other clients: command "dia", args ["mcp"], stdio transport
```

Tools: `dia_new`, `dia_validate`, `dia_manual` run in-process
(stdlib-only); `dia_translate_slide`, `dia_repair_slide`,
`dia_lift_diagram`, `dia_service_health` proxy to a running `dia serve`
and return a clear "start it with `dia serve`" error when it is down.
The MCP surface exists for agents WITHOUT shell access — with a shell,
the CLI is the same capability with a stronger contract (exit codes).

## Tools with neither plugins nor instruction files

Point the agent at two things:

1. `dia agents-md` output (the operating manual), and
2. `dia validate` as the acceptance test for anything it writes.

The validator is the real interface: an agent that satisfies
`dia validate` has produced a working deck, whatever produced it.
