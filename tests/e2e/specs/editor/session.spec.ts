// 登录状态变化时的编辑器页（P4 设计 §3.7.3，审查 B1）：本页可能有未保存的修改，所以不整页跳转、不自动重新加载。
// 登录已过期或在别处退出：暂停保存，提示在新标签页中登录，本人登录回来之后恢复；别的标签页登录了另一个人：本页不能再保存。
// M3-P1 起编辑权（编辑租约）绑定"这个标签页、这次登录"（P1 设计 §3.4.1）：本人重新登录之后，页面确认是本人、核对编辑权，
// 得知它随原来的登录失效，随即自动续上（期间没人保存过），所以"登录回来之后保存成功"照旧成立。
// 核对保存这一条路遇到未登录、令牌失效时怎样确认会话的几条（1、3、4）拦下心跳（support/sheet.ts 的 blockLeaseRenewals）：
// 心跳也会先发现登录变化；M4-P2 起拦下的心跳还会暂停云端保存。因此先完成一次真实心跳并冻结时钟，在有限页面时间内触发保存，再放开恢复。
// M3-P4 起修改自动保存：会话不是本人时不上传，回到本人时立即上传（测试构建的夹具暂停了定时的上传，生产镜像里没有这个控制）——
// 回来之后不断言"有未保存的修改"，按保存之后看结果；令牌按"之前的都是旧的、之后的都是新的"核对（生产构建里回来时可能多一次自动上传）
import type { Page, Request } from '@playwright/test'
import { createUser, expireSessions } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { openBeforeSave } from '../../support/save-before-heartbeat.ts'
import { loginThroughApi, loginThroughUi } from '../../support/session.ts'
import { blockLeaseRenewals, cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, isSaveRequest, openAndEnterEditing, saveAndWait, saveButton, savedContent, saveStatus, typeInCell } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

/** 这个页面所在的浏览器上下文现在的会话的 CSRF 令牌 */
async function csrfTokenOf(page: Page): Promise<string> {
  const session = await (await page.request.get('/api/auth/session')).json() as { csrfToken: string }
  return session.csrfToken
}

/**
 * 保存带的 CSRF 令牌：第一次是旧的（被拒），之后都是新的、至少一次——生产构建里会话回来时自动保存也上传，可能比按的那一次多一次，
 * 但不会再带着旧的令牌发
 */
function expectTokens(tokens: readonly (string | undefined)[], oldToken: string, newToken: string): void {
  expect(tokens[0]).toBe(oldToken)
  expect(tokens.length).toBeGreaterThan(1)
  expect(new Set(tokens.slice(1))).toEqual(new Set([newToken]))
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

/** 保存先失败、随后才开始确认会话；不把心跳先发现问题的另一条故事当成通过。 */
function expectSaveTriggeredSession(events: readonly string[]): void {
  expect(events[0]).toBe('save')
  expect(events).not.toContain('heartbeat')
  expect(events.indexOf('session')).toBeGreaterThan(events.indexOf('save'))
}

test.describe('US-M1-05 登录状态变化时，本页的修改不丢', () => {
  test('登录过期之后保存：留在本页，提示在新标签页中登录；登录回来之后保存成功', async ({ page, context }) => {
    const owner = await createUser('editor-expired')
    await loginThroughApi(page, owner)
    const documentId = await createSheetThroughApi(page)
    const prepared = await openBeforeSave(page, documentId)
    const renewals = await blockLeaseRenewals(page)
    const editorUrl = page.url()
    let releaseChecks = (): void => {}
    try {
      await typeInCell(page, 'A1', 'kept')
      await expireSessions(owner)
      // 确认会话有结果之前：页头说明正在确认，不先显示任何失败的说明（复验 TB1、UB2）
      const checks = await holdSessionChecks(page)
      releaseChecks = checks.release
      await saveButton(page).click()
      await prepared.expectResponse(401)
      await expect.poll(checks.held).toBe(1)
      expectSaveTriggeredSession(prepared.events)
      await expect(saveStatus(page)).toHaveText('正在确认登录状态…')
      await expect(page.getByRole('alert')).toHaveCount(0)
      checks.release()
      // 没有人登录了：自动保存暂停，失败原因由唯一的会话提示说明（复验 RB2、SB3）
      await expect(saveStatus(page)).toHaveText('暂停保存：登录回来之后自动保存')
      const alert = page.getByRole('alert').filter({ hasText: '本页的修改还在' })
      await expect(alert).toBeVisible()
      await expect(page.getByRole('alert')).toHaveCount(1)
      expect(page.url()).toBe(editorUrl)

      await renewals.unblock()
      // 新标签页共用时钟：先恢复，再操作真实登录界面。
      await prepared.resume()
      const [loginPage] = await Promise.all([context.waitForEvent('page'), alert.getByRole('link', { name: '在新标签页中登录' }).click()])
      await expect(loginPage.getByRole('form', { name: '登录' })).toBeVisible()
      await loginThroughUi(loginPage, owner)
      await expect(loginPage.getByRole('heading', { name: '我的空间' })).toBeVisible()
      // 登录标签页发出消息，本页确认本人后续上编辑权，原说明清掉。
      await expect(alert).toBeHidden()
      await expect(page.getByRole('alert')).toHaveCount(0)
      await saveAndWait(page)
      expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('kept')
    }
    finally {
      await renewals.unblock()
      releaseChecks()
      await prepared.resume()
    }
  })

  test('确认会话还没结束时按保存：等确认结束，确认是本人之后照常保存（复验 RB1）', async ({ page, context }) => {
    const owner = await createUser('editor-check-pending')
    await loginThroughApi(page, owner)
    const documentId = await createSheetThroughApi(page)
    await openAndEnterEditing(page, documentId)
    await typeInCell(page, 'A1', 'waited')
    await expireSessions(owner)
    await saveButton(page).click()
    await expect(page.getByRole('alert').filter({ hasText: '本页的修改还在' })).toBeVisible()

    // 拖住本页确认会话的请求：别的标签页登录之后，本页的确认还没回来时就按保存
    const checks = await holdSessionChecks(page)
    const other = await context.newPage()
    await other.goto('/login')
    await loginThroughUi(other, owner)
    await expect(other.getByRole('heading', { name: '我的空间' })).toBeVisible()
    // 本页收到登录的消息、开始确认会话（被拦住）之后再按保存（复验 SB3）：确认有结果之前一次也不发
    await expect.poll(checks.held).toBe(1)
    const sent: Request[] = []
    page.on('request', (request) => {
      if (isSaveRequest(request))
        sent.push(request)
    })
    await page.keyboard.press('ControlOrMeta+s')
    await expect(saveStatus(page)).toHaveText('正在确认登录状态…')
    expect(sent).toEqual([])
    checks.release()
    // 确认是本人之后保存成功（生产构建里自动保存在会话回来时也上传，先发出的可能是它）
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('waited')
  })

  test('本人在别处重新登录（消息没有送到）、保存得到令牌失效：确认期间说明正在确认；再按保存等换上新的令牌再发（复验 TB1、TB3）', async ({ page, context }) => {
    const owner = await createUser('editor-csrf-stale')
    await loginThroughApi(page, owner)
    const documentId = await createSheetThroughApi(page)
    const prepared = await openBeforeSave(page, documentId)
    const renewals = await blockLeaseRenewals(page)
    let releaseChecks = (): void => {}
    try {
      // 接口登录不广播；先换会话和令牌，再修改，第一次保存必带旧令牌，两种自动保存节奏都一样。
      const oldToken = await csrfTokenOf(page)
      const other = await context.newPage()
      await loginThroughApi(other, owner)
      const newToken = await csrfTokenOf(other)
      expect(newToken).not.toBe(oldToken)
      const checks = await holdSessionChecks(page)
      releaseChecks = checks.release
      const tokens: (string | undefined)[] = []
      page.on('request', (request) => {
        if (isSaveRequest(request))
          tokens.push(request.headers()['x-csrf-token'])
      })
      await typeInCell(page, 'A1', 'csrf-wait')
      await page.keyboard.press('ControlOrMeta+s')
      await prepared.expectResponse(403)
      await expect.poll(checks.held).toBe(1)
      expectSaveTriggeredSession(prepared.events)
      // 确认有结果之前：不先提示请求失效（复验 TB1）。
      await expect(saveStatus(page)).toHaveText('正在确认登录状态…')
      await expect(page.getByRole('alert')).toHaveCount(0)

      // 确认期间再按保存：不发，等确认换上新的令牌（复验 RB1、TB3）。
      const early = page.waitForRequest(isSaveRequest, { timeout: 500 }).then(() => true, () => false)
      await page.keyboard.press('ControlOrMeta+s')
      expect(await early).toBe(false)
      await renewals.unblock()
      checks.release()
      await prepared.resume()
      await expect(saveStatus(page)).toHaveText('已保存到云端')
      expectTokens(tokens, oldToken, newToken)
      expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('csrf-wait')
    }
    finally {
      await renewals.unblock()
      releaseChecks()
      await prepared.resume()
    }
  })

  test('本人在别处重新登录、保存得到令牌失效、确认会话断网：说明原因，不带着失效的令牌再发；网络恢复之后换上新的令牌保存（复验 UB1、VB2）', async ({ page, context }) => {
    const owner = await createUser('editor-csrf-offline')
    await loginThroughApi(page, owner)
    const documentId = await createSheetThroughApi(page)
    const prepared = await openBeforeSave(page, documentId)
    const renewals = await blockLeaseRenewals(page)
    try {
      // 修改前换登录并令会话确认断网；冻结心跳，保证是保存得到旧令牌的真实 403。
      const oldToken = await csrfTokenOf(page)
      const other = await context.newPage()
      await loginThroughApi(other, owner)
      const newToken = await csrfTokenOf(other)
      const tokens: (string | undefined)[] = []
      page.on('request', (request) => {
        if (isSaveRequest(request))
          tokens.push(request.headers()['x-csrf-token'])
      })
      await page.route('**/api/auth/session', async route => route.abort('internetdisconnected'))
      await typeInCell(page, 'A1', 'csrf-offline')
      await page.keyboard.press('ControlOrMeta+s')
      await prepared.expectResponse(403)
      await expect(page.getByRole('alert')).toHaveText(/保存失败：暂时无法确认登录状态：网络连接失败/)
      expectSaveTriggeredSession(prepared.events)
      // 再按保存：先确认，又断网，不带着失效的令牌再发。
      const resent = page.waitForRequest(isSaveRequest, { timeout: 1_000 }).then(() => true, () => false)
      await page.keyboard.press('ControlOrMeta+s')
      expect(await resent).toBe(false)
      expect(tokens).toEqual([oldToken])

      await page.unroute('**/api/auth/session')
      await renewals.unblock()
      await prepared.resume()
      await saveAndWait(page)
      expectTokens(tokens, oldToken, newToken)
      expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('csrf-offline')
    }
    finally {
      await page.unroute('**/api/auth/session')
      await renewals.unblock()
      await prepared.resume()
    }
  })

  test('别的标签页退出并换人登录：本页不能再保存；原来的人登录回来之后恢复', async ({ page, context }) => {
    const owner = await createUser('editor-owner')
    const someoneElse = await createUser('editor-someone-else')
    await loginThroughApi(page, owner)
    const documentId = await createSheetThroughApi(page)
    await openAndEnterEditing(page, documentId)

    const other = await context.newPage()
    await other.goto('/')
    await other.getByRole('button', { name: '退出', exact: true }).click()
    await expect(other.getByRole('form', { name: '登录' })).toBeVisible()
    await expect(page.getByRole('alert').filter({ hasText: '本页的修改还在' })).toBeVisible()
    // 没有人登录时改的：不上传（修改自动保存，在这之前改的话生产构建里停 2 秒就存上了），一直是没存上的修改
    await typeInCell(page, 'A1', 'mine')
    await expect(saveStatus(page)).toHaveText('暂停保存：登录回来之后自动保存')

    await loginThroughUi(other, someoneElse)
    await expect(other.getByRole('heading', { name: '我的空间' })).toBeVisible()
    await expect(page.getByRole('alert').filter({ hasText: '别的标签页登录了另一个账户，本页不能再保存' })).toBeVisible()
    await expect(saveButton(page)).toHaveAttribute('aria-disabled', 'true')
    // 换了人：自动保存暂停（M3-P4 设计 §3.9）
    await expect(saveStatus(page)).toHaveText('暂停保存：登录回来之后自动保存')

    await other.getByRole('button', { name: '退出', exact: true }).click()
    await loginThroughUi(other, owner)
    await expect(other.getByRole('heading', { name: '我的空间' })).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await saveAndWait(page)
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('mine')
  })
})
