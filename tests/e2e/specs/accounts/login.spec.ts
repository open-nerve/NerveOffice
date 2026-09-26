// 账户（P3，US-M1-01、US-M1-02）：命令行初始化的管理员登录；登录、错误提示、限流、退出、会话过期。
import { expect, test } from '@playwright/test'
import { createDocument, createUser, expireSessions } from '../../support/database.ts'
import { E2E_ADMIN } from '../../support/environment.ts'
import { loginThroughApi, loginThroughUi } from '../../support/session.ts'

test('US-M1-01 用命令行初始化的管理员登录，进入个人空间', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/login$/)
  await loginThroughUi(page, E2E_ADMIN)
  await expect(page.getByRole('heading', { name: '我的空间' })).toBeVisible()
  await expect(page.getByText(E2E_ADMIN.displayName)).toBeVisible()
})

test.describe('US-M1-02 登录与退出', () => {
  test('用户名和密码正确：进入个人空间', async ({ page }) => {
    const user = await createUser('login-ok', '登录成功的人')
    await page.goto('/login')
    await loginThroughUi(page, user)
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByRole('heading', { name: '我的空间' })).toBeVisible()
    await expect(page.getByText('登录成功的人')).toBeVisible()
  })

  test('密码错误与用户不存在：同一句提示，不区分', async ({ page }) => {
    const user = await createUser('login-bad')
    await page.goto('/login')
    await loginThroughUi(page, { username: user.username, password: 'wrong password' })
    await expect(page.getByRole('alert')).toHaveText('用户名或密码错误')
    await loginThroughUi(page, { username: `${user.username}-nobody`, password: 'wrong password' })
    await expect(page.getByRole('alert')).toHaveText('用户名或密码错误')
    await expect(page).toHaveURL(/\/login$/)
  })

  test('连续失败触发限流：提示多久之后再试', async ({ page }) => {
    const user = await createUser('login-lock')
    await page.goto('/login')
    for (let attempt = 1; attempt < 5; attempt++) {
      await loginThroughUi(page, { username: user.username, password: `wrong ${attempt}` })
      await expect(page.getByRole('alert')).toHaveText('用户名或密码错误')
    }
    // 第 5 次失败触发锁定；之后正确的密码也被拒绝
    await loginThroughUi(page, { username: user.username, password: 'wrong 5' })
    await expect(page.getByRole('alert')).toHaveText('尝试次数过多，请 15 分钟后再试')
    await loginThroughUi(page, user)
    await expect(page.getByRole('alert')).toHaveText(/尝试次数过多/)
  })

  test('退出后会话失效：回到登录页，按后退键也看不到内容', async ({ page }) => {
    const user = await createUser('logout')
    await createDocument(user, '退出前能看到的文档')
    await loginThroughApi(page, user)
    await page.goto('/')
    await expect(page.getByText('退出前能看到的文档')).toBeVisible()
    // 再开一个历史记录，后退时回到上面那个页面
    await page.goto('/?view=list')
    await expect(page.getByText('退出前能看到的文档')).toBeVisible()

    await page.getByRole('button', { name: '退出' }).click()
    await expect(page).toHaveURL(/\/login$/)
    await page.goBack()
    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByText('退出前能看到的文档')).toBeHidden()
    const response = await page.request.get('/api/documents')
    expect(response.status()).toBe(401)
  })

  test('会话过期后：被引导到登录页，并提示登录已过期；重新登录后回到原来的页面', async ({ page }) => {
    const user = await createUser('expired')
    await loginThroughApi(page, user)
    await page.goto('/')
    await expect(page.getByRole('heading', { name: '我的空间' })).toBeVisible()

    await expireSessions(user)
    await page.goto('/?view=list')
    await expect(page).toHaveURL(/\/login\?from=%2F%3Fview%3Dlist&reason=expired$/)
    await expect(page.getByText('登录已过期，请重新登录')).toBeVisible()
    await loginThroughUi(page, user)
    await expect(page).toHaveURL(/\/\?view=list$/)
    await expect(page.getByRole('heading', { name: '我的空间' })).toBeVisible()
  })
})
