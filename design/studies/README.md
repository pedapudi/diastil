# UI studies

Four candidate editor designs, built before any editor code, for review.
Each is a self-contained HTML mockup — open in a browser; light/dark
follows the OS. All four speak the same design language (token role
contract, monospace chrome, one accent, hairline rules) and show the same
slide + diagram, so only the information architecture differs.

| study | bet | strongest at | weakest at |
| --- | --- | --- | --- |
| [01-bench](01-bench.html) | familiarity: filmstrip · canvas · inspector | typesetting flow; write-target visibility | diagram tools homeless; structure invisible |
| [02-console](02-console.html) | structure made visible: tree + op log + fidelity | trust after ingest; auditability; complex decks | chrome-heavy; properties lack a fixed home |
| [03-stage](03-stage.html) | canvas-first, transient chrome at the selection | diagramming; maximum canvas; demo quality | discoverability; where does write-target live |
| [04-lichttisch](04-lichttisch.html) | the deck as a sequence, edited in flow | deck-wide rhythm; cross-slide copilot asks | single-diagram deep work needs a zoom mode |

Shared ideas that appear in every study (candidates for "keep regardless
of direction"):

- **write-target line** — every style edit declares whether it lands on a
  token, a rule, or this element, before it lands (01 shows it best);
- **op-diff bubbles** — copilot edits arrive as typed ops with
  apply/preview/reject, entering the same undo history (all four);
- **fidelity surfaced in place** — ingest scores and islands are visible
  where you work, not buried in a report (02's tree, 04's gutter);
- **selection-scoped copilot context** — the chat names what it sees
  (02, 03, 04).

The decision (possibly a hybrid) gets recorded in `design/DECISION.md`.
