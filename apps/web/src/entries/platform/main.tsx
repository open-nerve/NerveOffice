import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../app/app.tsx'
import { configureZodForCsp } from '../../shared/lib/zod-config.ts'
import '../../app/styles.css'

configureZodForCsp()

const container = document.getElementById('root')
if (!container)
  throw new Error('页面缺少挂载点 #root')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
