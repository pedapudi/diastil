# Design decision

**Direction: study 05 (lichtbühne) + the minimap from study 01.**

One surface, two altitudes:

- **table** — slides in vertical flow at reading size; margin gutter with
  slide number / import confidence / island flags; in-place text editing;
  right rail (inspect · copilot · tokens).
- **stage** — one slide fills the viewport; transient chrome; contextual
  toolbar at the selection; write-target toast; deep diagram work.
- **minimap** (from study 01) — a persistent left filmstrip in both
  altitudes: thumbnails, current highlighted, click to navigate (scroll
  in table / switch in stage), drag to reorder, viewport indicator in
  table. The minimap is the one piece of permanent structure chrome; the
  02-console tree was rejected as too heavy for the default surface.

Navigation contract:

- click slide = select · double-click / ⏎ = lift to stage
- double-click a figure = lift + enter the scene
- esc = up one level (scene → stage → table), position preserved
- minimap click = go there (never lifts on its own)
- ⌘K = op palette; ⌘. = copilot

Visual language: zicato role contract verbatim (16 themes, swatch
dropdown), 12-face typeface popover with S/M/L, monospace-forward chrome,
one accent, hairline rules, hovercards. Explicitly rejected: accent
left-rail boxes, decorative pills/tags, second accent colors. Pills are
reserved for state that needs a word (island, offline) — never decoration.

Import review (fix/validate): full-screen compare mode after every
import — original (sandboxed, JS live) beside converted, per slide, with
a blend-difference overlay toggle; per-slide verdict: accept / island a
region / retry (service). The report rides in the table gutter after
acceptance.
