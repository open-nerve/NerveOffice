import { defineConfig } from '@playwright/test';

const PORT = 4700;

// 串行执行：CSP 报告由同一个服务收集，并行会互相混入。
export default defineConfig({
    testDir: 'e2e',
    timeout: 180_000,
    fullyParallel: false,
    workers: 1,
    reporter: [['list']],
    outputDir: 'test-results',
    use: {
        baseURL: `http://127.0.0.1:${PORT}`,
        viewport: { width: 1440, height: 900 },
        locale: 'zh-CN',
        trace: 'retain-on-failure',
    },
    webServer: {
        command: `node server/serve.ts --port ${PORT}`,
        url: `http://127.0.0.1:${PORT}/index.html`,
        reuseExistingServer: false,
    },
    // 不使用 devices 预设：预设会改写 UA（例如把 Chromium 伪装成 Windows），
    // 而 Univer 按 UA 判断快捷键的修饰键。这里保持浏览器在本机的真实 UA。
    projects: [
        { name: 'chromium', use: { browserName: 'chromium' } },
        { name: 'chrome', use: { browserName: 'chromium', channel: 'chrome' } },
        { name: 'webkit', use: { browserName: 'webkit' } },
    ],
});
