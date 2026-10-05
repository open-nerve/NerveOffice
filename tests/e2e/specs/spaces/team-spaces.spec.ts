// 团队空间（M2-P2，US-M2-05）：系统管理员在管理界面创建团队空间并指定空间管理员；设为全员可见；归档与恢复；
// 系统管理员要看内容，先把自己加入空间（记审计）。团队空间的名称全库唯一，三个浏览器并行时名称带随机后缀。
import type { Page } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import { createDocumentIn, createTeamSpace, createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { searchList } from '../../support/list-search.ts'
import { shownName } from '../../support/people.ts'
import { loginThroughApi } from '../../support/session.ts'
import { saveStatus } from '../../support/sheet.ts'

/** 管理界面的团队空间页：按名称找到这一行。等搜索的过滤完成再返回，之后的操作不会赶上表格换成加载状态（support/list-search.ts） */
async function spaceRow(page: Page, name: string) {
  await page.goto('/admin/spaces')
  await searchList(page, '按名称搜索', name)
  const row = page.getByRole('table', { name: '团队空间列表' }).getByRole('row').filter({ hasText: name })
  await expect(row).toHaveCount(1)
  return row
}

/** 点行里的操作（可读名称是"操作 空间名"），在确认的弹窗里再点一次同名的按钮 */
async function confirmOnRow(page: Page, name: string, action: string): Promise<void> {
  const row = await spaceRow(page, name)
  await row.getByRole('button', { name: `${action} ${name}`, exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: action, exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

function spaceNav(page: Page) {
  return page.getByRole('navigation', { name: '空间' })
}

/** 审计页按动作筛选之后，对象是这个空间的事件 */
async function auditEventsOf(page: Page, spaceName: string, action: string) {
  await page.goto('/admin/audit')
  await page.getByLabel('动作', { exact: true }).selectOption({ label: action })
  return page.getByRole('table', { name: '审计事件' }).getByRole('row').filter({ hasText: spaceName })
}

test.describe('US-M2-05 团队空间', () => {
  test('系统管理员创建团队空间并指定空间管理员：对方在导航里看到它，在里面新建表格；系统管理员自己没有加入，看不到它', async ({ page, anotherDevice }) => {
    const admin = await createUser('ts-admin', '建空间的管理员', { systemRole: 'admin' })
    const lead = await createUser('ts-lead', '空间负责人')
    const name = `市场部 ${randomBytes(3).toString('hex')}`
    await loginThroughApi(page, admin)
    await page.goto('/')
    await page.getByRole('link', { name: '管理', exact: true }).click()
    await page.getByRole('navigation', { name: '管理界面' }).getByRole('link', { name: '团队空间', exact: true }).click()
    const form = page.getByRole('form', { name: '创建团队空间' })
    await form.getByLabel('名称', { exact: true }).fill(name)
    await form.getByLabel('首个空间管理员', { exact: true }).fill(lead.username)
    await form.getByRole('button', { name: shownName(lead), exact: true }).click()
    await form.getByRole('button', { name: '创建团队空间', exact: true }).click()
    // 先在当前页面等到创建成功（表单清空），再跳转：跳转会中断还没完成的请求（审查 B6）
    await expect(form.getByLabel('名称', { exact: true })).toHaveValue('')
    const row = await spaceRow(page, name)
    await expect(row.getByText('没有加入')).toBeVisible()
    // 导航的团队空间一节加载完（列表，或者"还没有加入团队空间"），再确认里面没有它（审查 B6）
    const nav = spaceNav(page)
    await expect(nav.getByRole('list', { name: '团队空间', exact: true }).or(nav.getByText('还没有加入团队空间'))).toBeVisible()
    await expect(nav.getByRole('link', { name })).toHaveCount(0)

    await loginThroughApi(anotherDevice, lead)
    await anotherDevice.goto('/')
    await spaceNav(anotherDevice).getByRole('link', { name }).click()
    await expect(anotherDevice.getByRole('heading', { name })).toBeVisible()
    await expect(anotherDevice.getByText('我的角色：空间管理员')).toBeVisible()
    await anotherDevice.getByRole('button', { name: '新建表格', exact: true }).click()
    await expect(anotherDevice).toHaveURL(/\/documents\/[\da-f-]{36}$/)
    // 编辑器页的返回链接回到这个空间
    await expect(anotherDevice.getByRole('link', { name, exact: true })).toHaveAttribute('href', /\/spaces\/[\da-f-]{36}$/)
  })

  test('设为全员可见：不是成员的同事以查看者看到它，没有新建，打开的文档只能查看；取消之后看不到', async ({ page, anotherDevice }) => {
    const admin = await createUser('ts-vis-admin', '管理员', { systemRole: 'admin' })
    const lead = await createUser('ts-vis-lead', '负责人')
    const reader = await createUser('ts-vis-reader', '读者')
    const space = await createTeamSpace('公告栏', admin, [[lead, 'admin']])
    await createDocumentIn(space.id, lead, '放假通知')
    await loginThroughApi(page, admin)
    await confirmOnRow(page, space.name, '设为全员可见')

    await loginThroughApi(anotherDevice, reader)
    await anotherDevice.goto('/')
    await spaceNav(anotherDevice).getByRole('link', { name: space.name }).click()
    await expect(anotherDevice.getByText('我的角色：查看者')).toBeVisible()
    await expect(anotherDevice.getByRole('button', { name: '新建表格', exact: true })).toHaveCount(0)
    await anotherDevice.getByRole('link', { name: /放假通知/ }).click()
    await expect(saveStatus(anotherDevice)).toHaveText('只能查看')

    await confirmOnRow(page, space.name, '取消全员可见')
    await anotherDevice.goto(`/spaces/${space.id}`)
    await expect(anotherDevice.getByText('空间不存在，或者你没有访问权限')).toBeVisible()
  })

  test('归档：成员只能查看，没有新建，打开里面的文档也只能查看；恢复之后照旧', async ({ page, anotherDevice }) => {
    const admin = await createUser('ts-arc-admin', '管理员', { systemRole: 'admin' })
    const lead = await createUser('ts-arc-lead', '负责人')
    const space = await createTeamSpace('旧项目', admin, [[lead, 'admin']])
    await createDocumentIn(space.id, lead, '旧方案')
    await loginThroughApi(page, admin)
    await confirmOnRow(page, space.name, '归档')

    await loginThroughApi(anotherDevice, lead)
    await anotherDevice.goto(`/spaces/${space.id}`)
    await expect(anotherDevice.getByText('这个空间已归档，只能查看。')).toBeVisible()
    await expect(anotherDevice.getByRole('button', { name: '新建表格', exact: true })).toHaveCount(0)
    await expect(spaceNav(anotherDevice).getByRole('link', { name: `${space.name}（已归档）` })).toBeVisible()
    // 归档空间里的文档：空间管理员打开也只能查看（审查 B7）
    await anotherDevice.getByRole('link', { name: /旧方案/ }).click()
    await expect(saveStatus(anotherDevice)).toHaveText('只能查看')

    await confirmOnRow(page, space.name, '恢复')
    await anotherDevice.goto(`/spaces/${space.id}`)
    await expect(anotherDevice.getByRole('button', { name: '新建表格', exact: true })).toBeVisible()
  })

  test('系统管理员没有加入就看不到团队空间的内容；把自己加入之后能看到；审计里记着"系统管理员加入空间"与"归档空间"', async ({ page }) => {
    const admin = await createUser('ts-join-admin', '想看内容的管理员', { systemRole: 'admin' })
    const lead = await createUser('ts-join-lead', '负责人')
    const space = await createTeamSpace('财务部', admin, [[lead, 'admin']])
    await createDocumentIn(space.id, lead, '预算表')
    await loginThroughApi(page, admin)
    await page.goto(`/spaces/${space.id}`)
    await expect(page.getByText('空间不存在，或者你没有访问权限')).toBeVisible()

    const row = await spaceRow(page, space.name)
    await row.getByRole('button', { name: `加入空间 ${space.name}`, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: `加入 ${space.name}` })
    await expect(dialog.getByText('加入会记入审计')).toBeVisible()
    await dialog.getByRole('button', { name: '加入空间', exact: true }).click()
    await expect(row.getByText('查看者')).toBeVisible()
    await spaceNav(page).getByRole('link', { name: space.name }).click()
    await expect(page.getByRole('link', { name: /预算表/ })).toBeVisible()

    const joined = await auditEventsOf(page, space.name, '系统管理员加入空间')
    await expect(joined).toHaveCount(1)
    await expect(joined).toContainText('系统管理员加入空间')

    // 管理界面的其他操作同样记入审计：归档这个空间之后按动作筛选，按空间名找到这一行（审查 B7）
    await confirmOnRow(page, space.name, '归档')
    const archived = await auditEventsOf(page, space.name, '归档空间')
    await expect(archived).toHaveCount(1)
    await expect(archived).toContainText('归档空间')
  })

  test('页头留着之前的、重新请求失败：说明空间信息没能刷新与原因，之前的名称与角色照常显示；恢复之后按"重试"，说明消失、焦点交给标题（DEF-040）', async ({ page }) => {
    const admin = await createUser('ts-head-admin', '管理员', { systemRole: 'admin' })
    const editor = await createUser('ts-head-editor', '编辑者')
    const space = await createTeamSpace('页头', admin, [[editor, 'editor']])
    await loginThroughApi(page, editor)
    await page.goto(`/spaces/${space.id}`)
    const title = page.getByRole('heading', { level: 1, name: space.name, exact: true })
    await expect(title).toBeVisible()
    await expect(page.getByText('我的角色：编辑者')).toBeVisible()

    // 只拦这个空间的页头（导航与文档列表照常）：服务暂时不可用，查询自动重试一次之后才算失败
    const isSpaceHeader = (url: URL): boolean => url.pathname === `/api/spaces/${space.id}`
    await page.route(isSpaceHeader, async route => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: '服务暂时不可用', requestId: 'e2e' } }),
    }))
    // 单页里离开再回来：页头先显示缓存里之前的，同时重新请求
    await spaceNav(page).getByRole('link', { name: '我的空间', exact: true }).click()
    await expect(page.getByRole('heading', { level: 1, name: '我的空间', exact: true })).toBeVisible()
    await spaceNav(page).getByRole('link', { name: space.name, exact: true }).click()
    const problem = page.getByRole('alert').filter({ hasText: '空间信息没能刷新，显示的还是之前的内容' })
    await expect(problem).toBeVisible()
    await expect(problem).toContainText('服务暂时不可用，请稍后重试')
    await expect(title).toBeVisible()
    await expect(page.getByText('我的角色：编辑者')).toBeVisible()
    await expect(page.getByRole('button', { name: '新建表格', exact: true })).toBeVisible()

    // 恢复之后用键盘按"重试"：说明随之消失，焦点不落到 body，交给标题
    await page.unroute(isSpaceHeader)
    await problem.getByRole('button', { name: '重试', exact: true }).press('Enter')
    await expect(problem).toHaveCount(0)
    await expect(title).toBeFocused()
    await expect(page.getByText('我的角色：编辑者')).toBeVisible()
  })
})
