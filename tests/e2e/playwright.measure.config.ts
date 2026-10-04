// 实测（M3-P2 S5）：模式切换的耗时（三个浏览器）与反复切换的内存（Chromium，经 CDP）。与 E2E 用同一套服务与设置，只跑 measure/ 下的用例，
// 不进常规的 E2E 与 CI（常规的配置只认 specs/）。计时要准：一个工作进程，浏览器一个接一个地跑，不重试。
// pnpm --filter @nerve-office/e2e run measure:switch、pnpm --filter @nerve-office/e2e run measure:memory（先构建，同 pnpm test:e2e）
import { defineConfig } from '@playwright/test'
import base from './playwright.config.ts'

/** 内存的实测只在 Chromium 上（CDP 的 HeapProfiler、Memory） */
const MEMORY_SPEC = /[\\/]memory\.spec\.ts$/

export default defineConfig({
  ...base,
  testDir: './measure',
  outputDir: './measure/test-results/playwright',
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'chrome', use: { browserName: 'chromium', channel: 'chrome' }, testIgnore: MEMORY_SPEC },
    { name: 'webkit', use: { browserName: 'webkit' }, testIgnore: MEMORY_SPEC },
  ],
})
