// Playwright：本机跑 Chromium、Chrome、WebKit，CI（Linux）另加 Edge（规范 §8.2）。
// 不用设备预设：它会改写 UA，而 Univer 按 UA 判断快捷键（M0 交接单）。
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
    // CI 上把失败与不稳定的用例写成 GitHub 注解，不登录也能从运行结果里看到
    ...(CI ? [['github'] as const] : []),
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
    { name: 'webkit', use: { browserName: 'webkit' } },
    // Edge 与 Chrome 同一个内核，本机再跑一遍意义不大，安装还要管理员权限；CI 的 Linux 机器上由 Playwright 自动安装
    ...(CI ? [{ name: 'msedge', use: { browserName: 'chromium' as const, channel: 'msedge' } }] : []),
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
