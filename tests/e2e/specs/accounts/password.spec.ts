// 修改密码（M2-P1，US-M2-02）：改完之后其他地方的登录被退出、这里保持登录；旧密码不对时的提示；
// 当前页面的会话令牌也换掉，旧的令牌不再有效（M2-P6 复核 B1）；换令牌之前发出、之后才到的请求不删掉新 Cookie，
// 别的设备上的旧 Cookie 照常清除（复验 N3，M2-P6 复验 一般-3）；与退出同时发生时退出照样生效（M2-P6 复验 一般-4）。
import type { Cookie, Page, Route } from '@playwright/test'
import { DOCUMENT_LIST_DEFAULT_LIMIT } from '@nerve-office/contracts'
import { createDocuments, createUser } from '../../support/database.ts'
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

/** 这个浏览器上下文里还有没有会话 Cookie（清除之后就没有了） */
async function hasSessionCookie(page: Page): Promise<boolean> {
  return (await page.context().cookies()).some(entry => entry.name.endsWith('nerve_session'))
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

/** 同一个浏览器的另一个标签页（共用 Cookie）里修改密码，等到成功的提示：浏览器里的会话 Cookie 随之换成新的 */
async function changePasswordInAnotherTab(page: Page, current: string, next: string): Promise<Page> {
  const other = await page.context().newPage()
  await other.goto('/settings/password')
  expect((await submitPasswordChange(other, current, next)).status()).toBe(200)
  await expect(other.getByText('密码已修改。你在其他设备上的登录已经退出。')).toBeVisible()
  return other
}

/**
 * 扣住这个页面发出的第一个符合条件的请求，之后的照常放行。route 在请求被扣住时兑现：由用例决定何时放行、带着哪个 Cookie——
 * 用来构造"换令牌之前发出、之后才到服务端"的请求。包一层对象：直接返回 Promise 会被 async 函数展开，要等到请求发出才兑现
 */
async function holdFirstRequest(page: Page, matches: (url: URL) => boolean): Promise<{ readonly route: Promise<Route> }> {
  let capture: (route: Route) => void = () => {}
  const route = new Promise<Route>((resolve) => {
    capture = resolve
  })
  let held = false
  await page.route(matches, async (candidate) => {
    if (held)
      return candidate.continue()
    held = true
    capture(candidate)
  })
  return { route }
}

/** 文档列表的下一页（"加载更多"：带游标） */
function isNextDocumentsPage(url: URL): boolean {
  return url.pathname === '/api/documents' && url.searchParams.has('cursor')
}

/** 这个页面发出的退出请求（到达服务端之前就记下，扣住的也算） */
function recordLogouts(page: Page): string[] {
  const logouts: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/auth/logout')
      logouts.push(`${request.method()} ${request.url()}`)
  })
  return logouts
}

/** 带着换令牌之前的旧 Cookie 把扣住的请求发到服务端（其余请求头照旧），返回服务端的响应，交给页面 */
async function releaseWithOldCookie(route: Route, old: Cookie) {
  const headers = await route.request().allHeaders()
  const response = await route.fetch({ headers: { ...headers, cookie: `${old.name}=${old.value}` } })
  await route.fulfill({ response })
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
    // 另一台设备上的旧 Cookie 随之清除（M2-P6 复验 一般-3）：它不会有新的 Cookie，留着只会每次打开都提示"登录已过期"
    expect(await hasSessionCookie(anotherDevice)).toBe(false)
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

  test('同一个浏览器的另一个标签页修改了密码，本页换令牌之前发出的"加载更多"晚到：不删掉新 Cookie，本页不离开、提示这次没有完成，再点一次照常（复验 N3）', async ({ page }) => {
    const user = await createUser('pw-late', '晚到的请求')
    await createDocuments(user, '文档', DOCUMENT_LIST_DEFAULT_LIMIT + 5)
    await loginThroughApi(page, user)
    const before = await sessionCookieOf(page)
    await page.goto('/?view=list')
    const items = page.getByRole('list', { name: '文档列表' }).getByRole('listitem')
    await expect(items).toHaveCount(DOCUMENT_LIST_DEFAULT_LIMIT)

    // 本页的"加载更多"先扣住：它是修改密码之前发出的
    const held = await holdFirstRequest(page, isNextDocumentsPage)
    await page.getByRole('button', { name: '加载更多' }).click()
    const route = await held.route

    const other = await changePasswordInAnotherTab(page, user.password, NEW_PASSWORD)
    const after = await sessionCookieOf(page)
    expect(after.value).not.toBe(before.value)

    // 放行扣住的请求：它带着旧 Cookie 到达服务端，晚于修改密码的响应回到浏览器。服务端回"登录已过期"，不清除 Cookie
    const late = await releaseWithOldCookie(route, before)
    expect(late.status()).toBe(401)
    expect(late.headersArray().filter(header => header.name.toLowerCase() === 'set-cookie')).toEqual([])

    // 本页确认之后还是同一个人：不离开，列表下面说明这次没有完成；浏览器里的新 Cookie 还在
    await expect(page.getByRole('alert')).toHaveText('登录状态刚刚变化，这次操作没有完成，请重试')
    await expect(page).toHaveURL(/\/\?view=list$/)
    expect((await sessionCookieOf(page)).value).toBe(after.value)

    // 再点一次：带着新 Cookie，照常加载
    await page.getByRole('button', { name: '加载更多' }).click()
    await expect(items).toHaveCount(DOCUMENT_LIST_DEFAULT_LIMIT + 5)
    await expect(page).toHaveURL(/\/\?view=list$/)
    // 另一个标签页也还登录着
    await other.goto('/')
    await expect(other.getByRole('heading', { name: '我的空间' })).toBeVisible()
  })

  test('同一个浏览器里退出与修改密码同时发生、退出晚于换令牌处理：先确认会话，带着新的令牌再退出一次，停在登录页，浏览器里不再有登录（M2-P6 复验 一般-4）', async ({ page }) => {
    const user = await createUser('pw-logout-race', '同时退出的人')
    await loginThroughApi(page, user)
    const before = await sessionCookieOf(page)
    await page.goto('/')
    await expect(page.getByRole('heading', { name: '我的空间' })).toBeVisible()
    const logouts = recordLogouts(page)

    // 本页的退出先扣住：它是修改密码之前发出的
    const held = await holdFirstRequest(page, url => url.pathname === '/api/auth/logout')
    await page.getByRole('button', { name: '退出' }).click()
    const route = await held.route

    const other = await changePasswordInAnotherTab(page, user.password, NEW_PASSWORD)
    expect((await sessionCookieOf(page)).value).not.toBe(before.value)

    // 放行扣住的退出：它带着旧 Cookie、晚于修改密码处理。服务端回"登录已过期"、不清除 Cookie，新会话仍然有效
    const late = await releaseWithOldCookie(route, before)
    expect(late.status()).toBe(401)
    expect((await late.json() as { error: { code: string } }).error.code).toBe('SESSION_EXPIRED')

    // 本页先确认：还是同一个人，带着新的令牌再退出一次，然后回到登录页，停在那里（不被登录页送回应用）
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByRole('form', { name: '登录' })).toBeVisible()
    expect(logouts).toHaveLength(2)
    expect(await hasSessionCookie(page)).toBe(false)
    expect((await page.request.get('/api/auth/session')).status()).toBe(401)
    // 同一个浏览器的另一个标签页随之也退出了
    await other.reload()
    await expect(other).toHaveURL(/\/login/)
    await expect(page).toHaveURL(/\/login$/)
  })

  test('修改密码的回包丢了（代理的 502），服务端其实已经改好：随即回到登录页，说明新密码可能已经生效；先用旧密码试，说明留着、错误另起一条（DEF-048）；新密码登录得进去（M2-P6 复核第五批 G2）', async ({ page }) => {
    const user = await createUser('pw-unknown', '回包丢了的人')
    await loginThroughApi(page, user)
    await page.goto('/settings/password')
    const before = await sessionCookieOf(page)
    await page.route('**/api/auth/password', async (route) => {
      // 请求放行到服务端：照常改好（当前会话随之撤销、换发新的会话）。回包换成代理的 502，新会话的 Cookie 随之丢了：
      // 浏览器里留着的还是原来那个（route.fetch 的响应写进上下文的 Cookie 要还原，才与真实的代理一样）
      await route.fetch()
      await page.context().addCookies([before])
      return route.fulfill({ status: 502, contentType: 'text/html', body: 'bad gateway' })
    })
    await page.getByLabel('当前密码').fill(user.password)
    await page.getByLabel('新密码', { exact: true }).fill(NEW_PASSWORD)
    await page.getByLabel('再输入一次新密码').fill(NEW_PASSWORD)
    await page.getByRole('button', { name: '修改密码' }).click()
    // 不等再提交、不等换页（原来一换页就只说"登录已过期"）：随即带着"新密码可能已经生效"回到登录页
    await expect(page).toHaveURL(/\/login\?from=%2Fsettings%2Fpassword&reason=password_changed$/)
    const notice = page.getByText('刚才修改密码时没能确认结果，随后登录失效了：新密码可能已经生效，请试试用新密码登录。')
    await expect(notice).toBeVisible()
    await expect(page.getByText('登录已过期，请重新登录')).toBeHidden()
    await page.unroute('**/api/auth/password')
    // 习惯性地先用旧密码：被拒，失败之后最用得着的那句说明不被错误的说明换掉（DEF-048）
    await loginThroughUi(page, user)
    await expect(page.getByRole('alert')).toHaveText('用户名或密码错误')
    await expect(notice).toBeVisible()
    // 新密码确实已经生效：登录之后回到修改密码页
    await loginThroughUi(page, { username: user.username, password: NEW_PASSWORD })
    await expect(page).toHaveURL(/\/settings\/password$/)
    await expect(page.getByLabel('当前密码')).toBeVisible()
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
