// 管理界面的账户（M2-P1，US-M2-01、03、04）：经界面签发邀请与重置链接，同事在另一台设备上打开链接；停用与启用；系统管理员的授予与取消。
// 并行的用例各建各的管理员与账户，互不影响；"至少保留一个有效的系统管理员"依赖全库的管理员数量，由集成测试覆盖。
import type { Page } from '@playwright/test'
import { randomBytes } from 'node:crypto'
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

/** 点行里的操作，在确认的弹窗里再点一次同名的按钮 */
async function confirmAction(page: Page, row: ReturnType<Page['getByRole']>, action: string): Promise<void> {
  await row.getByRole('button', { name: action }).click()
  await page.getByRole('dialog').getByRole('button', { name: action }).click()
}

test.describe('US-M2-01 邀请注册', () => {
  test('管理员在管理界面签发邀请；同事在另一台设备上打开链接、设置密码，进入个人空间；再打开这个链接时说明已经接受过', async ({ page, anotherDevice }) => {
    const admin = await createUser('inv-admin', '签发邀请的管理员', { systemRole: 'admin' })
    const username = `inv-${randomBytes(4).toString('hex')}`
    await loginThroughApi(page, admin)
    await page.goto('/')
    await page.getByRole('link', { name: '管理' }).click()
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
  test('管理员生成重置链接：同事已打开的页面被要求重新登录；打开链接设置新密码后进入个人空间，旧密码不能再登录', async ({ page, anotherDevice }) => {
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

    await anotherDevice.reload()
    await expect(anotherDevice).toHaveURL(/\/login/)
    await anotherDevice.goto(url)
    await expect(anotherDevice.getByText(user.username)).toBeVisible()
    await anotherDevice.getByLabel('新密码', { exact: true }).fill(NEW_PASSWORD)
    await anotherDevice.getByLabel('再输入一次新密码').fill(NEW_PASSWORD)
    await anotherDevice.getByRole('button', { name: '设置新密码并登录' }).click()
    await expect(anotherDevice.getByRole('heading', { name: '我的空间' })).toBeVisible()

    await anotherDevice.getByRole('button', { name: '退出' }).click()
    await loginThroughUi(anotherDevice, user)
    await expect(anotherDevice.getByRole('alert')).toHaveText('用户名或密码错误')
    await loginThroughUi(anotherDevice, { username: user.username, password: NEW_PASSWORD })
    await expect(anotherDevice.getByRole('heading', { name: '我的空间' })).toBeVisible()
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

    await anotherDevice.reload()
    await expect(anotherDevice).toHaveURL(/\/login/)
    await loginThroughUi(anotherDevice, user)
    await expect(anotherDevice.getByRole('alert')).toHaveText('用户名或密码错误')

    await confirmAction(page, row, '启用')
    await expect(row.getByText('有效')).toBeVisible()
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
    await expect(anotherDevice.getByRole('link', { name: '管理' })).toBeVisible()

    await confirmAction(page, row, '取消系统管理员')
    await expect(row.getByText('成员', { exact: true })).toBeVisible()
    await anotherDevice.reload()
    await expect(anotherDevice.getByText('只有系统管理员能打开管理界面。')).toBeVisible()
  })
})
