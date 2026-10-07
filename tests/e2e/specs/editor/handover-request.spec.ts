// 请求编辑与交出（US-M3-06；M3-P5 设计 §3.6）：别人在编辑时，能编辑的人点"请求编辑"，等待持有者回应（每 5 秒续期，读屏状态区说在等谁）。
// 持有者的下一次心跳带来请求：他已空闲满 2 分钟就先保存再自动交出；否则页头下面出现带标题的分组（"交出""继续编辑"与一行静态说明），
// 不移动焦点、不挂屏障，读屏在一直在的状态区里播一次；不理会时一旦空闲满 2 分钟同样交出。交出之后编辑权留给请求方 2 分钟（别人申请被挡，
// 说明交给了谁、留到几点），请求方下一次续期得知、页面看得见时自动进入编辑。持有者选"继续编辑"时请求方得到说明；请求方可以取消；持有者的页面
// 没有响应时按到期处理（请求方的续期得知没人在编辑，同样自动进入）；退出编辑时有请求在等就交给请求方。
// 两个人、两个浏览器上下文（各自登录，不共用 Cookie、锁与时钟）；第三个人另开一个上下文（newDevice）。不真等：页面的时间用 Playwright 的
// 时钟（上下文级，打开之前装上，之后照常流动），要到点时 fastForward——持有者的心跳 10 秒、请求方的续期 5 秒、空闲 2 分钟。时间照常流动，
// 心跳、续期也可能在拨之前自己到点：等的请求在触发它的操作之前就开始等，断言看结果（界面、请求的记录），不看是哪一次心跳、续期带来的
// 容器 E2E 也跑（生产镜像里定时的自动保存照常运行）：持有者的修改由交出前的保存或之前的自动保存存上，断言只看结果（服务器上的内容、租约怎样结束）
import type { Page, Request } from '@playwright/test'
import type { TestUser } from '../../support/database.ts'
import { setPageHidden } from '../../support/autosave.ts'
import { createDocumentIn, createTeamSpace, createUser, editLeaseEndReason, editLeaseEpoch, editLeaseReservation, expireEditLease } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { shownName } from '../../support/people.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cancelRequestButton, cellOf, disconnectTab, editingBy, editingNotice, EDITOR_TEST_TIMEOUT, editorSurface, enterEditButton, exitEditButton, lostNotice, openAndEnterEditing, openReader, requestEditButton, requestPrompt, saveAndWait, saveButton, savedContent, selectCell, statusRegion, typeInCell, waitForEditorAccess } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

/** 持有者的心跳间隔与请求方的续期间隔（契约的 EDIT_LEASE_HEARTBEAT_SECONDS、EDIT_REQUEST_RENEW_SECONDS） */
const HEARTBEAT_MS = 10_000
const RENEW_MS = 5_000

/**
 * 甲（持有者）、乙（请求方）都是团队空间的编辑者（不能强制接管：谢绝之后另说可以请空间管理员）；丙也是编辑者（保留期里被挡的第三人）。
 * 登录名至多 32 个字符（createUser 另加 9 个）：前缀写短
 */
async function sharedDocument(prefix: string): Promise<{ readonly holder: TestUser, readonly requester: TestUser, readonly third: TestUser, readonly documentId: string }> {
  const lead = await createUser(`${prefix}-l`, '组长')
  const holder = await createUser(`${prefix}-h`, '甲')
  const requester = await createUser(`${prefix}-r`, '乙')
  const third = await createUser(`${prefix}-t`, '丙')
  const space = await createTeamSpace(prefix, lead, [[lead, 'admin'], [holder, 'editor'], [requester, 'editor'], [third, 'editor']])
  const documentId = await createDocumentIn(space.id, lead, '共同的表')
  return { holder, requester, third, documentId }
}

/** 写进正则的一段原文 */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 请求方等待时读屏状态区里的说明（不倒计时） */
function waitingFor(holder: TestUser): string {
  return `已请求编辑，等待 ${shownName(holder)} 回应。${shownName(holder)} 停下操作 2 分钟后会自动保存并交给你；你也可以取消请求`
}

/** 持有者这边提示出现时读屏状态区里的那一句 */
function announcement(requester: TestUser): string {
  return `${shownName(requester)} 请求编辑这份文档，可以在页头下方选择"交出"或"继续编辑"`
}

/** 交出（POST …/edit-lease/handover）的请求 */
function isHandover(request: Request, documentId: string): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === `/api/documents/${documentId}/edit-lease/handover`
}

/** 释放（DELETE …/edit-lease）的请求 */
function isRelease(request: Request, documentId: string): boolean {
  return request.method() === 'DELETE' && new URL(request.url()).pathname === `/api/documents/${documentId}/edit-lease`
}

/** 申请编辑权（POST …/edit-lease）的请求 */
function isAcquisition(request: Request, documentId: string): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === `/api/documents/${documentId}/edit-lease`
}

/** 这个页面申请编辑权时带的接管方式（不带时为 null），按先后 */
function recordAcquisitions(page: Page, documentId: string): (string | null)[] {
  const takeovers: (string | null)[] = []
  page.on('request', (request) => {
    if (isAcquisition(request, documentId))
      takeovers.push((request.postDataJSON() as { readonly takeover?: string }).takeover ?? null)
  })
  return takeovers
}

/** 持有者：装上时钟、打开并进入编辑，改一处 */
async function holderEditing(page: Page, holder: TestUser, documentId: string): Promise<void> {
  await loginThroughApi(page, holder)
  await page.clock.install()
  await openAndEnterEditing(page, documentId)
  await typeInCell(page, 'A1', 'from holder')
}

/**
 * 请求方：装上时钟、打开（阅读，持有者是别人："请求编辑"），点"请求编辑"，进入等待（同一个按钮换成"取消请求"，读屏状态区说在等谁）。
 * 交回这一页申请编辑权的记录（recordAcquisitions）
 */
async function requesterWaiting(device: Page, requester: TestUser, holder: TestUser, documentId: string): Promise<(string | null)[]> {
  await loginThroughApi(device, requester)
  await device.clock.install()
  const acquisitions = recordAcquisitions(device, documentId)
  await openReader(device, documentId)
  await expect(editingNotice(device)).toHaveText(editingBy(holder, true))
  await expect(enterEditButton(device)).toHaveCount(0)
  await requestEditButton(device).click()
  await expect(cancelRequestButton(device)).toBeVisible()
  await expect(statusRegion(device)).toHaveText(waitingFor(holder))
  return acquisitions
}

/** 持有者的下一次心跳（至多 10 秒）：拨过一个心跳间隔，等这一次续租的回答 */
async function nextHeartbeat(page: Page, documentId: string): Promise<void> {
  const renewed = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === `/api/documents/${documentId}/edit-lease`)
  await page.clock.fastForward(HEARTBEAT_MS)
  expect((await renewed).status()).toBe(200)
}

/** 请求方的下一次续期（至多 5 秒；时间照常流动，也可能已经自己到点了）：拨过一个续期间隔 */
async function nextRenewal(device: Page): Promise<void> {
  await device.clock.fastForward(RENEW_MS)
}

/** 持有者：心跳带来请求、人在（有操作）——页头下面出现提示 */
async function prompted(page: Page, requester: TestUser, documentId: string): Promise<void> {
  await nextHeartbeat(page, documentId)
  await expect(requestPrompt(page)).toBeVisible()
  await expect(requestPrompt(page)).toHaveAccessibleName(`${shownName(requester)} 请求编辑这份文档`)
  await expect(requestPrompt(page)).toContainText('你停下操作 2 分钟后会自动保存并交给对方')
}

/** 请求方的下一次续期得知交给了他（或者没人在编辑）：自动进入编辑——普通申请（不带接管方式），只申请一次 */
async function requesterEnters(device: Page, acquisitions: readonly (string | null)[]): Promise<void> {
  await nextRenewal(device)
  await waitForEditorAccess(device, 'edit')
  await expect(saveButton(device)).toBeVisible()
  expect(acquisitions).toEqual([null])
}

/** 服务器上 A1、B1 两格 */
async function savedCells(page: Page, documentId: string): Promise<unknown[]> {
  const saved = (await savedContent(page, documentId)).snapshot
  return [cellOf(saved, 'A1')?.v, cellOf(saved, 'B1')?.v]
}

test.describe('US-M3-06 请求编辑与交出', () => {
  test('US-M3-06 持有者已空闲满 2 分钟：请求方请求，持有者下一次心跳带来请求，随即先保存再自动交出（不显示提示），回到阅读并说明；请求方下一次续期得知交给了他，自动进入编辑；服务器上有持有者的修改', async ({ page, anotherDevice }) => {
    const { holder, requester, documentId } = await sharedDocument('rq-idle')
    await holderEditing(page, holder, documentId)
    // 持有者 2 分钟没有操作（这期间的心跳照常，没有请求）
    await page.clock.fastForward('02:00')
    const handedOver = page.waitForResponse(response => isHandover(response.request(), documentId))
    const acquisitions = await requesterWaiting(anotherDevice, requester, holder, documentId)

    await page.clock.fastForward(HEARTBEAT_MS)
    expect((await handedOver).status()).toBe(200)
    await waitForEditorAccess(page, 'read')
    await expect(statusRegion(page)).toHaveText(`你 2 分钟没有操作，已保存并把编辑权交给了 ${shownName(requester)}`)
    await expect(requestPrompt(page)).toHaveCount(0)
    await expect(saveButton(page)).toHaveCount(0)

    await requesterEnters(anotherDevice, acquisitions)
    await typeInCell(anotherDevice, 'B1', 'from requester')
    await saveAndWait(anotherDevice)
    expect(await savedCells(anotherDevice, documentId)).toEqual(['from holder', 'from requester'])
  })

  test('US-M3-06 持有者在编辑：页头下面出现提示，点"交出"——先保存再交出，回到阅读并说明交给了谁；请求方自动进入编辑', async ({ page, anotherDevice }) => {
    const { holder, requester, documentId } = await sharedDocument('rq-hand')
    await holderEditing(page, holder, documentId)
    const acquisitions = await requesterWaiting(anotherDevice, requester, holder, documentId)
    await prompted(page, requester, documentId)

    const handedOver = page.waitForResponse(response => isHandover(response.request(), documentId))
    await requestPrompt(page).getByRole('button', { name: '交出', exact: true }).click()
    expect((await handedOver).status()).toBe(200)
    await waitForEditorAccess(page, 'read')
    await expect(statusRegion(page)).toHaveText(`已保存并把编辑权交给了 ${shownName(requester)}`)

    await requesterEnters(anotherDevice, acquisitions)
    await typeInCell(anotherDevice, 'B1', 'from requester')
    await saveAndWait(anotherDevice)
    expect(await savedCells(anotherDevice, documentId)).toEqual(['from holder', 'from requester'])
  })

  test('US-M3-06 持有者选"继续编辑"：提示消失、照常编辑，之后空闲 2 分钟也不交出；请求方下一次续期得知，说明谁选择继续编辑（不能强制接管的人另说可以请空间管理员），按钮回到"请求编辑"', async ({ page, anotherDevice }) => {
    const { holder, requester, documentId } = await sharedDocument('rq-decline')
    await holderEditing(page, holder, documentId)
    await requesterWaiting(anotherDevice, requester, holder, documentId)
    await prompted(page, requester, documentId)

    await requestPrompt(page).getByRole('button', { name: '继续编辑', exact: true }).click()
    await expect(requestPrompt(page)).toHaveCount(0)
    await expect(saveButton(page)).toBeVisible()

    // 说明谁选择继续编辑（放在最前面），之后照旧说谁在编辑
    await nextRenewal(anotherDevice)
    await expect(statusRegion(anotherDevice)).toHaveText(new RegExp(`^${literal(`${shownName(holder)} 选择继续编辑，你的请求已取消。着急时可以请空间管理员强制接管`)} ${literal(shownName(holder))} 正在编辑这份文档`))
    await expect(requestEditButton(anotherDevice)).toBeVisible()
    await expect(cancelRequestButton(anotherDevice)).toHaveCount(0)

    // 持有者之后空闲 2 分钟：请求已经谢绝，不交出；照常编辑、保存
    await page.clock.fastForward('02:10')
    await nextHeartbeat(page, documentId)
    await expect(saveButton(page)).toBeVisible()
    await expect(requestPrompt(page)).toHaveCount(0)
    expect(await editLeaseEndReason(documentId)).toBeNull()
    await typeInCell(page, 'B1', 'still holder')
    await saveAndWait(page)
    expect(await savedCells(page, documentId)).toEqual(['from holder', 'still holder'])
  })

  test('US-M3-06 持有者不理会提示：一旦空闲满 2 分钟就先保存再交出（说明 2 分钟没有操作）；请求方自动进入编辑', async ({ page, anotherDevice }) => {
    const { holder, requester, documentId } = await sharedDocument('rq-ignore')
    await holderEditing(page, holder, documentId)
    const acquisitions = await requesterWaiting(anotherDevice, requester, holder, documentId)
    await prompted(page, requester, documentId)

    const handedOver = page.waitForResponse(response => isHandover(response.request(), documentId))
    await page.clock.fastForward('02:00')
    expect((await handedOver).status()).toBe(200)
    await waitForEditorAccess(page, 'read')
    await expect(statusRegion(page)).toHaveText(`你 2 分钟没有操作，已保存并把编辑权交给了 ${shownName(requester)}`)

    await requesterEnters(anotherDevice, acquisitions)
    expect((await savedCells(anotherDevice, documentId))[0]).toBe('from holder')
  })

  test('US-M3-06 请求方取消：按钮回到"请求编辑"、说明回到谁在编辑；持有者下一次心跳时提示消失、说明请求方取消了，之后空闲也不交出', async ({ page, anotherDevice }) => {
    const { holder, requester, documentId } = await sharedDocument('rq-cancel')
    await holderEditing(page, holder, documentId)
    await requesterWaiting(anotherDevice, requester, holder, documentId)
    await prompted(page, requester, documentId)

    await cancelRequestButton(anotherDevice).click()
    await expect(requestEditButton(anotherDevice)).toBeVisible()
    await expect(editingNotice(anotherDevice)).toHaveText(editingBy(holder, true))

    await nextHeartbeat(page, documentId)
    await expect(requestPrompt(page)).toHaveCount(0)
    await expect(statusRegion(page)).toHaveText(`${shownName(requester)} 已取消请求`)
    await page.clock.fastForward('02:10')
    await nextHeartbeat(page, documentId)
    await expect(saveButton(page)).toBeVisible()
    expect(await editLeaseEndReason(documentId)).toBeNull()
  })

  test('US-M3-06 持有者的页面没有响应（断网、休眠：心跳与保存都送不到）：编辑权到期之后请求方下一次续期得知没人在编辑，自动进入编辑；持有者恢复之后不能再保存，修改给副本', async ({ page, anotherDevice }) => {
    const { holder, requester, documentId } = await sharedDocument('rq-silent')
    await holderEditing(page, holder, documentId)
    await saveAndWait(page)
    const epoch = await editLeaseEpoch(documentId) ?? 0
    // 持有者断网之后改了一处：这一处存不上
    const asleep = await disconnectTab(page)
    await typeInCell(page, 'B1', 'never saved')
    const acquisitions = await requesterWaiting(anotherDevice, requester, holder, documentId)

    // 持有者的编辑权到期（改写租约行的时间，不等真实的 90 秒）：请求方的下一次续期得知没人在编辑
    await expireEditLease(documentId)
    await requesterEnters(anotherDevice, acquisitions)
    expect(await editLeaseEpoch(documentId)).toBe(epoch + 1)
    await typeInCell(anotherDevice, 'B1', 'from requester')
    await saveAndWait(anotherDevice)

    // 持有者恢复：下一次心跳得知编辑权不在了（续上时被请求方占着），失去编辑权，本页的修改给副本
    await asleep.reconnect()
    await page.clock.fastForward(HEARTBEAT_MS)
    await expect(lostNotice(page)).toContainText(`编辑权已失效：${shownName(requester)} 正在编辑这份文档`)
    await waitForEditorAccess(page, 'read')
    expect(await savedCells(anotherDevice, documentId)).toEqual(['from holder', 'from requester'])
  })

  test('US-M3-06 交出之后的保留期里第三人被挡：请求方的页面在后台时不进入编辑（编辑权留给他）；第三人点"编辑"得到说明——编辑权刚交给了谁、留到几点（服务端的时刻）；请求方回到前台随即进入编辑', async ({ page, anotherDevice, newDevice }) => {
    const { holder, requester, third, documentId } = await sharedDocument('rq-reserved')
    await holderEditing(page, holder, documentId)
    const acquisitions = await requesterWaiting(anotherDevice, requester, holder, documentId)
    await prompted(page, requester, documentId)
    // 请求方切到后台
    await setPageHidden(anotherDevice, true)
    await requestPrompt(page).getByRole('button', { name: '交出', exact: true }).click()
    await waitForEditorAccess(page, 'read')
    const reservation = await editLeaseReservation(documentId)
    expect(reservation?.reservedFor).toBe(requester.id)

    // 请求方在后台：续期得知交给了他，但不进入编辑（回到前台时进入）
    await nextRenewal(anotherDevice)
    await expect(statusRegion(anotherDevice)).toHaveText('可以进入编辑了：回到这一页时自动进入编辑')
    await expect(cancelRequestButton(anotherDevice)).toBeVisible()
    await expect(editorSurface(anotherDevice)).toHaveAttribute('data-editor-access', 'read')

    // 第三人：没人在编辑（"编辑"），点了被挡——编辑权刚交给了乙，留到几点（服务端的保留时刻，按页面的时区写成 HH:mm）
    const thirdPage = await newDevice()
    await loginThroughApi(thirdPage, third)
    await openReader(thirdPage, documentId)
    const acquired = thirdPage.waitForResponse(response => isAcquisition(response.request(), documentId))
    await enterEditButton(thirdPage).click()
    expect((await acquired).status()).toBe(409)
    const until = new Intl.DateTimeFormat('zh-CN', { timeZone: test.info().project.use.timezoneId, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(reservation?.reservedUntil)
    await expect(statusRegion(thirdPage)).toHaveText(`编辑权刚交给了 ${shownName(requester)}，留到 ${until}`)
    await expect(editorSurface(thirdPage)).toHaveAttribute('data-editor-access', 'read')

    // 请求方回到前台：随即进入编辑（普通申请：编辑权留给他）
    await setPageHidden(anotherDevice, false)
    await waitForEditorAccess(anotherDevice, 'edit')
    await expect(saveButton(anotherDevice)).toBeVisible()
    expect(acquisitions).toEqual([null])
  })

  test('US-M3-06 提示出现时不打断输入：焦点留在正在编辑的单元格里（不移动、不挂屏障），接着键入的字照常进这一格；读屏状态区说有人请求编辑', async ({ page, anotherDevice }) => {
    const { holder, requester, documentId } = await sharedDocument('rq-typing')
    await holderEditing(page, holder, documentId)
    // 持有者开始在 B1 里键入（不提交）：记下焦点所在的元素
    await selectCell(page, 'B1')
    await page.keyboard.type('typed ')
    await page.evaluate(() => {
      (window as unknown as { focusedBefore?: Element | null }).focusedBefore = document.activeElement
    })
    await requesterWaiting(anotherDevice, requester, holder, documentId)

    await prompted(page, requester, documentId)
    expect(await page.evaluate(() => document.activeElement === (window as unknown as { focusedBefore?: Element | null }).focusedBefore)).toBe(true)
    await expect(editorSurface(page)).toHaveAttribute('data-editor-state', /^(?:ready|steady)$/)
    await expect(statusRegion(page)).toHaveText(announcement(requester))

    await page.keyboard.type('more')
    await page.keyboard.press('Enter')
    await saveAndWait(page)
    expect(await savedCells(page, documentId)).toEqual(['from holder', 'typed more'])
    // 提示还在，照样能交出
    await expect(requestPrompt(page)).toBeVisible()
  })

  test('US-M3-06 退出编辑时有请求在等：用交出代替释放（不发释放），回到阅读并说明交给了谁；请求方自动进入编辑', async ({ page, anotherDevice }) => {
    const { holder, requester, documentId } = await sharedDocument('rq-exit')
    await holderEditing(page, holder, documentId)
    const acquisitions = await requesterWaiting(anotherDevice, requester, holder, documentId)
    await prompted(page, requester, documentId)
    const writes: string[] = []
    page.on('request', (request) => {
      if (isHandover(request, documentId))
        writes.push('交出')
      if (isRelease(request, documentId))
        writes.push('释放')
    })

    await exitEditButton(page).click()
    await waitForEditorAccess(page, 'read')
    await expect(statusRegion(page)).toHaveText(`已保存并把编辑权交给了 ${shownName(requester)}`)
    expect(writes).toEqual(['交出'])

    await requesterEnters(anotherDevice, acquisitions)
    expect((await savedCells(anotherDevice, documentId))[0]).toBe('from holder')
  })

  test('US-M3-06 同一个人的另一个页面不接手正在等的请求（审查 B2）：乙在 R1 请求编辑、在等；同一个浏览器里另开的 R2 只说"你已在别处请求编辑这份文档"，不进入等待；R2 关掉不撤回请求——R1 照旧在等，甲的提示照旧', async ({ page, anotherDevice }) => {
    const { holder, requester, documentId } = await sharedDocument('rq-tabs')
    await holderEditing(page, holder, documentId)
    await requesterWaiting(anotherDevice, requester, holder, documentId)
    await prompted(page, requester, documentId)

    // R2：同一个浏览器上下文里另开（同一个会话，时钟是上下文级的）；这一页没发出过请求（记号按标签页，在 sessionStorage 里）
    const second = await anotherDevice.context().newPage()
    const requestPath = `/api/documents/${documentId}/edit-lease/request`
    const fromSecond: string[] = []
    second.on('request', (request) => {
      if (new URL(request.url()).pathname === requestPath)
        fromSecond.push(request.method())
    })
    await openReader(second, documentId)
    await expect(statusRegion(second)).toContainText('你已在别处请求编辑这份文档')
    await expect(statusRegion(second)).toContainText(`${shownName(holder)} 正在编辑这份文档`)
    await expect(requestEditButton(second)).toBeVisible()
    await expect(cancelRequestButton(second)).toHaveCount(0)

    // R2 关掉（页面还在时派发 pagehide，与现有 E2E 同一个做法）：不撤回（DELETE），之前也没续期（PUT）
    await second.evaluate(() => window.dispatchEvent(new Event('pagehide')))
    expect(await second.evaluate(async () => (await fetch('/api/health/live')).status)).toBe(200)
    expect(fromSecond).toEqual([])
    await second.close()

    // R1 的下一次续期：请求还在（pending），照旧在等；甲的下一次心跳：提示照旧
    const renewed = anotherDevice.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === requestPath)
    await nextRenewal(anotherDevice)
    expect(((await (await renewed).json()) as { readonly kind: string }).kind).toBe('pending')
    await expect(statusRegion(anotherDevice)).toHaveText(waitingFor(holder))
    await nextHeartbeat(page, documentId)
    await expect(requestPrompt(page)).toBeVisible()
  })

  test('US-M3-06 请求方的续期一直得到 CSRF_TOKEN_INVALID（例如网关剥掉了请求头）、确认会话照常是本人：续期与确认会话按续期的节奏，不按网络往返的速度连着发（审查 B1）', async ({ page, anotherDevice }) => {
    const { holder, requester, documentId } = await sharedDocument('rq-csrf')
    await holderEditing(page, holder, documentId)
    await requesterWaiting(anotherDevice, requester, holder, documentId)

    const requestPath = `/api/documents/${documentId}/edit-lease/request`
    await anotherDevice.route(`**${requestPath}`, async route => route.request().method() === 'PUT'
      ? route.fulfill({ status: 403, contentType: 'application/json', json: { error: { code: 'CSRF_TOKEN_INVALID', message: '请求已失效，请刷新页面', requestId: 'b1' } } })
      : route.continue())
    const counts = { renewals: 0, sessions: 0 }
    anotherDevice.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (request.method() === 'PUT' && path === requestPath)
        counts.renewals += 1
      if (request.method() === 'GET' && path === '/api/auth/session')
        counts.sessions += 1
    })
    // 下一次续期被拒，页面向服务端确认会话（照常是本人）
    const confirmed = anotherDevice.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/auth/session')
    await nextRenewal(anotherDevice)
    expect((await confirmed).status()).toBe(200)
    const start = { ...counts }
    // 再走十个网络往返（不按固定时长等）：修之前确认之后立即再续期、再被拒、再确认，按网络往返的速度连着发（3 秒里各约 300–450 次），这段时间里
    // 就有好几次；修之后下一次续期照续期的节奏，在 5 秒之后
    for (let round = 0; round < 10; round += 1)
      expect(await anotherDevice.evaluate(async () => (await fetch('/api/health/live')).status)).toBe(200)
    expect(counts.renewals - start.renewals).toBe(0)
    expect(counts.sessions - start.sessions).toBe(0)
    // 页面照旧在等（会话没问题，说明不变）；拨过一个续期间隔才再续一次
    await expect(cancelRequestButton(anotherDevice)).toBeVisible()
    await expect(statusRegion(anotherDevice)).toHaveText(waitingFor(holder))
    await nextRenewal(anotherDevice)
    await expect.poll(() => counts.renewals - start.renewals).toBe(1)
  })
})
