import type { Connect, Plugin } from 'vite'
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defaultClientConditions, defineConfig } from 'vite'
// 配置文件由 Vite 打包后执行：直接引用 contracts 的源码，开发时不需要先构建 contracts
import { DOCUMENT_PAGE_PATTERN } from '../../packages/contracts/src/documents/document-page.ts'
import { moduleSources } from './build/module-sources.ts'
import { thirdPartyLicenses } from './build/third-party-licenses.ts'

// 第三方许可清单：主构建与 Worker 的产物都要收集（00 号计划书 §3.3）
const licenses = thirdPartyLicenses({ supplementDir: resolve(import.meta.dirname, 'third-party-licenses') })
// 每个脚本由哪些源码模块组成（M3-P2 复核 B2）：门禁 artifacts 按来源认测试专用的模块；Worker 同样要记。两份构建的入口块相同（复核 B4）
// 没有跨构建的自动比较（ADR-015），源头由 lint 规则 nerve/selftest-entry-self-contained 拦住
const sources = moduleSources({ root: import.meta.dirname })

/** 两个入口页：平台页面与编辑器页（整页加载，P4 设计 §3.8） */
const PAGE_INPUTS = {
  index: resolve(import.meta.dirname, 'index.html'),
  editor: resolve(import.meta.dirname, 'editor.html'),
}

/**
 * 只在测试构建里的入口（vite build --mode e2e）：CSP 阳性对照（P3 设计 §3.9）与页面自检的入口页（M3-P2 设计 §3.5：真实 Safari 上
 * 登录之后跳到编辑器页跑自检）。生产构建不含它们，门禁 artifacts 检查
 */
const TEST_ONLY_INPUTS = {
  'csp-probe': resolve(import.meta.dirname, 'csp-probe.html'),
  'selftest': resolve(import.meta.dirname, 'selftest.html'),
}

/**
 * 开发与预览时，编辑器页的地址（/documents/<id>）交给 editor.html；生产由后端的托管按同一个规则映射（ENTRY_PAGES）。
 * 其他没有扩展名的地址照旧回退到平台页面（Vite 默认）。
 */
function editorPageRewrite(): Plugin {
  const rewrite: Connect.NextHandleFunction = (request, _response, next) => {
    const path = request.url?.split('?')[0] ?? ''
    if (DOCUMENT_PAGE_PATTERN.test(path))
      request.url = '/editor.html'
    next()
  }
  return {
    name: 'nerve:editor-page-rewrite',
    configureServer: server => void server.middlewares.use(rewrite),
    configurePreviewServer: server => void server.middlewares.use(rewrite),
  }
}

export default defineConfig(({ mode }) => {
  const testBuild = mode === 'e2e'
  return {
    plugins: [react(), tailwindcss(), licenses.emit, sources.emit, editorPageRewrite()],
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
      // 补丁在只有一个入口时内联进入口块，有多个入口时拆成共用的块，E2E 测的入口块就与生产的不一样了（审查 B19）
      modulePreload: { polyfill: false },
      rolldownOptions: { input: testBuild ? { ...PAGE_INPUTS, ...TEST_ONLY_INPUTS } : PAGE_INPUTS },
    },
    worker: { format: 'es' as const, plugins: () => [licenses.collect(), sources.collect()] },
    // 开发时 /api 代理到 pnpm dev:api；浏览器的 Origin 是开发服务器的地址，与 .env.development 的 NERVE_PUBLIC_ORIGIN 相同
    server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:3000' } },
    preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  }
})
