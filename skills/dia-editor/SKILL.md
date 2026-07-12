---
name: dia-editor
description: Operate the diastil editor UI — launch it, navigate table/stage altitudes, select and edit text, reorder slides, change themes/typefaces, save and present decks. Use when driving the editor in a browser, testing editor behavior, or explaining the editor to a user.
---

# Operating the diastil editor

## Launch

- Dev: `npm run dev` in the repo → http://localhost:5199. Boots into the
  built-in demo deck (`examples/demo-deck.html`, 6 slides + a scene diagram).
- On a file: `dia <deck.html>` (see `dia-cli`) — same editor served at
  `/editor` by the service, with save-back and disk-watch.
- Query params: `?file=<abs path>` edit a CLI-opened file; `?import=<abs path>`
  open straight into import review. Both require the service's `/file`
  allowlist (set by the CLI).

## The surface (design/DECISION.md contract, revised)

ONE surface — the table — plus permanent chrome:

- **table** — all slides in vertical flow; import-report gutter
  (confidence / fidelity / island flags) on the left edge of each slide.
  The `s · m · l` zoom segment in the topbar sizes the slides (`l` is the
  detail/diagram working size; `present` is full-screen viewing).
- **minimap** — persistent left filmstrip: click = navigate, ⌥-click =
  pin/unpin the slide into the copilot context (◆ marker), drag = reorder,
  `+ slide` appends a template slide; per-slide duplicate/delete buttons
  on the current row.
- **right rail** — tabs: `inspect` (selection details + per-element
  typesetting), `copilot` (context chips show exactly which slides ride
  along), `tokens` (live theme token editing). `\` hides/shows the rail.
- **topbar** — `s · m · l · present`; `open · save`; theme picker (16
  zicato color themes) and typeface picker; status dot `valid · v1`.

## Navigation & keyboard

| where | keys |
| --- | --- |
| anywhere | `/` keyboard legend · `\` toggle rail · `⌘S`/`Ctrl+S` save · `⌘Z` undo · `⇧⌘Z` redo (history crosses sessions: when the in-session op log is exhausted, undo/redo walk recorded states from earlier sessions, persisted per deck in IndexedDB) |
| deck | `↓`/`j`/`→` next slide · `↑`/`k`/`←` previous · `Esc` clear selection |
| text edit | `Enter` commit · `Esc` cancel · blur commits |

Double-click behavior: on role text → in-place edit (plain text only —
structure edits are ops, not typing); inside any editable svg → scene
editing (see `dia-scenes`). Images drag to move and resize from their
bottom-right corner (⇧ frees the aspect).

## Files

- **open** — the one door for every HTML file: dialect decks load directly;
  anything foreign is detected (parse-based) and handed to the import
  pipeline automatically (see `dia-import`). There is no separate import
  button.
- **save** — writes back through the CLI service path or the File System
  Access handle when available, else downloads. Serialization is
  byte-stable: saving an unedited deck produces identical bytes, editor
  session attributes (`data-dia-id`, `data-dia-selected`, `contenteditable`,
  …) are always stripped, and the presentation runtime is embedded so the
  saved file presents itself when opened.
- **present** — opens the serialized deck in a new tab, self-running
  (keyboard navigation, build steps) with no editor attached.
- Under `dia <deck.html>`, the editor polls the file every 2s: external
  changes reload the deck when the editor is clean; with unsaved edits the
  editor keeps them and warns in the console (save overwrites).

## Programmatic driving (dev builds only)

`window.__diaImport(html, name)` runs the full import pipeline on an HTML
string without the native file picker — the reliable way to drive imports
from automation. Note: while the import review overlay is open, Chrome
screenshot capture can stall; gather state via DOM queries and capture
after the review closes.
