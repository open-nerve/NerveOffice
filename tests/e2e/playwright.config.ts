// Playwright：本机跑 Chromium、Chrome、WebKit，CI（Linux）另加 Edge（规范 §8.2）。
// 不用设备预设：它会改写 UA，而 Univer 按 UA 判断快捷键（M0 交接单）。
// 测的是真实后端 + 数据库 + 前端的测试构建（生产构建加上 CSP 探针，P3 设计 §3.9、§3.10）。
import process from 'node:process'
import { defineConfig } from '@playwright/test'
import { databaseUrl, E2E_DATABASE_PREFIX, e2eOrigin, pickFreePort } from './support/environment.ts'

const CI = process.env.CI === 'true'
/** 测外部已经部署好的环境（P5 恢复这个模式）：不启动服务脚本 */
const externalBaseUrl = process.env.E2E_BASE_URL

// 配置在主进程与每个工作进程里都会执行一遍：本次运行的端口与测试库只在主进程里定一次，工作进程与服务脚本从环境变量继承。
// 端口按次挑选（审查 B9）：多个 worktree 同时跑 E2E 时各用各的端口，不会测到别人的服务；库名带主进程的进程号
if (externalBaseUrl === undefined)
  process.env.E2E_PORT ??= String(await pickFreePort())
process.env.E2E_DATABASE_URL ??= databaseUrl(`${E2E_DATABASE_PREFIX}${process.pid}`)
const baseURL = externalBaseUrl ?? e2eOrigin()

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
  // 服务脚本：建测试库、迁移、初始化管理员、启动后端托管测试构建；退出时删库（先执行 pnpm build 与 web 的 build:e2e）。
  // 后端的日志写进 test-results/e2e-server.log，不刷在测试输出里（support/serve.ts）
  webServer: externalBaseUrl === undefined
    ? {
        command: 'node support/serve.ts',
        url: `${baseURL}/api/health/ready`,
        env: { ...process.env as Record<string, string> },
        // 不复用已经在运行的服务：可能是别的 worktree 的构建。启动前 Playwright 先确认这个端口上没有服务，有就直接失败
        reuseExistingServer: false,
        gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 120_000,
      }
    : undefined,
})
