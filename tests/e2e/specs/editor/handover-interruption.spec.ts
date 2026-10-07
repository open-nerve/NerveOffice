// 上一位编辑者异常中断的提醒（US-M3-10；M3-P5 设计 §3.5、§3.8、§3.11）：编辑权因为到期、空闲回收或登录失效而结束（不是释放、交出、接管或收回）之后的
// 30 分钟内，下一个申请编辑的人进入编辑之后，页头下面有一条不打断的说明——"上一位编辑者 [人名] 的会话在 HH:mm 异常中断，可能还有未同步的修改"
// （是自己的那一代时说"你上一次的编辑在 HH:mm 异常中断……"），带"知道了"，同一句话在一直在的读屏状态区里播一次；阅读时没人在编辑、别人的那一代
// 异常中断的，读屏状态区里也说（不必等点"编辑"）。续上（编辑权中断之后同一个页面自动重新申请）不说，由编辑模式的单元测试核对（续上的申请带回提醒时
// 也不显示）。异常结束的那一代就是本页自己的（服务端给的 samePage：本页退出时释放没送到，到期之后本页再进入编辑）同样不说。
// 系统管理员签发重置链接（撤销这个人的全部登录）之后，他持有的编辑权随之结束（登录失效，算异常中断）；停用账户是收回编辑权（明确结束），没有提醒。
// 时刻是服务端的（上一代最后一次续租），按页面的时区写成 HH:mm——那段 30 分钟跨过了午夜时带日期（与页面同一条规则，support 里按库里的时刻算出预期）。
// 不真等：30 分钟、到期改库挪时间（support/database.ts 的 expireEditLeaseAgo、expireEditLease），阅读时的检查用 Playwright 的时钟拨过 30 秒。
// 容器 E2E 也跑（生产镜像里定时的自动保存照常运行）：断言只看说明与申请的结果
import type { Page } from '@playwright/test'
import type { TestUser } from '../../support/database.ts'
import { randomUUID } from 'node:crypto'
import { CURRENT_CLIENT } from '../../support/client-format.ts'
import { createDocumentIn, createTeamSpace, createUser, editLeaseEndReason, editLeaseRenewedAt, expireEditLease, expireEditLeaseAgo } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { shownName } from '../../support/people.ts'
import { actAs, loginThroughApi } from '../../support/session.ts'
import { backLink, EDITOR_TEST_TIMEOUT, enterEditButton, enterEditing, exitEditing, interruptionNotice, openAndEnterEditing, openReader, saveAndWait, saveButton, statusRegion, typeInCell } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

/** 阅读时的检查间隔（页面的 READING_CHECK_INTERVAL_MS） */
const READING_CHECK_MS = 30_000
/** 异常中断的提醒只在结束之后 30 分钟以内给出（契约的 EDIT_INTERRUPTION_NOTICE_SECONDS） */
const NOTICE_WINDOW_MS = 30 * 60_000
/** 编辑权的有效期（契约的 EDIT_LEASE_TTL_SECONDS）：本页退出时没能确认放掉的那一代，到这时页面再读一次编辑状态 */
const LEASE_TTL_MS = 90_000

/**
 * 说明里的时刻：上一代最后一次续租的时刻按页面的时区写成 HH:mm；从它起 30 分钟之内跨过了午夜时前面加日期（页面的 formatRecentClockTime，
 * 不与浏览器的时钟比较）。用例在午夜前后跑也照样对
 */
function interruptedAt(endedAt: Date | undefined): string {
  if (endedAt === undefined)
    throw new Error('库里没有这份文档的编辑租约')
  const timeZone = test.info().project.use.timezoneId
  const day = (at: Date): string => new Intl.DateTimeFormat('zh-CN', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }).format(at)
  const clock = new Intl.DateTimeFormat('zh-CN', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(endedAt)
  if (day(endedAt) === day(new Date(endedAt.getTime() + NOTICE_WINDOW_MS)))
    return clock
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, month: 'numeric', day: 'numeric' }).formatToParts(endedAt)
  const part = (type: string): string => parts.find(item => item.type === type)?.value ?? ''
  return `${part('month')}月${part('day')}日 ${clock}`
}

/** 别人的那一代异常中断的说法 */
function byOther(holder: TestUser, at: string): string {
  return `上一位编辑者 ${shownName(holder)} 的会话在 ${at} 异常中断，可能还有未同步的修改`
}

/** 自己的那一代异常中断的说法 */
function bySelf(at: string): string {
  return `你上一次的编辑在 ${at} 异常中断（例如页面被关闭、断网或电脑休眠），那时还没保存的修改可能没有存上`
}

/** 打开阅读，等阅读时的第一次检查读回来（读屏状态区据此说明） */
async function openAndCheck(page: Page, documentId: string): Promise<void> {
  const checked = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/documents/${documentId}/edit-lease`)
  await openReader(page, documentId)
  expect((await checked).status()).toBe(200)
}

/** 甲（持有者）、乙（下一个人）都是团队空间的编辑者 */
async function sharedDocument(prefix: string): Promise<{ readonly holder: TestUser, readonly next: TestUser, readonly documentId: string }> {
  const lead = await createUser(`${prefix}-l`, '组长')
  const holder = await createUser(`${prefix}-h`, '甲')
  const next = await createUser(`${prefix}-n`, '乙')
  const space = await createTeamSpace(prefix, lead, [[lead, 'admin'], [holder, 'editor'], [next, 'editor']])
  const documentId = await createDocumentIn(space.id, lead, '共同的表')
  return { holder, next, documentId }
}

/** 经接口申请出一代没有页面在用的编辑权（这个人的登录、一个新的页面标识） */
async function leaseWithoutPage(page: Page, documentId: string): Promise<void> {
  await actAs(page, 'POST', `/api/documents/${documentId}/edit-lease`, { clientInstanceId: randomUUID(), ...CURRENT_CLIENT })
}

test.describe('US-M3-10 上一位编辑者异常中断时得到提醒', () => {
  test('US-M3-10 系统管理员签发重置链接（撤销了持有者的全部登录）：他的编辑权随之结束；下一个人打开时读屏状态区就说上一位编辑者的会话异常中断，进入编辑之后页头下面另有一条说明与"知道了"（读屏状态区播一次）；"知道了"之后说明消失、焦点交给返回链接', async ({ page, anotherDevice, newDevice }) => {
    const { holder, next, documentId } = await sharedDocument('it-reset')
    await loginThroughApi(page, holder)
    await openAndEnterEditing(page, documentId)
    const admin = await newDevice()
    await loginThroughApi(admin, await createUser('it-a', '系统管理员', { systemRole: 'admin' }))
    await actAs(admin, 'POST', `/api/admin/users/${holder.id}/password-reset`)
    const text = byOther(holder, interruptedAt(await editLeaseRenewedAt(documentId)))
    // 登录失效不是明确结束：租约行上没有结束的原因
    expect(await editLeaseEndReason(documentId)).toBeNull()

    await loginThroughApi(anotherDevice, next)
    await openAndCheck(anotherDevice, documentId)
    await expect(statusRegion(anotherDevice)).toHaveText(text)
    await expect(enterEditButton(anotherDevice)).toBeVisible()
    await enterEditing(anotherDevice)
    await expect(interruptionNotice(anotherDevice)).toContainText(text)
    await expect(statusRegion(anotherDevice)).toHaveText(text)

    // 键盘按"知道了"：说明消失，焦点交给返回链接；照常编辑、保存
    await interruptionNotice(anotherDevice).getByRole('button', { name: '知道了', exact: true }).focus()
    await anotherDevice.keyboard.press('Enter')
    await expect(interruptionNotice(anotherDevice)).toHaveCount(0)
    await expect(backLink(anotherDevice)).toBeFocused()
    await expect(statusRegion(anotherDevice)).toHaveText('')
    await typeInCell(anotherDevice, 'A1', 'after the interruption')
    await saveAndWait(anotherDevice)
  })

  test('US-M3-10 系统管理员停用持有者：编辑权被收回（明确结束），下一个人打开、进入编辑都没有异常中断的提醒', async ({ page, anotherDevice, newDevice }) => {
    const { holder, next, documentId } = await sharedDocument('it-disable')
    await loginThroughApi(page, holder)
    await openAndEnterEditing(page, documentId)
    const admin = await newDevice()
    await loginThroughApi(admin, await createUser('it-a2', '系统管理员', { systemRole: 'admin' }))
    await actAs(admin, 'POST', `/api/admin/users/${holder.id}/disable`)
    expect(await editLeaseEndReason(documentId)).toBe('revoked')

    await loginThroughApi(anotherDevice, next)
    await openAndCheck(anotherDevice, documentId)
    await expect(statusRegion(anotherDevice)).toHaveText('')
    await enterEditing(anotherDevice)
    await expect(saveButton(anotherDevice)).toBeVisible()
    await expect(interruptionNotice(anotherDevice)).toHaveCount(0)
    await expect(statusRegion(anotherDevice)).toHaveText('')
  })

  test('US-M3-10 上一位编辑者正常退出编辑（释放）：下一个人没有提醒', async ({ page, anotherDevice }) => {
    const { holder, next, documentId } = await sharedDocument('it-exit')
    await loginThroughApi(page, holder)
    await openAndEnterEditing(page, documentId)
    await exitEditing(page)
    expect(await editLeaseEndReason(documentId)).toBe('released')

    await loginThroughApi(anotherDevice, next)
    await openAndCheck(anotherDevice, documentId)
    await expect(statusRegion(anotherDevice)).toHaveText('')
    await enterEditing(anotherDevice)
    await expect(interruptionNotice(anotherDevice)).toHaveCount(0)
  })

  test('US-M3-10 只在 30 分钟以内提醒：上一代 29 分钟之前到期——阅读时说明（时刻是它最后一次续租）；挪到 31 分钟之前，下一次检查之后说明消失，进入编辑也没有提醒', async ({ page, anotherDevice }) => {
    const { holder, next, documentId } = await sharedDocument('it-window')
    await loginThroughApi(anotherDevice, holder)
    await leaseWithoutPage(anotherDevice, documentId)
    await expireEditLeaseAgo(documentId, 29)

    await loginThroughApi(page, next)
    await page.clock.install()
    await openAndCheck(page, documentId)
    await expect(statusRegion(page)).toHaveText(byOther(holder, interruptedAt(await editLeaseRenewedAt(documentId))))

    await expireEditLeaseAgo(documentId, 31)
    const checked = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/documents/${documentId}/edit-lease`)
    await page.clock.fastForward(READING_CHECK_MS)
    await checked
    await expect(statusRegion(page)).toHaveText('')
    await enterEditing(page)
    await expect(saveButton(page)).toBeVisible()
    await expect(interruptionNotice(page)).toHaveCount(0)
  })

  test('US-M3-10 自己的那一代异常结束（例如页面被关闭时保存在途、没有释放，之后到期）：阅读时不说（可能就是本页刚退出时没释放成的那一代），进入编辑之后说"你上一次的编辑……异常中断"', async ({ page }) => {
    const { holder, documentId } = await sharedDocument('it-self')
    await loginThroughApi(page, holder)
    await leaseWithoutPage(page, documentId)
    await expireEditLease(documentId)
    // 那一代最后一次续租的时刻（进入编辑之后这一行就是新的一代了）
    const text = bySelf(interruptedAt(await editLeaseRenewedAt(documentId)))

    await openAndCheck(page, documentId)
    await expect(statusRegion(page)).toHaveText('')
    await enterEditing(page)
    await expect(interruptionNotice(page)).toContainText(text)
    await expect(interruptionNotice(page).getByRole('button', { name: '知道了', exact: true })).toBeVisible()
  })

  test('US-M3-10 本页退出时释放没送到、那一代到期之后本页再进入编辑：服务端说那一代就是本页的（samePage），进入编辑之后不说"你上一次的编辑……异常中断"（本页的修改退出时都已存上）', async ({ page }) => {
    const { holder, documentId } = await sharedDocument('it-same-page')
    await loginThroughApi(page, holder)
    await page.clock.install()
    await openAndEnterEditing(page, documentId)
    // 退出时的释放送不到服务端：那一代还在（没有明确结束），到期之后服务端按事实算异常中断
    await page.route('**/api/documents/*/edit-lease', async route => route.request().method() === 'DELETE' ? route.abort('internetdisconnected') : route.continue())
    await exitEditing(page)
    await page.unroute('**/api/documents/*/edit-lease')
    expect(await editLeaseEndReason(documentId)).toBeNull()
    await expireEditLease(documentId)
    // 本页没能确认放掉的那一代过了有效期：页面再读一次编辑状态，没人在编辑，回到"编辑"（阅读时自己那一代的提醒本来就不说）
    await page.clock.fastForward(LEASE_TTL_MS)
    await expect(enterEditButton(page)).toBeVisible()

    const acquired = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/documents/${documentId}/edit-lease`)
    await enterEditing(page)
    const body = await (await acquired).json() as { readonly interruption: unknown }
    expect(body.interruption).toMatchObject({ holder: { id: holder.id }, sameUser: true, samePage: true })
    await expect(saveButton(page)).toBeVisible()
    await expect(interruptionNotice(page)).toHaveCount(0)
    await expect(statusRegion(page)).not.toContainText('异常中断')
  })
})
