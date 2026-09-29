// 成员与空间角色（M2-P2，US-M2-06）：空间管理员在成员页按名字搜索同事并添加、调整角色、移出；
// 被移出的人已打开的页面里，再进这个空间就看不到它（不显示缓存里的旧内容），导航里它随之消失。
import type { Page } from '@playwright/test'
import type { TestUser } from '../../support/database.ts'
import { createTeamSpace, createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'

function nameOf(user: TestUser): string {
  return `${user.displayName}（${user.username}）`
}

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
    await page.getByRole('list', { name: '找到的同事' }).getByRole('button', { name: nameOf(colleague), exact: true }).click()
    await page.getByLabel('角色', { exact: true }).selectOption({ label: '编辑者' })
    await page.getByRole('button', { name: '添加成员', exact: true }).click()
    const role = page.getByRole('combobox', { name: `${nameOf(colleague)} 的角色` })
    await expect(role).toHaveValue('editor')

    await loginThroughApi(anotherDevice, colleague)
    await anotherDevice.goto('/')
    await spaceNav(anotherDevice).getByRole('link', { name: space.name }).click()
    await expect(anotherDevice.getByText('我的角色：编辑者')).toBeVisible()
    await expect(anotherDevice.getByRole('button', { name: '新建表格', exact: true })).toBeVisible()

    // 调整为查看者：对方重新打开就只能查看
    await role.selectOption({ label: '查看者' })
    await expect(role).toHaveValue('viewer')
    await expect(page.getByRole('row').filter({ hasText: nameOf(colleague) })).toHaveAttribute('aria-busy', 'false')
    await anotherDevice.reload()
    await expect(anotherDevice.getByText('我的角色：查看者')).toBeVisible()
    await expect(anotherDevice.getByRole('button', { name: '新建表格', exact: true })).toHaveCount(0)

    // 移出：先确认
    await page.getByRole('button', { name: `移出 ${nameOf(colleague)}` }).click()
    await page.getByRole('dialog').getByRole('button', { name: '移出', exact: true }).click()
    await expect(page.getByRole('combobox', { name: `${nameOf(colleague)} 的角色` })).toHaveCount(0)

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

  test('只有空间管理员能管理：编辑者打开成员页只能查看', async ({ page }) => {
    const admin = await createUser('mb-ro-admin', '管理员', { systemRole: 'admin' })
    const lead = await createUser('mb-ro-lead', '空间管理员')
    const editor = await createUser('mb-ro-editor', '编辑者')
    const space = await createTeamSpace('只读成员页', admin, [[lead, 'admin'], [editor, 'editor']])
    await loginThroughApi(page, editor)
    await page.goto(`/spaces/${space.id}/members`)
    await expect(page.getByText('只有空间管理员能添加、调整与移出成员。')).toBeVisible()
    await expect(page.getByRole('table', { name: '成员列表' }).getByText(nameOf(lead))).toBeVisible()
    await expect(page.getByLabel('要添加的同事')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^移出 / })).toHaveCount(0)
  })
})
