// 更新表格的模板快照（P4 设计 §3.4）：与 E2E 用同一套服务与设置，只跑 tools/ 下的更新脚本，只用 Chromium。
// SDK 升级或插件档案变更之后执行一次：pnpm --filter @nerve-office/e2e run update:sheet-template
import { defineConfig } from '@playwright/test'
import base from './playwright.config.ts'

export default defineConfig({
  ...base,
  testDir: './tools',
  retries: 0,
  reporter: [['list']],
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
