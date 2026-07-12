import './chrome/tokens.css'
import './chrome/base.css'
import { initChromePrefs } from './chrome/pickers'
import { mountEditor } from './editor/shell'
import { attachSceneEditing } from './scene/interact'

initChromePrefs()
mountEditor(document.getElementById('app')!)
attachSceneEditing()
