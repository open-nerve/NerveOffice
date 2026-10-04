// 同一个人打开、刷新与关闭编辑器页时的编辑权（US-M3-04 的同一个人、多个标签页的部分；P1 设计 §3.4.7、§7 第一条）：
// 打开时申请，回包丢了也不留下没人用的一代——同一个页面用同一个标识再试一次，服务端当作重试、发新的一代（审查 B7）；
// 刷新、关闭时经 keepalive 释放，之后刷新、重开出来的页面立即能编辑。M3-P2 起打开即阅读，点"编辑"才申请。
// 这几条都不在导航离开之前装拦截：WebKit 装了 page.route 之后，导航离开、刷新时的 keepalive 请求送不到（support/sheet.ts 的 leaveEditor）
import { createUser, editLeaseEndReason, editLeaseEpoch } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, editingNotice, EDITOR_TEST_TIMEOUT, openAndEnterEditing, reloadAndEnterEditing, saveAndWait, saveButton, savedContent, typeInCell } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

test.describe('US-M3-04 同一个人在多个标签页：打开、刷新与关闭时的编辑权', () => {
  test('US-M3-04 申请的回包丢了（服务端其实已经批给了本页）：页面用同一个标识再试一次，照常编辑与保存，不留下占着编辑权、却没有页面在用的一代（审查 B7）', async ({ page }) => {
    await loginThroughApi(page, await createUser('acquire-lost-reply'))
    const documentId = await createSheetThroughApi(page)
    // 这个页面的第一次申请（POST；阅读时读编辑状态的 GET 照常）：请求照常到达服务端并取得，浏览器却收不到回包
    let dropped = false
    await page.route('**/api/documents/*/edit-lease', async (route) => {
      if (dropped || route.request().method() !== 'POST') {
        await route.continue()
        return
      }
      dropped = true
      await route.fetch()
      await route.abort('connectionreset')
    })
    await openAndEnterEditing(page, documentId)
    await expect(saveButton(page)).toBeVisible()
    await expect(editingNotice(page)).toHaveCount(0)
    // 服务端：第一次申请取得了一代；再试是同一个页面的重试，发了新的一代，取代没人用的那一代
    expect(await editLeaseEpoch(documentId)).toBe(2)
    await typeInCell(page, 'A1', 'after retry')
    await saveAndWait(page)
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('after retry')
  })

  test('US-M3-04 关闭标签页：编辑权随即释放（keepalive 送到），之后打开的页面立即能编辑', async ({ page, context }) => {
    await loginThroughApi(page, await createUser('close-releases'))
    const documentId = await createSheetThroughApi(page)
    const editor = await context.newPage()
    await openAndEnterEditing(editor, documentId)
    await expect(saveButton(editor)).toBeVisible()
    expect(await editLeaseEndReason(documentId)).toBeNull()

    await editor.close()
    await expect.poll(async () => editLeaseEndReason(documentId)).toBe('released')
    await openAndEnterEditing(page, documentId)
    await expect(saveButton(page)).toBeVisible()
    await expect(editingNotice(page)).toHaveCount(0)
  })

  test('US-M3-04 刷新：刷新出来的页面点"编辑"立即能编辑，每次是新的一代（旧页面的释放晚到时，新页面隔一小会儿再试，P1 设计 §7 第一条）', async ({ page }) => {
    await loginThroughApi(page, await createUser('reload-keeps-editing'))
    const documentId = await createSheetThroughApi(page)
    await openAndEnterEditing(page, documentId)
    let epoch = await editLeaseEpoch(documentId) ?? 0
    for (let round = 0; round < 3; round += 1) {
      await reloadAndEnterEditing(page)
      await expect(saveButton(page)).toBeVisible()
      await expect(editingNotice(page)).toHaveCount(0)
      const next = await editLeaseEpoch(documentId) ?? 0
      expect(next).toBeGreaterThan(epoch)
      epoch = next
    }
    await typeInCell(page, 'A1', 'after reloads')
    await saveAndWait(page)
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('after reloads')
  })
})
