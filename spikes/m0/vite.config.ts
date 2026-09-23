import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 多页面：入口页 + 每种文档类型一个编辑器页面（整页加载，一页一份文档）。
export default defineConfig({
    plugins: [react()],
    server: { host: '127.0.0.1', port: 4600, strictPort: true },
    preview: { host: '127.0.0.1', port: 4601, strictPort: true },
    build: {
        target: 'es2022',
        manifest: true,
        // 生成打包依赖的许可清单（dist/.vite/license.md）；M1 用它随部署包分发第三方许可
        license: true,
        sourcemap: false,
        chunkSizeWarningLimit: 20_000,
        rolldownOptions: {
            input: {
                index: resolve(import.meta.dirname, 'index.html'),
                sheet: resolve(import.meta.dirname, 'sheet.html'),
                doc: resolve(import.meta.dirname, 'doc.html'),
                // CSP 阳性对照页面（只用于验证，不属于编辑器产物）
                'csp-probe': resolve(import.meta.dirname, 'csp-probe.html'),
            },
        },
    },
    worker: { format: 'es' },
});
