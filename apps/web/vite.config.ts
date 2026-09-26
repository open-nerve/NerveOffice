import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defaultClientConditions, defineConfig } from 'vite'
import { thirdPartyLicenses } from './build/third-party-licenses.ts'

// 第三方许可清单：主构建与 Worker 的产物都要收集（00 号计划书 §3.3）
const licenses = thirdPartyLicenses({ supplementDir: resolve(import.meta.dirname, 'third-party-licenses') })

export default defineConfig({
  plugins: [react(), tailwindcss(), licenses.emit],
  // 工作区的包（contracts）直接读源码，开发时不需要先构建（ADR-003）
  resolve: { conditions: ['@nerve-office/source', ...defaultClientConditions] },
  build: {
    target: 'es2022',
    // 构建清单供产物检查与体积统计使用
    manifest: true,
    sourcemap: false,
  },
  worker: { format: 'es', plugins: () => [licenses.collect()] },
  // 开发时 /api 代理到 pnpm dev:api；浏览器的 Origin 是开发服务器的地址，与 .env.development 的 NERVE_PUBLIC_ORIGIN 相同
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:3000' } },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
})
