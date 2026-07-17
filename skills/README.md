# diastil skills

Operating manuals for diastil, written for **any agent** (or human), one
skill per surface. Each folder holds a `SKILL.md`: plain-YAML frontmatter
(`name`, plus a `description` stating when the skill applies) followed by
markdown instructions. No harness-specific features are used — load them
however your agent consumes instructions:

- point the agent at `skills/` and let it read `SKILL.md` files on demand;
- inject the relevant `SKILL.md` into context when its `description` matches
  the task;
- or symlink/copy the folders into whatever directory your agent framework
  discovers skills from.

| skill | teaches |
| --- | --- |
| `dia-editor` | driving the editor UI: altitudes, selection, text editing, saving, presenting |
| `dia-authoring` | writing dialect decks directly — frame, roles, tokens, layout, media, behavior |
| `dia-scenes` | diagrams: the scene vocabulary and the direct-manipulation editor |
| `dia-artwork` | drawing figures: the line-art register, pictorial canon, palette/setting variety, the imagery iteration loop |
| `dia-import` | converting foreign decks: pipeline, review UI, fidelity, islands |
| `dia-validate` | the profile validator: rule ids, fixing violations, islands as escape hatch |
| `dia-cli` | the `dia` command: edit/ingest/present/validate/serve/eval |
| `dia-service` | the inference sidecar: config, endpoints, copilot, skill prompts, evals |
| `dia-extend` | extending diastil: extractors, fixtures, eval cases, tests |

Ground truth lives in the repo: `PLAN.md` (architecture),
`profile/PROFILE.md` (the dialect contract), `design/DECISION.md` (UI
contract), `service/README.md` (service + CLI). The skills summarize and
point; when they disagree with the code, the code wins.
