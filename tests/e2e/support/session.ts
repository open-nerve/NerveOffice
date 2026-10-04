// 登录的辅助：界面登录（验证登录本身时用），或者直接调接口（其他用例的前置步骤，快而稳定）。
import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { e2eOrigin } from './environment.ts'

export interface Credentials {
  readonly username: string
  readonly password: string
}

export async function loginThroughUi(page: Page, credentials: Credentials): Promise<void> {
  await page.getByLabel('用户名').fill(credentials.username)
  await page.getByLabel('密码').fill(credentials.password)
  await page.getByRole('button', { name: '登录' }).click()
}

/** 调登录接口，会话 Cookie 存进这个页面的浏览器上下文。状态变更的请求要带与公开地址相同的 Origin（与 baseURL 同一个源） */
export async function loginThroughApi(page: Page, credentials: Credentials): Promise<void> {
  const response = await page.request.post('/api/auth/login', {
    data: { username: credentials.username, password: credentials.password },
    headers: { origin: e2eOrigin() },
  })
  expect(response.status(), await response.text()).toBe(200)
}

/**
 * 另一个人在他自己的浏览器里经接口做的操作（取消分享、降级、移出空间、移动、停用）：状态变更的请求带上与公开地址相同的 Origin 与他的 CSRF 令牌。
 * 请求必须成功，否则后面的"被拒绝"什么也说明不了。他的界面由各自的用户故事的用例覆盖
 */
export async function actAs(page: Page, method: 'PUT' | 'POST' | 'DELETE', path: string, data?: unknown): Promise<void> {
  const { csrfToken } = await (await page.request.get('/api/auth/session')).json() as { csrfToken: string }
  const response = await page.request.fetch(path, { method, headers: { 'origin': e2eOrigin(), 'x-csrf-token': csrfToken }, ...(data === undefined ? {} : { data }) })
  expect(response.ok(), `${method} ${path}：${response.status()} ${await response.text()}`).toBe(true)
}
