import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    // 构建清单供产物检查与体积统计使用
    manifest: true,
    // 生成第三方许可清单（.vite/license.md），随部署包分发（00 号计划书 §3.3）
    license: true,
    sourcemap: false,
  },
  worker: { format: 'es' },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
})
