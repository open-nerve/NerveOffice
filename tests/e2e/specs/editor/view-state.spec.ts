// 按新内容重建时的视图状态（M3-P2 设计 §3.3，复核 B1）：阅读者点"有更新，点击刷新"，按服务端的新版本以只读重建、恢复视图。
// 新版本里本页当前单元格的合并布局变了——别人合并了它所在的格子，或者取消了它所在的合并——SDK 的 activateAsCurrentCell 只接受
// 一个没有合并的单元格或者恰好一个合并区，照旧设它会抛错：报成页面错误、滚动也没恢复。恢复前先按新表的合并信息核对，
// 不符合就不设当前单元格（落在选区的左上角），工作表与可见区域照旧，没有页面错误（夹具对任何页面错误都判失败）。
// 新版本由另一个人经编辑器造出（进入编辑、经探针的 Facade 合并或取消合并、保存），与真实的使用相同；"有更新"由回到前台的
// 立即检查给出（改写可见性并派发 visibilitychange，同 reading-updates.spec.ts）。视图经探针读出（只在测试构建里）：标签 @test-build
import type { Page } from '@playwright/test'
import type { Workbook } from '../../support/sheet.ts'
import { createDocumentIn, createTeamSpace, createUser } from '../../support/database.ts'
import { editorView, runFacade, scrollAndSelect } from '../../support/editor-probe.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'
import { EDITOR_TEST_TIMEOUT, openAndEnterEditing, openReader, saveAndWait, savedContent, waitForEditorAccess } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

/** 合并区：快照里 mergeData 的一项 */
interface Merge {
  readonly startRow: number
  readonly endRow: number
  readonly startColumn: number
  readonly endColumn: number
}

/** B45:C46（从 0 开始是第 44–45 行、第 1–2 列） */
const B45_C46: Merge = { startRow: 44, endRow: 45, startColumn: 1, endColumn: 2 }

/** 页头的"有更新，点击刷新" */
function updateButton(page: Page) {
  return page.locator('#editor-chrome').getByRole('banner').getByRole('button', { name: '有更新，点击刷新', exact: true })
}

/** 页面隐藏、再回到前台：阅读页回到前台时立即读一次编辑状态（页面按 document.visibilityState 判断） */
async function hideAndShow(page: Page): Promise<void> {
  for (const hidden of [true, false]) {
    await page.evaluate((value) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value ? 'hidden' : 'visible' })
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => value })
      document.dispatchEvent(new Event('visibilitychange'))
    }, hidden)
  }
}

/** 快照里第一张表的合并区（只取四个边界） */
function mergesOf(snapshot: Workbook): Merge[] {
  const sheets = snapshot.sheets as Readonly<Record<string, { readonly mergeData?: readonly Merge[] }>>
  return (sheets[snapshot.sheetOrder[0] ?? '']?.mergeData ?? []).map(({ startRow, endRow, startColumn, endColumn }) => ({ startRow, endRow, startColumn, endColumn }))
}

/**
 * 页面里现在显示的第一张表的合并区（探针给出的内存快照）。重建期间旧的编辑器已经销毁、新的还没就绪，页面里没有探针，
 * 这时为 undefined：调用方用 expect.poll 等到换上了新内容的编辑器（探针在恢复视图之后才装上，等到它时视图已经恢复）
 */
async function shownMerges(page: Page): Promise<Merge[] | undefined> {
  const text = await page.evaluate(() => window.__nerveEditorProbe?.snapshot() ?? '')
  return text === '' ? undefined : mergesOf(JSON.parse(text) as Workbook)
}

/** 阅读者：回到前台立即检查，看到"有更新"，点了，等换上显示 merges 的那个编辑器到 steady */
async function refreshTo(page: Page, merges: readonly Merge[]): Promise<void> {
  await hideAndShow(page)
  await expect(updateButton(page)).toBeVisible()
  await updateButton(page).click()
  await expect(updateButton(page)).toHaveCount(0)
  await expect.poll(async () => shownMerges(page), { message: '等换上新内容的编辑器', timeout: 30_000 }).toEqual(merges)
  await waitForEditorAccess(page, 'read', 'steady')
}

test.describe('US-M3-05 有更新、按新内容重建之后视图照旧：当前单元格的合并布局变了（M3-P2 复核 B1）', { tag: '@test-build' }, () => {
  test('US-M3-05 别人合并了本页当前单元格所在的格子、之后又取消了合并：两次刷新都停在同一张表、同一个可见区域，当前单元格落在选区的左上角，没有页面错误', async ({ page, anotherDevice, pageErrors }) => {
    const lead = await createUser('view-merge-lead', '组长')
    const writer = await createUser('view-merge-writer', '甲')
    const reader = await createUser('view-merge-reader', '乙')
    const space = await createTeamSpace('合并之后', lead, [[lead, 'admin'], [writer, 'editor'], [reader, 'viewer']])
    const documentId = await createDocumentIn(space.id, lead, '共同的表')

    // 乙（查看者）打开（修订 1）：滚到第 41 行在左上角，选中 B45，当前单元格就是它
    await loginThroughApi(anotherDevice, reader)
    await openReader(anotherDevice, documentId, 'steady')
    await scrollAndSelect(anotherDevice, 40, 0, 'B45')
    await expect.poll(async () => editorView(anotherDevice)).toMatchObject({ top: 40, range: 'B45', current: 'B45' })
    const view = await editorView(anotherDevice)

    // 甲进入编辑，把 B45:C46 合并、保存（修订 2）
    await loginThroughApi(page, writer)
    await openAndEnterEditing(page, documentId)
    expect(await runFacade(page, ({ sheet }) => sheet.getRange('B45:C46').merge())).toEqual({})
    await saveAndWait(page)
    const merged = await savedContent(page, documentId)
    expect([merged.revision, mergesOf(merged.snapshot)]).toEqual([2, [B45_C46]])

    // 乙刷新：记下的当前单元格 B45 现在落在合并区里，不设它；表、可见区域与选区照旧，当前单元格是选区左上角所在的合并区
    await refreshTo(anotherDevice, [B45_C46])
    expect(await editorView(anotherDevice)).toEqual({ ...view, current: 'B45:C46' })
    expect(pageErrors.list()).toEqual([])

    // 甲取消这个合并、保存（修订 3）
    expect(await runFacade(page, ({ sheet }) => (sheet.getRange('B45:C46') as unknown as { breakApart: () => unknown }).breakApart())).toEqual({})
    await saveAndWait(page)
    const unmerged = await savedContent(page, documentId)
    expect([unmerged.revision, mergesOf(unmerged.snapshot)]).toEqual([3, []])

    // 乙再刷新：记下的当前单元格是合并区 B45:C46，现在不是合并区了，不设它；表、可见区域与选区照旧，当前单元格回到 B45
    await refreshTo(anotherDevice, [])
    expect(await editorView(anotherDevice)).toEqual(view)
    expect(pageErrors.list()).toEqual([])
  })
})
