import type { Page } from '@playwright/test'
import { expect } from './fixtures.ts'

/** 打开实际公开退出页；只有读取原会话和预览结束后才返回。 */
export async function openLogoutPreview(page: Page): Promise<void> {
  await page.goto('/logout')
  await expect(page.getByRole('heading', { name: '退出登录', level: 1 })).toBeVisible()
  await expect(page.getByRole('button', { name: '清理本机草稿并退出', exact: true })).toHaveAttribute('aria-disabled', 'false')
}

/** 旧账户故事仍覆盖实际入口，并明确确认新流程。失败/竞态故事单独控制每一步。 */
export async function logoutThroughUi(page: Page): Promise<void> {
  await page.getByRole('button', { name: '退出', exact: true }).click()
  await page.getByRole('button', { name: '清理本机草稿并退出', exact: true }).click()
  const login = page.getByRole('form', { name: '登录' })
  const retry = page.getByRole('button', { name: '重试未完成步骤', exact: true })
  await expect(login.or(retry)).toBeVisible()
  if (await retry.isVisible()) {
    // 活跃编辑页异步释放镜像：服务器结束与本机清理分别呈现，随后按原资格明确重试一次。
    await expect(page.getByText('服务器上的登录已结束。', { exact: true })).toBeVisible()
    await expect(retry).toHaveAttribute('aria-disabled', 'false')
    await retry.click()
  }
  await expect(login).toBeVisible()
}

/** 故意保留编辑器页时，SDK 模块仍占用旧库：分别核对服务器退出和本机待清理，再由用户前往登录。 */
export async function logoutWithOpenEditor(page: Page): Promise<void> {
  await page.getByRole('button', { name: '退出', exact: true }).click()
  await page.getByRole('button', { name: '清理本机草稿并退出', exact: true }).click()
  await expect(page.getByText('服务器上的登录已结束。', { exact: true })).toBeVisible()
  await expect(page.getByText('本机数据尚未全部清理。请关闭其它正在使用本站的标签页后重试。', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '重试未完成步骤', exact: true })).toHaveAttribute('aria-disabled', 'false')
  await page.getByRole('link', { name: '前往登录', exact: true }).click()
  await expect(page.getByRole('form', { name: '登录' })).toBeVisible()
}
