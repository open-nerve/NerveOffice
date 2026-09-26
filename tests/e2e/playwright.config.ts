// Playwright：本机跑 Chromium、Chrome、WebKit，CI（Linux）另加 Edge（规范 §8.2）。
// 不用设备预设：它会改写 UA，而 Univer 按 UA 判断快捷键（M0 交接单）。
// 测的是真实后端 + 数据库 + 前端的测试构建（生产构建加上 CSP 探针，P3 设计 §3.9、§3.10）。
import process from 'node:process'
import { defineConfig } from '@playwright/test'
import { databaseUrl, E2E_DATABASE_PREFIX, E2E_ORIGIN } from './support/environment.ts'

const CI = process.env.CI === 'true'
const externalBaseUrl = process.env.E2E_BASE_URL
const baseURL = externalBaseUrl ?? E2E_ORIGIN

// 本次运行专用的测试库：按主进程的进程号命名；工作进程与服务脚本继承这个环境变量（配置在每个进程里都会执行一遍）
process.env.E2E_DATABASE_URL ??= databaseUrl(`${E2E_DATABASE_PREFIX}${process.pid}`)

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
  // 服务脚本：建测试库、迁移、初始化管理员、启动后端托管测试构建；退出时删库（先执行 pnpm build 与 web 的 build:e2e）
  webServer: externalBaseUrl === undefined
    ? {
        command: 'node support/serve.ts',
        url: `${E2E_ORIGIN}/api/health/ready`,
        env: { ...process.env as Record<string, string> },
        // 不复用已经在运行的服务：多个 worktree 并行时，可能测到别的 worktree 的构建；端口被占用时直接失败
        reuseExistingServer: false,
        gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 120_000,
      }
    : undefined,
})
