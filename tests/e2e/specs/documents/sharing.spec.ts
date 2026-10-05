// 单独分享（M2-P5 设计 §3.5、§4 的 E2E 一行，US-M2-10）：
// - 分享对话框：按名字搜同事（等过滤的响应回来再操作，support/list-search.ts）、给查看者与编辑者、调整、取消，每一步都核对库里的授权；
//   做完一件事的说明写进一直在的状态区，取消之后的说明等确认框关掉、焦点交还之后才写（写进去的那一刻不在 aria-hidden 之下，
//   support/status-writes.ts）；
// - 对方在"与我共享"里看到并打开：查看者只读、编辑者能改；只凭授权的人看不到所在位置（团队空间里的文件夹），没有移动、删除与分享的入口
//   （行操作只有复制，编辑者另有改名：documents/copy.spec.ts 的 US-M2-08），编辑器页的返回链接回"与我共享"；个人空间按所有者的人名呈现；
// - 取消之后立即不能访问：另一台设备上已经打开的页面存不进去，重新打开是"内容不存在"；
// - 编辑者看不到分享入口（行操作与编辑器的页头），空间管理员看得到（对照）；
// - 编辑器页头的分享：对话框里输入不改动表格；对话框开着时保存完成或失败，页头的保存状态写进结果的那一刻不在 aria-hidden 之下；
// - 对话框的代码没能下载下来：入口旁边说明，可以重试；
// - 授权列表第一次就没取到：用键盘按"重试"，进行中按钮不卸载，取到之后焦点交给对话框里的说明（规范 §2.4，M3-P2 收尾）。
// 人名按 support/people.ts 的写法断言（登录名在前）。US-M2-10 在 S4 改为 active（tests/stories.json）；
// 越权访问的关键路径（猜地址、取消分享与移出空间、停用之后的访问）在 security/unauthorized-access.spec.ts（US-M2-14）。
import type { Locator, Page, Route } from '@playwright/test'
import { createDocument, createDocumentIn, createFolderIn, createTeamSpace, createUser, grantDocument, grantsOn } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { searchList } from '../../support/list-search.ts'
import { plainName, shownName } from '../../support/people.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, EDITOR_TEST_TIMEOUT, enterEditing, headerAnnouncement, openAndEnterEditing, openReader, saveAndWait, saveButton, savedContent, saveStatus, typeInCell } from '../../support/sheet.ts'
import { expectWrittenAfterClose, recordStatusWrites, spokenWrites } from '../../support/status-writes.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

/**
 * 展开一行的操作面板，等到面板里的操作出现（权限已经取到）。按文档列表限定：团队空间的空间管理员在页头另有一个"改名"（空间改名），
 * 不限定的话面板还没出来时就会先认到页头那个
 */
async function openActions(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: `操作 ${title}`, exact: true }).click()
  await expect(page.getByRole('list', { name: '文档列表' }).getByRole('button', { name: '改名', exact: true })).toBeVisible()
}

/** 点"分享"，等对话框出现、授权列表加载完 */
async function openShareDialog(page: Page, title: string): Promise<Locator> {
  await page.getByRole('button', { name: '分享', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: `分享「${title}」` })
  await expect(dialog.getByRole('heading', { name: '已分享给', exact: true })).toBeVisible()
  return dialog
}

/** 在对话框里按登录名找到同事并选中：等过滤的响应回来再点候选 */
async function pickColleague(page: Page, dialog: Locator, person: { readonly username: string, readonly displayName: string }): Promise<void> {
  await searchList(page, '要分享给的同事', person.username)
  await dialog.getByRole('list', { name: '找到的同事' }).getByRole('button', { name: shownName(person), exact: true }).click()
  await expect(dialog.getByText(`已选择：${shownName(person)}`)).toBeVisible()
}

function sharedNav(page: Page): Locator {
  return page.getByRole('navigation', { name: '空间' }).getByRole('link', { name: '与我共享', exact: true })
}

test.describe('US-M2-10 单独分享', () => {
  test('授权列表第一次就没取到之后用键盘按"重试"：重试期间说明与同一个按钮留着（不可用、说正在重试），焦点还在按钮上；取到之后焦点交给对话框里一直在的说明，不落到对话框本身（规范 §2.4）', async ({ page }) => {
    const owner = await createUser('sh-retry', '所有者')
    const reader = await createUser('sh-retry-reader', '读者')
    const documentId = await createDocument(owner, '重试的表')
    await grantDocument(documentId, reader, 'viewer', owner)
    await loginThroughApi(page, owner)
    await page.goto('/')
    await openActions(page, '重试的表')
    // 只拦这份文档的授权列表：服务暂时不可用（查询自动重试一次之后才算失败）
    const isGrants = (url: URL): boolean => url.pathname === `/api/documents/${documentId}/grants`
    await page.route(isGrants, async route => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: '服务暂时不可用', requestId: 'e2e' } }),
    }))
    await page.getByRole('button', { name: '分享', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '分享「重试的表」' })
    const problem = dialog.getByRole('alert').filter({ hasText: '分享的情况没能加载' })
    await expect(problem).toContainText('服务暂时不可用，请稍后重试')
    // 说明里只有这一个按钮：按名称找的话，它改说"正在重试…"之后就找不到了
    const retry = problem.getByRole('button')
    await expect(retry).toHaveText('重试')

    // 恢复之前先挂住重试的那一次请求，看进行中的样子；放开之后照常发给后端
    let release: () => void = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.unroute(isGrants)
    await page.route(isGrants, async (route) => {
      await released
      await route.continue()
    })
    await retry.focus()
    await page.keyboard.press('Enter')
    await expect(retry).toHaveText('正在重试…')
    await expect(retry).toHaveAttribute('aria-disabled', 'true')
    await expect(retry).toHaveAttribute('aria-busy', 'true')
    await expect(retry).toBeFocused()
    await expect(dialog.getByRole('status', { name: '正在加载分享的情况…' })).toHaveCount(0)

    release()
    await expect(dialog.getByRole('list', { name: '已分享给' }).getByRole('listitem')).toHaveCount(1)
    await expect(dialog.getByRole('list', { name: '已分享给' })).toContainText(shownName(reader))
    await expect(problem).toHaveCount(0)
    await expect(dialog.getByText(/^分享给同事之后，对方在"与我共享"里看得到这份文档。/)).toBeFocused()
  })

  test('分享对话框：按名字搜同事，给查看者与编辑者，调整，取消；每一步都写进了库', async ({ page }) => {
    const owner = await createUser('sh-owner', '所有者')
    const reader = await createUser('sh-reader', '读者')
    const writer = await createUser('sh-writer', '写手')
    const documentId = await createDocument(owner, '要分享的表')
    await loginThroughApi(page, owner)
    await page.goto('/')
    await openActions(page, '要分享的表')
    const dialog = await openShareDialog(page, '要分享的表')
    await expect(dialog.getByText('还没有单独分享给任何人。')).toBeVisible()
    // 做完一件事的说明（对话框自己的状态区）：打开之后、做任何事之前就在无障碍树里，内容出现时读屏才会播报——与内容一起出现的状态区
    // 部分读屏不播报（M2-P5 审查 B 的 M1：原来空的时候是 display: none，按角色找不到）。现在空的时候只做视觉隐藏：按角色找得到
    // （getByRole 不认不在无障碍树里的元素），是空的
    const notice = dialog.locator(':scope > [data-slot="status-region"]')
    await expect(dialog.getByRole('status').and(notice)).toHaveCount(1)
    await expect(notice).toBeEmpty()
    expect(await notice.evaluate(element => getComputedStyle(element).display)).not.toBe('none')

    // 给查看者（默认的角色）：说明填进了那个一直在的状态区
    await pickColleague(page, dialog, reader)
    await dialog.getByRole('button', { name: '分享', exact: true }).click()
    await expect(dialog.getByRole('status').and(notice)).toHaveText(`已分享给 ${shownName(reader)}（查看者）`)
    await expect(dialog.getByRole('combobox', { name: `${plainName(reader)} 的角色` })).toHaveValue('viewer')
    // 给编辑者：已经有授权的人不再是候选
    await pickColleague(page, dialog, writer)
    await dialog.getByLabel('角色', { exact: true }).selectOption({ label: '编辑者' })
    await dialog.getByRole('button', { name: '分享', exact: true }).click()
    await expect(dialog.getByRole('combobox', { name: `${plainName(writer)} 的角色` })).toHaveValue('editor')
    expect(await grantsOn(documentId)).toEqual({ [reader.username]: 'viewer', [writer.username]: 'editor' })
    await searchList(page, '要分享给的同事', reader.username)
    await expect(dialog.getByText('没有找到这个人')).toBeVisible()

    // 调整：选好之后点"保存"才提交
    await dialog.getByRole('combobox', { name: `${plainName(reader)} 的角色` }).selectOption({ label: '编辑者' })
    await dialog.getByRole('button', { name: `保存 ${plainName(reader)} 的角色`, exact: true }).click()
    await expect(dialog.getByRole('listitem').filter({ hasText: shownName(reader) })).toHaveAttribute('aria-busy', 'false')
    await expect.poll(async () => grantsOn(documentId)).toEqual({ [reader.username]: 'editor', [writer.username]: 'editor' })

    // 取消：先确认。说明等确认框关掉之后才写进状态区（M2-P5 复验 S1）：确认框开着时 Radix 把它之外的内容（这个对话框）标为
    // aria-hidden，那时写进去的读屏多半不播报，确认框关掉之后文字不再变化，也不会补播。记下状态区每一次内容变化的那一刻
    await recordStatusWrites(notice)
    await dialog.getByRole('button', { name: `取消分享 ${plainName(writer)}`, exact: true }).click()
    const confirm = page.getByRole('dialog', { name: `取消分享给 ${plainName(writer)}？` })
    await confirm.getByRole('button', { name: '取消分享', exact: true }).click()
    await expect(confirm).toHaveCount(0)
    await expect(dialog.getByRole('status').and(notice)).toHaveText(`已取消分享给 ${shownName(writer)}`)
    await expectWrittenAfterClose(page, `已取消分享给 ${shownName(writer)}`)
    await expect(dialog.getByRole('combobox', { name: `${plainName(writer)} 的角色` })).toHaveCount(0)
    expect(await grantsOn(documentId)).toEqual({ [reader.username]: 'editor' })

    // 关闭之后焦点回到入口
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: '分享', exact: true })).toBeFocused()
  })

  test('对方在"与我共享"里看到并打开：查看者只读，编辑者能改；看不到所在位置，没有移动与删除的入口，返回链接回"与我共享"', async ({ page, anotherDevice }) => {
    const admin = await createUser('sh-open-admin', '系统管理员', { systemRole: 'admin' })
    const lead = await createUser('sh-open-lead', '空间管理员')
    const reader = await createUser('sh-open-reader', '读者')
    const writer = await createUser('sh-open-writer', '写手')
    const space = await createTeamSpace('共享来源部', admin, [[lead, 'admin']])
    const folderId = await createFolderIn(space.id, lead, '机密目录')
    const documentId = await createDocumentIn(space.id, lead, '部门的周报', { folderId })
    const personalDocument = await createDocument(lead, '个人的计划')
    await grantDocument(documentId, reader, 'viewer', lead)
    await grantDocument(documentId, writer, 'editor', lead)
    await grantDocument(personalDocument, reader, 'viewer', lead)

    // 查看者：导航里的"与我共享"
    await loginThroughApi(page, reader)
    await page.goto('/')
    await sharedNav(page).click()
    await expect(page.getByRole('heading', { level: 1, name: '与我共享' })).toBeVisible()
    const list = page.getByRole('list', { name: '分享给我的文档' })
    const team = list.getByRole('listitem').filter({ hasText: '部门的周报' })
    await expect(team).toContainText(`${space.name} · 只能查看`)
    await expect(list.getByRole('listitem').filter({ hasText: '个人的计划' })).toContainText(`${shownName(lead)} 的个人空间 · 只能查看`)
    // 不显示所在位置（团队空间里的文件夹）；行操作按权限只给能做的：只凭授权的查看者只能复制，没有移动、删除与分享
    // （结构性的操作只给空间里有角色的人；"与我共享"里的复制与改名见 documents/copy.spec.ts 的 US-M2-08，Codex 对抗评审 CX3）
    await expect(page.getByText('机密目录')).toHaveCount(0)
    await team.getByRole('button', { name: '操作 部门的周报', exact: true }).click()
    await expect(team.getByRole('button', { name: '复制', exact: true })).toBeVisible()
    await expect(team.getByRole('button', { name: /^(?:改名|移动|删除|分享)$/ })).toHaveCount(0)
    await team.getByRole('button', { name: '取消', exact: true }).click()
    await team.getByRole('link').click()
    await expect(page).toHaveURL(new RegExp(`/documents/${documentId}$`))
    await expect(page.locator('#sheet-editor')).toHaveAttribute('data-editor-state', /^(?:ready|steady)$/, { timeout: 30_000 })
    const header = page.locator('#editor-chrome').getByRole('banner')
    await expect(saveStatus(page)).toHaveText('只能查看')
    await expect(saveButton(page)).toHaveCount(0)
    await expect(header.getByRole('link', { name: '与我共享', exact: true })).toHaveAttribute('href', '/shared')
    await expect(header).not.toContainText(space.name)
    await expect(header.getByRole('button', { name: /分享|移动|删除/ })).toHaveCount(0)

    // 编辑者：能改（打开即阅读，点"编辑"进入编辑），保存成功；返回链接同样回"与我共享"
    await loginThroughApi(anotherDevice, writer)
    await anotherDevice.goto('/shared')
    await anotherDevice.getByRole('list', { name: '分享给我的文档' }).getByRole('link', { name: /部门的周报/ }).click()
    await expect(anotherDevice.locator('#sheet-editor')).toHaveAttribute('data-editor-state', /^(?:ready|steady)$/, { timeout: 30_000 })
    await expect(anotherDevice.locator('#editor-chrome').getByRole('banner').getByRole('link', { name: '与我共享', exact: true })).toBeVisible()
    await enterEditing(anotherDevice)
    await typeInCell(anotherDevice, 'A1', '编辑者写的')
    await saveAndWait(anotherDevice)

    // 搜索结果里同样不带所在位置：团队空间写名称，没有文件夹路径
    await page.goto(`/search?q=${encodeURIComponent('部门的周报')}`)
    const result = page.getByRole('list', { name: '搜索结果' }).getByRole('listitem')
    await expect(result).toHaveCount(1)
    await expect(result).toContainText(`${space.name} · 更新于`)
    await expect(result).not.toContainText('机密目录')
  })

  test('取消之后立即不能访问：另一台设备上已经打开的页面存不进去，重新打开是"内容不存在"，"与我共享"里也没有了', async ({ page, anotherDevice }) => {
    const owner = await createUser('sh-revoke-owner', '所有者')
    const friend = await createUser('sh-revoke-friend', '同事')
    const documentId = await createDocument(owner, '会被取消的表')
    await grantDocument(documentId, friend, 'editor', owner)

    // 同事在另一台设备上打开着（能编辑）
    await loginThroughApi(anotherDevice, friend)
    await openAndEnterEditing(anotherDevice, documentId)
    await expect(saveButton(anotherDevice)).toBeVisible()

    // 所有者经对话框取消
    await loginThroughApi(page, owner)
    await page.goto('/')
    await openActions(page, '会被取消的表')
    const dialog = await openShareDialog(page, '会被取消的表')
    await dialog.getByRole('button', { name: `取消分享 ${plainName(friend)}`, exact: true }).click()
    await page.getByRole('dialog', { name: `取消分享给 ${plainName(friend)}？` }).getByRole('button', { name: '取消分享', exact: true }).click()
    await expect(dialog.getByText('还没有单独分享给任何人。')).toBeVisible()
    // 前提：确实取消成功了（库里已经没有这条授权），下面的"不能访问"才说明问题
    expect(await grantsOn(documentId)).toEqual({})

    // 已经打开的页面：保存被拒绝（按不存在回答），编辑权失效（M3-P1 起保存与心跳得知都一样）
    await typeInCell(anotherDevice, 'A1', '取消之后写的')
    await saveButton(anotherDevice).click()
    await expect(saveStatus(anotherDevice)).toHaveText('编辑权已失效')
    await expect(anotherDevice.getByRole('alert')).toContainText('你已无法访问这份文档（可能已被删除、移走，或你失去了访问权限）。本页的修改没有保存')
    // 重新打开：内容不存在；"与我共享"里也没有了
    await anotherDevice.goto(`/documents/${documentId}`)
    await expect(anotherDevice.getByText('内容不存在，或者你没有访问权限')).toBeVisible()
    await anotherDevice.goto('/shared')
    await expect(anotherDevice.getByText('还没有人单独分享文档给你。')).toBeVisible()
  })

  test('编辑者看不到分享入口（行操作与编辑器的页头）；空间管理员看得到', async ({ page, anotherDevice }) => {
    const admin = await createUser('sh-entry-admin', '系统管理员', { systemRole: 'admin' })
    const lead = await createUser('sh-entry-lead', '空间管理员')
    const editor = await createUser('sh-entry-editor', '编辑者')
    const space = await createTeamSpace('分享入口', admin, [[lead, 'admin'], [editor, 'editor']])
    const documentId = await createDocumentIn(space.id, lead, '部门的表')

    // 编辑者：面板里的操作已经取到（能改名），没有"分享"；编辑器能保存，页头没有"分享"
    await loginThroughApi(page, editor)
    await page.goto(`/spaces/${space.id}`)
    await openActions(page, '部门的表')
    await expect(page.getByRole('button', { name: '分享', exact: true })).toHaveCount(0)
    await openAndEnterEditing(page, documentId)
    await expect(saveButton(page)).toBeVisible()
    await expect(page.locator('#editor-chrome').getByRole('button', { name: '分享', exact: true })).toHaveCount(0)

    // 对照：空间管理员两处都有（编辑者正在编辑：空间管理员打开即阅读，页头照样有"分享"）
    await loginThroughApi(anotherDevice, lead)
    await anotherDevice.goto(`/spaces/${space.id}`)
    await openActions(anotherDevice, '部门的表')
    await expect(anotherDevice.getByRole('button', { name: '分享', exact: true })).toBeVisible()
    await openReader(anotherDevice, documentId)
    await expect(anotherDevice.locator('#editor-chrome').getByRole('button', { name: '分享', exact: true })).toBeVisible()
  })

  test('编辑器页头的分享：打开对话框加人；在对话框里输入不改动表格；关闭之后焦点回到入口', async ({ page }) => {
    const owner = await createUser('sh-editor-owner', '所有者')
    const colleague = await createUser('sh-editor-colleague', '同事')
    const documentId = await createDocument(owner, '编辑器里分享的表')
    await loginThroughApi(page, owner)
    await openAndEnterEditing(page, documentId, 'steady')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    await page.locator('#editor-chrome').getByRole('button', { name: '分享', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '分享「编辑器里分享的表」' })
    await expect(dialog.getByText('还没有单独分享给任何人。')).toBeVisible()
    // 逐个键入（不是直接填值）：按键落在对话框的输入框里，编辑器不把它们当成单元格的输入。等这个关键词的候选出现再点
    await dialog.getByLabel('要分享给的同事', { exact: true }).pressSequentially(colleague.username)
    await dialog.getByRole('list', { name: '找到的同事' }).getByRole('button', { name: shownName(colleague), exact: true }).click()
    await dialog.getByRole('button', { name: '分享', exact: true }).click()
    await expect(dialog.getByRole('combobox', { name: `${plainName(colleague)} 的角色` })).toHaveValue('viewer')
    expect(await grantsOn(documentId)).toEqual({ [colleague.username]: 'viewer' })
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('#editor-chrome').getByRole('button', { name: '分享', exact: true })).toBeFocused()
    // 对话框里的输入没有进表格：关掉之后，页头的保存状态仍是没有未保存的修改
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    // 只看保存状态挡不住"输入落进了单元格、还在编辑没提交"（M2-P5 审查 B 的 G4）：点别的单元格写一个对照的值、保存——
    // 单元格里还在编辑的内容随选区移走一起提交，存下来的内容里只有这个对照的值，没有对话框里键入的登录名
    await typeInCell(page, 'C3', '对照')
    await saveAndWait(page)
    const saved = await savedContent(page, documentId)
    expect(cellOf(saved.snapshot, 'C3')?.v).toBe('对照')
    expect(saved.text).not.toContain(colleague.username)
  })

  // 保存在后台进行，分享对话框（模态）开着时也会完成或失败（M2-P5 复验第二轮 G1）：Radix 打开模态弹窗时把它之外的内容都标为 aria-hidden，
  // 只跳过那一刻已经在的、显式写了 aria-live 的元素。页头读屏的播报区显式写了它：播报写进去的那一刻不在 aria-hidden 之下，读屏照样播报。
  // 这时焦点在对话框里是对的（结果不是对话框里的操作引起的），只看写进去的那一刻在不在无障碍树里（support/status-writes.ts 的 hidden）。
  // 被拦住的保存放行时（respond）：完成照常发出；失败回 502（代理出错），另有一条详细说明的提示条（role="alert"）随失败插入。
  // M3-P4（设计 §3.9）：看得见的保存状态与读屏的播报区分开，读屏只播有意义的变化——例行的"保存中… → 已保存到云端"只改看得见的文字、
  // 不播（announcements 为空）；失败（会自动重试）要播
  const BACKGROUND_SAVES = [
    { outcome: '完成', user: 'sh-modal-saved', respond: async (route: Route) => route.continue(), status: '已保存到云端', announcements: [], failureNotices: 0 },
    { outcome: '失败', user: 'sh-modal-failed', respond: async (route: Route) => route.fulfill({ status: 502, contentType: 'text/html', body: 'bad gateway' }), status: '保存失败，稍后自动重试', announcements: ['保存失败，稍后自动重试'], failureNotices: 1 },
  ] as const
  for (const save of BACKGROUND_SAVES) {
    test(`编辑器页开着分享对话框时保存${save.outcome}：要播的结果写进页头的播报区的那一刻不在 aria-hidden 之下；保存失败的详细说明在对话框关掉之后读得到`, async ({ page }) => {
      const owner = await createUser(save.user, '所有者')
      const title = `开着对话框保存${save.outcome}的表`
      const documentId = await createDocument(owner, title)
      await loginThroughApi(page, owner)
      await openAndEnterEditing(page, documentId, 'steady')
      await expect(saveStatus(page)).toHaveText('已保存到云端')
      await typeInCell(page, 'B2', '后台保存')
      await expect(saveStatus(page)).toHaveText('有未保存的修改')
      // 拦住保存的请求，等分享对话框打开之后再放行
      let release: () => void = () => {}
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      await page.route('**/api/documents/*/content?*', async (route) => {
        if (route.request().method() !== 'PUT') {
          await route.continue()
          return
        }
        await released
        await save.respond(route)
      })
      await recordStatusWrites(headerAnnouncement(page))
      await saveButton(page).click()
      await expect(saveStatus(page)).toHaveText('保存中…')
      await page.locator('#editor-chrome').getByRole('button', { name: '分享', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: `分享「${title}」` })
      await expect(dialog.getByText('还没有单独分享给任何人。')).toBeVisible()
      // 前提：对话框开着，页头的其余部分已经对读屏隐藏（保存按钮按角色找不到）
      await expect(saveButton(page)).toHaveCount(0)
      release()
      await expect(saveStatus(page)).toHaveText(save.status)
      // 播报区写过的话（例行的完成一句也没有）；写进去的那一刻对话框还开着，播报区不在 aria-hidden、inert、hidden 之下
      await expect.poll(async () => (await spokenWrites(page)).map(write => write.text)).toEqual(save.announcements)
      await expect(dialog).toBeVisible()
      expect((await spokenWrites(page)).map(write => write.hidden)).toEqual(save.announcements.map(() => false))
      await dialog.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      // 保存失败的详细说明（提示条，随失败插入）：对话框开着时在 aria-hidden 之下，关掉之后读得到
      await expect(page.getByRole('alert').filter({ hasText: '保存失败：' })).toHaveCount(save.failureNotices)
    })
  }

  test('分享对话框的代码没能下载下来：入口旁边说明没能加载、可以重试（整页重新加载）；代码取得到之后照常打开', async ({ page }) => {
    const owner = await createUser('sh-chunk-owner', '所有者')
    await createDocument(owner, '代码下载失败的表')
    await loginThroughApi(page, owner)
    await page.goto('/')
    await openActions(page, '代码下载失败的表')
    // 之后请求的脚本一律失败（相当于这一块下载不下来：服务端暂时给不出来）；入口页照常取得到（服务器连得上、版本也没变）
    await page.route('**/assets/*.js', async route => route.fulfill({ status: 503, headers: { 'cache-control': 'no-store' }, body: '' }))
    await page.getByRole('button', { name: '分享', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('没能加载分享：它的代码没能下载下来（服务器连得上，版本也没有变）。可以重试；一直这样的话，请告诉管理员。')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    // 页面的其余部分照常；焦点留在入口上
    await expect(page.getByRole('heading', { level: 1, name: '我的空间' })).toBeVisible()
    await page.unroute('**/assets/*.js')
    // 重试：整页重新加载
    const reloaded = page.waitForEvent('load')
    await page.getByRole('button', { name: '重试', exact: true }).click()
    await reloaded
    await expect(page.getByRole('heading', { level: 1, name: '我的空间' })).toBeVisible()
    await expect(page.getByRole('alert').filter({ hasText: '没能加载分享' })).toHaveCount(0)
    // 代码取得到之后照常打开。用新开的页面核对：WebKit 在同一个页面里整页重新加载之后，不再请求之前失败的那几个分块地址
    // （本机实测：Chromium 与 Chrome 重新请求、照常打开；WebKit 直接按失败处理，新开的页面照常）
    const fresh = await page.context().newPage()
    await fresh.goto('/')
    await openActions(fresh, '代码下载失败的表')
    await openShareDialog(fresh, '代码下载失败的表')
    await fresh.close()
  })
})
