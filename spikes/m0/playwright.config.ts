import { defineConfig } from '@playwright/test';

// 串行执行：CSP 报告由同一个服务收集，并行会互相混入。
export default defineConfig({
    testDir: 'e2e',
    timeout: 180_000,
    fullyParallel: false,
    workers: 1,
    reporter: [['list']],
    outputDir: 'test-results',
    use: {
        baseURL: 'http://127.0.0.1:4700',
        viewport: { width: 1440, height: 900 },
        locale: 'zh-CN',
        trace: 'retain-on-failure',
    },
    // 同一份 dist 的三种 CSP 模式：full（全部响应带策略）、off（不带策略）、html-only（只有 HTML 带策略）
    webServer: [
        { command: 'node server/serve.ts --port 4700 --csp full', url: 'http://127.0.0.1:4700/index.html', reuseExistingServer: false },
        { command: 'node server/serve.ts --port 4701 --csp off', url: 'http://127.0.0.1:4701/index.html', reuseExistingServer: false },
        { command: 'node server/serve.ts --port 4702 --csp html-only', url: 'http://127.0.0.1:4702/index.html', reuseExistingServer: false },
    ],
    // 不使用 devices 预设：预设会改写 UA（例如把 Chromium 伪装成 Windows），
    // 而 Univer 按 UA 判断快捷键的修饰键。这里保持浏览器在本机的真实 UA。
    projects: [
        { name: 'chromium', use: { browserName: 'chromium' } },
        { name: 'chrome', use: { browserName: 'chromium', channel: 'chrome' } },
        { name: 'webkit', use: { browserName: 'webkit' } },
    ],
});
