import { startHistoryPreview } from '../../features/history-preview/index.ts'

const chrome = document.getElementById('editor-chrome')
const surface = document.getElementById('sheet-editor')
if (chrome === null || surface === null)
  throw new Error('历史预览的页面容器缺失')
const stop = startHistoryPreview({ chrome, surface })
window.addEventListener('pagehide', () => void stop(), { once: true })
// 返回浏览器冻结的页面时重新鉴权；已经销毁的 SDK 不从冻结状态重新出现。
window.addEventListener('pageshow', (event) => {
  if (event.persisted)
    window.location.reload()
})
