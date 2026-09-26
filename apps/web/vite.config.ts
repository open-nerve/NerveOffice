import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defaultClientConditions, defineConfig } from 'vite'
import { thirdPartyLicenses } from './build/third-party-licenses.ts'

// 第三方许可清单：主构建与 Worker 的产物都要收集（00 号计划书 §3.3）
const licenses = thirdPartyLicenses({ supplementDir: resolve(import.meta.dirname, 'third-party-licenses') })

/** 只在测试构建里的入口（vite build --mode e2e）：CSP 阳性对照（P3 设计 §3.9）。生产构建不含它，门禁 artifacts 检查 */
const TEST_ONLY_INPUTS = { 'csp-probe': resolve(import.meta.dirname, 'csp-probe.html') }

export default defineConfig(({ mode }) => {
  const testBuild = mode === 'e2e'
  return {
    plugins: [react(), tailwindcss(), licenses.emit],
    // 工作区的包（contracts）直接读源码，开发时不需要先构建（ADR-003）
    resolve: { conditions: ['@nerve-office/source', ...defaultClientConditions] },
    build: {
      target: 'es2022',
      // 测试构建另放一个目录：生产构建（dist）永远不含测试用的入口
      outDir: testBuild ? 'dist-e2e' : 'dist',
      // 构建清单供产物检查与体积统计使用
      manifest: true,
      sourcemap: false,
      // 不注入 modulepreload 的补丁：目标浏览器（桌面 Chrome、Edge 的当前与前一个主要版本，Safari 的当前主要版本）都原生支持。
      // 补丁在生产构建里内联进入口块，在测试构建（两个入口）里拆成共用的块，E2E 测的入口块就与生产的不一样了（审查 B19）
      modulePreload: { polyfill: false },
      rolldownOptions: testBuild ? { input: { index: resolve(import.meta.dirname, 'index.html'), ...TEST_ONLY_INPUTS } } : undefined,
    },
    worker: { format: 'es' as const, plugins: () => [licenses.collect()] },
    // 开发时 /api 代理到 pnpm dev:api；浏览器的 Origin 是开发服务器的地址，与 .env.development 的 NERVE_PUBLIC_ORIGIN 相同
    server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:3000' } },
    preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  }
})
