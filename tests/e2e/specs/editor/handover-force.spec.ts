// 强制接管（US-M3-09；M3-P5 设计 §3.8）：空间管理员（个人空间是所有者）在阅读时、别人在编辑时，"请求编辑"旁边有"强制接管"。点了先确认——
// 说清他是谁、最后活动多久之前、强制接管会立即结束他的编辑权、他没保存的修改不会写进来（可以在他自己的页面上另存为副本）、记入审计；
// 确认框关掉、焦点交还之后才以强制接管申请，进入编辑。被接管的人下一次心跳得知，不续上，失去编辑权，说明空间管理员（个人空间是文档的所有者）
// 某某强制接管了编辑，没保存的修改另存为副本。审计记下这次接管（操作者、文档、被接管的人）。编辑者、查看者没有"强制接管"；交出之后的保留期里
// 强制接管同样被挡。
// 两个人、两个浏览器上下文（各自登录）；查审计的系统管理员、保留期里的请求方另开上下文（newDevice）。不真等：被接管的人的页面装 Playwright 的时钟
// （打开之前装上，之后照常流动），要它的下一次心跳时拨 10 秒。
// 容器 E2E 也跑（生产镜像里定时的自动保存照常运行）：要"没保存的修改"的，在修改之前断开那一页的保存与心跳（disconnectTab），两种构建里都存不上
import type { Page, Request } from '@playwright/test'
import type { TestUser } from '../../support/database.ts'
import { CURRENT_CLIENT } from '../../support/client-format.ts'
import { createDocument, createDocumentIn, createTeamSpace, createUser, editLeaseReservation, editLeaseTakeover, grantDocument } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { plainName, shownName } from '../../support/people.ts'
import { actAs, loginThroughApi } from '../../support/session.ts'
import { backLink, cellOf, disconnectTab, editingBy, editingNotice, EDITOR_TEST_TIMEOUT, editorSurface, enterEditButton, focusPlace, forceTakeOverButton, lostNotice, openAndEnterEditing, openReader, requestEditButton, requestPrompt, saveAndWait, saveButton, savedContent, saveStatus, statusRegion, typeInCell, waitForEditorAccess } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

/** 被接管的人的心跳间隔（契约的 EDIT_LEASE_HEARTBEAT_SECONDS） */
const HEARTBEAT_MS = 10_000

/** 申请编辑权（POST …/edit-lease）的请求 */
function isAcquisition(request: Request, documentId: string): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === `/api/documents/${documentId}/edit-lease`
}

/** 这个页面申请编辑权时带的接管方式（不带时为 null），按先后 */
function recordTakeovers(page: Page, documentId: string): (string | null)[] {
  const takeovers: (string | null)[] = []
  page.on('request', (request) => {
    if (isAcquisition(request, documentId))
      takeovers.push((request.postDataJSON() as { readonly takeover?: string }).takeover ?? null)
  })
  return takeovers
}

/** 强制接管之前的确认框 */
function forceDialog(page: Page) {
  return page.getByRole('dialog', { name: '强制接管编辑？' })
}

/** 写进正则的一段原文 */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 确认框里的说明：正在编辑的人（纯文字的写法）、最后活动多久之前（刚刚操作过时是"不到 1 分钟"，用例慢的时候可能过了一分钟） */
function forceDescription(holder: TestUser): RegExp {
  return new RegExp(`^${literal(plainName(holder))} 正在编辑（最后活动(?:不到 1| \\d+) 分钟前）。强制接管会立即结束对方的编辑权：对方还没保存的修改不会写进这份文档，可以在自己的页面上另存为副本。这次操作会记入审计。$`)
}

/** 用键盘按"强制接管"、在确认框里用键盘确认（焦点从按钮进确认框，关掉之后交还） */
async function forceWithKeyboard(page: Page): Promise<void> {
  await forceTakeOverButton(page).focus()
  await page.keyboard.press('Enter')
  const confirm = forceDialog(page).getByRole('button', { name: '强制接管', exact: true })
  await confirm.focus()
  await page.keyboard.press('Enter')
}

/** 另存为副本之后的说明里新文档的 id（链接在新标签页打开它） */
async function copiedDocumentId(page: Page): Promise<string> {
  const link = page.locator('#editor-chrome').getByRole('status').filter({ hasText: '已另存为副本' }).getByRole('link', { name: '打开副本（新标签页）', exact: true })
  await expect(link).toBeVisible()
  return (await link.getAttribute('href') ?? '').split('/').at(-1) ?? ''
}

test.describe('US-M3-09 强制接管', () => {
  test('US-M3-09 空间管理员强制接管：别人在编辑时"请求编辑"旁边有"强制接管"；先确认（说明他是谁、最后活动多久之前、后果、记入审计），确认之后以强制接管进入编辑；被接管的人下一次心跳得知，失去编辑权，说明空间管理员某某强制接管了编辑，没保存的修改另存为副本；审计记下这次接管', async ({ page, anotherDevice, newDevice }) => {
    const lead = await createUser('fo-l', '组长')
    const holder = await createUser('fo-h', '甲')
    const space = await createTeamSpace('fo', lead, [[lead, 'admin'], [holder, 'editor']])
    const documentId = await createDocumentIn(space.id, lead, '共同的表')
    // 被接管的人在编辑：断开之后改一处——这一处存不上
    await loginThroughApi(page, holder)
    await page.clock.install()
    await openAndEnterEditing(page, documentId)
    const asleep = await disconnectTab(page)
    await typeInCell(page, 'A1', 'holder unsaved')

    // 空间管理员：别人在编辑，"请求编辑"与"强制接管"
    await loginThroughApi(anotherDevice, lead)
    const takeovers = recordTakeovers(anotherDevice, documentId)
    await openReader(anotherDevice, documentId)
    await expect(editingNotice(anotherDevice)).toHaveText(editingBy(holder, true))
    await expect(requestEditButton(anotherDevice)).toBeVisible()
    await expect(enterEditButton(anotherDevice)).toHaveCount(0)
    await forceTakeOverButton(anotherDevice).click()
    const dialog = forceDialog(anotherDevice)
    await expect(dialog.getByText(forceDescription(holder))).toBeVisible()
    // 取消就不接管
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    expect(takeovers).toEqual([])

    await forceTakeOverButton(anotherDevice).click()
    await forceDialog(anotherDevice).getByRole('button', { name: '强制接管', exact: true }).click()
    await waitForEditorAccess(anotherDevice, 'edit')
    await expect(saveButton(anotherDevice)).toBeVisible()
    expect(takeovers).toEqual(['force'])
    expect(await editLeaseTakeover(documentId)).toBe('forced')
    await typeInCell(anotherDevice, 'B1', 'from lead')
    await saveAndWait(anotherDevice)

    // 被接管的人恢复联网：下一次心跳得知被强制接管——不续上，失去编辑权，说明是谁，没保存的修改另存为副本
    await asleep.reconnect()
    await page.clock.fastForward(HEARTBEAT_MS)
    await expect(lostNotice(page)).toHaveText(new RegExp(`^${literal(`编辑权已失效：空间管理员 ${shownName(lead)} 强制接管了编辑。本页的修改没有保存：可以另存为副本，或者放弃这些修改。`)}`))
    await waitForEditorAccess(page, 'read')
    expect(await editLeaseTakeover(documentId)).toBe('forced')
    await lostNotice(page).getByRole('button', { name: '另存为副本', exact: true }).click()
    const copyId = await copiedDocumentId(page)
    expect(cellOf((await savedContent(page, copyId)).snapshot, 'A1')?.v).toBe('holder unsaved')
    const saved = (await savedContent(anotherDevice, documentId)).snapshot
    expect([cellOf(saved, 'A1')?.v, cellOf(saved, 'B1')?.v]).toEqual([undefined, 'from lead'])

    // 审计：系统管理员按动作筛选"强制接管编辑"，对象是这份文档的一行——操作者是空间管理员，明细是被接管的人
    const auditor = await newDevice()
    await loginThroughApi(auditor, await createUser('fo-a', '查审计的管理员', { systemRole: 'admin' }))
    await auditor.goto('/admin/audit')
    await auditor.getByLabel('动作', { exact: true }).selectOption({ label: '强制接管编辑' })
    const events = auditor.getByRole('table', { name: '审计事件' }).getByRole('row').filter({ hasText: documentId })
    await expect(events).toHaveCount(1)
    await expect(events).toContainText(shownName(lead))
    await expect(events).toContainText('强制接管编辑')
    await expect(events).toContainText(`{"holderId":"${holder.id}"}`)
  })

  test('US-M3-09 个人空间的所有者强制接管被授权的编辑者（键盘操作）：确认框关掉之后焦点回到"强制接管"、随即在重建出来的编辑器里；被接管的人得知文档的所有者某某强制接管了编辑，修改都已存上', async ({ page, anotherDevice }) => {
    const owner = await createUser('fo-o', '主人')
    const grantee = await createUser('fo-g', '被授权的人')
    const documentId = await createDocument(owner, '主人的表')
    await grantDocument(documentId, grantee, 'editor', owner)
    await loginThroughApi(page, grantee)
    await page.clock.install()
    await openAndEnterEditing(page, documentId)
    await typeInCell(page, 'A1', 'from grantee')
    await saveAndWait(page)

    await loginThroughApi(anotherDevice, owner)
    const takeovers = recordTakeovers(anotherDevice, documentId)
    await openReader(anotherDevice, documentId)
    await expect(forceTakeOverButton(anotherDevice)).toBeVisible()
    await forceTakeOverButton(anotherDevice).focus()
    await anotherDevice.keyboard.press('Enter')
    await expect(forceDialog(anotherDevice).getByText(forceDescription(grantee))).toBeVisible()
    await forceDialog(anotherDevice).getByRole('button', { name: '强制接管', exact: true }).focus()
    await anotherDevice.keyboard.press('Enter')
    await waitForEditorAccess(anotherDevice, 'edit')
    expect(takeovers).toEqual(['force'])
    // 焦点在重建出来的编辑器里（新建的编辑器把焦点放进它的输入框），不留在页头、不落到 body
    await expect.poll(async () => focusPlace(anotherDevice)).toBe('editor')

    await page.clock.fastForward(HEARTBEAT_MS)
    await expect(lostNotice(page)).toHaveText(new RegExp(`^${literal(`编辑权已失效：文档的所有者 ${shownName(owner)} 强制接管了编辑。本页的修改都已保存，重新加载可以看到最新的版本。`)}`))
    await waitForEditorAccess(page, 'read')
    expect(cellOf((await savedContent(anotherDevice, documentId)).snapshot, 'A1')?.v).toBe('from grantee')
  })

  test('US-M3-09 编辑者看不到"强制接管"（只有"请求编辑"），查看者两个都没有；空间管理员有', async ({ page, anotherDevice, newDevice }) => {
    const lead = await createUser('fo-l3', '组长')
    const holder = await createUser('fo-h3', '甲')
    const editor = await createUser('fo-e3', '乙')
    const viewer = await createUser('fo-v3', '丙')
    const space = await createTeamSpace('fo3', lead, [[lead, 'admin'], [holder, 'editor'], [editor, 'editor'], [viewer, 'viewer']])
    const documentId = await createDocumentIn(space.id, lead, '共同的表')
    await loginThroughApi(page, holder)
    await openAndEnterEditing(page, documentId)

    await loginThroughApi(anotherDevice, editor)
    await openReader(anotherDevice, documentId)
    await expect(editingNotice(anotherDevice)).toHaveText(editingBy(holder, true))
    await expect(requestEditButton(anotherDevice)).toBeVisible()
    await expect(forceTakeOverButton(anotherDevice)).toHaveCount(0)

    const viewing = await newDevice()
    await loginThroughApi(viewing, viewer)
    await openReader(viewing, documentId)
    await expect(editingNotice(viewing)).toHaveText(editingBy(holder, false))
    await expect(saveStatus(viewing)).toHaveText('只能查看')
    await expect(requestEditButton(viewing)).toHaveCount(0)
    await expect(forceTakeOverButton(viewing)).toHaveCount(0)

    const leading = await newDevice()
    await loginThroughApi(leading, lead)
    await openReader(leading, documentId)
    await expect(requestEditButton(leading)).toBeVisible()
    await expect(forceTakeOverButton(leading)).toBeVisible()
  })

  test('US-M3-09 交出之后的保留期里强制接管同样被挡：说明编辑权刚交给了谁、留到几点（服务端的时刻）、这期间不能强制接管；"强制接管"随之消失，焦点交给返回链接', async ({ page, anotherDevice, newDevice }) => {
    const lead = await createUser('fo-l4', '组长')
    const holder = await createUser('fo-h4', '甲')
    const requester = await createUser('fo-r4', '乙')
    const space = await createTeamSpace('fo4', lead, [[lead, 'admin'], [holder, 'editor'], [requester, 'editor']])
    const documentId = await createDocumentIn(space.id, lead, '共同的表')
    await loginThroughApi(page, holder)
    await page.clock.install()
    await openAndEnterEditing(page, documentId)

    // 空间管理员先打开（别人在编辑："强制接管"），之后拦下它读编辑状态的请求：手里的状态停在"甲在编辑"
    const leading = await newDevice()
    await loginThroughApi(leading, lead)
    await openReader(leading, documentId)
    await expect(forceTakeOverButton(leading)).toBeVisible()
    await leading.route('**/api/documents/*/edit-lease', async route => route.request().method() === 'GET' ? route.abort('internetdisconnected') : route.continue())

    // 乙经接口请求编辑（没有页面：不会自动进入，保留一直留着），甲的下一次心跳带来请求，甲交出
    await loginThroughApi(anotherDevice, requester)
    await actAs(anotherDevice, 'POST', `/api/documents/${documentId}/edit-lease/request`, CURRENT_CLIENT)
    const renewed = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === `/api/documents/${documentId}/edit-lease`)
    await page.clock.fastForward(HEARTBEAT_MS)
    expect((await renewed).status()).toBe(200)
    await requestPrompt(page).getByRole('button', { name: '交出', exact: true }).click()
    await waitForEditorAccess(page, 'read')
    const reservation = await editLeaseReservation(documentId)
    expect(reservation?.reservedFor).toBe(requester.id)

    // 空间管理员用键盘强制接管：409，说明留给了乙、留到几点、这期间不能强制接管；没人占着（"编辑"），"强制接管"消失、焦点交给返回链接
    const acquired = leading.waitForResponse(response => isAcquisition(response.request(), documentId))
    await forceWithKeyboard(leading)
    expect((await acquired).status()).toBe(409)
    const until = new Intl.DateTimeFormat('zh-CN', { timeZone: test.info().project.use.timezoneId, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(reservation?.reservedUntil)
    await expect(statusRegion(leading)).toHaveText(`编辑权刚交给了 ${shownName(requester)}，留到 ${until}，这期间不能强制接管`)
    await expect(forceTakeOverButton(leading)).toHaveCount(0)
    await expect(enterEditButton(leading)).toBeVisible()
    await expect(backLink(leading)).toBeFocused()
    await expect(saveButton(leading)).toHaveCount(0)
  })

  test('US-M3-09 强制接管没有成功（网络）：说明没能强制接管，"强制接管"还在、焦点还在它上面，可以再按', async ({ page, anotherDevice }) => {
    const lead = await createUser('fo-l5', '组长')
    const holder = await createUser('fo-h5', '甲')
    const space = await createTeamSpace('fo5', lead, [[lead, 'admin'], [holder, 'editor']])
    const documentId = await createDocumentIn(space.id, lead, '共同的表')
    await loginThroughApi(page, holder)
    await openAndEnterEditing(page, documentId)

    await loginThroughApi(anotherDevice, lead)
    await openReader(anotherDevice, documentId)
    const acquisition = '**/api/documents/*/edit-lease'
    await anotherDevice.route(acquisition, async route => route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.continue())
    await forceWithKeyboard(anotherDevice)
    await expect(anotherDevice.locator('#editor-chrome').getByRole('alert')).toHaveText('没能强制接管：网络连接失败，请检查网络后重试')
    await expect(forceTakeOverButton(anotherDevice)).toBeFocused()
    await expect(editorSurface(anotherDevice)).toHaveAttribute('data-editor-access', 'read')

    await anotherDevice.unroute(acquisition)
    await forceWithKeyboard(anotherDevice)
    await waitForEditorAccess(anotherDevice, 'edit')
    expect(await editLeaseTakeover(documentId)).toBe('forced')
  })
})
