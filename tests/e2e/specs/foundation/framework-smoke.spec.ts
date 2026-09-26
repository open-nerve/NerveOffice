import { expect, test } from '@playwright/test'

test('E2E 框架冒烟：登录页的标题正确，没有脚本错误与 CSP 违规', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (message) => {
    // 未登录时查询会话得到 401，浏览器会把它记成一条网络错误；这是预期的，不算
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource'))
      errors.push(message.text())
  })
  page.on('pageerror', error => errors.push(error.message))

  await page.goto('/login')

  await expect(page).toHaveTitle('NerveOffice')
  await expect(page.getByRole('heading', { level: 1, name: 'NerveOffice' })).toBeVisible()
  await expect(page.getByRole('form', { name: '登录' })).toBeVisible()
  expect(errors).toEqual([])
})
