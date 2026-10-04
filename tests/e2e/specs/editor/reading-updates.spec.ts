// 阅读者的更新提示（US-M3-05；M3-P2 设计 §3.4 的"阅读者的定时检查"，§3.2 的条件请求）：阅读时每 30 秒读一次编辑状态（只读状态，不读内容），
// 修订号比本页新时页头提示"有更新，点击刷新"；点了按 If-None-Match（本页的修订）取内容、以只读重建，保留视图（当前工作表、可见区域、选区）。
// 页面隐藏时不检查，回到前台立即检查一次。
// 不真等 30 秒：阅读者的浏览器上下文装上 Playwright 的时钟（page.clock.install，打开之前装；之后时间照常流动，页面照常载入、渲染），
// 要检查的时候 fastForward 30 秒——页面的计时器经注入的时钟（edit-lease.ts 的 browserLeaseClock：setTimeout 与 performance.now）
// 都是装上的假实现，到点的计时器随之触发。编辑的人在另一个浏览器上下文，用真实的时钟。
// 页面隐藏没有跨浏览器的办法（Playwright 的页面一直是可见的）：在页面里改写 document.visibilityState、document.hidden 并派发
// visibilitychange，页面就按它判断（start.tsx 的 browserVisibility 读的就是这两样）。
// 显示的内容与视图经探针读出（只在测试构建里）：标签 @test-build。
import type { Page } from '@playwright/test'
import { revisionEtag } from '@nerve-office/contracts'
import { createDocumentIn, createTeamSpace, createUser } from '../../support/database.ts'
import { editorView, scrollAndSelect, shownCell } from '../../support/editor-probe.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'
import { appendSheet, editingBy, editingNotice, EDITOR_TEST_TIMEOUT, editorSurface, openAndEnterEditing, openReader, saveAndWait, savedContent, saveStatus, sheetTab, typeInCell, waitForEditorAccess } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

/** 阅读时读编辑状态的间隔（M3 总设计 §2.1、US-M3-05） */
const CHECK_INTERVAL = 30_000

/** 页头的"有更新，点击刷新" */
function updateButton(page: Page) {
  return page.locator('#editor-chrome').getByRole('banner').getByRole('button', { name: '有更新，点击刷新', exact: true })
}

/** 阅读页读这份文档的请求：内容（带没带 If-None-Match）与编辑状态，按发出的先后 */
interface Reads {
  readonly content: (string | undefined)[]
  readonly status: number
}

function recordReads(page: Page, documentId: string): Reads {
  const reads = { content: [] as (string | undefined)[], status: 0 }
  page.on('request', (request) => {
    if (request.method() !== 'GET')
      return
    const path = new URL(request.url()).pathname
    if (path === `/api/documents/${documentId}/content`)
      reads.content.push(request.headers()['if-none-match'])
    else if (path === `/api/documents/${documentId}/edit-lease`)
      reads.status += 1
  })
  return reads
}

/** 等这个页面读完一次编辑状态（之后的检查按 30 秒计） */
async function statusReadsReach(reads: Reads, count: number): Promise<void> {
  await expect.poll(() => reads.status, { message: `读到第 ${count} 次编辑状态` }).toBeGreaterThanOrEqual(count)
}

/** 页面隐藏或回到前台：改写可见性并派发 visibilitychange（页面按 document.visibilityState 判断） */
async function setPageHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value ? 'hidden' : 'visible' })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value })
    document.dispatchEvent(new Event('visibilitychange'))
  }, hidden)
}

test.describe('US-M3-05 别人保存了新版本时阅读者得到提示', { tag: '@test-build' }, () => {
  test('US-M3-05 甲保存了新版本、乙在阅读：阅读页每 30 秒只读编辑状态（不读内容），30 秒内出现"有更新，点击刷新"；点了按 If-None-Match 取内容，显示最新的版本，视图照旧', async ({ page, anotherDevice }) => {
    const lead = await createUser('update-lead', '组长')
    const writer = await createUser('update-writer', '甲')
    const reader = await createUser('update-reader', '乙')
    const space = await createTeamSpace('有更新', lead, [[lead, 'admin'], [writer, 'editor'], [reader, 'viewer']])
    const documentId = await createDocumentIn(space.id, lead, '共同的表')

    // 甲：加一张表、保存（修订 2），接着在第二张表的 A1 键入（先不保存）
    await loginThroughApi(page, writer)
    await openAndEnterEditing(page, documentId)
    await appendSheet(page)
    await expect(sheetTab(page, '工作表2')).toHaveAttribute('aria-selected', 'true')
    await saveAndWait(page)
    await typeInCell(page, 'A1', 'v3')

    // 乙（查看者）：装上可控的时钟再打开（修订 2），看到甲在编辑；在第二张表上往下、往右滚，选中 K45:L47
    await loginThroughApi(anotherDevice, reader)
    await anotherDevice.clock.install()
    const reads = recordReads(anotherDevice, documentId)
    await openReader(anotherDevice, documentId)
    await statusReadsReach(reads, 1)
    await expect(editingNotice(anotherDevice)).toHaveText(editingBy(writer, false))
    await sheetTab(anotherDevice, '工作表2').click()
    await expect(sheetTab(anotherDevice, '工作表2')).toHaveAttribute('aria-selected', 'true')
    await scrollAndSelect(anotherDevice, 40, 8, 'K45:L47')
    await expect.poll(async () => editorView(anotherDevice)).toMatchObject({ sheet: '工作表2', top: 40, range: 'K45:L47', current: 'K45' })
    const view = await editorView(anotherDevice)
    expect(reads.content).toEqual([undefined])

    // 甲保存（修订 3）
    await saveAndWait(page)
    const latest = await savedContent(page, documentId)
    expect(latest.revision).toBe(3)

    // 乙：下一次检查（30 秒之后）读到修订 3，提示有更新；期间只读了编辑状态，没有读内容。
    // 从乙打开到这里不到 30 秒（时间照常流动），还没到下一次检查
    await expect(updateButton(anotherDevice)).toHaveCount(0)
    const before = reads.status
    await anotherDevice.clock.fastForward(CHECK_INTERVAL)
    await expect(updateButton(anotherDevice)).toBeVisible()
    expect(reads.status).toBe(before + 1)
    expect(reads.content).toEqual([undefined])

    // 点了：按 If-None-Match（本页的修订 2）取内容，以只读重建，显示修订 3（第二张表的 A1），视图照旧
    await updateButton(anotherDevice).click()
    const second = latest.snapshot.sheetOrder[1] ?? ''
    await expect.poll(async () => shownCell(anotherDevice, 'A1', second)).toBe('v3')
    await waitForEditorAccess(anotherDevice, 'read')
    await expect(anotherDevice.locator('#editor-chrome').getByRole('banner').getByRole('button')).toHaveCount(0)
    expect(reads.content).toEqual([undefined, revisionEtag(2)])
    expect(await editorView(anotherDevice)).toEqual(view)
    await expect(saveStatus(anotherDevice)).toHaveText('只能查看')

    // 之后照常每 30 秒只读编辑状态：没有新的版本就不提示，也不读内容。下一次检查在上一次的回答处理完之后才排上（请求发出时还没排），
    // 所以一次一次地往前拨，直到又读了两次
    const count = reads.status
    await expect.poll(async () => {
      await anotherDevice.clock.fastForward(CHECK_INTERVAL)
      return reads.status
    }, { message: '又读了两次编辑状态' }).toBeGreaterThanOrEqual(count + 2)
    await expect(updateButton(anotherDevice)).toHaveCount(0)
    expect(reads.content).toEqual([undefined, revisionEtag(2)])
    await expect(editorSurface(anotherDevice)).toHaveAttribute('data-editor-access', 'read')
  })

  test('US-M3-05 页面隐藏时不检查（时间过去多久都不读编辑状态）；回到前台立即检查一次，随即提示有更新', async ({ page, anotherDevice }) => {
    const lead = await createUser('update-hidden-lead', '组长')
    const writer = await createUser('update-hidden-writer', '甲')
    const reader = await createUser('update-hidden-reader', '乙')
    const space = await createTeamSpace('隐藏时不检查', lead, [[lead, 'admin'], [writer, 'editor'], [reader, 'editor']])
    const documentId = await createDocumentIn(space.id, lead, '共同的表')

    await loginThroughApi(anotherDevice, reader)
    await anotherDevice.clock.install()
    const reads = recordReads(anotherDevice, documentId)
    await openReader(anotherDevice, documentId)
    await statusReadsReach(reads, 1)

    // 乙的页面隐藏；甲编辑、保存了新的版本
    await setPageHidden(anotherDevice, true)
    await loginThroughApi(page, writer)
    await openAndEnterEditing(page, documentId)
    await typeInCell(page, 'A1', 'while hidden')
    await saveAndWait(page)

    // 隐藏期间过了两个间隔：一次编辑状态也不读，不提示
    const hiddenAt = reads.status
    await anotherDevice.clock.fastForward(CHECK_INTERVAL)
    await anotherDevice.clock.fastForward(CHECK_INTERVAL)
    await expect(updateButton(anotherDevice)).toHaveCount(0)
    expect(reads.status).toBe(hiddenAt)

    // 回到前台：立即读一次（不等下一个间隔），随即提示有更新；点了显示最新的版本
    await setPageHidden(anotherDevice, false)
    await expect(updateButton(anotherDevice)).toBeVisible()
    expect(reads.status).toBe(hiddenAt + 1)
    await updateButton(anotherDevice).click()
    await expect.poll(async () => shownCell(anotherDevice, 'A1')).toBe('while hidden')
    await expect(updateButton(anotherDevice)).toHaveCount(0)
    expect(reads.content).toEqual([undefined, revisionEtag(1)])
  })
})
