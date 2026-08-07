import './chrome/tokens.css'
import './chrome/base.css'
import { initChromePrefs } from './chrome/pickers'
import { mountEditor } from './editor/shell'
import { attachSceneEditing } from './scene/interact'
import { initMcpApp } from './mcp/app'

initChromePrefs()
mountEditor(document.getElementById('app')!)
attachSceneEditing()

// If served as an MCP App (rendered inside a host like Claude / Copilot), connect
// to the host: open the deck it hands us and stream edits back. No-op on the web.
initMcpApp()

// dev/e2e hook: drive the import pipeline without the native file picker
if (import.meta.env.DEV) {
  void import('./ingest/pipeline').then(({ startImport }) => {
    ;(window as unknown as Record<string, unknown>).__diaImport =
      (html: string, name: string) => startImport(html, name)
  })
  void import('./ingest/corpus').then(({ installCorpusCapture }) => installCorpusCapture())
  // …and the document editor (LaTeX or saved artifact), likewise
  void import('./editor/slides').then(({ openDocumentText }) => {
    ;(window as unknown as Record<string, unknown>).__diaDoc =
      (text: string, name: string) => openDocumentText(text, name)
  })
}
