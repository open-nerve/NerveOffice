// 保存协议加固的页面一侧（M3-P3 设计 §3.5、§3.7、§3.10；US-M3-14、US-M3-16）：
// - 旧版页面写不进来：page.route 把页面发出的请求改写成旧页面的（保存的查询参数、申请编辑权与心跳的请求体里的 Univer 版本换成旧的），
//   服务端回答 CLIENT_OUTDATED，页面停下来说明需要刷新——保存时是终态（放掉编辑权，不能再保存），申请时留在阅读，
//   编辑中的心跳在 10 秒之内停下（服务端升级之后不必等到保存才知道）；
// - 文档由更新的版本保存过（服务端回滚之后，库里的 sdk_version 比服务端的新）：打开就只能阅读，服务端也拒绝申请（DOCUMENT_TOO_NEW）；
// - 快照达到容量的 80%：编辑时页头之下一直在的状态区里给一条不打断的说明；
// - 不合格的快照：经探针写进服务端不收的内容（嵌套过深的单元格数据），保存失败、按规则给出说法，服务器上的内容不变；
// - 内容没变的保存：修订号不增加，页面照"已保存"处理（回答 unchanged），改了再保存照常加一。
// 服务端的各种版本组合、每条规则与回执的重放由集成测试覆盖（tests/integration/src/documents/save-protocol.test.ts）
import type { Locator, Page, Route } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { sheetSnapshotFor, SNAPSHOT_MAX_RAW_BYTES, SNAPSHOT_WARN_RAW_BYTES, UNIVER_SDK_VERSION } from '@nerve-office/contracts'
import { CURRENT_CLIENT } from '../../support/client-format.ts'
import { createDocument, createUser, editLeaseEndReason, editLeaseEpoch, revisionOf, withDatabase } from '../../support/database.ts'
import { runFacade } from '../../support/editor-probe.ts'
import { e2eOrigin } from '../../support/environment.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, enterEditButton, enterEditing, openAndEnterEditing, openReader, saveAndCapture, saveAndWait, saveButton, savedContent, saveStatus, typeInCell, waitForEditorAccess } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

/** 旧页面的 Univer 版本：与服务端的不同（数据格式过旧） */
const OLD_UNIVER_VERSION = '0.0.1'

/** 编辑器页的页头与说明（#editor-chrome） */
function chrome(page: Page): Locator {
  return page.locator('#editor-chrome')
}

/** 本页的版本过旧的说明（role="alert"） */
function outdatedNotice(page: Page): Locator {
  return chrome(page).getByRole('alert').filter({ hasText: /^页面的版本过旧/ })
}

/** 页头之下一直在的读屏状态区里容量的说明 */
function capacityNote(page: Page): Locator {
  return chrome(page).getByRole('status').filter({ hasText: '已用去容量上限' })
}

/**
 * 把这个页面发出的请求改写成旧页面的：保存（PUT …/content 的查询参数）、申请编辑权（POST …/edit-lease 的请求体）或心跳
 * （PUT …/edit-lease 的请求体）里的 Univer 版本换成旧的，别的请求照常。返回撤掉改写的函数
 */
async function fakeOldPage(page: Page, request: 'save' | 'acquire' | 'renew'): Promise<() => Promise<void>> {
  const pattern = request === 'save' ? '**/api/documents/*/content?*' : '**/api/documents/*/edit-lease'
  const method = request === 'acquire' ? 'POST' : 'PUT'
  const handler = async (route: Route): Promise<void> => {
    const sent = route.request()
    if (sent.method() !== method) {
      await route.continue()
      return
    }
    if (request === 'save') {
      const url = new URL(sent.url())
      url.searchParams.set('univerVersion', OLD_UNIVER_VERSION)
      await route.continue({ url: url.toString() })
      return
    }
    await route.continue({ postData: JSON.stringify({ ...sent.postDataJSON() as Record<string, unknown>, univerVersion: OLD_UNIVER_VERSION }) })
  }
  await page.route(pattern, handler)
  return async () => page.unroute(pattern, handler)
}

/** 接近容量上限的表：模板的第一张表填上 1,000 行 × 10 列、每格 432 个字符的文字，解压之后约 4.5 MB（上限 5 MiB 的 85% 上下） */
function nearCapacitySheetFor(unitId: string): string {
  const workbook = JSON.parse(sheetSnapshotFor(unitId)) as { sheetOrder: string[], sheets: Record<string, { cellData: Record<string, Record<string, unknown>> }> }
  const sheet = workbook.sheets[workbook.sheetOrder[0] ?? '']
  if (sheet === undefined)
    throw new Error('模板里没有第一张表')
  const text = 'nearly full '.repeat(36)
  for (let row = 0; row < 1_000; row += 1)
    sheet.cellData[String(row)] = Object.fromEntries(Array.from({ length: 10 }, (_, column) => [String(column), { v: text, t: 1 }]))
  return JSON.stringify(workbook)
}

test.describe('US-M3-16 旧版页面不能把文档写回旧格式', () => {
  test('伪造的旧版本保存：服务端回答 CLIENT_OUTDATED，页头"需要刷新"，说明本页的修改没有保存、先复制出来再重新加载；不能再保存，编辑权放掉；重新加载之后照常编辑', async ({ page }) => {
    await loginThroughApi(page, await createUser('outdated-save'))
    const documentId = await createSheetThroughApi(page)
    await openAndEnterEditing(page, documentId)
    await typeInCell(page, 'A1', '旧页面的修改')
    const restore = await fakeOldPage(page, 'save')
    await saveButton(page).click()

    await expect(saveStatus(page)).toHaveText('需要刷新')
    await expect(outdatedNotice(page)).toContainText('页面的版本过旧，本页的修改没有保存，也不能再保存。需要的话先把内容复制出来，再重新加载页面')
    await expect(saveButton(page)).toHaveAttribute('aria-disabled', 'true')
    await expect.poll(async () => editLeaseEndReason(documentId)).toBe('released')
    expect(await revisionOf(documentId)).toBe(1)

    // 重新加载：新的页面（撤掉改写）照常进入编辑、保存。本页还有没保存的修改，离开的确认里选择离开
    await restore()
    page.once('dialog', dialog => void dialog.accept())
    await outdatedNotice(page).getByRole('button', { name: '重新加载' }).click()
    await waitForEditorAccess(page, 'read')
    await enterEditing(page)
    await typeInCell(page, 'A1', '新页面的修改')
    await saveAndWait(page)
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('新页面的修改')
  })

  test('伪造的旧版本申请编辑权：留在阅读，页头"需要刷新"，不再给"编辑"，说明并给"重新加载"；服务端没有发出编辑权；重新加载之后照常进入编辑', async ({ page }) => {
    await loginThroughApi(page, await createUser('outdated-acquire'))
    const documentId = await createSheetThroughApi(page)
    await openReader(page, documentId)
    const restore = await fakeOldPage(page, 'acquire')
    // 键盘按"编辑"（WebKit 点击按钮不给它焦点，用键盘才看得出焦点交给了谁）
    await enterEditButton(page).focus()
    await page.keyboard.press('Enter')

    await expect(saveStatus(page)).toHaveText('需要刷新')
    await expect(outdatedNotice(page)).toContainText('页面的版本过旧，不能进入编辑。重新加载页面之后再编辑')
    await expect(enterEditButton(page)).toHaveCount(0)
    await expect(saveButton(page)).toHaveCount(0)
    // "编辑"随之消失：焦点交给返回链接，不落到 body（规范 §2.4）
    await expect(chrome(page).getByRole('banner').getByRole('link').first()).toBeFocused()
    expect(await editLeaseEpoch(documentId)).toBeUndefined()

    await restore()
    await outdatedNotice(page).getByRole('button', { name: '重新加载' }).click()
    await waitForEditorAccess(page, 'read')
    await enterEditing(page)
    await expect(saveStatus(page)).toHaveText('已保存到云端')
  })

  test('编辑中服务端升级了（心跳带的是旧版本）：10 秒之内停下来，页头"需要刷新"，本页的修改都已保存时说明重新加载之后可以接着编辑；不能再保存，编辑权放掉', async ({ page }) => {
    await loginThroughApi(page, await createUser('outdated-renew'))
    const documentId = await createSheetThroughApi(page)
    await openAndEnterEditing(page, documentId)
    await typeInCell(page, 'A1', '心跳之前保存的')
    await saveAndWait(page)
    await fakeOldPage(page, 'renew')

    // 心跳每 10 秒一次：留足一个间隔加上慢机器的余量
    await expect(saveStatus(page)).toHaveText('需要刷新', { timeout: 30_000 })
    await expect(outdatedNotice(page)).toContainText('页面的版本过旧，不能再保存。本页的修改都已保存，重新加载页面之后可以接着编辑')
    await expect(saveButton(page)).toHaveAttribute('aria-disabled', 'true')
    await expect.poll(async () => editLeaseEndReason(documentId)).toBe('released')
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('心跳之前保存的')
  })

  test('文档由更新的版本保存过（服务端回滚之后）：打开就只能阅读，不给"编辑"，说明由更新的版本保存过、不提示刷新；服务端拒绝申请编辑权（DOCUMENT_TOO_NEW）', async ({ page }) => {
    await loginThroughApi(page, await createUser('too-new'))
    const documentId = await createSheetThroughApi(page)
    const newer = `${Number(UNIVER_SDK_VERSION.split('.')[0]) + 1}.0.0`
    await withDatabase(async client => client.query('UPDATE documents SET sdk_version = $2 WHERE id = $1', [documentId, newer]))

    await openReader(page, documentId)
    await expect(saveStatus(page)).toHaveText('只能查看')
    await expect(enterEditButton(page)).toHaveCount(0)
    await expect(chrome(page).getByText('这份文档由更新的版本保存过，当前只能阅读，不能编辑')).toBeVisible()
    await expect(chrome(page).getByRole('button', { name: '重新加载' })).toHaveCount(0)

    // 页面不给"编辑"之外，服务端同样拒绝：照现在的页面直接申请
    const { csrfToken } = await (await page.request.get('/api/auth/session')).json() as { csrfToken: string }
    const response = await page.request.post(`/api/documents/${documentId}/edit-lease`, {
      data: { clientInstanceId: randomUUID(), ...CURRENT_CLIENT },
      headers: { 'origin': e2eOrigin(), 'x-csrf-token': csrfToken },
    })
    expect(response.status(), await response.text()).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'DOCUMENT_TOO_NEW' } })
    expect(await editLeaseEpoch(documentId)).toBeUndefined()
  })
})

test.describe('US-M3-14 服务端拒绝不合格的快照', () => {
  test('快照达到容量的 80%：进入编辑时页头之下的状态区给一条不打断的说明（占上限的百分比），保存照常，保存之后照样说明', async ({ page }) => {
    const owner = await createUser('near-capacity')
    const text = nearCapacitySheetFor('unit-for-size')
    const bytes = new TextEncoder().encode(text).byteLength
    expect(bytes).toBeGreaterThan(SNAPSHOT_WARN_RAW_BYTES)
    expect(bytes).toBeLessThan(SNAPSHOT_MAX_RAW_BYTES)
    await loginThroughApi(page, owner)
    const documentId = await createDocument(owner, '快满的表', nearCapacitySheetFor)

    await openReader(page, documentId)
    await expect(capacityNote(page)).toHaveCount(0)
    await enterEditing(page)
    await expect(capacityNote(page)).toHaveText(/^这份表格已用去容量上限（5 MiB）的 8\d%，再加内容可能就保存不了了$/)
    await expect(chrome(page).getByRole('alert')).toHaveCount(0)

    await typeInCell(page, 'K1', '再加一点')
    await saveAndWait(page)
    await expect(capacityNote(page)).toHaveText(/的 8\d%/)
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'K1')?.v).toBe('再加一点')
  })

  test('不合格的快照（经探针写进服务端不收的内容：嵌套过深的单元格数据）：保存失败，按违反的规则说明，服务器上的内容不变', { tag: '@test-build' }, async ({ page }) => {
    await loginThroughApi(page, await createUser('invalid-snapshot'))
    const documentId = await createSheetThroughApi(page)
    await openAndEnterEditing(page, documentId)
    const before = await savedContent(page, documentId)
    // 单元格的自定义数据（Univer 的 cell.custom）嵌套 80 层：页面照常捕获、上传，服务端的检查按嵌套的上限（64 层）拒绝（depth）
    const outcome = await runFacade(page, ({ sheet }) => {
      let deep: Record<string, unknown> = { leaf: true }
      for (let level = 0; level < 80; level += 1)
        deep = { level: deep }
      ;(sheet.getRange('B2') as unknown as { setCustomMetaData: (data: unknown) => unknown }).setCustomMetaData(deep)
    })
    expect(outcome).toEqual({})
    await expect(saveStatus(page)).toHaveText('有未保存的修改')
    await saveButton(page).click()

    await expect(saveStatus(page)).toHaveText('保存失败')
    await expect(chrome(page).getByRole('alert').filter({ hasText: '保存失败：表格的内容过于复杂（嵌套太深）' })).toBeVisible()
    const after = await savedContent(page, documentId)
    expect([after.revision, after.text]).toEqual([before.revision, before.text])
  })

  test('内容没变的保存：修订号不增加，页面照"已保存"处理（回答 unchanged、保存时间是原来的）；改了再保存照常加一', async ({ page }) => {
    await loginThroughApi(page, await createUser('unchanged-save'))
    const documentId = await createSheetThroughApi(page)
    await openAndEnterEditing(page, documentId)
    await typeInCell(page, 'A1', '第一次')
    const first = await saveAndCapture(page)
    expect(first.answer).toMatchObject({ revision: 2, unchanged: false })

    // 不改，再按保存：内容相同，修订号不变，保存时间是那一版的
    const again = await saveAndCapture(page)
    expect(again.answer).toEqual({ revision: 2, savedAt: first.answer.savedAt, unchanged: true })
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(await revisionOf(documentId)).toBe(2)

    // 改了：照常加一
    await typeInCell(page, 'A2', '第二次')
    const changed = await saveAndCapture(page)
    expect(changed.answer).toMatchObject({ revision: 3, unchanged: false })
    const saved = await savedContent(page, documentId)
    expect([saved.revision, cellOf(saved.snapshot, 'A1')?.v, cellOf(saved.snapshot, 'A2')?.v]).toEqual([3, '第一次', '第二次'])
  })
})
