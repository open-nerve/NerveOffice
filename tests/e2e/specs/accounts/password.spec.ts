// 修改密码（M2-P1，US-M2-02）：改完之后其他地方的登录被退出、这里保持登录；旧密码不对时的提示；
// 当前页面的会话令牌也换掉，旧的令牌不再有效（M2-P6 复核 B1）。
import type { Cookie, Page } from '@playwright/test'
import { createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi, loginThroughUi } from '../../support/session.ts'

const NEW_PASSWORD = 'a brand new password'

/** 这个页面的浏览器上下文里的会话 Cookie（本机 HTTP 时叫 nerve_session，HTTPS 时带 __Host- 前缀） */
async function sessionCookieOf(page: Page): Promise<Cookie> {
  const cookie = (await page.context().cookies()).find(entry => entry.name.endsWith('nerve_session'))
  if (cookie === undefined)
    throw new Error('浏览器里没有会话 Cookie')
  return cookie
}

/** 在修改密码页填好表单并提交，返回这次请求的响应 */
async function submitPasswordChange(page: Page, current: string, next: string) {
  await page.getByLabel('当前密码').fill(current)
  await page.getByLabel('新密码', { exact: true }).fill(next)
  await page.getByLabel('再输入一次新密码').fill(next)
  const response = page.waitForResponse(candidate => new URL(candidate.url()).pathname === '/api/auth/password' && candidate.request().method() === 'PUT')
  await page.getByRole('button', { name: '修改密码' }).click()
  return response
}

test.describe('US-M2-02 修改密码', () => {
  test('改完之后另一台设备被要求重新登录，这里保持登录；新密码能登录，旧密码不能', async ({ page, anotherDevice }) => {
    const user = await createUser('pw-change', '改密码的人')
    await loginThroughApi(anotherDevice, user)
    await anotherDevice.goto('/')
    await expect(anotherDevice.getByRole('heading', { name: '我的空间' })).toBeVisible()

    await loginThroughApi(page, user)
    await page.goto('/')
    await page.getByRole('link', { name: '修改密码' }).click()
    await expect(page).toHaveURL(/\/settings\/password$/)
    await page.getByLabel('当前密码').fill(user.password)
    await page.getByLabel('新密码', { exact: true }).fill(NEW_PASSWORD)
    await page.getByLabel('再输入一次新密码').fill(NEW_PASSWORD)
    await page.getByRole('button', { name: '修改密码' }).click()
    await expect(page.getByText('密码已修改。你在其他设备上的登录已经退出。')).toBeVisible()

    await page.goto('/')
    await expect(page.getByRole('heading', { name: '我的空间' })).toBeVisible()

    await anotherDevice.reload()
    await expect(anotherDevice).toHaveURL(/\/login/)
    await expect(anotherDevice.getByText('登录已过期，请重新登录')).toBeVisible()
    await loginThroughUi(anotherDevice, user)
    await expect(anotherDevice.getByRole('alert')).toHaveText('用户名或密码错误')
    await loginThroughUi(anotherDevice, { username: user.username, password: NEW_PASSWORD })
    await expect(anotherDevice.getByRole('heading', { name: '我的空间' })).toBeVisible()
  })

  test('改完之后当前的会话令牌也换掉（M2-P6 复核 B1）：旧的令牌不再有效，当前页面换上新的会话照常可用', async ({ page, request }) => {
    const user = await createUser('pw-rotate', '换令牌的人')
    await loginThroughApi(page, user)
    const before = await sessionCookieOf(page)
    await page.goto('/settings/password')
    expect((await submitPasswordChange(page, user.password, NEW_PASSWORD)).status()).toBe(200)
    await expect(page.getByText('密码已修改。你在其他设备上的登录已经退出。')).toBeVisible()

    // 浏览器里换成了新的会话令牌；拿着旧令牌的请求（例如被拷走的 Cookie）从此是"登录已过期"
    const after = await sessionCookieOf(page)
    expect(after.value).not.toBe(before.value)
    const stale = await request.get('/api/auth/session', { headers: { cookie: `${before.name}=${before.value}` } })
    expect(stale.status()).toBe(401)
    expect((await stale.json() as { error: { code: string } }).error.code).toBe('SESSION_EXPIRED')

    // 当前页面照常可用：同一个页面里再改一次密码，新的 Cookie 与新的 CSRF 令牌都得生效
    expect((await submitPasswordChange(page, NEW_PASSWORD, 'yet another new password')).status()).toBe(200)
    await expect(page.getByLabel('当前密码')).toHaveValue('')
    await page.goto('/')
    await expect(page.getByRole('heading', { name: '我的空间' })).toBeVisible()
  })

  test('当前密码不对：提示，密码不变', async ({ page }) => {
    const user = await createUser('pw-wrong')
    await loginThroughApi(page, user)
    await page.goto('/settings/password')
    await page.getByLabel('当前密码').fill('not my password')
    await page.getByLabel('新密码', { exact: true }).fill(NEW_PASSWORD)
    await page.getByLabel('再输入一次新密码').fill(NEW_PASSWORD)
    await page.getByRole('button', { name: '修改密码' }).click()
    await expect(page.getByRole('alert')).toHaveText('当前密码不正确')
    const login = await page.request.post('/api/auth/login', { data: { username: user.username, password: user.password }, headers: { origin: new URL(page.url()).origin } })
    expect(login.status()).toBe(200)
  })
})
