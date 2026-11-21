// 编辑器页的挂载（由 main.tsx 在关掉 zod 的 JIT 之后导入）。
// M6-P1 S8c（S8 spec §3.3）：这里是组合处——共用编辑会话层的启动（startEditorPage：组合处专用的窄入口，直接引用 document-editor 的 start.tsx）
// 带上表格的启动装配（kit）；新建表格的页面收同一个启动函数。P2 组合两份 kit 时再定组合的写法
import { CSV_CREATE_PAGE_PATTERN } from '@nerve-office/contracts'
import { startEditorPage } from '../../features/document-editor/start.tsx'
import { sheetEditorPageKit, startCsvCreatePage } from '../../features/sheet-editor/index.ts'
import { reloadWhenRestoredFromCache } from '../../shared/lib/back-forward-cache.ts'

reloadWhenRestoredFromCache(window, () => window.location.reload())

const chrome = document.getElementById('editor-chrome')
const surface = document.getElementById('sheet-editor')
if (!chrome || !surface)
  throw new Error('页面缺少挂载点 #editor-chrome 或 #sheet-editor')

if (CSV_CREATE_PAGE_PATTERN.test(window.location.pathname))
  startCsvCreatePage({ chrome, surface }, async elements => startEditorPage(elements, sheetEditorPageKit))
else
  void startEditorPage({ chrome, surface }, sheetEditorPageKit).catch(reportError)
