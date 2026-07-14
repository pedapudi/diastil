import './chrome/tokens.css'
import './chrome/base.css'
import { initChromePrefs } from './chrome/pickers'
import { mountEditor } from './editor/shell'
import { attachSceneEditing } from './scene/interact'

initChromePrefs()
mountEditor(document.getElementById('app')!)
attachSceneEditing()

// dev/e2e hook: drive the import pipeline without the native file picker
if (import.meta.env.DEV) {
  void import('./ingest/pipeline').then(({ startImport }) => {
    ;(window as unknown as Record<string, unknown>).__diaImport =
      (html: string, name: string) => startImport(html, name)
  })
  void import('./ingest/corpus').then(({ installCorpusCapture }) => installCorpusCapture())
}
