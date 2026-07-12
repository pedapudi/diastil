---
name: dia-validate
description: Validate decks against the diastil dialect profile and fix violations — rule ids, error vs advisory levels, what islands exempt, common repairs. Use when dia validate fails, when a deck edited outside diastil re-enters, or when checking generated dialect output.
---

# Profile validation

`profile/PROFILE.md` is the contract; two mirror implementations enforce
it with identical rule ids: `src/model/validate.ts` (editor/tests) and
`service/dia_service/validate.py` (`dia validate`, stdlib-only).

```sh
dia validate deck.html other.html   # exit 1 on any error-level finding
```

Findings: **error** = the dialect contract is broken (full direct
manipulation can't be promised); **advisory** = in-dialect but degraded
(deck still validates `ok`).

## Rules and their fixes

| rule | fix |
| --- | --- |
| `frame/version` | add `data-dia-version="1"` to `<html>` |
| `frame/theme` | exactly one `<style id="dia-theme">` |
| `frame/theme-tokens` (advisory) | define `--dia-*` tokens so token editing works |
| `frame/runtime` (advisory) | save from diastil to embed the runtime (never-saved decks are fine) |
| `frame/slides` | slides must be `<section class="dia-slide">` |
| `frame/stray-content` | body children are only slides, styles, the runtime script — move strays into a slide or island |
| `content/script` | no `<script>` in dialect regions — express behavior as `data-dia-*`, or island the region |
| `content/event-handler` | remove `on*=` attributes — same remedy |
| `content/embed` | `iframe`/`object`/`embed` only inside islands |
| `content/unknown-dia-attr` | only the documented `data-dia-*` vocabulary; rename custom data attrs to non-`dia` prefixes |
| `content/editor-artifact` | `data-dia-id`/`data-dia-selected`/`contenteditable` leaked into a saved file — re-save from diastil (a leak is a serializer bug worth reporting) |
| `content/inline-color` (advisory) | prefer `var(--dia-…)` over literal colors |
| `behavior/step` | `data-dia-step` must be a positive integer |
| `scene/*` | unique node ids; finite `data-x/y/w/h`; shapes ∈ rect·rounded·pill·ellipse·diamond; edges `a->b` with both endpoints existing; routes ∈ straight·ortho·curve; anchors ∈ N·S·E·W·auto |

## Islands exempt everything

Content under `[data-dia-island]` is validated not at all — scripts,
handlers, embeds, foreign attributes are all legal there. When a fix
would mean rewriting content you don't control, wrap the smallest
enclosing region as an island instead.

## Where validation runs automatically

- Every import report appends profile findings (`profile error …` /
  `profile advisory …` lines in warnings).
- Lifted diagrams and service-translated slides are probe-validated
  before they're accepted into a conversion.
- The round-trip tests hold the guarantee that diastil's own output
  always validates clean.
