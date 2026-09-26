// 编辑器页的挂载（由 main.tsx 在关掉 zod 的 JIT 之后导入）。
import { startSheetEditorPage } from '../../features/sheet-editor/index.ts'
import { reloadWhenRestoredFromCache } from '../../shared/lib/back-forward-cache.ts'

reloadWhenRestoredFromCache(window, () => window.location.reload())

const chrome = document.getElementById('editor-chrome')
const surface = document.getElementById('sheet-editor')
if (!chrome || !surface)
  throw new Error('页面缺少挂载点 #editor-chrome 或 #sheet-editor')

startSheetEditorPage({ chrome, surface })
