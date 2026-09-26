// 账户（P3，US-M1-01、US-M1-02）：命令行初始化的管理员登录；登录、错误提示、限流、退出、会话过期、断网、多个标签页。
import type { Page } from '@playwright/test'
import { DOCUMENT_LIST_DEFAULT_LIMIT } from '@nerve-office/contracts'
import { createDocument, createDocuments, createUser, expireSessions } from '../../support/database.ts'
import { E2E_ADMIN } from '../../support/environment.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi, loginThroughUi } from '../../support/session.ts'

/** 页面发出的接口请求（方法与路径，含查询） */
function recordApiRequests(page: Page): string[] {
  const requests: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/'))
      requests.push(`${request.method()} ${url.pathname}${url.search}`)
  })
  return requests
}

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

  test('用键盘提交且登录失败：焦点留在登录按钮上，不丢到页面上（审查 B13）', async ({ page }) => {
    const user = await createUser('login-keyboard')
    await page.goto('/login')
    await page.getByLabel('用户名').fill(user.username)
    await page.getByLabel('密码').fill('wrong password')
    const submit = page.getByRole('button', { name: '登录' })
    await submit.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('alert')).toHaveText('用户名或密码错误')
    await expect(submit).toBeFocused()
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

  test('登录后回到的地址带控制字符（/<制表符>/evil.example，浏览器会解析成另一个站点）：不回去，进入首页（审查 B5）', async ({ page }) => {
    const user = await createUser('login-from')
    await page.goto('/login?from=%2F%09%2Fevil.example')
    await loginThroughUi(page, user)
    await expect(page.getByRole('heading', { name: '我的空间' })).toBeVisible()
    expect(new URL(page.url()).pathname).toBe('/')
  })

  test('已登录时打开登录页：确认会话期间不显示登录表单，随后回到首页（审查 B14）', async ({ page }) => {
    await loginThroughApi(page, await createUser('login-page-signed-in'))
    let release: () => void = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route('**/api/auth/session', async (route) => {
      await released
      await route.continue()
    })
    await page.goto('/login')
    await expect(page.getByRole('status', { name: '正在确认登录状态…' })).toBeVisible()
    await expect(page.getByRole('form', { name: '登录' })).toBeHidden()
    release()
    await expect(page.getByRole('heading', { name: '我的空间' })).toBeVisible()
    expect(new URL(page.url()).pathname).toBe('/')
  })

  // Playwright 启动 Chromium 时关掉了往返缓存（bfcache），三个浏览器在这里后退时都是重新加载，
  // 从往返缓存恢复时整页重新加载的逻辑走不到，由单元测试覆盖（apps/web/src/shared/lib/back-forward-cache.test.ts，审查 B16）
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

  test('刷新时发现会话过期：被引导到登录页，并提示登录已过期；重新登录后回到原来的页面', async ({ page }) => {
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

  test('页面打开期间会话过期：加载更多时回到登录页并提示过期，不多发请求；重新登录后回到原来的页面（审查 B7、B11）', async ({ page }) => {
    const user = await createUser('expired-open')
    await createDocuments(user, '过期前的文档', DOCUMENT_LIST_DEFAULT_LIMIT + 5)
    await loginThroughApi(page, user)
    await page.goto('/?view=list')
    await expect(page.getByRole('list', { name: '文档列表' }).getByRole('listitem')).toHaveCount(DOCUMENT_LIST_DEFAULT_LIMIT)

    const requests = recordApiRequests(page)
    await expireSessions(user)
    await page.getByRole('button', { name: '加载更多' }).click()
    await expect(page).toHaveURL(/\/login\?from=%2F%3Fview%3Dlist&reason=expired$/)
    await expect(page.getByText('登录已过期，请重新登录')).toBeVisible()
    // 只有下一页（401）与登录页确认会话各一次：没有在旧页面上重新请求列表
    expect(requests).toEqual([expect.stringMatching(/^GET \/api\/documents\?cursor=/), 'GET /api/auth/session'])

    await loginThroughUi(page, user)
    await expect(page).toHaveURL(/\/\?view=list$/)
    await expect(page.getByRole('list', { name: '文档列表' }).getByRole('listitem')).toHaveCount(DOCUMENT_LIST_DEFAULT_LIMIT)
  })
})

test.describe('US-M1-02 断网（审查 B4）', () => {
  test('断网时登录：提示网络错误；恢复后再点登录即可进入', async ({ page, context }) => {
    const user = await createUser('offline-login')
    await page.goto('/login')
    await expect(page.getByRole('form', { name: '登录' })).toBeVisible()
    await context.setOffline(true)
    await loginThroughUi(page, user)
    await expect(page.getByRole('alert')).toHaveText('网络连接失败，请检查网络后重试')
    await expect(page.getByRole('button', { name: '登录' })).toBeVisible()
    await context.setOffline(false)
    await page.getByRole('button', { name: '登录' }).click()
    await expect(page.getByRole('heading', { name: '我的空间' })).toBeVisible()
  })

  test('断网时退出：提示网络错误，不会一直停在"正在退出"；恢复后再点退出即可退出，会话随之失效', async ({ page, context }) => {
    await loginThroughApi(page, await createUser('offline-logout'))
    await page.goto('/')
    await expect(page.getByRole('heading', { name: '我的空间' })).toBeVisible()
    await context.setOffline(true)
    await page.getByRole('button', { name: '退出' }).click()
    await expect(page.getByRole('alert')).toHaveText('退出失败：网络连接失败，请检查网络后重试')
    await expect(page.getByRole('button', { name: '退出' })).toBeVisible()
    await context.setOffline(false)
    await page.getByRole('button', { name: '退出' }).click()
    await expect(page).toHaveURL(/\/login$/)
    expect((await page.request.get('/api/documents')).status()).toBe(401)
  })
})

test.describe('US-M1-02 多个标签页（审查 B6）', () => {
  test('一个标签页退出并换人登录：另一个标签页随之回到登录页，再随之进入新登录的人的空间，退出照常', async ({ context }) => {
    const first = await createUser('tabs-first', '先登录的人')
    const second = await createUser('tabs-second', '后登录的人')
    await createDocument(first, '先登录的人的文档')
    await createDocument(second, '后登录的人的文档')
    const tabA = await context.newPage()
    const tabB = await context.newPage()
    await loginThroughApi(tabA, first)
    await tabA.goto('/')
    await tabB.goto('/')
    await expect(tabB.getByText('先登录的人的文档')).toBeVisible()

    await tabA.getByRole('button', { name: '退出' }).click()
    await expect(tabA).toHaveURL(/\/login$/)
    await expect(tabB).toHaveURL(/\/login$/)
    await expect(tabB.getByText('先登录的人的文档')).toBeHidden()

    await loginThroughUi(tabA, second)
    await expect(tabA.getByText('后登录的人的文档')).toBeVisible()
    await expect(tabB.getByText('后登录的人的文档')).toBeVisible()
    await expect(tabB.getByText('后登录的人', { exact: true })).toBeVisible()

    await tabB.getByRole('button', { name: '退出' }).click()
    await expect(tabB).toHaveURL(/\/login$/)
    await expect(tabA).toHaveURL(/\/login$/)
  })

  test('会话在别处被换掉而本页没有收到消息：退出得到"页面已失效"，随后本页重新加载，显示现在登录的人', async ({ context }) => {
    const first = await createUser('stale-first', '原来的人')
    const second = await createUser('stale-second', '现在的人')
    await createDocument(first, '原来的人的文档')
    await createDocument(second, '现在的人的文档')
    const page = await context.newPage()
    await loginThroughApi(page, first)
    await page.goto('/')
    await expect(page.getByText('原来的人的文档')).toBeVisible()

    // 直接调登录接口换人：Cookie 变了，但没有标签页发出消息（例如消息没有送达）
    await loginThroughApi(page, second)
    // 页面随后向服务端确认会话：先挂起这个请求，看清失败的提示，再放行
    let release: () => void = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route('**/api/auth/session', async (route) => {
      await released
      await route.continue()
    })
    await page.getByRole('button', { name: '退出' }).click()
    await expect(page.getByRole('alert')).toHaveText('退出失败：页面已失效，请刷新后重试')
    release()
    await expect(page.getByText('现在的人的文档')).toBeVisible()
    await expect(page.getByText('原来的人的文档')).toBeHidden()
    await page.getByRole('button', { name: '退出' }).click()
    await expect(page).toHaveURL(/\/login$/)
  })
})
