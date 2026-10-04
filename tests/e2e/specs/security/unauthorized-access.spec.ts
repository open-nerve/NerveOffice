// 越权访问一律被拒绝（US-M2-14、上线门槛 A03 的 E2E 关键路径；M2-P5 设计 §3.4(5)、§4，S4）：
// - 猜文档地址：看不到的文档（与分享给我的那份同在一个空间却没分享给我的、取消了分享的、有授权却进了回收站的、别人个人空间里的）
//   与不存在的文档，编辑器页的说法与整个页头逐字相同；猜空间地址（那个空间里只有一份分享给了我）与不存在的空间同样；
// - 取消分享后访问："与我共享"页还开着，点上面的链接进去，与不存在的文档相同；回到"与我共享"与搜索都没有了；
// - 降为查看者：已经打开的编辑器页下一次保存被拒，说的是服务端给的原因，没有存进去；重新打开只能查看；
// - 移出空间后访问：已经打开的编辑器页下一次保存被拒（说明存不进去了）；空间从导航里消失，空间页与不存在的相同；
//   另有单独授权的那一份改由"与我共享"打开，只能查看，页头回"与我共享"、不显示所在位置；
// - 停用后访问：停用的人被退出——已经打开的编辑器页保存时说明登录已失效，平台页面的下一次请求回到登录页，原来的密码登录不了。
// 另一个人（分享的人、空间管理员、系统管理员）在 anotherDevice 上经接口操作：他们的界面由 US-M2-10、06、04 的用例覆盖。
// documents/sharing.spec.ts（US-M2-10）已有：取消之后，已打开的编辑器页存不进去（按不存在说明）、重新打开是"内容不存在"、
// "与我共享"空了——这里不重复，改测"与我共享"页上留着的链接与搜索，另补降为查看者的那一种保存被拒。
import type { Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { createDocument, createDocumentIn, createFolderIn, createTeamSpace, createUser, grantDocument, grantsOn, revisionOf, revokeGrant } from '../../support/database.ts'
import { e2eOrigin } from '../../support/environment.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi, loginThroughUi } from '../../support/session.ts'
import { EDITOR_TEST_TIMEOUT, editorSurface, openEditor, openReader, saveButton, saveStatus, typeInCell, waitForEditor } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

/**
 * 另一个人在他自己的浏览器里经接口做的操作（取消分享、降级、移出空间、停用）：状态变更的请求带上与公开地址相同的 Origin 与他的 CSRF 令牌。
 * 请求必须成功，否则后面的"被拒绝"什么也说明不了
 */
async function actAs(page: Page, method: 'PUT' | 'POST' | 'DELETE', path: string, data?: unknown): Promise<void> {
  const { csrfToken } = await (await page.request.get('/api/auth/session')).json() as { csrfToken: string }
  const response = await page.request.fetch(path, { method, headers: { 'origin': e2eOrigin(), 'x-csrf-token': csrfToken }, ...(data === undefined ? {} : { data }) })
  expect(response.ok(), `${method} ${path}：${response.status()} ${await response.text()}`).toBe(true)
}

/** 编辑器页打不开时的样子：进入失败状态、说"内容不存在，或者你没有访问权限"；返回页头的全部文字，与别的情形逐字比较 */
async function notFoundEditor(page: Page, documentId: string): Promise<string> {
  await page.goto(`/documents/${documentId}`)
  await expect(editorSurface(page)).toHaveAttribute('data-editor-state', 'failed')
  await expect(page.getByText('内容不存在，或者你没有访问权限')).toBeVisible()
  return page.locator('#editor-chrome').innerText()
}

/** 空间页看不到时的样子：标题是"空间不存在"、说明看不到；返回主区域的全部文字 */
async function notFoundSpace(page: Page, spaceId: string): Promise<string> {
  await page.goto(`/spaces/${spaceId}`)
  await expect(page.getByRole('heading', { level: 1, name: '空间不存在' })).toBeVisible()
  await expect(page.getByText('空间不存在，或者你没有访问权限')).toBeVisible()
  return page.getByRole('main').innerText()
}

/**
 * 文档被删除、移走或失去权限之后的保存：说明存不进去了（与 editor/access.spec.ts 相同的一句）。M3-P1 起保存与心跳得知 404 都转为
 * 编辑权失效，说明相同；读不到了，不提重新加载（重新加载只会显示"内容不存在"，审查 B2）
 */
const GONE = '编辑权已失效：你已无法访问这份文档（可能已被删除、移走，或你失去了访问权限）。本页的修改没有保存，也不能再保存到这份文档，需要的话先把内容复制出来。'

test.describe('US-M2-14 越权访问一律被拒绝：关键路径', () => {
  test('US-M2-14 猜文档地址：看不到的文档与不存在的文档，编辑器页的说法与页头逐字相同；猜空间地址同样', async ({ page, anotherDevice }) => {
    const admin = await createUser('ua-guess-admin', '系统管理员', { systemRole: 'admin' })
    const lead = await createUser('ua-guess-lead', '空间管理员')
    const me = await createUser('ua-guess-me', '猜地址的人')
    const space = await createTeamSpace('猜地址', admin, [[lead, 'admin']])
    const sharedId = await createDocumentIn(space.id, lead, '分享给我的表')
    const siblingId = await createDocumentIn(space.id, lead, '同一空间里没分享的表')
    const revokedId = await createDocumentIn(space.id, lead, '取消了分享的表')
    const trashedId = await createDocumentIn(space.id, lead, '分享了却删掉的表')
    const othersId = await createDocument(lead, '别人个人空间里的表')
    for (const id of [sharedId, revokedId, trashedId])
      await grantDocument(id, me, 'viewer', lead)
    await revokeGrant(revokedId, me)
    // 空间管理员把那一份删进回收站（授权跟着文档，还在）
    await loginThroughApi(anotherDevice, lead)
    await actAs(anotherDevice, 'DELETE', `/api/documents/${trashedId}`)
    expect(await grantsOn(trashedId)).toEqual({ [me.username]: 'viewer' })

    // 前提：分享给我的那一份打得开（凭授权：页头回"与我共享"；查看者打开即阅读）
    await loginThroughApi(page, me)
    await openReader(page, sharedId)
    await expect(page.locator('#editor-chrome').getByRole('link', { name: '与我共享', exact: true })).toBeVisible()

    const shown: string[] = []
    for (const id of [siblingId, revokedId, trashedId, othersId, randomUUID()])
      shown.push(await notFoundEditor(page, id))
    expect(new Set(shown).size, shown.join('\n----\n')).toBe(1)
    for (const title of ['同一空间里没分享的表', '取消了分享的表', '分享了却删掉的表', '别人个人空间里的表'])
      expect(shown[0]).not.toContain(title)

    // 猜空间地址：那个空间里有一份分享给了我，空间本身照样与不存在的相同（授权不给空间开口子）
    const hiddenSpace = await notFoundSpace(page, space.id)
    expect(await notFoundSpace(page, randomUUID())).toBe(hiddenSpace)
    expect(hiddenSpace).not.toContain(space.name)
  })

  test('US-M2-14 取消分享后访问："与我共享"页还开着，点上面的链接进去与不存在的文档相同；回到"与我共享"与搜索都没有了', async ({ page, anotherDevice }) => {
    const owner = await createUser('ua-unshare-owner', '所有者')
    const me = await createUser('ua-unshare-me', '被取消的人')
    const documentId = await createDocument(owner, '会被取消的周报')
    await grantDocument(documentId, me, 'viewer', owner)
    await loginThroughApi(page, me)
    await page.goto('/shared')
    const link = page.getByRole('list', { name: '分享给我的文档' }).getByRole('link', { name: /会被取消的周报/ })
    await expect(link).toBeVisible()

    // 所有者在另一台设备上取消；前提：库里确实没有这条授权了
    await loginThroughApi(anotherDevice, owner)
    await actAs(anotherDevice, 'DELETE', `/api/documents/${documentId}/grants/${me.id}`)
    expect(await grantsOn(documentId)).toEqual({})

    // 页面上还留着的链接：点进去是"内容不存在"，与不存在的文档逐字相同
    await link.click()
    await expect(page).toHaveURL(new RegExp(`/documents/${documentId}$`))
    await expect(editorSurface(page)).toHaveAttribute('data-editor-state', 'failed')
    await expect(page.getByText('内容不存在，或者你没有访问权限')).toBeVisible()
    const revoked = await page.locator('#editor-chrome').innerText()
    expect(await notFoundEditor(page, randomUUID())).toBe(revoked)

    // "与我共享"与搜索里都没有了
    await page.goto('/shared')
    await expect(page.getByText('还没有人单独分享文档给你。')).toBeVisible()
    await page.goto(`/search?q=${encodeURIComponent('会被取消的周报')}`)
    await expect(page.getByText('没有找到标题包含“会被取消的周报”的文档（回收站里的不算）')).toBeVisible()
  })

  test('US-M2-14 降为查看者：已经打开的编辑器页下一次保存被拒，说的是服务端给的原因，没有存进去；重新打开只能查看', async ({ page, anotherDevice }) => {
    const owner = await createUser('ua-demote-owner', '所有者')
    const me = await createUser('ua-demote-me', '被降级的人')
    const documentId = await createDocument(owner, '会被降级的表')
    await grantDocument(documentId, me, 'editor', owner)
    await loginThroughApi(page, me)
    await openEditor(page, documentId)
    await expect(saveButton(page)).toBeVisible()
    await typeInCell(page, 'A1', '降级之后写的')

    await loginThroughApi(anotherDevice, owner)
    await actAs(anotherDevice, 'PUT', `/api/documents/${documentId}/grants/${me.id}`, { role: 'viewer' })
    expect(await grantsOn(documentId)).toEqual({ [me.username]: 'viewer' })

    // 保存（或者心跳先一步）得知失去编辑权（403）：编辑权失效，说的是服务端给的原因，本页的修改没有保存
    await saveButton(page).click()
    await expect(saveStatus(page)).toHaveText('编辑权已失效')
    await expect(page.getByRole('alert')).toContainText('编辑权已失效：你已没有编辑这份文档的权限（只能查看这份文档，不能编辑）。本页的修改没有保存：可以另存为副本，或者放弃这些修改。')
    expect(await revisionOf(documentId)).toBe(1)

    await openReader(page, documentId)
    await expect(page.locator('#editor-chrome').getByRole('banner').getByText('只能查看', { exact: true })).toBeVisible()
    await expect(saveButton(page)).toHaveCount(0)
  })

  test('US-M2-14 移出空间后访问：已经打开的编辑器页保存被拒；空间从导航里消失、空间页与不存在的相同；另有授权的那一份改由"与我共享"打开，只能查看、不显示所在位置', async ({ page, anotherDevice }) => {
    const admin = await createUser('ua-remove-admin', '系统管理员', { systemRole: 'admin' })
    const lead = await createUser('ua-remove-lead', '空间管理员')
    const me = await createUser('ua-remove-me', '被移出的人')
    const space = await createTeamSpace('会被移出', admin, [[lead, 'admin'], [me, 'editor']])
    const folderId = await createFolderIn(space.id, lead, '部门目录')
    const workingId = await createDocumentIn(space.id, lead, '正在改的表', { folderId })
    const sharedId = await createDocumentIn(space.id, lead, '另外分享给我的表', { folderId })
    await grantDocument(sharedId, me, 'viewer', lead)

    await loginThroughApi(page, me)
    await page.goto(`/spaces/${space.id}`)
    await expect(page.getByText('我的角色：编辑者')).toBeVisible()
    await openEditor(page, workingId)
    await typeInCell(page, 'A1', '移出之后写的')

    // 空间管理员在另一台设备上把我移出
    await loginThroughApi(anotherDevice, lead)
    await actAs(anotherDevice, 'DELETE', `/api/spaces/${space.id}/members/${me.id}`)

    await saveButton(page).click()
    await expect(saveStatus(page)).toHaveText('编辑权已失效')
    await expect(page.getByRole('alert')).toContainText(GONE)
    await expect(page.getByRole('alert').getByRole('button')).toHaveCount(0)
    expect(await revisionOf(workingId)).toBe(1)

    // 空间页与不存在的空间逐字相同；导航里没有这个空间了
    const hiddenSpace = await notFoundSpace(page, space.id)
    await expect(page.getByRole('navigation', { name: '空间' }).getByRole('link', { name: space.name })).toHaveCount(0)
    expect(await notFoundSpace(page, randomUUID())).toBe(hiddenSpace)

    // 另有单独授权的那一份：在"与我共享"里，打开只能查看，页头回"与我共享"、不显示所在的文件夹
    await page.goto('/shared')
    const item = page.getByRole('list', { name: '分享给我的文档' }).getByRole('listitem').filter({ hasText: '另外分享给我的表' })
    await expect(item).toContainText(`${space.name} · 只能查看`)
    await expect(page.getByText('部门目录')).toHaveCount(0)
    await item.getByRole('link').click()
    await expect(page).toHaveURL(new RegExp(`/documents/${sharedId}$`))
    await waitForEditor(page)
    const header = page.locator('#editor-chrome').getByRole('banner')
    await expect(header.getByText('只能查看', { exact: true })).toBeVisible()
    await expect(header.getByRole('link', { name: '与我共享', exact: true })).toHaveAttribute('href', '/shared')
    await expect(header).not.toContainText('部门目录')
    await expect(saveButton(page)).toHaveCount(0)
  })

  test('US-M2-14 停用后访问：停用的人被退出——已经打开的编辑器页保存时说明登录已失效，平台页面的下一次请求回到登录页，原来的密码登录不了', async ({ page, anotherDevice }) => {
    const admin = await createUser('ua-disable-admin', '系统管理员', { systemRole: 'admin' })
    const owner = await createUser('ua-disable-owner', '所有者')
    const me = await createUser('ua-disable-me', '被停用的人')
    const documentId = await createDocument(owner, '停用之前分享的表')
    await grantDocument(documentId, me, 'editor', owner)
    await loginThroughApi(page, me)
    await openEditor(page, documentId)
    await expect(saveButton(page)).toBeVisible()
    await typeInCell(page, 'A1', '停用之后写的')

    // 系统管理员在另一台设备上停用我
    await loginThroughApi(anotherDevice, admin)
    await actAs(anotherDevice, 'POST', `/api/admin/users/${me.id}/disable`)

    // 编辑器页：会话已经撤销，说明登录已失效、本页的修改还在（不整页跳走），什么也没存进去。
    // 保存与心跳续租都会得知（M3-P1）：保存先到时页头的保存状态是"保存失败"，心跳先到时按保存只确认会话、不发保存，仍是"有未保存的修改"；
    // 两条路的说明相同，不断言是哪一条
    await saveButton(page).click()
    await expect(page.getByRole('alert').filter({ hasText: '本页的修改还在' })).toBeVisible()
    await expect(saveStatus(page)).toHaveText(/^(?:保存失败|有未保存的修改)$/)
    expect(await revisionOf(documentId)).toBe(1)

    // 平台页面：下一次请求回到登录页；原来的密码登录不了，说法与密码错误相同
    await page.goto('/shared')
    await expect(page).toHaveURL(/\/login/)
    await loginThroughUi(page, me)
    await expect(page.getByRole('alert')).toHaveText('用户名或密码错误')
    // 授权还在：停用可以撤回，启用之后照常生效（documents/sharing.test.ts 的集成用例）
    expect(await grantsOn(documentId)).toEqual({ [me.username]: 'editor' })
  })
})
