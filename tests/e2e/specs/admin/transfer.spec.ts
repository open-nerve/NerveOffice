// 停用者文档的转移（M2-P2，US-M2-04）：系统管理员停用账户之后，在转移页只看得到标题，选文档与目标团队空间，确认之后转移；
// 空间的成员随即能打开这些文档。系统管理员打不开停用者的文档。
import { createDocument, createTeamSpace, createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { shownName } from '../../support/people.ts'
import { loginThroughApi } from '../../support/session.ts'

test.describe('US-M2-04 停用者文档的转移', () => {
  test('停用之后转移到团队空间：只看得到标题；转移之后空间的成员能打开', async ({ page, anotherDevice }) => {
    const admin = await createUser('tr-admin', '管理员', { systemRole: 'admin' })
    const leaver = await createUser('tr-leaver', '离职的同事')
    const receiver = await createUser('tr-receiver', '接手的同事')
    const space = await createTeamSpace('接手的空间', admin, [[receiver, 'editor']])
    const kept = await createDocument(leaver, '交接清单')
    await createDocument(leaver, '客户名单')

    await loginThroughApi(page, admin)
    // 系统管理员打不开别人个人空间里的文档
    await page.goto(`/documents/${kept}`)
    await expect(page.getByText('内容不存在，或者你没有访问权限')).toBeVisible()

    // 停用，然后从账户页进入转移页
    await page.goto('/admin/users')
    await page.getByLabel('按名字或登录名搜索').fill(leaver.username)
    const row = page.getByRole('table', { name: '账户列表' }).getByRole('row').filter({ hasText: leaver.username })
    await row.getByRole('button', { name: /^停用 / }).click()
    await page.getByRole('dialog').getByRole('button', { name: '停用', exact: true }).click()
    await row.getByRole('link', { name: /^转移文档 / }).click()
    await expect(page.getByRole('heading', { name: `转移 ${shownName(leaver)} 的文档` })).toBeVisible()
    const list = page.getByRole('table', { name: '个人空间里的文档' })
    await expect(list.getByText('交接清单')).toBeVisible()
    await expect(list.getByText('客户名单')).toBeVisible()

    await page.getByLabel('选择 交接清单').check()
    await page.getByLabel('目标团队空间', { exact: true }).fill(space.name)
    await page.getByRole('list', { name: '找到的团队空间', exact: true }).getByRole('button', { name: space.name, exact: true }).click()
    await page.getByRole('button', { name: '转移', exact: true }).click()
    await page.getByRole('dialog', { name: `把 1 份文档转移到 ${space.name}？` }).getByRole('button', { name: '转移', exact: true }).click()
    await expect(page.getByText(`已把 1 份文档转移到 ${space.name}`)).toBeVisible()
    await expect(list.getByText('交接清单')).toHaveCount(0)
    await expect(list.getByText('客户名单')).toBeVisible()

    await loginThroughApi(anotherDevice, receiver)
    await anotherDevice.goto(`/spaces/${space.id}`)
    await anotherDevice.getByRole('link', { name: /交接清单/ }).click()
    await expect(anotherDevice.getByRole('heading', { name: '交接清单' })).toBeVisible()
  })
})
