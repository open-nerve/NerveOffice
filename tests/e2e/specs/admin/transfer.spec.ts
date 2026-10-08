// 停用者文档的转移（M2-P2，US-M2-04）：系统管理员停用账户之后，在转移页只看得到标题，选文档与目标团队空间，确认之后转移；
// 结果的说明等确认框关掉、焦点交还之后才写进状态区，写进去的那一刻不在 aria-hidden 之下，读屏读得到（M2-P5 复验 S1，support/status-writes.ts）；
// 空间的成员随即能打开这些文档。系统管理员打不开停用者的文档。
// 长列表之后转移：说明写进列表上方的状态区时下面的内容整体下移，焦点交还的"转移"由状态区的 keepFocusInView 滚回可视区域（M3-P6 复验）；
// "有文档已经不在了"的说明插在"转移"正上方，同样由共用的 useKeepFocusInView 把它滚回来（再复核 D5）。
import type { Page } from '@playwright/test'
import { createDocument, createDocuments, createTeamSpace, createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { searchList } from '../../support/list-search.ts'
import { shownName } from '../../support/people.ts'
import { actAs, loginThroughApi } from '../../support/session.ts'
import { expectWrittenAfterClose, recordStatusWrites, statusWrites } from '../../support/status-writes.ts'

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
    // 等搜索的过滤完成再操作这一行（support/list-search.ts）
    await searchList(page, '按名字或登录名搜索', leaver.username)
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
    // 结果的说明：页面上的状态区一直在（空的时候只做视觉隐藏），记下它们每一次内容变化的那一刻
    await recordStatusWrites(page.locator('[data-slot="status-region"]'))
    await page.getByRole('button', { name: '转移', exact: true }).click()
    const confirm = page.getByRole('dialog', { name: `把 1 份文档转移到 ${space.name}？` })
    await confirm.getByRole('button', { name: '转移', exact: true }).click()
    await expect(confirm).toHaveCount(0)
    const done = page.getByRole('status').filter({ hasText: '已把 1 份文档转移到' })
    await expect(done).toHaveText(`已把 1 份文档转移到 ${space.name}`)
    await expect(done).toBeVisible()
    // 确认框开着时 Radix 把页面标为 aria-hidden：说明等它关掉、焦点交还之后才写，写进去的那一刻读屏读得到
    await expectWrittenAfterClose(page, `已把 1 份文档转移到 ${space.name}`)
    await expect(list.getByText('交接清单')).toHaveCount(0)
    await expect(list.getByText('客户名单')).toBeVisible()

    // 再把"客户名单"转移到同一个空间：得到同样的说法（M2-P5 复验第二轮 G2）。打开确认框时清掉上一次的说明，确认之后再写一次——
    // 同样的文字照样是状态区的一次变化，读屏照样播报；不清掉的话，关掉之后状态区没有任何变化
    await page.getByLabel('选择 客户名单').check()
    await page.getByRole('button', { name: '转移', exact: true }).click()
    const again = page.getByRole('dialog', { name: `把 1 份文档转移到 ${space.name}？` })
    await expect(again).toBeVisible()
    // 确认框开着时状态区在 aria-hidden 之下，按角色找不到：直接看页面上的状态区，哪一个里也没有上一次的说明了
    await expect(page.locator('[data-slot="status-region"]').filter({ hasText: '已把' })).toHaveCount(0)
    await again.getByRole('button', { name: '转移', exact: true }).click()
    await expect(again).toHaveCount(0)
    await expect(done).toHaveText(`已把 1 份文档转移到 ${space.name}`)
    expect(await statusWrites(page, `已把 1 份文档转移到 ${space.name}`)).toHaveLength(2)
    await expectWrittenAfterClose(page, `已把 1 份文档转移到 ${space.name}`)
    await expect(list.getByText('客户名单')).toHaveCount(0)

    await loginThroughApi(anotherDevice, receiver)
    await anotherDevice.goto(`/spaces/${space.id}`)
    await anotherDevice.getByRole('link', { name: /交接清单/ }).click()
    await expect(anotherDevice.getByRole('heading', { name: '交接清单' })).toBeVisible()
  })

  test('长列表之后用键盘转移：结果的说明写进列表上方的状态区之后，焦点交还的"转移"仍整个在可视区域里（状态区空的时候不占位置，写进说明时下面的内容整体下移，M3-P6 复验）', async ({ page }) => {
    const admin = await createUser('trlong-admin', '管理员', { systemRole: 'admin' })
    const leaver = await createUser('trlong-leaver', '离职的同事')
    const space = await createTeamSpace('长列表的去处', admin)
    // 一长串文档："转移"在页面最下面，用键盘走到它时页面滚到底
    await createDocuments(leaver, '旧文档', 25)
    await loginThroughApi(page, admin)
    await actAs(page, 'POST', `/api/admin/users/${leaver.id}/disable`)
    await page.goto(`/admin/users/${leaver.id}/documents`)
    await expect(page.getByRole('table', { name: '个人空间里的文档' }).getByRole('row')).toHaveCount(26)
    await page.getByLabel('选择 旧文档 1', { exact: true }).check()
    await page.getByLabel('目标团队空间', { exact: true }).fill(space.name)
    await page.getByRole('list', { name: '找到的团队空间', exact: true }).getByRole('button', { name: space.name, exact: true }).click()
    const submit = page.getByRole('button', { name: '转移', exact: true })
    await submit.focus()
    await page.keyboard.press('Enter')
    const confirm = page.getByRole('dialog', { name: `把 1 份文档转移到 ${space.name}？` })
    await confirm.getByRole('button', { name: '转移', exact: true }).click()
    await expect(confirm).toHaveCount(0)
    await expect(page.getByRole('status').filter({ hasText: '已把 1 份文档转移到' })).toHaveText(`已把 1 份文档转移到 ${space.name}`)
    await expect(submit).toBeFocused()
    await expect(submit).toBeInViewport({ ratio: 1 })
  })

  test('长列表之后用键盘转移、选中的文档在确认之前已被别人转走：确认框关掉之后"有文档已经不在了"的说明插在"转移"正上方，焦点交还的"转移"仍整个在可视区域里（M3-P6 再复核 D5）', async ({ page }) => {
    const admin = await createUser('trconf-admin', '管理员', { systemRole: 'admin' })
    const leaver = await createUser('trconf-leaver', '离职的同事')
    const space = await createTeamSpace('长列表的去处', admin)
    await createDocuments(leaver, '旧文档', 25)
    await loginThroughApi(page, admin)
    await actAs(page, 'POST', `/api/admin/users/${leaver.id}/disable`)
    await page.goto(`/admin/users/${leaver.id}/documents`)
    await expect(page.getByRole('table', { name: '个人空间里的文档' }).getByRole('row')).toHaveCount(26)
    await page.getByLabel('选择 旧文档 1', { exact: true }).check()
    await page.getByLabel('目标团队空间', { exact: true }).fill(space.name)
    await page.getByRole('list', { name: '找到的团队空间', exact: true }).getByRole('button', { name: space.name, exact: true }).click()
    // 确认之前，"旧文档 1"已经被别人转走
    await actAs(page, 'POST', `/api/admin/users/${leaver.id}/documents/transfer`, { documentIds: [await documentIdOf(page, leaver.id, '旧文档 1')], target: { type: 'team', spaceId: space.id } })
    const submit = page.getByRole('button', { name: '转移', exact: true })
    await submit.focus()
    await page.keyboard.press('Enter')
    const confirm = page.getByRole('dialog', { name: `把 1 份文档转移到 ${space.name}？` })
    await confirm.getByRole('button', { name: '转移', exact: true }).click()
    await expect(confirm).toHaveCount(0)
    await expect(page.getByRole('alert').filter({ hasText: '有文档已经不在' })).toBeVisible()
    await expect(submit).toBeFocused()
    await expect(submit).toBeInViewport({ ratio: 1 })
  })
})

/** 停用者个人空间里这份文档的 id（经管理界面的接口按标题找） */
async function documentIdOf(page: Page, userId: string, title: string): Promise<string> {
  const response = await page.request.get(`/api/admin/users/${userId}/documents`)
  expect(response.status(), await response.text()).toBe(200)
  const { items } = await response.json() as { items: { id: string, title: string }[] }
  const found = items.find(item => item.title === title)
  if (found === undefined)
    throw new Error(`找不到"${title}"`)
  return found.id
}
