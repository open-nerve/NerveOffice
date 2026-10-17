// 每组后端必须接受该组代理的真实来源；沿用 measure 的单工作进程、无重试与三浏览器配置。
import { defineConfig } from '@playwright/test'
import measure from './playwright.measure.config.ts'

export default defineConfig({ ...measure, webServer: [], testMatch: 'local-save-selftest.spec.ts' })
