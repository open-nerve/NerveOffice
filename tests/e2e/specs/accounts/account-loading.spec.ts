import type { Route } from '@playwright/test'
import { expect, test } from '../../support/fixtures.ts'

const ACCOUNT_CHUNK = '**/assets/account-*.js'
const TOKEN = 't'.repeat(43)

test.describe('账户页面的实际分块加载', () => {
  for (const [path, endpoint, message] of [
    ['/invite', '/api/auth/invitations/inspect', '邀请链接无效：请检查链接是否完整，或者请管理员重新发送'],
    ['/reset-password', '/api/auth/password-resets/inspect', '重置链接无效：请检查链接是否完整，或者请管理员重新发送'],
  ] as const) {
    test(`${path} 的代码尚未下载时保留链接，下载完成后才核对并移除令牌`, async ({ page }) => {
      let captured: (route: Route) => void = () => {}
      const held = new Promise<Route>((resolve) => {
        captured = resolve
      })
      await page.route(ACCOUNT_CHUNK, route => captured(route))
      const inspections: string[] = []
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === endpoint)
          inspections.push(request.postData() ?? '')
      })
      await page.goto(`${path}#${TOKEN}`, { waitUntil: 'domcontentloaded' })
      const route = await held
      try {
        await expect(page.getByRole('status', { name: '正在打开页面…' })).toBeVisible()
        expect(new URL(page.url()).hash).toBe(`#${TOKEN}`)
        expect(inspections).toEqual([])
      }
      finally {
        await route.continue()
      }
      await expect(page.getByText(message, { exact: true })).toBeVisible()
      expect(new URL(page.url()).hash).toBe('')
      expect(inspections.map(body => JSON.parse(body) as unknown)).toEqual([{ token: TOKEN }])
    })
  }

  test('公开页面的代码下载失败时给出重试入口，保留原链接且不发送令牌核对', async ({ page }) => {
    const inspections: string[] = []
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/auth/invitations/inspect')
        inspections.push(request.url())
    })
    await page.route(ACCOUNT_CHUNK, async route => route.abort('failed'))
    await page.goto(`/invite#${TOKEN}`)
    await expect(page.getByRole('main').getByRole('heading', { name: '页面没能加载' })).toBeVisible()
    await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible()
    expect(new URL(page.url()).hash).toBe(`#${TOKEN}`)
    expect(inspections).toEqual([])
  })
})
