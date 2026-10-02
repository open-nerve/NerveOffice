import { expect, test } from '../../support/fixtures.ts'

// CSP 违规与页面错误（没接住的异常）由夹具收集，每个用例结束时断言为空（support/fixtures.ts）：违规不一定出现在控制台里。
// 这里另外看控制台的错误
test('E2E 框架冒烟：登录页的标题正确，没有脚本错误与 CSP 违规', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (message) => {
    // 未登录时查询会话得到 401，浏览器会把它记成一条网络错误；这是预期的，不算
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource'))
      errors.push(message.text())
  })

  await page.goto('/login')

  // 每个页面有自己的标题（WCAG 2.4.2，M2-P6 复核 S4）
  await expect(page).toHaveTitle('登录 - NerveOffice')
  await expect(page.getByRole('heading', { level: 1, name: 'NerveOffice' })).toBeVisible()
  await expect(page.getByRole('form', { name: '登录' })).toBeVisible()
  expect(errors).toEqual([])
})
