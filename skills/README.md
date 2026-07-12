# diastil skills

Agent-facing operating manuals for diastil, one skill per surface. Each
folder holds a `SKILL.md` in the Claude Code skill format (frontmatter
`name` + `description`, then the instructions). To activate them in a
Claude Code session, symlink or copy the folders into the project's
`.claude/skills/` directory:

```sh
mkdir -p .claude/skills && ln -s ../../skills/* .claude/skills/
```

| skill | teaches |
| --- | --- |
| `dia-editor` | driving the editor UI: altitudes, selection, text editing, saving, presenting |
| `dia-authoring` | writing dialect decks directly — frame, roles, tokens, layout, media, behavior |
| `dia-scenes` | diagrams: the scene vocabulary and the direct-manipulation editor |
| `dia-import` | converting foreign decks: pipeline, review UI, fidelity, islands |
| `dia-validate` | the profile validator: rule ids, fixing violations, islands as escape hatch |
| `dia-cli` | the `dia` command: edit/ingest/present/validate/serve/eval |
| `dia-service` | the inference sidecar: config, endpoints, copilot, skill prompts, evals |
| `dia-extend` | extending diastil: extractors, fixtures, eval cases, tests |

Ground truth lives in the repo: `PLAN.md` (architecture),
`profile/PROFILE.md` (the dialect contract), `design/DECISION.md` (UI
contract), `service/README.md` (service + CLI). The skills summarize and
point; when they disagree with the code, the code wins.
