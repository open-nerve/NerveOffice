// 访问控制（P3，US-M1-08）：未登录时一律要求先登录；别人的文档与不存在的文档，接口响应相同。
// 文档页（编辑器）在 P4 建立，届时补上"两种情况的页面相同"。
import { randomUUID } from 'node:crypto'
import { errorResponseSchema } from '@nerve-office/contracts'
import { expect, test } from '@playwright/test'
import { createDocument, createUser } from '../../support/database.ts'
import { loginThroughApi } from '../../support/session.ts'

test.describe('US-M1-08 未登录与别人的文档', () => {
  test('未登录访问页面：转到登录页', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByRole('form', { name: '登录' })).toBeVisible()
  })

  test('未登录访问接口：401，要求先登录', async ({ request }) => {
    for (const path of ['/api/documents', `/api/documents/${randomUUID()}`, '/api/auth/session']) {
      const response = await request.get(path)
      expect(response.status(), path).toBe(401)
      expect(errorResponseSchema.parse(await response.json()).error.code).toBe('UNAUTHENTICATED')
    }
  })

  test('别人的文档与不存在的文档：接口响应相同，不暴露文档是否存在', async ({ page }) => {
    const me = await createUser('access-me')
    const other = await createUser('access-other')
    const othersDocument = await createDocument(other, '别人的文档')
    await loginThroughApi(page, me)

    const others = await page.request.get(`/api/documents/${othersDocument}`)
    const missing = await page.request.get(`/api/documents/${randomUUID()}`)
    expect(others.status()).toBe(404)
    expect(missing.status()).toBe(404)
    const [first, second] = [errorResponseSchema.parse(await others.json()).error, errorResponseSchema.parse(await missing.json()).error]
    expect({ code: first.code, message: first.message }).toEqual({ code: second.code, message: second.message })
  })
})
