// Playwright：本机跑 Chromium、Chrome、WebKit，CI（Linux）另加 Edge（规范 §8.2）。
// 不用设备预设：它会改写 UA，而 Univer 按 UA 判断快捷键（M0 交接单）。
// 两种运行方式（P5 设计 §3.6）：
// - 本机模式：服务脚本起真实后端 + 数据库，托管前端的测试构建（生产构建加上 CSP 探针，P3 设计 §3.9、§3.10）；
// - 外部模式（E2E_BASE_URL）：测已经部署好的环境（容器 E2E 用生产镜像），测试数据直接写被测环境的库（E2E_DATABASE_URL）。
//   只依赖测试构建的用例（标签 @test-build）按标签排除，生产镜像里没有探针页。
import type { PlaywrightTestProject } from '@playwright/test'
import process from 'node:process'
import { defineConfig } from '@playwright/test'
import { databaseUrl, E2E_DATABASE_PREFIX, e2eOrigin, pickFreePort } from './support/environment.ts'

const CI = process.env.CI === 'true'
const externalBaseUrl = process.env.E2E_BASE_URL

// 配置在主进程与每个工作进程里都会执行一遍：本次运行的端口与测试库只在主进程里定一次，工作进程与服务脚本从环境变量继承。
// 端口按次挑选（审查 B9）：多个 worktree 同时跑 E2E 时各用各的端口，不会测到别人的服务；库名带主进程的进程号
if (externalBaseUrl === undefined) {
  process.env.E2E_PORT ??= String(await pickFreePort())
  process.env.E2E_DATABASE_URL ??= databaseUrl(`${E2E_DATABASE_PREFIX}${process.pid}`)
}
else if (process.env.E2E_DATABASE_URL === undefined) {
  throw new Error('外部模式（E2E_BASE_URL）必须同时给出 E2E_DATABASE_URL：测试数据直接写被测环境的库')
}
const baseURL = externalBaseUrl ?? e2eOrigin()

/** 浏览器项目；E2E_BROWSERS（逗号分隔）可以只选其中几个（CI 的容器 E2E 只跑 chromium） */
const BROWSERS: Readonly<Record<string, PlaywrightTestProject['use']>> = {
  chromium: { browserName: 'chromium' },
  chrome: { browserName: 'chromium', channel: 'chrome' },
  webkit: { browserName: 'webkit' },
  // Edge 与 Chrome 同一个内核，本机再跑一遍意义不大，安装还要管理员权限；CI 的 Linux 机器上由 Playwright 自动安装
  msedge: { browserName: 'chromium', channel: 'msedge' },
}
const browsers = process.env.E2E_BROWSERS?.split(',') ?? ['chromium', 'chrome', 'webkit', ...(CI ? ['msedge'] : [])]
for (const name of browsers) {
  if (!Object.hasOwn(BROWSERS, name))
    throw new Error(`E2E_BROWSERS 里有不认识的浏览器：${name}（可选 ${Object.keys(BROWSERS).join('、')}）`)
}

/** 强制结束后端的用例（US-M1-10）：单独一个项目，等全部浏览器项目跑完再执行，不打断别的用例 */
const RESTART_SPECS = /[\\/]deploy[\\/]restart\.spec\.ts$/

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
  // 外部模式：按标签排除只依赖测试构建的用例（不是跳过：本机模式里照常执行）；被测环境里还没有 E2E 的管理员时先初始化
  ...(externalBaseUrl === undefined ? {} : { grepInvert: /@test-build/, globalSetup: './support/external-setup.ts' }),
  use: {
    baseURL,
    // 测试环境的 HTTPS 用 Caddy 自带的 CA，浏览器不信任
    ignoreHTTPSErrors: baseURL.startsWith('https:'),
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    ...browsers.map(name => ({ name, use: BROWSERS[name], testIgnore: RESTART_SPECS })),
    // 只跑重启用例：--project restart --no-deps。命令行的 --grep 不作用于依赖的浏览器项目：它们照样全部执行。
    // 重复运行要加 --workers 1：--repeat-each 的副本会分到几个工作进程并行，互相强制结束同一个后端（复验 RB5）
    // 用例的时限放宽到 2 分钟：强制结束后等后端重新可用最多 1 分钟（support/api-process.ts），慢的机器上还要重新打开编辑器
    { name: 'restart', use: { browserName: 'chromium' }, testMatch: RESTART_SPECS, dependencies: browsers, timeout: 120_000 },
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
