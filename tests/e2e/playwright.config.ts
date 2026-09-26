// Playwright：四个浏览器，不用设备预设（它会改写 UA，而 Univer 按 UA 判断快捷键，M0 交接单）。
import process from 'node:process'
import { defineConfig } from '@playwright/test'

const CI = process.env.CI === 'true'
const externalBaseUrl = process.env.E2E_BASE_URL
const baseURL = externalBaseUrl ?? 'http://127.0.0.1:4173'

export default defineConfig({
  testDir: './specs',
  outputDir: './test-results',
  forbidOnly: true,
  // 出现重试就记为不稳定，在当前 Phase 内修掉根因（规范 §8.4）
  retries: CI ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: './playwright-report' }],
    ['json', { outputFile: './test-results/results.json' }],
  ],
  use: {
    baseURL,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'chrome', use: { browserName: 'chromium', channel: 'chrome' } },
    { name: 'msedge', use: { browserName: 'chromium', channel: 'msedge' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  // 本 Phase 测 web 构建产物的预览服务（先执行 pnpm build）；M1-P3 起换成 api 托管的生产构建
  webServer: externalBaseUrl === undefined
    ? {
        command: 'pnpm --filter @nerve-office/web run preview',
        url: baseURL,
        // 不复用已经在运行的服务：多个 worktree 并行时，可能测到别的 worktree 的构建；端口被占用时直接失败
        reuseExistingServer: false,
        timeout: 120_000,
      }
    : undefined,
})
