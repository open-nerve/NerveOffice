import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../app/app.tsx'
import { configureZodForCsp } from '../../shared/lib/zod-config.ts'
import '../../app/styles.css'

configureZodForCsp()

// 从往返缓存（bfcache）恢复的页面带着旧的数据与状态：重新加载，由服务端重新确认会话（US-M1-02：退出后按后退键看不到内容）
window.addEventListener('pageshow', (event) => {
  if (event.persisted)
    window.location.reload()
})

const container = document.getElementById('root')
if (!container)
  throw new Error('页面缺少挂载点 #root')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
