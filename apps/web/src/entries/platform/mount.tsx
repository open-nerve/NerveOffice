// 平台页面的挂载（由 main.tsx 在关掉 zod 的 JIT 之后导入）：建运行时，挂载 React。
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../app/app.tsx'
import { createAppRuntime } from '../../app/runtime.ts'
import { reloadWhenRestoredFromCache } from '../../shared/lib/back-forward-cache.ts'

reloadWhenRestoredFromCache(window, () => window.location.reload())

const container = document.getElementById('root')
if (!container)
  throw new Error('页面缺少挂载点 #root')

// 路由、请求缓存与会话的全局处理在 React 之外建一次（审查 B22）
const runtime = createAppRuntime()

createRoot(container).render(
  <StrictMode>
    <App runtime={runtime} />
  </StrictMode>,
)
