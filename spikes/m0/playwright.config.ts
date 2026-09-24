import { defineConfig } from '@playwright/test';

// 端口、构建目录与输出目录可以用环境变量改掉，便于两套用例并行（例如回归与新 Phase 的功能用例）：
// M0_PORT_BASE（默认 4700，占用 +0、+1、+2 三个端口）、M0_DIST（默认 dist）、M0_OUTPUT（默认 test-results）。
// 性能测量（V08、V10）必须单独运行。
const PORT = Number(process.env.M0_PORT_BASE ?? 4700);
const DIST = process.env.M0_DIST ?? 'dist';
const server = (offset: number, csp: string) => ({
    command: `node server/serve.ts --port ${PORT + offset} --csp ${csp} --dist ${DIST}`,
    url: `http://127.0.0.1:${PORT + offset}/index.html`,
    reuseExistingServer: false,
});

// 串行执行：CSP 报告由同一个服务收集，并行会互相混入。
export default defineConfig({
    testDir: 'e2e',
    timeout: 180_000,
    fullyParallel: false,
    workers: 1,
    reporter: [['list']],
    outputDir: process.env.M0_OUTPUT ?? 'test-results',
    use: {
        baseURL: `http://127.0.0.1:${PORT}`,
        viewport: { width: 1440, height: 900 },
        locale: 'zh-CN',
        trace: 'retain-on-failure',
    },
    // 同一份 dist 的三种 CSP 模式：full（全部响应带策略）、off（不带策略）、html-only（只有 HTML 带策略）
    webServer: [server(0, 'full'), server(1, 'off'), server(2, 'html-only')],
    // 不使用 devices 预设：预设会改写 UA（例如把 Chromium 伪装成 Windows），
    // 而 Univer 按 UA 判断快捷键的修饰键。这里保持浏览器在本机的真实 UA。
    projects: [
        { name: 'chromium', use: { browserName: 'chromium' } },
        { name: 'chrome', use: { browserName: 'chromium', channel: 'chrome' } },
        { name: 'webkit', use: { browserName: 'webkit' } },
    ],
});
