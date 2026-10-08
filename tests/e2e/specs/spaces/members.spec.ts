// 成员与空间角色（M2-P2，US-M2-06）：空间管理员在成员页按名字搜索同事并添加、调整角色、移出；
// 被移出的人已打开的页面里，再进这个空间就看不到它（不显示缓存里的旧内容），导航里它随之消失。
// 要移出的人已经被别人移出时，确认框关掉、焦点交还之后才在表格上方说明，写进去的那一刻读屏读得到（M2-P5 复验 S1，support/status-writes.ts）。
// 表格上方的状态区变高时（写进说明），排在它下面、有焦点的选择框按最小距离滚回可视区域；变矮时（"成员列表还在刷新"一句消失）不滚，
// 用户滚走了也不拉回去（共用 StatusRegion 的 keepFocusInView，M3-P6 再复核 D1、D2）。
import type { Locator, Page } from '@playwright/test'
import type { TestUser } from '../../support/database.ts'
import { randomBytes } from 'node:crypto'
import { createTeamSpace, createUser, removeMember } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { plainName, shownName } from '../../support/people.ts'
import { loginThroughApi } from '../../support/session.ts'
import { expectWrittenAfterClose, recordStatusWrites } from '../../support/status-writes.ts'

/** 等写操作成功之后的刷新到了时限（10 秒，OUTCOME_REFRESH_TIME_LIMIT_MS）、确认框照常关掉：留出慢机器上的余量 */
const REFRESH_TIME_LIMIT_WAIT_MS = 30_000

/** 长成员表的两条用例：建二十几位同事、真等一次刷新的时限 */
const LONG_LIST_TEST_TIMEOUT = 90_000

function spaceNav(page: Page) {
  return page.getByRole('navigation', { name: '空间' })
}

test.describe('US-M2-06 管理成员与空间角色', () => {
  test('空间管理员添加同事、调整角色、移出；对方随即按新的角色看到这个空间，移出之后已打开的页面里再进来就看不到', async ({ page, anotherDevice }) => {
    const admin = await createUser('mb-admin', '管理员', { systemRole: 'admin' })
    const lead = await createUser('mb-lead', '空间管理员')
    const colleague = await createUser('mb-colleague', '新成员')
    const space = await createTeamSpace('项目组', admin, [[lead, 'admin']])
    await loginThroughApi(page, lead)
    await page.goto(`/spaces/${space.id}`)
    await page.getByRole('link', { name: '成员', exact: true }).click()
    await expect(page.getByRole('heading', { name: `${space.name} 的成员` })).toBeVisible()

    // 添加：按名字搜索（这里用登录名：它全库唯一），选角色
    await page.getByLabel('要添加的同事').fill(colleague.username)
    await page.getByRole('list', { name: '找到的同事' }).getByRole('button', { name: shownName(colleague), exact: true }).click()
    await page.getByLabel('角色', { exact: true }).selectOption({ label: '编辑者' })
    await page.getByRole('button', { name: '添加成员', exact: true }).click()
    const role = page.getByRole('combobox', { name: `${plainName(colleague)} 的角色` })
    await expect(role).toHaveValue('editor')

    await loginThroughApi(anotherDevice, colleague)
    await anotherDevice.goto('/')
    await spaceNav(anotherDevice).getByRole('link', { name: space.name }).click()
    await expect(anotherDevice.getByText('我的角色：编辑者')).toBeVisible()
    await expect(anotherDevice.getByRole('button', { name: '新建表格', exact: true })).toBeVisible()

    // 调整为查看者：选好之后点"保存"才提交（M2-P6 复核的疑点：收起的选择框上按方向键会逐个改值），对方重新打开就只能查看
    await role.selectOption({ label: '查看者' })
    await page.getByRole('button', { name: `保存 ${plainName(colleague)} 的角色`, exact: true }).click()
    await expect(role).toHaveValue('viewer')
    await expect(page.getByRole('row').filter({ hasText: shownName(colleague) })).toHaveAttribute('aria-busy', 'false')
    await anotherDevice.reload()
    await expect(anotherDevice.getByText('我的角色：查看者')).toBeVisible()
    await expect(anotherDevice.getByRole('button', { name: '新建表格', exact: true })).toHaveCount(0)

    // 移出：先确认
    await page.getByRole('button', { name: `移出 ${plainName(colleague)}`, exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '移出', exact: true }).click()
    await expect(page.getByRole('combobox', { name: `${plainName(colleague)} 的角色` })).toHaveCount(0)

    // 对方已打开的页面（单页，不整页加载）：先到我的空间，再点导航里这个空间（缓存里还有它的页头与文档）。
    // 重新请求得到 404：说明看不到，不显示旧的内容；导航随之刷新，这个空间的链接消失（审查 B1）
    const nav = spaceNav(anotherDevice)
    await nav.getByRole('link', { name: '我的空间', exact: true }).click()
    await expect(anotherDevice.getByRole('heading', { name: '我的空间', exact: true })).toBeVisible()
    await nav.getByRole('link', { name: space.name }).click()
    await expect(anotherDevice.getByText('空间不存在，或者你没有访问权限')).toBeVisible()
    await expect(anotherDevice.getByText('我的角色：查看者')).toHaveCount(0)
    await expect(nav.getByRole('link', { name: space.name })).toHaveCount(0)
  })

  test('选人：显示名写成"李四（登录名）"冒充别人的，与真正的李四分得清——登录名在单独的元素里、等宽、与显示名同样醒目；选中与成员表里一样（M2-P6 复核 M2，第三批 S-d）', async ({ page }) => {
    const admin = await createUser('mb-pick-admin', '管理员', { systemRole: 'admin' })
    const lead = await createUser('mb-pick-lead', '空间管理员')
    const tag = randomBytes(3).toString('hex')
    const real = await createUser(`lisi${tag}`, `李四${tag}`)
    const spoof = await createUser(`mallory${tag}`, `李四${tag}（${real.username}）`)
    const space = await createTeamSpace('选人', admin, [[lead, 'admin']])
    await loginThroughApi(page, lead)
    await page.goto(`/spaces/${space.id}/members`)
    await page.getByLabel('要添加的同事').fill(`李四${tag}`)
    const candidates = page.getByRole('list', { name: '找到的同事' })
    await expect(candidates.getByRole('button')).toHaveCount(2)
    const realButton = candidates.getByRole('button', { name: shownName(real), exact: true })
    const spoofButton = candidates.getByRole('button', { name: shownName(spoof), exact: true })
    // 每个候选里：显示名在 <bdi> 里（冒充者显示名里的"（登录名）"只是显示名的一部分），登录名在另一个元素里
    await expect(realButton.locator('bdi')).toHaveText(real.displayName)
    await expect(realButton.locator('[data-slot="person-username"]')).toHaveText(`@${real.username}`)
    await expect(spoofButton.locator('bdi')).toHaveText(spoof.displayName)
    await expect(spoofButton.locator('[data-slot="person-username"]')).toHaveText(`@${spoof.username}`)
    // 登录名用等宽字体与显示名区分；与显示名同样醒目——颜色、字号、粗细都相同（需求方 2026-10-02 的决定，M2-P6 复核第三批 S-d：
    // 原来登录名灰色、小一号，冒充者那一行里最醒目的反倒是可以伪造的显示名）
    const styles = await spoofButton.locator('[data-slot="person-username"]').evaluate((username) => {
      const name = username.parentElement?.querySelector('bdi')
      const own = getComputedStyle(username)
      const shown = name === null || name === undefined ? undefined : getComputedStyle(name)
      return {
        login: { font: own.fontFamily, color: own.color, size: own.fontSize, weight: own.fontWeight },
        name: { font: shown?.fontFamily, color: shown?.color, size: shown?.fontSize, weight: shown?.fontWeight },
      }
    })
    expect(styles.login.font).toMatch(/mono/i)
    expect(styles.login.font).not.toBe(styles.name.font)
    expect(styles.login.color).toBe(styles.name.color)
    expect(styles.login.size).toBe(styles.name.size)
    expect(styles.login.weight).toBe(styles.name.weight)

    // 选中冒充者：已选的标签里同样分得清；添加之后成员表里也一样
    await spoofButton.click()
    await expect(page.getByText(`已选择：${shownName(spoof)}`)).toBeVisible()
    await page.getByRole('button', { name: '添加成员', exact: true }).click()
    const table = page.getByRole('table', { name: '成员列表' })
    const row = table.getByRole('row').filter({ hasText: `@${spoof.username}` })
    await expect(row).toHaveCount(1)
    await expect(row.locator('bdi')).toHaveText(spoof.displayName)
    await expect(row.locator('[data-slot="person-username"]')).toHaveText(`@${spoof.username}`)
    await expect(table.getByRole('row').filter({ hasText: `@${real.username}` })).toHaveCount(0)
  })

  test('选人：显示名写成"李四 @登录名"冒充别人的，候选的可读名称与确认框的标题都是登录名在前，从开头就分得清（M2-P6 复核第二批 M-1）', async ({ page }) => {
    const admin = await createUser('mb-at-admin', '管理员', { systemRole: 'admin' })
    const lead = await createUser('mb-at-lead', '空间管理员')
    const tag = randomBytes(3).toString('hex')
    const real = await createUser(`lisi${tag}`, `李四${tag}`)
    const spoof = await createUser(`eve${tag}`, `李四${tag} @${real.username}`)
    const space = await createTeamSpace('冒充', admin, [[lead, 'admin']])
    await loginThroughApi(page, lead)
    await page.goto(`/spaces/${space.id}/members`)
    await page.getByLabel('要添加的同事').fill(real.username)
    const candidates = page.getByRole('list', { name: '找到的同事' })
    await expect(candidates.getByRole('button')).toHaveCount(2)
    // 读屏读出的候选：登录名在前。原来显示名在前时两个候选的开头相同（"李四… @lisi…"与"李四… @lisi… @eve…"）
    const names = (await candidates.getByRole('button').allTextContents()).toSorted()
    expect(names).toEqual([shownName(spoof), shownName(real)].toSorted())
    expect(names.filter(name => name.startsWith(`@${real.username} `))).toEqual([shownName(real)])
    await expect(candidates.getByRole('button', { name: shownName(spoof), exact: true })).toHaveAccessibleName(new RegExp(`^@${spoof.username} `))

    // 把冒充者加进来，再打开移出的确认框：标题同样登录名在前
    await candidates.getByRole('button', { name: shownName(spoof), exact: true }).click()
    await page.getByRole('button', { name: '添加成员', exact: true }).click()
    await page.getByRole('button', { name: `移出 ${plainName(spoof)}`, exact: true }).click()
    await expect(page.getByRole('dialog', { name: `把 ${plainName(spoof)} 移出这个空间？` })).toBeVisible()
    expect(plainName(spoof).startsWith(`@${spoof.username} `)).toBe(true)
  })

  test('要移出的人已经被别人移出：确认框关掉之后才在表格上方说明（写进去的那一刻读屏读得到），那一行随之消失（M2-P5 复验 S1）', async ({ page }) => {
    const admin = await createUser('mb-gone-admin', '管理员', { systemRole: 'admin' })
    const lead = await createUser('mb-gone-lead', '空间管理员')
    const member = await createUser('mb-gone-member', '成员')
    const space = await createTeamSpace('已被移出', admin, [[lead, 'admin'], [member, 'viewer']])
    await loginThroughApi(page, lead)
    await page.goto(`/spaces/${space.id}/members`)
    await expect(page.getByRole('combobox', { name: `${plainName(member)} 的角色` })).toBeVisible()
    // 表格上方的状态区一直在（空的时候只做视觉隐藏）：记下它每一次内容变化的那一刻
    await recordStatusWrites(page.locator('[data-slot="status-region"]'))

    // 别人先把他移出了（直接改库），这一页还显示着他
    await removeMember(space.id, member)
    await page.getByRole('button', { name: `移出 ${plainName(member)}`, exact: true }).click()
    const confirm = page.getByRole('dialog', { name: `把 ${plainName(member)} 移出这个空间？` })
    await confirm.getByRole('button', { name: '移出', exact: true }).click()
    await expect(confirm).toHaveCount(0)
    const text = `${shownName(member)} 已经不在成员里了（可能已被别人移出），列表已刷新`
    await expect(page.getByRole('status').filter({ hasText: '已经不在成员里了' })).toHaveText(text)
    // 确认框开着时 Radix 把页面标为 aria-hidden：说明等它关掉、焦点交还之后才写，写进去的那一刻读屏读得到。原来与关掉在同一次渲染里写：
    // 那一刻 aria-hidden 已经撤销，焦点却还在 body 上（交还焦点在后面），读屏能否播报说不准（M2-P5 复验 S1）
    await expectWrittenAfterClose(page, text)
    await expect(page.getByRole('combobox', { name: `${plainName(member)} 的角色` })).toHaveCount(0)
  })

  test('只有空间管理员能管理：编辑者打开成员页只能查看', async ({ page }) => {
    const admin = await createUser('mb-ro-admin', '管理员', { systemRole: 'admin' })
    const lead = await createUser('mb-ro-lead', '空间管理员')
    const editor = await createUser('mb-ro-editor', '编辑者')
    const space = await createTeamSpace('只读成员页', admin, [[lead, 'admin'], [editor, 'editor']])
    await loginThroughApi(page, editor)
    await page.goto(`/spaces/${space.id}/members`)
    await expect(page.getByText('只有空间管理员能添加、调整与移出成员。')).toBeVisible()
    await expect(page.getByRole('table', { name: '成员列表' }).getByText(shownName(lead))).toBeVisible()
    await expect(page.getByLabel('要添加的同事')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^移出 / })).toHaveCount(0)
  })

  test('窄屏：显示名到了上限、登录名最长时，同事选择的候选与已选都在表单之内换行，不撑出页面；可读名称仍是全名（M2-P6 复核第四批）', async ({ page }) => {
    const admin = await createUser('mb-narrow-admin', '管理员', { systemRole: 'admin' })
    const lead = await createUser('mb-narrow-lead', '空间管理员')
    // 登录名 32 个字符（上限：前缀 23 个，加上随机的后缀 9 个）；显示名 64 个字符（上限），后半是一个没有空格的长单词
    const longest = await createUser('n'.repeat(23), `${'很长的显示名'.repeat(5)}Supercalifragilisticexpialidocious`)
    expect(longest.username).toHaveLength(32)
    expect([...longest.displayName]).toHaveLength(64)
    const space = await createTeamSpace('窄屏', admin, [[lead, 'admin']])
    await page.setViewportSize({ width: 320, height: 800 })
    await loginThroughApi(page, lead)
    await page.goto(`/spaces/${space.id}/members`)
    await page.getByLabel('要添加的同事').fill(longest.username)
    const form = page.locator('form').filter({ has: page.getByLabel('要添加的同事') })

    // 候选：按钮的可读名称是全名（登录名在前），换行之后仍在表单之内
    const candidate = page.getByRole('list', { name: '找到的同事' }).getByRole('button', { name: shownName(longest), exact: true })
    await expect(candidate).toBeVisible()
    await expectInside(page, form, candidate, '候选')
    // 选中之后的标签同样
    await candidate.click()
    const chosen = form.getByText('已选择：')
    await expect(chosen).toContainText(shownName(longest))
    await expectInside(page, form, chosen, '已选')
  })

  test('长成员表靠下的地方降低自己、刷新成员列表超过时限：确认框关掉之后焦点交还给自己那一行的选择框（在表格上方的状态区下面），说明写进状态区之后它仍整个在可视区域里（M3-P6 再复核 D2）', async ({ page }) => {
    // 要真等刷新的时限（10 秒），另有二十几位同事要建：放宽这条用例的时限
    test.setTimeout(LONG_LIST_TEST_TIMEOUT)
    const root = await createUser('mbkeep-root', '系统管理员', { systemRole: 'admin' })
    // 自己的显示名排在最后：成员表按显示名排，22 位空间管理员在前
    const self = await createUser('mbkeep-self', 'z自己')
    const others = await people('mbkeep-a', 'a管理员', 22)
    const space = await createTeamSpace('长成员表', root, [[self, 'admin'], ...others.map(user => [user, 'admin'] as const)])
    await loginThroughApi(page, self)
    await page.goto(`/spaces/${space.id}/members`)
    const select = page.getByRole('combobox', { name: `${plainName(self)} 的角色` })
    await select.focus()
    // 前提：用键盘走到的这一行在可视区域底部附近，状态区撑开（加上间距 62 像素）时会被挤出去
    expect(await distanceToBottom(page, select), '自己那一行离可视区域的底边太远，用例的前提不成立').toBeLessThan(62)
    const refresh = await holdMembersRefresh(page, space.id)
    await select.selectOption({ label: '查看者' })
    await page.getByRole('button', { name: `保存 ${plainName(self)} 的角色`, exact: true }).focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: '把你自己的角色改为查看者？' })
    refresh.arm()
    await dialog.getByRole('button', { name: '修改', exact: true }).click()
    await refresh.arrived
    // 真等刷新的时限（10 秒）：装了 Playwright 的时钟时确认框关掉、焦点交还与写进说明的先后跟真实的不一样，量出的位置不可信
    await expect(dialog).toHaveCount(0, { timeout: REFRESH_TIME_LIMIT_WAIT_MS })
    const notice = page.getByRole('status').filter({ hasText: '已把你的角色改为查看者' })
    await expect(notice).toContainText('成员列表还在刷新')
    // 缓存里还能管理，选择框还在：焦点交还给它（打开确认框之前它有焦点），说明写进去之后它整个在可视区域里
    await expect(select).toBeFocused()
    await expect(select).toBeInViewport({ ratio: 1 })
    refresh.release()
    await expect(notice).not.toContainText('成员列表还在刷新')
  })

  test('手机宽度、长成员表移出最后一个人、刷新成员列表超过时限之后滚到页面底部：刷新回来、"成员列表还在刷新"一句消失（状态区变矮）时页面不跳回标题，停在底部（M3-P6 再复核 D1）', async ({ page }) => {
    test.setTimeout(LONG_LIST_TEST_TIMEOUT)
    // 手机的宽度：说明带着"成员列表还在刷新"一句时折成几行，那一句消失时状态区变矮（1280 宽时一行放得下，高度不变）
    await page.setViewportSize({ width: 400, height: 720 })
    const root = await createUser('mbjump-root', '系统管理员', { systemRole: 'admin' })
    const self = await createUser('mbjump-self', '空间管理员')
    const others = await people('mbjump-v', 'v成员', 24)
    const space = await createTeamSpace('长成员表', root, [[self, 'admin'], ...others.map(user => [user, 'viewer'] as const)])
    await loginThroughApi(page, self)
    await page.goto(`/spaces/${space.id}/members`)
    const title = page.getByRole('heading', { name: `${space.name} 的成员` })
    await expect(title).toBeVisible()
    const last = lastOf(others)
    await page.getByRole('button', { name: `移出 ${plainName(last)}`, exact: true }).focus()
    const refresh = await holdMembersRefresh(page, space.id)
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: `把 ${plainName(last)} 移出这个空间？` })
    refresh.arm()
    await dialog.getByRole('button', { name: '移出', exact: true }).click()
    await refresh.arrived
    // 真等刷新的时限（10 秒）：装了 Playwright 的时钟时几处更新的先后跟真实的不一样（后台刷新的结果与列表的通知谁先到）
    await expect(dialog).toHaveCount(0, { timeout: REFRESH_TIME_LIMIT_WAIT_MS })
    const notice = page.getByRole('status').filter({ hasText: '移出这个空间' })
    await expect(notice).toContainText('成员列表还在刷新')
    // 那一行没了，焦点交给页面的标题
    await expect(title).toBeFocused()
    const taller = await heightOf(notice)
    // 用户等刷新的时候滚到页面底部看成员表（滚轮、手指的滑动都不动焦点）。这里直接滚到底：滚轮的平滑滚动还没停的时候页面被拉走，
    // Chromium 会接着把它滚回底部，跳动就看不出来了（再复核 D1 时实测）
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    expect(await page.evaluate(() => window.scrollY), '页面没有滚动的余地，用例的前提不成立').toBeGreaterThan(200)
    await expect(title).not.toBeInViewport()
    refresh.release()
    await expect(notice).not.toContainText('成员列表还在刷新')
    expect(await heightOf(notice), '那一句消失时状态区没有变矮，用例的前提不成立').toBeLessThan(taller)
    // 那一句消失之后再过两帧（之后才重新渲染、才滚的也都已经滚了）：页面没有跳回标题，仍在底部（文档变短了，到底的位置随之上移）
    await nextFrames(page)
    await expect(title).not.toBeInViewport()
    expect(await distanceFromPageBottom(page)).toBeLessThanOrEqual(1)
  })
})

/** 一批同事（显示名带两位序号，按显示名排在一起） */
async function people(prefix: string, displayPrefix: string, count: number): Promise<TestUser[]> {
  const created: TestUser[] = []
  for (let n = 1; n <= count; n += 1)
    created.push(await createUser(`${prefix}${n}`, `${displayPrefix}${String(n).padStart(2, '0')}`))
  return created
}

/** 最后一个（成员表里排在最下面的那一位） */
function lastOf<T>(items: readonly T[]): T {
  const item = items.at(-1)
  if (item === undefined)
    throw new Error('一个也没有')
  return item
}

/** 这个元素的底边离可视区域的底边还有多少像素 */
async function distanceToBottom(page: Page, locator: Locator): Promise<number> {
  return locator.evaluate(element => window.innerHeight - element.getBoundingClientRect().bottom)
}

/** 元素的高度（像素） */
async function heightOf(locator: Locator): Promise<number> {
  return locator.evaluate(element => element.getBoundingClientRect().height)
}

/** 页面还能往下滚多少像素（0 是在底部） */
async function distanceFromPageBottom(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight - window.scrollY)
}

/**
 * 扣住写操作之后对成员列表的刷新（GET …/members）：arm 之后的那一次请求停住，arrived 在它到了时兑现，release 之后照常放行。
 * 写操作成功之后的刷新超过时限（10 秒）时，确认框照常关掉，说明里说成员列表还在刷新
 */
async function holdMembersRefresh(page: Page, spaceId: string): Promise<{ arm: () => void, readonly arrived: Promise<void>, release: () => void }> {
  let armed = false
  let arrive: () => void = () => {}
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve
  })
  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(url => url.pathname === `/api/spaces/${spaceId}/members`, async (route) => {
    if (armed && route.request().method() === 'GET') {
      arrive()
      await released
    }
    await route.continue()
  })
  function arm(): void {
    armed = true
  }
  return { arm, arrived, release }
}

/** 等两个动画帧：布局变了之后的 ResizeObserver 回调（滚动在这里）与随后一次重新渲染都已经走完 */
async function nextFrames(page: Page): Promise<void> {
  await page.evaluate(async () => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
}

/** 这一处在容器之内（左右都不出界），页面没有横向溢出（窄屏的用例，视口 320px 宽） */
async function expectInside(page: Page, container: Locator, part: Locator, what: string): Promise<void> {
  const box = await part.boundingBox()
  const outer = await container.boundingBox()
  if (box === null || outer === null)
    throw new Error(`${what} 或者它的容器没有出现`)
  expect(box.x, `${what} 左边出界`).toBeGreaterThanOrEqual(outer.x - 0.5)
  expect(box.x + box.width, `${what} 撑出了容器`).toBeLessThanOrEqual(outer.x + outer.width + 0.5)
  expect(await page.evaluate(() => document.documentElement.scrollWidth), `${what}：页面横向溢出`).toBeLessThanOrEqual(320)
}
