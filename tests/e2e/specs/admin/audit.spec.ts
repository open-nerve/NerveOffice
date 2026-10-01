// 审计查询（M2-P1，US-M2-13）：管理界面里查到账户的操作；按动作筛选、点对象只看这个对象。
// 并行的用例会写入别的事件：按对象过滤之后再断言。
import { createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { searchList } from '../../support/list-search.ts'
import { shownName } from '../../support/people.ts'
import { loginThroughApi } from '../../support/session.ts'

test.describe('US-M2-13 审计查询', () => {
  test('停用与启用一个账户之后：按动作筛选能找到，点对象之后只剩这个账户的事件，操作者与来源都显示出来', async ({ page }) => {
    const admin = await createUser('audit-admin', '查审计的管理员', { systemRole: 'admin' })
    const user = await createUser('audit-user', '被审计的人')
    await loginThroughApi(page, admin)
    await page.goto('/admin/users')
    // 等搜索的过滤完成再操作这一行：没等的话，背后的表格会在点确认的半途换成加载状态（support/list-search.ts）
    await searchList(page, '按名字或登录名搜索', user.username)
    const row = page.getByRole('table', { name: '账户列表' }).getByRole('row').filter({ hasText: user.username })
    // 行里按钮的可读名称是"操作 对象"（审查 B14）
    await row.getByRole('button', { name: /^停用 / }).click()
    await page.getByRole('dialog').getByRole('button', { name: '停用', exact: true }).click()
    await expect(row.getByText('已停用')).toBeVisible()
    await row.getByRole('button', { name: /^启用 / }).click()
    await page.getByRole('dialog').getByRole('button', { name: '启用', exact: true }).click()
    await expect(row.getByText('有效')).toBeVisible()

    await page.getByRole('navigation', { name: '管理界面' }).getByRole('link', { name: '审计' }).click()
    await page.getByLabel('动作').selectOption({ label: '停用账户' })
    // 对象与操作者都用 PersonName：显示名与登录名分开呈现（M2-P6 复核 M2）
    const target = `账户：${shownName(user)}`
    await page.getByRole('table', { name: '审计事件' }).getByRole('button', { name: target }).first().click()
    await expect(page.getByText(`对象：${target}`)).toBeVisible()
    const events = page.getByRole('table', { name: '审计事件' }).getByRole('row')
    // 表头一行，加上这个账户的"停用账户"一行
    await expect(events).toHaveCount(2)
    await expect(events.nth(1)).toContainText(shownName(admin))
    await expect(events.nth(1)).toContainText('网页')

    // 清除动作的筛选：这个账户的停用与启用都在，按时间倒序
    await page.getByLabel('动作').selectOption({ label: '全部' })
    await expect(events).toHaveCount(3)
    await expect(events.nth(1)).toContainText('启用账户')
    await expect(events.nth(2)).toContainText('停用账户')
  })

  test('成员打开审计页：说明没有权限，看不到任何事件', async ({ page }) => {
    const member = await createUser('audit-member')
    await loginThroughApi(page, member)
    await page.goto('/admin/audit')
    await expect(page.getByText('只有系统管理员能打开管理界面。')).toBeVisible()
    await expect(page.getByRole('table')).toHaveCount(0)
  })
})
