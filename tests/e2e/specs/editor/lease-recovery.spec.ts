// 编辑权中断之后自动续上（US-M3-11 的在线部分；M3 总设计 §2.1 的细化，2026-10-04 决定从 P2 提前到 P1）：
// 编辑权因为到期（断网、休眠一类）、换了登录而中断，期间没人保存过、本人仍能编辑时，页面自动重新取得编辑权（新的一代），接着保存，
// 页头不出现失效的说明。续不上（别处在编辑、别处保存过）的情形见 conflict.spec.ts（US-M1-07）；
// 换了登录、原来的登录还在（经接口重新登录）的情形见 session.spec.ts（US-M1-05 的第三条）。
// 期间的那一版是本页自己一次没收到回包的保存时（US-M3-13）：续上时认出是自己的，以它为基准接着保存，不当成别处保存过（审查 B1）。
import type { Page } from '@playwright/test'
import { createUser, editLeaseEpoch, expireEditLease } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi, loginThroughUi } from '../../support/session.ts'
import { blockLeaseRenewals, cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, openAndEnterEditing, saveAndWait, saveButton, savedContent, saveStatus, typeInCell } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

test.describe('US-M3-11 编辑权中断、期间没人保存过：自动续上，接着保存', () => {
  test('编辑权到期、没人接手（改写租约行的时间）：保存时（或者心跳先一步）续上新的一代，保存成功，不出现失效的说明', async ({ page }) => {
    await loginThroughApi(page, await createUser('recover-expired'))
    const documentId = await createSheetThroughApi(page)
    await openAndEnterEditing(page, documentId)
    const before = await editLeaseEpoch(documentId)
    await typeInCell(page, 'A1', 'after expiry')

    await expireEditLease(documentId)
    await saveAndWait(page)
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('after expiry')
    expect(await editLeaseEpoch(documentId)).toBeGreaterThan(before ?? 0)
    await expect(page.getByRole('alert')).toHaveCount(0)

    // 续上之后照常编辑、保存
    await typeInCell(page, 'A2', 'still editing')
    await saveAndWait(page)
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A2')?.v).toBe('still editing')
  })

  test('本人在别的标签页退出又重新登录（换了登录）：本页确认是本人之后续上新的一代，接着保存成功', async ({ page, context }) => {
    const owner = await createUser('recover-relogin')
    await loginThroughApi(page, owner)
    const documentId = await createSheetThroughApi(page)
    await openAndEnterEditing(page, documentId)
    const before = await editLeaseEpoch(documentId)
    await typeInCell(page, 'A1', 'after relogin')

    const other = await context.newPage()
    await other.goto('/')
    await other.getByRole('button', { name: '退出', exact: true }).click()
    await expect(other.getByRole('form', { name: '登录' })).toBeVisible()
    await expect(page.getByRole('alert').filter({ hasText: '本页的修改还在' })).toBeVisible()
    await loginThroughUi(other, owner)
    await expect(other.getByRole('heading', { name: '我的空间' })).toBeVisible()

    // 本页收到登录的消息，确认是本人；编辑权绑定的是原来的登录，随即续上（新的一代），页头没有任何说明
    await expect.poll(async () => editLeaseEpoch(documentId)).toBeGreaterThan(before ?? 0)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(saveStatus(page)).toHaveText('有未保存的修改')
    await saveAndWait(page)
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('after relogin')
  })
})

/**
 * 本页的第一次保存：请求照常到达服务端并提交（修订号 2），浏览器却收不到回包，页头说保存失败。之后接着改了 A2。
 * 返回打开时编辑权的代次
 */
async function saveWithLostReply(page: Page, documentId: string): Promise<number> {
  await openAndEnterEditing(page, documentId)
  const epoch = await editLeaseEpoch(documentId) ?? 0
  await page.route('**/api/documents/*/content?*', async (route) => {
    if (route.request().method() !== 'PUT') {
      await route.continue()
      return
    }
    await route.fetch()
    await route.abort('connectionreset')
  }, { times: 1 })
  await typeInCell(page, 'A1', 'first')
  await saveButton(page).click()
  await expect(saveStatus(page)).toHaveText('保存失败')
  expect((await savedContent(page, documentId)).revision).toBe(2)
  await typeInCell(page, 'A2', 'second')
  return epoch
}

test.describe('US-M3-13 没收到保存的确认，这期间编辑权到期：续上时认出期间的那一版是本页自己的，不误判为别处保存过', () => {
  test('US-M3-13 心跳先得知编辑权到期：续上新的一代，以本页那次保存的修订为基准，"保存失败"随之消失；接着保存，服务器上的内容正确（审查 B1）', async ({ page }) => {
    await loginThroughApi(page, await createUser('recover-own-heartbeat'))
    const documentId = await createSheetThroughApi(page)
    const before = await saveWithLostReply(page, documentId)

    // 断网超过 90 秒的效果：编辑权到期，下一次心跳得知、续上
    await expireEditLease(documentId)
    await expect.poll(async () => editLeaseEpoch(documentId), { timeout: 15_000 }).toBeGreaterThan(before)
    // 那次保存其实已经提交：不再说保存失败，之后改的 A2 还没保存；没有失效的说明
    await expect(saveStatus(page)).toHaveText('有未保存的修改')
    await expect(page.getByRole('alert')).toHaveCount(0)

    await saveAndWait(page)
    const saved = await savedContent(page, documentId)
    expect(saved.revision).toBe(3)
    expect([cellOf(saved.snapshot, 'A1')?.v, cellOf(saved.snapshot, 'A2')?.v]).toEqual(['first', 'second'])
    await typeInCell(page, 'A3', 'third')
    await saveAndWait(page)
    const again = await savedContent(page, documentId)
    expect(again.revision).toBe(4)
    expect(cellOf(again.snapshot, 'A3')?.v).toBe('third')
  })

  test('US-M3-13 保存先得知编辑权到期：续上时认出是本页自己的，用新的一代重发、换上新的基准，保存成功，服务器上的内容正确（审查 B1）', async ({ page }) => {
    await loginThroughApi(page, await createUser('recover-own-save'))
    const documentId = await createSheetThroughApi(page)
    const before = await saveWithLostReply(page, documentId)

    // 拦下心跳（断网、休眠一类），免得它先一步得知；编辑权到期之后按保存
    await blockLeaseRenewals(page)
    await expireEditLease(documentId)
    await saveAndWait(page)
    expect(await editLeaseEpoch(documentId)).toBeGreaterThan(before)
    await expect(page.getByRole('alert')).toHaveCount(0)
    const saved = await savedContent(page, documentId)
    expect(saved.revision).toBe(3)
    expect([cellOf(saved.snapshot, 'A1')?.v, cellOf(saved.snapshot, 'A2')?.v]).toEqual(['first', 'second'])
  })
})
