import { expect, test } from '@playwright/test'

test('E2E 框架冒烟：占位页面的标题正确，没有控制台错误', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error')
      errors.push(message.text())
  })
  page.on('pageerror', error => errors.push(error.message))

  await page.goto('/')

  await expect(page).toHaveTitle('NerveOffice')
  await expect(page.getByRole('heading', { level: 1, name: 'NerveOffice' })).toBeVisible()
  expect(errors).toEqual([])
})
