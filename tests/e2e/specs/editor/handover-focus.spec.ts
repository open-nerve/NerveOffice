// P5 各条交接路径之后焦点去哪里（规范 §2.4"操作之后焦点不落到 body"；M3-P5 S8 的焦点通查）：
// - 重建编辑器的路径（空闲释放、交出、本人接管的两边、请求方自动进入、强制接管、被接管）：新建的编辑器初始化时把焦点放进它的输入框（SDK 的做法，
//   edit-mode.spec 的 US-M3-01 钉着"编辑""退出编辑"），所以页头里随之消失的按钮、单元格里开着的编辑都不会让焦点落到 body——焦点在重建出来的编辑器里；
// - 不重建就消失的（提示里的"继续编辑"、异常中断的"知道了"、随权限消失的"强制接管"）：useFocusRescue 交给页头的返回链接。
// 都用键盘按（焦点在按钮上），单元格里的用开着的单元格编辑。两个人、两个浏览器上下文；同一个人的两个标签页用同一个上下文。时间用 Playwright 的时钟
// （打开之前装上，之后照常流动），要到点时拨。容器 E2E 也跑：断言只看焦点与模式
import type { Locator, Page } from '@playwright/test'
import type { TestUser } from '../../support/database.ts'
import { createDocumentIn, createTeamSpace, createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'
import { backLink, cancelRequestButton, EDITOR_TEST_TIMEOUT, focusPlace, forceTakeOverButton, lostNotice, openAndEnterEditing, openReader, requestEditButton, requestPrompt, saveButton, selectCell, takeOverHereButton, waitForEditorAccess } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

/** 心跳间隔与请求方的续期间隔（契约的 EDIT_LEASE_HEARTBEAT_SECONDS、EDIT_REQUEST_RENEW_SECONDS） */
const HEARTBEAT_MS = 10_000
const RENEW_MS = 5_000

/** 组长（空间管理员）、甲、乙都在同一个团队空间里 */
async function sharedDocument(prefix: string): Promise<{ readonly lead: TestUser, readonly holder: TestUser, readonly other: TestUser, readonly documentId: string }> {
  const lead = await createUser(`${prefix}-l`, '组长')
  const holder = await createUser(`${prefix}-h`, '甲')
  const other = await createUser(`${prefix}-o`, '乙')
  const space = await createTeamSpace(prefix, lead, [[lead, 'admin'], [holder, 'editor'], [other, 'editor']])
  const documentId = await createDocumentIn(space.id, lead, '共同的表')
  return { lead, holder, other, documentId }
}

/** 选中一格、开始键入（不提交）：焦点在单元格编辑器里 */
async function typingInCell(page: Page): Promise<void> {
  await selectCell(page, 'B2')
  await page.keyboard.type('typing')
  expect(await focusPlace(page)).toBe('editor')
}

/** 键盘按一个按钮 */
async function pressWithKeyboard(page: Page, button: Locator): Promise<void> {
  await button.focus()
  await page.keyboard.press('Enter')
}

/** 持有者的下一次心跳带来请求：页头下面出现提示 */
async function prompted(page: Page): Promise<void> {
  await page.clock.fastForward(HEARTBEAT_MS)
  await expect(requestPrompt(page)).toBeVisible()
}

test.describe('M3-P5 交接路径之后的焦点（规范 §2.4）', () => {
  test('US-M3-07 空闲释放：单元格里开着编辑时 10 分钟没有操作——保存、释放、以只读重建之后焦点在新的编辑器里，不落到 body', async ({ page }) => {
    const { holder, documentId } = await sharedDocument('fc-idle')
    await loginThroughApi(page, holder)
    await page.clock.install()
    await openAndEnterEditing(page, documentId)
    await typingInCell(page)
    await page.clock.fastForward('10:30')
    await waitForEditorAccess(page, 'read')
    await expect.poll(async () => focusPlace(page)).toBe('editor')
  })

  test('US-M3-06 请求编辑与交出（键盘）：请求方按"请求编辑"，等待时焦点还在同一个按钮上（"取消请求"）；持有者按"交出"，焦点从按钮进到重建出来的编辑器里；请求方自动进入编辑之后焦点在编辑器里', async ({ page, anotherDevice }) => {
    const { holder, other, documentId } = await sharedDocument('fc-hand')
    await loginThroughApi(page, holder)
    await page.clock.install()
    await openAndEnterEditing(page, documentId)
    await loginThroughApi(anotherDevice, other)
    await anotherDevice.clock.install()
    await openReader(anotherDevice, documentId)
    await pressWithKeyboard(anotherDevice, requestEditButton(anotherDevice))
    await expect(cancelRequestButton(anotherDevice)).toBeFocused()

    await prompted(page)
    await pressWithKeyboard(page, requestPrompt(page).getByRole('button', { name: '交出', exact: true }))
    await waitForEditorAccess(page, 'read')
    await expect(requestPrompt(page)).toHaveCount(0)
    await expect.poll(async () => focusPlace(page)).toBe('editor')

    await anotherDevice.clock.fastForward(RENEW_MS)
    await waitForEditorAccess(anotherDevice, 'edit')
    await expect(saveButton(anotherDevice)).toBeVisible()
    await expect.poll(async () => focusPlace(anotherDevice)).toBe('editor')
  })

  test('US-M3-06 持有者按"继续编辑"（键盘）：提示消失（不重建），焦点交给返回链接，不落到 body', async ({ page, anotherDevice }) => {
    const { holder, other, documentId } = await sharedDocument('fc-keep')
    await loginThroughApi(page, holder)
    await page.clock.install()
    await openAndEnterEditing(page, documentId)
    await loginThroughApi(anotherDevice, other)
    await openReader(anotherDevice, documentId)
    await requestEditButton(anotherDevice).click()
    await expect(cancelRequestButton(anotherDevice)).toBeVisible()

    await prompted(page)
    await pressWithKeyboard(page, requestPrompt(page).getByRole('button', { name: '继续编辑', exact: true }))
    await expect(requestPrompt(page)).toHaveCount(0)
    await expect(backLink(page)).toBeFocused()
    await expect(saveButton(page)).toBeVisible()
  })

  test('US-M3-08 本人接管（同一个浏览器，键盘）：B 按"在此编辑"，进入编辑之后焦点在编辑器里；A 单元格里开着编辑，交出、回到阅读之后焦点在它重建出来的编辑器里', async ({ page, context }) => {
    const { holder, documentId } = await sharedDocument('fc-self')
    await loginThroughApi(page, holder)
    await openAndEnterEditing(page, documentId)
    const other = await context.newPage()
    await openReader(other, documentId)
    await typingInCell(page)
    await pressWithKeyboard(other, takeOverHereButton(other))
    await waitForEditorAccess(other, 'edit')
    await expect.poll(async () => focusPlace(other)).toBe('editor')
    await waitForEditorAccess(page, 'read')
    await expect.poll(async () => focusPlace(page)).toBe('editor')
  })

  test('US-M3-09 被强制接管：单元格里开着编辑的人失去编辑权、以只读重建之后焦点在编辑器里（不落到 body），失效的说明照常出来', async ({ page, anotherDevice }) => {
    const { lead, holder, documentId } = await sharedDocument('fc-forced')
    await loginThroughApi(page, holder)
    await page.clock.install()
    await openAndEnterEditing(page, documentId)
    await loginThroughApi(anotherDevice, lead)
    await openReader(anotherDevice, documentId)
    await typingInCell(page)
    await forceTakeOverButton(anotherDevice).click()
    await anotherDevice.getByRole('dialog', { name: '强制接管编辑？' }).getByRole('button', { name: '强制接管', exact: true }).click()
    await waitForEditorAccess(anotherDevice, 'edit')

    await page.clock.fastForward(HEARTBEAT_MS)
    await expect(lostNotice(page)).toBeVisible()
    await waitForEditorAccess(page, 'read')
    await expect.poll(async () => focusPlace(page)).toBe('editor')
  })
})
