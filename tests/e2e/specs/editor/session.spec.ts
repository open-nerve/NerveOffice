// 登录状态变化时的编辑器页（P4 设计 §3.7.3，审查 B1）：本页可能有未保存的修改，所以不整页跳转、不自动重新加载。
// 登录已过期或在别处退出：暂停保存，提示在新标签页中登录；别的标签页登录了另一个人：本页不能再保存。
//
// M3-P1 起编辑权（编辑租约）绑定"这个标签页、这次登录"（P1 设计 §3.4.1）：重新登录（换了令牌）之后，本页的编辑权随原来的登录失效，
// 页面确认是本人之后立即核对一次编辑权、得知失效，说明原因、不再发保存。P2 的"续上"会在期间没人保存过时自动重新取得编辑权，
// 届时这几条改回"登录回来之后保存成功"。核对保存与确认会话那几步的用例拦下心跳（support/sheet.ts 的 blockLeaseRenewals）：
// 心跳也会得知登录失效，结果取决于它恰好落在哪里
import type { Page } from '@playwright/test'
import { createUser, expireSessions, revisionOf } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi, loginThroughUi } from '../../support/session.ts'
import { blockLeaseRenewals, cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, isSaveRequest, openEditor, saveButton, savedContent, saveStatus, typeInCell } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

/** 这个页面所在的浏览器上下文现在的会话的 CSRF 令牌 */
async function csrfTokenOf(page: Page): Promise<string> {
  const session = await (await page.request.get('/api/auth/session')).json() as { csrfToken: string }
  return session.csrfToken
}

/** 拖住本页确认会话的请求，直到 release；held 是已经拦住的次数 */
async function holdSessionChecks(page: Page): Promise<{ held: () => number, release: () => void }> {
  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let held = 0
  await page.route('**/api/auth/session', async (route) => {
    held += 1
    await released
    await route.continue()
  })
  return { held: () => held, release }
}

/** 编辑权随原来的登录失效（P1）：页头说明原因与本页的修改没有保存，保存不可用 */
async function expectLeaseLostWithLogin(page: Page): Promise<void> {
  await expect(saveStatus(page)).toHaveText('编辑权已失效')
  const alert = page.getByRole('alert')
  await expect(alert).toHaveCount(1)
  await expect(alert).toContainText('编辑权已失效：登录状态变了（重新登录、退出或换了账户），编辑权随原来的登录一起失效。本页的修改没有保存')
  await expect(alert.getByRole('button', { name: '重新加载' })).toBeVisible()
  await expect(saveButton(page)).toHaveAttribute('aria-disabled', 'true')
}

/** 等一段时间确认本页没有发保存（正常的保存从按键到发出请求不到 100 ms，这里等 1 秒） */
async function noSaveWithin(page: Page, action: () => Promise<void>): Promise<boolean> {
  const put = page.waitForRequest(isSaveRequest, { timeout: 1_000 }).then(() => true, () => false)
  await action()
  return !await put
}

test.describe('US-M1-05 登录状态变化时，本页的修改不丢', () => {
  test('登录过期之后保存：留在本页，提示在新标签页中登录；登录回来之后说明编辑权随原来的登录失效，修改留在本页（续上在 P2）', async ({ page, context }) => {
    const owner = await createUser('editor-expired')
    await loginThroughApi(page, owner)
    const documentId = await createSheetThroughApi(page)
    await openEditor(page, documentId)
    const renewals = await blockLeaseRenewals(page)
    const editorUrl = page.url()
    await typeInCell(page, 'A1', 'kept')

    await expireSessions(owner)
    // 确认会话有结果之前：页头说明正在确认，不先显示任何失败的说明（复验 TB1、UB2）
    const checks = await holdSessionChecks(page)
    await saveButton(page).click()
    await expect.poll(checks.held).toBe(1)
    await expect(saveStatus(page)).toHaveText('正在确认登录状态…')
    await expect(page.getByRole('alert')).toHaveCount(0)
    checks.release()
    await expect(saveStatus(page)).toHaveText('保存失败')
    const alert = page.getByRole('alert').filter({ hasText: '本页的修改还在' })
    await expect(alert).toBeVisible()
    // 编辑权跟着这次登录失效了：不说"回到这里保存"
    await expect(alert).toContainText('编辑权随之失效，本页不能再保存')
    await expect(alert).not.toContainText('回到这里保存')
    // 会话的提示已经说明：不再重复"登录已过期"的失败说明（复验 RB2、SB3）
    await expect(page.getByRole('alert')).toHaveCount(1)
    expect(page.url()).toBe(editorUrl)

    await renewals.unblock()
    const [loginPage] = await Promise.all([context.waitForEvent('page'), alert.getByRole('link', { name: '在新标签页中登录' }).click()])
    await expect(loginPage.getByRole('form', { name: '登录' })).toBeVisible()
    await loginThroughUi(loginPage, owner)
    await expect(loginPage.getByRole('heading', { name: '我的空间' })).toBeVisible()
    // 登录的标签页发出消息，本页向服务端确认是同一个人，随即核对编辑权：绑定的是原来的登录，已经失效。
    // 会话的提示与"登录已过期"的失败说明随之清掉（复验 RB2），只说明编辑权已失效
    await expect(alert).toBeHidden()
    await expectLeaseLostWithLogin(page)
    expect(await noSaveWithin(page, async () => page.keyboard.press('ControlOrMeta+s'))).toBe(true)
    expect(await revisionOf(documentId)).toBe(1)
    expect(page.url()).toBe(editorUrl)
  })

  test('确认会话还没结束时按保存：等确认结束（连同编辑权的核对），编辑权随原来的登录失效时不发保存（复验 RB1；续上在 P2）', async ({ page, context }) => {
    const owner = await createUser('editor-check-pending')
    await loginThroughApi(page, owner)
    const documentId = await createSheetThroughApi(page)
    await openEditor(page, documentId)
    const renewals = await blockLeaseRenewals(page)
    await typeInCell(page, 'A1', 'waited')
    await expireSessions(owner)
    await saveButton(page).click()
    await expect(page.getByRole('alert').filter({ hasText: '本页的修改还在' })).toBeVisible()

    // 拖住本页确认会话的请求：别的标签页登录之后，本页的确认还没回来时就按保存
    await renewals.unblock()
    const checks = await holdSessionChecks(page)
    const other = await context.newPage()
    await other.goto('/login')
    await loginThroughUi(other, owner)
    await expect(other.getByRole('heading', { name: '我的空间' })).toBeVisible()
    // 本页收到登录的消息、开始确认会话（被拦住）之后再按保存（复验 SB3）
    await expect.poll(checks.held).toBe(1)
    const saved = page.waitForRequest(isSaveRequest, { timeout: 5_000 }).then(() => true, () => false)
    await page.keyboard.press('ControlOrMeta+s')
    await expect(saveStatus(page)).toHaveText('正在确认登录状态…')
    checks.release()
    // 确认是本人之后立即核对编辑权：已经随原来的登录失效，按下的那次保存不再发出
    await expectLeaseLostWithLogin(page)
    expect(await saved).toBe(false)
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')).toBeUndefined()
  })

  test('本人在别处重新登录（消息没有送到）、保存得到令牌失效：确认期间说明正在确认，再按保存不发；确认之后编辑权随原来的登录失效，不再发保存（复验 TB1、TB3；续上在 P2）', async ({ page, context }) => {
    const owner = await createUser('editor-csrf-stale')
    await loginThroughApi(page, owner)
    const documentId = await createSheetThroughApi(page)
    await openEditor(page, documentId)
    const renewals = await blockLeaseRenewals(page)
    await typeInCell(page, 'A1', 'csrf-wait')
    // 同一个人经接口重新登录：会话与令牌都换了，没有页面广播消息，本页还拿着旧的令牌
    const oldToken = await csrfTokenOf(page)
    const other = await context.newPage()
    await loginThroughApi(other, owner)
    const newToken = await csrfTokenOf(other)
    expect(newToken).not.toBe(oldToken)

    const checks = await holdSessionChecks(page)
    const tokens: (string | undefined)[] = []
    page.on('request', (request) => {
      if (isSaveRequest(request))
        tokens.push(request.headers()['x-csrf-token'])
    })
    const first = page.waitForResponse(response => isSaveRequest(response.request()))
    await saveButton(page).click()
    expect((await first).status()).toBe(403)
    await expect.poll(checks.held).toBe(1)
    // 确认有结果之前：页头说明正在确认，不先提示"请求已失效，请再保存一次"（复验 TB1）
    await expect(saveStatus(page)).toHaveText('正在确认登录状态…')
    await expect(page.getByRole('alert')).toHaveCount(0)

    // 确认期间再按保存：不发，等确认换上新的令牌（复验 RB1、TB3）
    const early = page.waitForRequest(isSaveRequest, { timeout: 500 }).then(() => true, () => false)
    await page.keyboard.press('ControlOrMeta+s')
    expect(await early).toBe(false)
    // 确认是本人、换上新的令牌之后立即核对编辑权：绑定的是原来的登录，已经失效，等着的那次保存不再发出
    await renewals.unblock()
    checks.release()
    await expectLeaseLostWithLogin(page)
    expect(await noSaveWithin(page, async () => {})).toBe(true)
    expect(tokens).toEqual([oldToken])
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')).toBeUndefined()
  })

  test('本人在别处重新登录、保存得到令牌失效、确认会话断网：说明原因，不带着失效的令牌再发；网络恢复之后确认是本人，编辑权随原来的登录失效（复验 UB1、VB2；续上在 P2）', async ({ page, context }) => {
    const owner = await createUser('editor-csrf-offline')
    await loginThroughApi(page, owner)
    const documentId = await createSheetThroughApi(page)
    await openEditor(page, documentId)
    const renewals = await blockLeaseRenewals(page)
    await typeInCell(page, 'A1', 'csrf-offline')
    const oldToken = await csrfTokenOf(page)
    const other = await context.newPage()
    await loginThroughApi(other, owner)
    const tokens: (string | undefined)[] = []
    page.on('request', (request) => {
      if (isSaveRequest(request))
        tokens.push(request.headers()['x-csrf-token'])
    })

    await page.route('**/api/auth/session', async route => route.abort('internetdisconnected'))
    await saveButton(page).click()
    await expect(page.getByRole('alert')).toHaveText(/保存失败：暂时无法确认登录状态：网络连接失败/)
    // 再按保存：先确认，又断网，不带着失效的令牌再发
    expect(await noSaveWithin(page, async () => saveButton(page).click())).toBe(true)
    expect(tokens).toEqual([oldToken])

    // 网络恢复：按保存先确认会话，是本人、换上新的令牌，随即核对编辑权——已经随原来的登录失效，不再发保存
    await page.unroute('**/api/auth/session')
    await renewals.unblock()
    expect(await noSaveWithin(page, async () => saveButton(page).click())).toBe(true)
    await expectLeaseLostWithLogin(page)
    expect(tokens).toEqual([oldToken])
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')).toBeUndefined()
  })

  test('别的标签页退出并换人登录：本页不能再保存；原来的人登录回来之后，编辑权随原来的登录失效（续上在 P2）', async ({ page, context }) => {
    const owner = await createUser('editor-owner')
    const someoneElse = await createUser('editor-someone-else')
    await loginThroughApi(page, owner)
    const documentId = await createSheetThroughApi(page)
    await openEditor(page, documentId)
    await typeInCell(page, 'A1', 'mine')

    const other = await context.newPage()
    await other.goto('/')
    await other.getByRole('button', { name: '退出', exact: true }).click()
    await expect(other.getByRole('form', { name: '登录' })).toBeVisible()
    await expect(page.getByRole('alert').filter({ hasText: '本页的修改还在' })).toBeVisible()

    await loginThroughUi(other, someoneElse)
    await expect(other.getByRole('heading', { name: '我的空间' })).toBeVisible()
    const otherUser = page.getByRole('alert').filter({ hasText: '别的标签页登录了另一个账户，本页不能再保存' })
    await expect(otherUser).toBeVisible()
    // 编辑权跟着原来的登录失效了：不说"原来的账户重新登录之后可以继续保存"
    await expect(otherUser).not.toContainText('可以继续保存')
    await expect(saveButton(page)).toHaveAttribute('aria-disabled', 'true')
    await expect(saveStatus(page)).toHaveText('有未保存的修改')

    await other.getByRole('button', { name: '退出', exact: true }).click()
    await loginThroughUi(other, owner)
    await expect(other.getByRole('heading', { name: '我的空间' })).toBeVisible()
    await expect(otherUser).toBeHidden()
    await expectLeaseLostWithLogin(page)
    expect(await revisionOf(documentId)).toBe(1)
  })
})
