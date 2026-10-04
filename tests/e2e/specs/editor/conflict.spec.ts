// 两个标签页，旧页面的保存不覆盖新内容（US-M1-07，P4 设计 §3.5.2、§3.10）。M3-P1 起同一时刻只有一个标签页能编辑（编辑租约，
// P1 设计 §3.4.7）：后打开的只能阅读；前一个断网、休眠到编辑权到期之后才轮到它，前一个回来时续不上（别处在编辑或者保存过），
// 再保存被拒、保留本页的内容。"到期"用改写租约行的时间模拟，前一个"断网、休眠"用拦下它的心跳模拟（support/sheet.ts 的
// blockLeaseRenewals）：不拦的话，它自己的心跳会先一步得知到期、自动续上（期间没人保存过），后一个就接不了手。
// M3-P2 起打开即阅读、点"编辑"才申请编辑权；失去编辑权之后本页换成只读、显示本页的内容，给"另存为副本"与"放弃本页的修改"
import { createUser, expireEditLease } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { pressUniverShortcut } from '../../support/keyboard.ts'
import { loginThroughApi } from '../../support/session.ts'
import { blockLeaseRenewals, cellOf, createSheetThroughApi, editingNotice, EDITOR_TEST_TIMEOUT, enterEditButton, enterEditing, isSaveRequest, leaveEditor, lostNotice, openAndEnterEditing, openReader, saveAndWait, saveButton, savedContent, saveStatus, selectCell, typeInCell, waitForEditorAccess } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

test.describe('US-M1-07 两个标签页，旧页面的保存不覆盖新内容', () => {
  test('A 编辑时 B 只能阅读；A 的编辑权到期之后 B 点"编辑"接手保存；A 再保存被拒、保留本页的内容，服务器上是 B 的版本', async ({ page, context }) => {
    await loginThroughApi(page, await createUser('conflict'))
    const documentId = await createSheetThroughApi(page)
    await openAndEnterEditing(page, documentId)
    await typeInCell(page, 'A1', 'from A')

    // B（同一个人的另一个标签页）：打开即阅读，读到编辑状态，说明是自己在另一个标签页或设备上编辑；能编辑的人照样有"编辑"，没有保存
    const other = await context.newPage()
    await openReader(other, documentId)
    await expect(editingNotice(other)).toHaveText('你在另一个标签页或设备上正在编辑这份文档，这里只能阅读。要是刚刚关闭或刷新过那个页面，那边的编辑权最多 90 秒后自动结束，到时再点"编辑"就能编辑')
    await expect(enterEditButton(other)).toBeVisible()
    await expect(saveButton(other)).toHaveCount(0)

    // A 断网、休眠，编辑权到期（改写租约行的时间，不等真实的 90 秒）；B 点"编辑"，取得编辑权，键入并保存
    const asleep = await blockLeaseRenewals(page)
    await expireEditLease(documentId)
    await enterEditing(other)
    await expect(saveButton(other)).toBeVisible()
    await expect(editingNotice(other)).toHaveCount(0)
    await typeInCell(other, 'A1', 'from B')
    await saveAndWait(other)

    // A 回来再保存：被拒（编辑权已经在 B 手里；A 的心跳也可能先一步得知），自动续上时被 B 占着：
    // 页头说明编辑权已失效、是自己在另一个标签页上编辑、本页的修改没有保存，可以另存为副本或者放弃；本页换成只读，没有保存按钮
    await asleep.unblock()
    await saveButton(page).click()
    await expect(saveStatus(page)).toHaveText('编辑权已失效')
    const lost = lostNotice(page)
    await expect(lost).toContainText('编辑权已失效：你在另一个标签页或设备上正在编辑这份文档（要是刚刚关闭或刷新过那个页面，那边的编辑权最多 90 秒后自动结束，到时再点"编辑"就能编辑）。本页的修改没有保存：可以另存为副本，或者放弃这些修改。')
    await expect(lost.getByRole('button', { name: '另存为副本', exact: true })).toBeVisible()
    await expect(lost.getByRole('button', { name: '放弃本页的修改', exact: true })).toBeVisible()
    await waitForEditorAccess(page, 'read', 'steady')
    await expect(saveButton(page)).toHaveCount(0)

    // 服务器上是 B 的版本
    const saved = await savedContent(page, documentId)
    expect(cellOf(saved.snapshot, 'A1')?.v).toBe('from B')
    expect(saved.revision).toBe(2)

    // A 的表格里仍是本页的内容（以只读重建、显示捕获的内容）：画布上的字读不出来，用查找核对（Codex 评审的覆盖说明）。
    // 只读时没有工具栏：点一下表格，按查找的快捷键
    await selectCell(page, 'C3')
    await pressUniverShortcut(page, 'F')
    const find = page.getByRole('dialog', { name: '查找' })
    await find.getByRole('textbox', { name: '输入查找内容' }).fill('from A')
    await find.getByRole('textbox', { name: '输入查找内容' }).press('Enter')
    await expect(find).toContainText('1/1')
    await find.getByRole('button', { name: 'Close' }).click()

    // A 保留本页的内容：再按保存不发请求（审查 B7），离开时仍提示有没保存的内容。
    // "没有请求"只能等一段时间再下结论：正常的保存从按键到发出请求不到 100 ms（公式收齐每 20 ms 判断一次），这里等 1 秒
    const put = page.waitForRequest(isSaveRequest, { timeout: 1_000 }).then(() => true, () => false)
    await page.keyboard.press('ControlOrMeta+s')
    expect(await put).toBe(false)
    await expect(saveStatus(page)).toHaveText('编辑权已失效')
    expect((await savedContent(page, documentId)).revision).toBe(2)
    const dialogs: string[] = []
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.type())
      void dialog.dismiss()
    })
    await page.close({ runBeforeUnload: true })
    await expect.poll(() => dialogs).toEqual(['beforeunload'])
  })

  test('保存已经提交、回包却丢了：再保存时认出是本页自己的保存（自己追自己），不报冲突', async ({ page }) => {
    await loginThroughApi(page, await createUser('conflict-self'))
    const documentId = await createSheetThroughApi(page)
    await openAndEnterEditing(page, documentId)
    // 第一次保存：请求照常到达服务端并提交，浏览器却收不到回包
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

    // 接着修改再保存：基准修订号已经过时，冲突的来源是本页那一次保存，换上当前修订号重发
    await typeInCell(page, 'A2', 'second')
    await saveAndWait(page)
    const saved = await savedContent(page, documentId)
    expect(saved.revision).toBe(3)
    expect([cellOf(saved.snapshot, 'A1')?.v, cellOf(saved.snapshot, 'A2')?.v]).toEqual(['first', 'second'])
  })

  test('编辑权失效之后放弃本页的修改：看到服务器上的最新版本，点"编辑"可以继续编辑保存', async ({ page, context }) => {
    await loginThroughApi(page, await createUser('conflict-reload'))
    const documentId = await createSheetThroughApi(page)
    await openAndEnterEditing(page, documentId)
    await typeInCell(page, 'B1', 'older page')

    // 这一页断网、休眠，编辑权到期；另一个标签页接手、保存，然后离开（关闭页面时释放编辑权）。
    // 等释放到了服务端再往下：这一页重新加载时要取得编辑权，释放晚到时它只能阅读（P1 设计 §7 第一条，P5 用 Web Locks 解决）
    const asleep = await blockLeaseRenewals(page)
    await expireEditLease(documentId)
    const other = await context.newPage()
    await openAndEnterEditing(other, documentId)
    await expect(saveButton(other)).toBeVisible()
    await typeInCell(other, 'A1', 'newer')
    await saveAndWait(other)
    await leaveEditor(other, documentId)
    await other.close()

    // 这一页回来再保存被拒：自动续上时发现别处保存过更新的版本，不覆盖，说明之后给"另存为副本"与"放弃本页的修改"。
    // 放弃（先确认）：按服务器上的最新版本重建为阅读，不重新加载整页（不出现离开的提示）；之后点"编辑"照常编辑、保存
    await asleep.unblock()
    await saveButton(page).click()
    const lost = lostNotice(page)
    await expect(lost).toContainText('编辑权已失效：编辑权中断期间，别处保存了更新的版本，本页不能再覆盖它。本页的修改没有保存：可以另存为副本，或者放弃这些修改。')
    const dialogs: string[] = []
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.type())
      void dialog.accept()
    })
    await lost.getByRole('button', { name: '放弃本页的修改', exact: true }).click()
    await page.getByRole('dialog', { name: '放弃本页的修改？' }).getByRole('button', { name: '放弃修改', exact: true }).click()
    await expect(lostNotice(page)).toHaveCount(0)
    await waitForEditorAccess(page, 'read')
    await enterEditing(page, 'steady')
    expect(dialogs).toEqual([])
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    await typeInCell(page, 'C1', 'after discard')
    await saveAndWait(page)
    const saved = (await savedContent(page, documentId)).snapshot
    expect([cellOf(saved, 'A1')?.v, cellOf(saved, 'B1'), cellOf(saved, 'C1')?.v]).toEqual(['newer', undefined, 'after discard'])
  })
})
