// 管理界面的账户（M2-P1，US-M2-01、03、04）：经界面签发、重新生成邀请与重置链接，同事在另一台设备上打开链接；运维命令签发重置链接；
// 停用与启用；系统管理员的授予与取消；解除登录锁定（M2-P6 复核 A1）。
// 并行的用例各建各的管理员与账户，互不影响；"至少保留一个有效的系统管理员"依赖全库的管理员数量，由集成测试覆盖。
// 同事"已打开的页面"在下一次请求时被要求重新登录：在页面里新建表格，由全局的处理回到登录页（不是刷新，审查 B12）。
import type { Locator, Page } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import { issueResetLinkThroughCommand } from '../../support/admin-command.ts'
import { createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi, loginThroughUi } from '../../support/session.ts'

const NEW_PASSWORD = 'a good long password'

/** 在账户页按登录名找到这一行 */
async function userRow(page: Page, username: string) {
  await page.getByLabel('按名字或登录名搜索').fill(username)
  const row = page.getByRole('table', { name: '账户列表' }).getByRole('row').filter({ hasText: username })
  await expect(row).toHaveCount(1)
  return row
}

/**
 * 在邀请页签发：先等表单出现（从别的管理页切过来时，旧页面还在的那一刻按标签找会找到别的输入框），
 * 在表单里按完整的标签填写（账户页的"按名字或登录名搜索"也含"登录名"）
 */
async function issueInvitation(page: Page, username: string, displayName: string): Promise<void> {
  const form = page.getByRole('form', { name: '生成邀请链接' })
  await expect(form).toBeVisible()
  await form.getByLabel('登录名', { exact: true }).fill(username)
  await form.getByLabel('显示名', { exact: true }).fill(displayName)
  await form.getByRole('button', { name: '生成邀请链接' }).click()
}

/**
 * 点行里的操作，在确认的弹窗里再点一次同名的按钮。行里按钮的可读名称是"操作 对象"（例如"停用 被停用的人（…）"，审查 B14）：
 * 按开头匹配，对象的名字里含有别的操作名时也不会多匹配
 */
async function confirmAction(page: Page, row: Locator, action: string): Promise<void> {
  await row.getByRole('button', { name: new RegExp(`^${action} `) }).click()
  await page.getByRole('dialog').getByRole('button', { name: action, exact: true }).click()
}

/** 同事已打开的页面发出下一次请求（新建表格）：会话已经失效，被带到登录页，提示登录已过期 */
async function expectNextRequestAsksToLogIn(page: Page): Promise<void> {
  await page.getByRole('button', { name: '新建表格' }).click()
  await expect(page).toHaveURL(/\/login/)
  await expect(page.getByText('登录已过期，请重新登录')).toBeVisible()
}

test.describe('US-M2-01 邀请注册', () => {
  test('管理员在管理界面签发邀请；同事在另一台设备上打开链接、设置密码，进入个人空间；再打开这个链接时说明已经接受过', async ({ page, anotherDevice }) => {
    const admin = await createUser('inv-admin', '签发邀请的管理员', { systemRole: 'admin' })
    const username = `inv-${randomBytes(4).toString('hex')}`
    await loginThroughApi(page, admin)
    await page.goto('/')
    await page.getByRole('link', { name: '管理', exact: true }).click()
    await page.getByRole('navigation', { name: '管理界面' }).getByRole('link', { name: '邀请' }).click()
    await issueInvitation(page, username, '新来的同事')
    const dialog = page.getByRole('dialog', { name: `邀请链接：新来的同事（${username}）` })
    const url = await dialog.getByLabel('链接').inputValue()
    expect(url).toMatch(/\/invite#[\w-]{43}$/)
    await expect(dialog.getByText(/链接只显示这一次/)).toBeVisible()
    await dialog.getByRole('button', { name: '关闭' }).click()
    const row = page.getByRole('table', { name: '邀请列表' }).getByRole('row').filter({ hasText: username })
    await expect(row.getByText('待接受')).toBeVisible()

    await anotherDevice.goto(url)
    await expect(anotherDevice.getByText(username)).toBeVisible()
    // 令牌读出之后从地址栏里去掉
    await expect(anotherDevice).toHaveURL(/\/invite$/)
    await anotherDevice.getByLabel('显示名').fill('新同事')
    await anotherDevice.getByLabel('设置密码').fill(NEW_PASSWORD)
    await anotherDevice.getByLabel('再输入一次新密码').fill(NEW_PASSWORD)
    await anotherDevice.getByRole('button', { name: '设置密码并登录' }).click()
    await expect(anotherDevice.getByRole('heading', { name: '我的空间' })).toBeVisible()
    await expect(anotherDevice.getByText('新同事')).toBeVisible()

    await anotherDevice.goto(url)
    await expect(anotherDevice.getByRole('alert')).toHaveText('这个邀请已经接受过了，请直接登录')
    await page.reload()
    await expect(page.getByRole('table', { name: '邀请列表' }).getByRole('row').filter({ hasText: username }).getByText('已接受')).toBeVisible()
  })

  test('重新生成：确认的弹窗换成新链接的弹窗；原来的链接随即作废，旧的一行不再给出重新生成；新链接在同一个标签页里粘贴也能用', async ({ page, anotherDevice }) => {
    const admin = await createUser('inv-reissue', '重发邀请的管理员', { systemRole: 'admin' })
    const username = `re-${randomBytes(4).toString('hex')}`
    await loginThroughApi(page, admin)
    await page.goto('/admin/invitations')
    await issueInvitation(page, username, '重发的同事')
    const firstUrl = await page.getByRole('dialog').getByLabel('链接').inputValue()
    await page.getByRole('dialog').getByRole('button', { name: '关闭' }).click()
    const rows = page.getByRole('table', { name: '邀请列表' }).getByRole('row').filter({ hasText: username })

    // 任何时刻只有一个弹窗（审查 B7）：重新生成之后的列表刷新先扣住，刷新期间只有确认的弹窗（"正在处理…"），刷新之后才换成链接的弹窗。
    // 按 role 属性数，被 aria-hidden 的弹窗也算上（复验 N3）；用不重试的 count()，只在刷新期间存在的第二个弹窗也数得到（复验 X4）
    const invitationList = /\/api\/admin\/invitations(?:\?|$)/
    let releaseRefresh: () => void = () => {}
    const refreshReleased = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    await page.route(invitationList, async (route) => {
      if (route.request().method() === 'GET')
        await refreshReleased
      await route.continue()
    })
    const refresh = page.waitForRequest(request => request.method() === 'GET' && invitationList.test(request.url()))
    await confirmAction(page, rows.filter({ hasText: '待接受' }), '重新生成')
    await refresh
    await expect(page.getByRole('dialog').getByRole('button', { name: '正在处理…' })).toBeVisible()
    // eslint-disable-next-line playwright/prefer-to-have-count -- 数的是刷新期间的瞬时状态：toHaveCount 会重试到计数对上为止
    expect(await page.locator('[role="dialog"]').count()).toBe(1)
    releaseRefresh()

    const dialog = page.getByRole('dialog', { name: `邀请链接：重发的同事（${username}）` })
    await expect(dialog.getByLabel('链接')).not.toHaveValue(firstUrl)
    const secondUrl = await dialog.getByLabel('链接').inputValue()
    // eslint-disable-next-line playwright/prefer-to-have-count -- 同上：链接的弹窗出现的那一刻，确认的弹窗已经关掉
    expect(await page.locator('[role="dialog"]').count()).toBe(1)
    await dialog.getByRole('button', { name: '关闭' }).click()
    const old = rows.filter({ hasText: '已作废' })
    await expect(old).toHaveCount(1)
    await expect(old.getByRole('button', { name: /^重新生成 / })).toHaveCount(0)
    await expect(rows.filter({ hasText: '待接受' }).getByRole('button', { name: /^重新生成 / })).toHaveCount(1)

    await anotherDevice.goto(firstUrl)
    await expect(anotherDevice.getByRole('alert')).toHaveText('邀请链接已作废，请管理员重新发送')
    // 同一个标签页粘贴新链接：只有 # 之后不同，是片段导航，页面按新的令牌重新查看（审查 B3）
    await anotherDevice.goto(secondUrl)
    await expect(anotherDevice.getByText(username)).toBeVisible()
    await expect(anotherDevice).toHaveURL(/\/invite$/)
    await anotherDevice.getByLabel('设置密码').fill(NEW_PASSWORD)
    await anotherDevice.getByLabel('再输入一次新密码').fill(NEW_PASSWORD)
    await anotherDevice.getByRole('button', { name: '设置密码并登录' }).click()
    await expect(anotherDevice.getByRole('heading', { name: '我的空间' })).toBeVisible()
  })

  test('作废的邀请：打开链接时说明已作废', async ({ page, anotherDevice }) => {
    const admin = await createUser('inv-revoke', '作废邀请的管理员', { systemRole: 'admin' })
    const username = `rev-${randomBytes(4).toString('hex')}`
    await loginThroughApi(page, admin)
    await page.goto('/admin/invitations')
    await issueInvitation(page, username, '不来了')
    const url = await page.getByRole('dialog').getByLabel('链接').inputValue()
    await page.getByRole('dialog').getByRole('button', { name: '关闭' }).click()
    const row = page.getByRole('table', { name: '邀请列表' }).getByRole('row').filter({ hasText: username })
    await confirmAction(page, row, '作废')
    await expect(row.getByText('已作废')).toBeVisible()

    await anotherDevice.goto(url)
    await expect(anotherDevice.getByRole('alert')).toHaveText('邀请链接已作废，请管理员重新发送')
  })
})

test.describe('US-M2-03 重置密码', () => {
  test('管理员生成重置链接：同事已打开的页面下一次请求被要求重新登录，旧密码随即失效；打开链接设置新密码后进入个人空间', async ({ page, anotherDevice }) => {
    const admin = await createUser('reset-admin', '重置的管理员', { systemRole: 'admin' })
    const user = await createUser('reset-user', '忘了密码的人')
    await loginThroughApi(anotherDevice, user)
    await anotherDevice.goto('/')
    await expect(anotherDevice.getByRole('heading', { name: '我的空间' })).toBeVisible()

    await loginThroughApi(page, admin)
    await page.goto('/admin/users')
    const row = await userRow(page, user.username)
    await confirmAction(page, row, '生成重置链接')
    const url = await page.getByRole('dialog', { name: `重置链接：忘了密码的人（${user.username}）` }).getByLabel('链接').inputValue()
    expect(url).toMatch(/\/reset-password#[\w-]{43}$/)

    await expectNextRequestAsksToLogIn(anotherDevice)
    // 旧密码随签发失效（审查 A7）
    await loginThroughUi(anotherDevice, user)
    await expect(anotherDevice.getByRole('alert')).toHaveText('用户名或密码错误')
    await anotherDevice.goto(url)
    await expect(anotherDevice.getByText(user.username)).toBeVisible()
    await anotherDevice.getByLabel('新密码', { exact: true }).fill(NEW_PASSWORD)
    await anotherDevice.getByLabel('再输入一次新密码').fill(NEW_PASSWORD)
    await anotherDevice.getByRole('button', { name: '设置新密码并登录' }).click()
    await expect(anotherDevice.getByRole('heading', { name: '我的空间' })).toBeVisible()

    await anotherDevice.getByRole('button', { name: '退出', exact: true }).click()
    await loginThroughUi(anotherDevice, user)
    await expect(anotherDevice.getByRole('alert')).toHaveText('用户名或密码错误')
    await loginThroughUi(anotherDevice, { username: user.username, password: NEW_PASSWORD })
    await expect(anotherDevice.getByRole('heading', { name: '我的空间' })).toBeVisible()
  })

  test('唯一的管理员忘了密码：运维命令签发重置链接（标准输出只有链接），打开之后设置新密码，照常进入管理界面', async ({ anotherDevice }) => {
    const admin = await createUser('cli-reset', '忘了密码的管理员', { systemRole: 'admin' })
    // 本机模式直接执行构建产物；容器 E2E 按部署说明经 docker compose exec 执行
    const output = issueResetLinkThroughCommand(admin.username)
    expect(output).toMatch(/^\S+\/reset-password#[\w-]{43}\n$/)
    await anotherDevice.goto(output.trim())
    await expect(anotherDevice.getByText(admin.username)).toBeVisible()
    await anotherDevice.getByLabel('新密码', { exact: true }).fill(NEW_PASSWORD)
    await anotherDevice.getByLabel('再输入一次新密码').fill(NEW_PASSWORD)
    await anotherDevice.getByRole('button', { name: '设置新密码并登录' }).click()
    await expect(anotherDevice.getByRole('heading', { name: '我的空间' })).toBeVisible()
    await anotherDevice.getByRole('link', { name: '管理', exact: true }).click()
    await expect(anotherDevice.getByRole('table', { name: '账户列表' })).toBeVisible()
  })
})

test.describe('US-M2-04 停用、启用与系统管理员', () => {
  test('停用：同事已打开的页面下一次请求被要求重新登录，登录时提示与密码错误相同；启用之后照常登录', async ({ page, anotherDevice }) => {
    const admin = await createUser('disable-admin', '停用的管理员', { systemRole: 'admin' })
    const user = await createUser('disable-user', '被停用的人')
    await loginThroughApi(anotherDevice, user)
    await anotherDevice.goto('/')
    await expect(anotherDevice.getByRole('heading', { name: '我的空间' })).toBeVisible()

    await loginThroughApi(page, admin)
    await page.goto('/admin/users')
    const row = await userRow(page, user.username)
    await confirmAction(page, row, '停用')
    await expect(row.getByText('已停用')).toBeVisible()

    await expectNextRequestAsksToLogIn(anotherDevice)
    await loginThroughUi(anotherDevice, user)
    await expect(anotherDevice.getByRole('alert')).toHaveText('用户名或密码错误')

    await confirmAction(page, row, '启用')
    await expect(row.getByText('有效')).toBeVisible()
    await loginThroughUi(anotherDevice, user)
    await expect(anotherDevice.getByRole('heading', { name: '我的空间' })).toBeVisible()
  })

  test('同事连续输错密码被锁定：账户页说明锁到什么时候；管理员确认解除之后，同事立即能登录（M2-P6 复核 A1）', async ({ page, anotherDevice }) => {
    const admin = await createUser('unlock-admin', '解除锁定的管理员', { systemRole: 'admin' })
    const user = await createUser('unlock-user', '被锁定的人')
    await anotherDevice.goto('/login')
    for (let attempt = 1; attempt < 5; attempt++) {
      await loginThroughUi(anotherDevice, { username: user.username, password: `wrong ${attempt}` })
      await expect(anotherDevice.getByRole('alert')).toHaveText('用户名或密码错误')
    }
    await loginThroughUi(anotherDevice, { username: user.username, password: 'wrong 5' })
    await expect(anotherDevice.getByRole('alert')).toHaveText(/尝试次数过多/)

    await loginThroughApi(page, admin)
    await page.goto('/admin/users')
    const row = await userRow(page, user.username)
    // 只有这一个来源被锁（本人从别处照常登录）：说明写"部分来源"
    await expect(row.getByText(/^部分来源的登录已锁定，到 .+ 解除$/)).toBeVisible()
    // 确认的说明准确（复验 N5）：清掉的是这个人在各个来源上的失败次数，他所在的网络整体被锁时仍要等到期
    await row.getByRole('button', { name: /^解除锁定 / }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toHaveAccessibleDescription(/清掉这个人在所有来源上的登录失败次数。他所在的网络如果整体被锁（同一来源失败次数太多），仍要等锁定到期/)
    await dialog.getByRole('button', { name: '解除锁定', exact: true }).click()
    await expect(row.getByText(/登录已锁定/)).toHaveCount(0)
    await expect(row.getByRole('button', { name: /^解除锁定 / })).toHaveCount(0)

    await loginThroughUi(anotherDevice, user)
    await expect(anotherDevice.getByRole('heading', { name: '我的空间' })).toBeVisible()
  })

  test('设为系统管理员之后能打开管理界面；取消之后再打开，说明没有权限', async ({ page, anotherDevice }) => {
    const admin = await createUser('role-admin', '授权的管理员', { systemRole: 'admin' })
    const user = await createUser('role-user', '将成为管理员的人')
    await loginThroughApi(anotherDevice, user)
    await anotherDevice.goto('/admin/users')
    await expect(anotherDevice.getByText('只有系统管理员能打开管理界面。')).toBeVisible()

    await loginThroughApi(page, admin)
    await page.goto('/admin/users')
    const row = await userRow(page, user.username)
    await confirmAction(page, row, '设为系统管理员')
    await expect(row.getByText('系统管理员', { exact: true })).toBeVisible()
    await anotherDevice.reload()
    await expect(anotherDevice.getByRole('table', { name: '账户列表' })).toBeVisible()
    await expect(anotherDevice.getByRole('link', { name: '管理', exact: true })).toBeVisible()

    await confirmAction(page, row, '取消系统管理员')
    await expect(row.getByText('成员', { exact: true })).toBeVisible()
    await anotherDevice.reload()
    await expect(anotherDevice.getByText('只有系统管理员能打开管理界面。')).toBeVisible()
  })
})
