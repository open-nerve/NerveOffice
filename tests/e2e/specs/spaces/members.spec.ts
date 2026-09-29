// 成员与空间角色（M2-P2，US-M2-06）：空间管理员在成员页按名字搜索同事并添加、调整角色、移出；
// 被移出的人已打开的页面，下一次请求就看不到这个空间。
import type { TestUser } from '../../support/database.ts'
import { createTeamSpace, createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'

function nameOf(user: TestUser): string {
  return `${user.displayName}（${user.username}）`
}

test.describe('US-M2-06 管理成员与空间角色', () => {
  test('空间管理员添加同事、调整角色、移出；对方随即按新的角色看到这个空间，移出之后下一次请求就看不到', async ({ page, anotherDevice }) => {
    const admin = await createUser('mb-admin', '管理员', { systemRole: 'admin' })
    const lead = await createUser('mb-lead', '空间管理员')
    const colleague = await createUser('mb-colleague', '新成员')
    const space = await createTeamSpace('项目组', admin, [[lead, 'admin']])
    await loginThroughApi(page, lead)
    await page.goto(`/spaces/${space.id}`)
    await page.getByRole('link', { name: '成员' }).click()
    await expect(page.getByRole('heading', { name: `${space.name} 的成员` })).toBeVisible()

    // 添加：按名字搜索（这里用登录名：它全库唯一），选角色
    await page.getByLabel('添加成员').fill(colleague.username)
    await page.getByRole('list', { name: '找到的同事' }).getByRole('button', { name: nameOf(colleague) }).click()
    await page.getByLabel('角色', { exact: true }).selectOption({ label: '编辑者' })
    await page.getByRole('button', { name: '添加成员' }).click()
    const role = page.getByRole('combobox', { name: `${nameOf(colleague)} 的角色` })
    await expect(role).toHaveValue('editor')

    await loginThroughApi(anotherDevice, colleague)
    await anotherDevice.goto('/')
    await anotherDevice.getByRole('navigation', { name: '空间' }).getByRole('link', { name: space.name }).click()
    await expect(anotherDevice.getByText('我的角色：编辑者')).toBeVisible()
    await expect(anotherDevice.getByRole('button', { name: '新建表格' })).toBeVisible()

    // 调整为查看者：对方重新打开就只能查看
    await role.selectOption({ label: '查看者' })
    await expect(role).toHaveValue('viewer')
    await anotherDevice.reload()
    await expect(anotherDevice.getByText('我的角色：查看者')).toBeVisible()
    await expect(anotherDevice.getByRole('button', { name: '新建表格' })).toHaveCount(0)

    // 移出：先确认；对方已打开的页面下一次请求（点导航里的空间）就看不到
    await page.getByRole('button', { name: `移出 ${nameOf(colleague)}` }).click()
    await page.getByRole('dialog').getByRole('button', { name: '移出', exact: true }).click()
    await expect(page.getByRole('combobox', { name: `${nameOf(colleague)} 的角色` })).toHaveCount(0)
    await anotherDevice.getByRole('link', { name: '我的空间' }).click()
    await anotherDevice.goto(`/spaces/${space.id}`)
    await expect(anotherDevice.getByText('空间不存在，或者你没有访问权限')).toBeVisible()
  })

  test('只有空间管理员能管理：编辑者打开成员页只能查看', async ({ page }) => {
    const admin = await createUser('mb-ro-admin', '管理员', { systemRole: 'admin' })
    const lead = await createUser('mb-ro-lead', '空间管理员')
    const editor = await createUser('mb-ro-editor', '编辑者')
    const space = await createTeamSpace('只读成员页', admin, [[lead, 'admin'], [editor, 'editor']])
    await loginThroughApi(page, editor)
    await page.goto(`/spaces/${space.id}/members`)
    await expect(page.getByText('只有空间管理员能添加、调整与移出成员。')).toBeVisible()
    await expect(page.getByRole('table', { name: '成员列表' }).getByText(nameOf(lead))).toBeVisible()
    await expect(page.getByLabel('添加成员')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^移出 / })).toHaveCount(0)
  })
})
