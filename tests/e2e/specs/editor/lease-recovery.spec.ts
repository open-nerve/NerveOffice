// 编辑权中断之后自动续上（US-M3-11 的在线部分；M3 总设计 §2.1 的细化，2026-10-04 决定从 P2 提前到 P1）：
// 编辑权因为到期（断网、休眠一类）、换了登录而中断，期间没人保存过、本人仍能编辑时，页面自动重新取得编辑权（新的一代），接着保存，
// 页头不出现失效的说明。续不上（别处在编辑、别处保存过）的情形见 conflict.spec.ts（US-M1-07）；
// 换了登录、原来的登录还在（经接口重新登录）的情形见 session.spec.ts（US-M1-05 的第三条）。
import { createUser, editLeaseEpoch, expireEditLease } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi, loginThroughUi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, openEditor, saveAndWait, savedContent, saveStatus, typeInCell } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

test.describe('US-M3-11 编辑权中断、期间没人保存过：自动续上，接着保存', () => {
  test('编辑权到期、没人接手（改写租约行的时间）：保存时（或者心跳先一步）续上新的一代，保存成功，不出现失效的说明', async ({ page }) => {
    await loginThroughApi(page, await createUser('recover-expired'))
    const documentId = await createSheetThroughApi(page)
    await openEditor(page, documentId)
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
    await openEditor(page, documentId)
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
