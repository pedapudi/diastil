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

## The surface (design/DECISION.md contract)

One surface, two altitudes, one permanent chrome piece:

- **table** — slides in vertical flow at reading size; import-report gutter
  (confidence / fidelity / island flags) on the left edge of each slide.
- **stage** — one slide fills the viewport; deep diagram work happens here.
- **minimap** — persistent left filmstrip in both altitudes: click = navigate
  (never changes altitude), drag = reorder slides, `+ slide` appends a
  template slide; per-slide duplicate/delete buttons on the current row.
- **right rail** — tabs: `inspect` (selection details), `copilot` (needs the
  dia service; shows a quiet offline line otherwise), `tokens` (live theme
  token editing — edits preview deck-wide and land as undoable ops).
- **topbar** — `table · stage · present` segment; `open · import · save`;
  theme picker (16 zicato color themes, default monokai) and typeface picker
  (with S/M/L size steps); status dot reading `valid · v1`.

## Navigation & keyboard

| where | keys |
| --- | --- |
| anywhere | `⌘S`/`Ctrl+S` save · `⌘Z` undo · `⇧⌘Z` redo |
| table | `↓`/`j` next slide · `↑`/`k` previous · `Enter` lift to stage · `Esc` clear selection |
| stage | `→`/`←` next/previous slide · `Esc` back to table (position preserved) |
| text edit | `Enter` commit · `Esc` cancel · blur commits |

Double-click behavior: on role text → in-place edit (plain text only —
structure edits are ops, not typing); on a slide with no text under the
cursor (table) → lift that slide to stage; inside a `svg.dia-scene` → scene
editing (see `dia-scenes`).

## Files

- **open** — dialect files load directly; anything foreign is handed to the
  import pipeline automatically (see `dia-import`).
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
