// 更新表格的模板快照（P4 设计 §3.4）与只读用例的样本（P3 审查 B13）：与 E2E 用同一套服务与设置，只跑 tools/ 下的更新脚本，只用 Chromium。
// SDK 升级或插件档案变更之后各执行一次（package.json 的脚本按文件名只跑其中一个）：
// pnpm --filter @nerve-office/e2e run update:sheet-template、pnpm --filter @nerve-office/e2e run update:read-only-sample
import { defineConfig } from '@playwright/test'
import base from './playwright.config.ts'

export default defineConfig({
  ...base,
  testDir: './tools',
  retries: 0,
  reporter: [['list']],
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
