// 阅读与编辑的切换（US-M3-01；M3-P2 设计 §3.1、§3.3、§3.4）：打开一律是阅读（以只读创建，刚由自己新建的表格经 ?edit=new 直接进入编辑），
// 点"编辑"申请编辑权、以可编辑重建，"退出编辑"先保存、再释放编辑权、以只读重建。模式切换一律重建编辑器（需求方 2026-10-04 决定）：
// - 切换之后编辑真的能编辑、只读真的只读（"进入再退出"之后跑与查看者的只读同一套入口检查，support/read-only-checks.ts）、撤销栈已清空
//   （新的实例：上一段编辑的撤销不再起作用；先在同一次编辑里核对同一套按键确实能撤销，阳性对照）；销毁旧的编辑器时终止它的公式 Worker，
//   页面的 Worker 回到 1 个；
// - 进入、退出没有成功（403、被占用、退出时保存失败）时焦点留在页头：按钮留着或者交给返回链接（审查 A2）；
// - 以服务端当前的修订为基准：阅读期间别人保存过，点"编辑"先按 If-None-Match 取最新的内容再进入；
// - 重建之前取出视图状态（当前工作表、左上角可见的行列、主选区），就绪之后恢复（风险表"重建丢掉用户的视图"）；
// - 公式计算进行中切换：销毁的旧编辑器留下的计时器到点时不再抛出没接住的异常（SDK 的进度计时器调已销毁的语言服务，
//   internal-api 的 disposalSafeLocaleOverride）。
// 失去编辑权之后另存为副本：上传本页捕获的内容（服务端按快照新建，M3-P2 S2 的接口），本页按服务器上的最新版本回到阅读。
// 编辑器没能重新打开（以只读重建失败，审查 A3）时留在失去编辑权，焦点交给"另存为副本"；副本之后按最新的内容重建又失败也留着，
// 副本的说明与链接照旧（复验 C1、C2）。
// 两个人与同一个人的多个标签页（US-M3-04）在 lease-acquire.spec.ts，阅读者的更新提示（US-M3-05）在 reading-updates.spec.ts，
// 失去编辑权的各种情形（US-M3-11、12、13）在 conflict.spec.ts、access.spec.ts 与 lease-recovery.spec.ts。
import type { Page, Request } from '@playwright/test'
import type { ProbeCommand } from '../../support/editor-probe.ts'
import { revisionEtag, SHEET_TEMPLATE } from '@nerve-office/contracts'
import { archiveSpace, createDocument, createDocumentIn, createTeamSpace, createUser, editLeaseEndReason, withDatabase } from '../../support/database.ts'
import { commandMark, editorView, probeCommands, runFacade, scrollAndSelect } from '../../support/editor-probe.ts'
import { expect, test } from '../../support/fixtures.ts'
import { pressUniverShortcut } from '../../support/keyboard.ts'
import { expectEntriesUnchanged, grantClipboard, OTHER_READ_ONLY_ENTRIES, PROBE_FACADE_ENTRIES, UI_ENTRIES } from '../../support/read-only-checks.ts'
import { ALERT, closePermissionAlert, OPENED, scene, watch } from '../../support/read-only.ts'
import { loginThroughApi } from '../../support/session.ts'
import { appendSheet, cellOf, createSheetThroughApi, createSheetThroughUi, editingNotice, EDITOR_TEST_TIMEOUT, editorSurface, enterEditButton, enterEditing, exitEditButton, exitEditing, isSaveRequest, lostNotice, openAndEnterEditing, openReader, saveAndWait, saveButton, savedContent, saveStatus, selectCell, sheetTab, typeInCell, waitForEditorAccess, wouldPromptOnLeave } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

/**
 * 页面的 Worker 回到 1 个（只剩现在这个编辑器的公式 Worker）：重建时销毁旧的编辑器要终止它的 Worker（sheet-editor.ts 的销毁），
 * 漏掉时每切换一次就多一个。Worker 终止之后 Playwright 才把它从列表里去掉，所以等一会儿
 */
async function expectSingleWorker(page: Page): Promise<void> {
  await expect.poll(() => page.workers().length, { message: '页面的 Worker 回到 1 个' }).toBe(1)
}

/** 这份文档的编辑状态（GET …/edit-lease，用这个页面的会话）：正在编辑的人，没有时为 null */
async function editorOnServer(page: Page, documentId: string): Promise<unknown> {
  const response = await page.request.get(`/api/documents/${documentId}/edit-lease`)
  expect(response.status(), await response.text()).toBe(200)
  return (await response.json() as { editor: unknown }).editor
}

/** 写的请求（保存、申请、释放编辑权）按发出的先后记下来：退出编辑时先保存、再释放 */
function recordWrites(page: Page, documentId: string): string[] {
  const writes: string[] = []
  page.on('request', (request: Request) => {
    const path = new URL(request.url()).pathname
    if (isSaveRequest(request) && path === `/api/documents/${documentId}/content`)
      writes.push('save')
    else if (path === `/api/documents/${documentId}/edit-lease` && request.method() !== 'GET' && request.method() !== 'PUT')
      writes.push(request.method() === 'POST' ? 'acquire' : 'release')
  })
  return writes
}

test.describe('US-M3-01 打开文档先阅读，点"编辑"进入编辑，点"退出编辑"回到阅读', () => {
  test('US-M3-01 打开是阅读（没有工具栏，键入被只读的提示拦下、不发保存）；点"编辑"进入编辑，真的能编辑、保存；撤销栈已清空；有修改时"退出编辑"先保存、再释放编辑权（服务端没有人在编辑）、回到阅读，只读真的只读；进入、退出之后页面的 Worker 都回到 1 个', async ({ page }) => {
    await loginThroughApi(page, await createUser('read-mode-switch'))
    const documentId = await createSheetThroughApi(page)
    const writes = recordWrites(page, documentId)

    // 打开即阅读：以只读创建，能编辑的人有"编辑"；没有工具栏与保存按钮，页头的状态是空的
    await openReader(page, documentId)
    await expect(enterEditButton(page)).toBeVisible()
    await expect(saveStatus(page)).toHaveText('')
    await expect(saveButton(page)).toHaveCount(0)
    await expect(page.getByRole('toolbar')).toHaveCount(0)
    await expectSingleWorker(page)
    // 阅读时的本地改动不提交：键入被只读的提示拦下；按保存的快捷键也不发请求
    await selectCell(page, 'K3')
    await page.keyboard.type('1')
    await closePermissionAlert(page, ALERT.edit)
    await page.keyboard.press('ControlOrMeta+s')

    // 点"编辑"：取得编辑权，以可编辑重建（工具栏回来了），保存状态从"已保存到云端"开始
    await enterEditing(page)
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    await expect(page.getByRole('tab', { name: '开始', exact: true })).toBeVisible()
    await expectSingleWorker(page)
    expect(writes).toEqual(['acquire'])
    // 编辑真的能编辑：键入、保存，服务器上有这一次
    await typeInCell(page, 'A1', 'first')
    await saveAndWait(page)
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('first')

    // 阳性对照（审查 A12）：同一次编辑里，同一套按键（点 C3、按撤销的快捷键）确实撤回上一步——C1 键入之后撤销，存下来的没有它。
    // 有它，下面"重建之后撤销无效"的 A1 不变才说明撤销栈清空了，而不是撤销的快捷键在这里根本没生效
    await typeInCell(page, 'C1', 'undo me')
    await selectCell(page, 'C3')
    await pressUniverShortcut(page, 'Z')
    await saveAndWait(page)
    const controlled = await savedContent(page, documentId)
    expect([cellOf(controlled.snapshot, 'A1')?.v, cellOf(controlled.snapshot, 'C1')?.v]).toEqual(['first', undefined])

    // 退出、再进入（两次重建）之后撤销：撤销栈已清空，A1 不变（原地切换会留着上一段编辑的撤销栈，撤销会把 A1 改回空）。
    // 按键按顺序处理：之后在 B1 键入、保存，存下来的就是撤销之后的内容
    await exitEditing(page)
    await enterEditing(page)
    await selectCell(page, 'C3')
    await pressUniverShortcut(page, 'Z')
    await typeInCell(page, 'B1', 'after undo')
    await saveAndWait(page)
    const undone = await savedContent(page, documentId)
    expect([cellOf(undone.snapshot, 'A1')?.v, cellOf(undone.snapshot, 'B1')?.v]).toEqual(['first', 'after undo'])

    // 有修改时"退出编辑"：先保存（服务器上有这一次），再释放编辑权（服务端的编辑状态里没有人在编辑），以只读重建、回到阅读
    await typeInCell(page, 'A2', 'saved on exit')
    await expect(saveStatus(page)).toHaveText('有未保存的修改')
    writes.length = 0
    await exitEditing(page)
    expect(writes).toEqual(['save', 'release'])
    const exited = await savedContent(page, documentId)
    expect([exited.revision, cellOf(exited.snapshot, 'A2')?.v]).toEqual([undone.revision + 1, 'saved on exit'])
    expect(await editLeaseEndReason(documentId)).toBe('released')
    expect(await editorOnServer(page, documentId)).toBeNull()
    await expect(enterEditButton(page)).toBeVisible()
    await expect(exitEditButton(page)).toHaveCount(0)
    await expect(saveButton(page)).toHaveCount(0)
    await expect(page.getByRole('toolbar')).toHaveCount(0)
    await expectSingleWorker(page)

    // 只读真的只读：键入被只读的提示拦下，不发保存，服务器上的内容不变
    await selectCell(page, 'K3')
    await page.keyboard.type('2')
    await closePermissionAlert(page, ALERT.edit)
    await page.keyboard.press('ControlOrMeta+s')
    await selectCell(page, 'C5')
    expect(writes).toEqual(['save', 'release'])
    expect((await savedContent(page, documentId)).revision).toBe(exited.revision)
  })

  test('US-M3-01 刚新建的表格直接进入编辑，地址里的 ?edit=new 随之去掉；刷新之后是阅读（不再自动进入编辑）', async ({ page }) => {
    await loginThroughApi(page, await createUser('read-mode-new'))
    // 列表里新建：跳到带 ?edit=new 的地址，直接以可编辑创建；进入之后地址里没有这个参数（createSheetThroughUi 核对）
    const documentId = await createSheetThroughUi(page)
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    await expect(exitEditButton(page)).toBeVisible()
    await expect(enterEditButton(page)).toHaveCount(0)

    await page.reload()
    await waitForEditorAccess(page, 'read')
    await expect(page).toHaveURL(new RegExp(`/documents/${documentId}$`))
    await expect(enterEditButton(page)).toBeVisible()
    await expect(saveButton(page)).toHaveCount(0)
  })

  test('US-M3-01 查看者与归档空间里的文档：打开是阅读，只能查看、没有"编辑"（对照：归档之前空间管理员有"编辑"）', async ({ page, anotherDevice }) => {
    const lead = await createUser('read-mode-lead')
    const viewer = await createUser('read-mode-viewer')
    const space = await createTeamSpace('打开即阅读', lead, [[lead, 'admin'], [viewer, 'viewer']])
    const documentId = await createDocumentIn(space.id, lead, '共同的表')

    await loginThroughApi(page, viewer)
    await openReader(page, documentId)
    await expect(saveStatus(page)).toHaveText('只能查看')
    await expect(enterEditButton(page)).toHaveCount(0)

    await loginThroughApi(anotherDevice, lead)
    await openReader(anotherDevice, documentId)
    await expect(enterEditButton(anotherDevice)).toBeVisible()
    await archiveSpace(space.id)
    await anotherDevice.reload()
    await waitForEditorAccess(anotherDevice, 'read')
    await expect(saveStatus(anotherDevice)).toHaveText('只能查看')
    await expect(enterEditButton(anotherDevice)).toHaveCount(0)
  })

  test('US-M3-01 阅读期间别人保存了新版本、本页还没刷新：点"编辑"以服务端当前的版本为基准（先按 If-None-Match 取最新的内容），进入之后照常保存，不冲突', async ({ page, anotherDevice }) => {
    const lead = await createUser('read-mode-behind-lead')
    const first = await createUser('read-mode-behind-first')
    const second = await createUser('read-mode-behind-second')
    const space = await createTeamSpace('本页落后', lead, [[lead, 'admin'], [first, 'editor'], [second, 'editor']])
    const documentId = await createDocumentIn(space.id, lead, '共同的表')

    // 第二个人先打开阅读（修订 1）
    await loginThroughApi(anotherDevice, second)
    await openReader(anotherDevice, documentId)
    // 读内容的请求带的 If-None-Match（读全文、不带它的是 null：toEqual 不比较数组里的 undefined）
    const reads: (string | null)[] = []
    anotherDevice.on('request', (request) => {
      if (request.method() === 'GET' && new URL(request.url()).pathname === `/api/documents/${documentId}/content`)
        reads.push(request.headers()['if-none-match'] ?? null)
    })

    // 第一个人编辑、保存（修订 2），退出编辑（放掉编辑权）
    await loginThroughApi(page, first)
    await openAndEnterEditing(page, documentId)
    await typeInCell(page, 'A1', 'from first')
    await saveAndWait(page)
    await exitEditing(page)

    // 第二个人没有刷新就点"编辑"：申请得到的修订是 2，本页是 1——先按 If-None-Match（本页的修订）取最新的内容，以它重建为可编辑
    await enterEditing(anotherDevice)
    expect(reads).toEqual([revisionEtag(1)])
    await expect(saveStatus(anotherDevice)).toHaveText('已保存到云端')
    await typeInCell(anotherDevice, 'B1', 'from second')
    await saveAndWait(anotherDevice)
    const saved = await savedContent(anotherDevice, documentId)
    expect([saved.revision, cellOf(saved.snapshot, 'A1')?.v, cellOf(saved.snapshot, 'B1')?.v]).toEqual([3, 'from first', 'from second'])
  })
})

// "进入再退出"之后的编辑器是重建出来的只读编辑器：与查看者打开时同一套入口检查（M2-P3 的 read-only.spec.ts，抽在 support/read-only-checks.ts），
// 免得重建漏装只读守卫、漏设权限点。作者（空间管理员）打开只读样本，进入、退出编辑，不做任何修改，然后逐项试
test.describe('US-M3-01 进入再退出编辑之后只读真的只读（以只读重建；与查看者的只读同一套检查）', { tag: '@test-build' }, () => {
  test('US-M3-01 M0 的只读入口清单（界面入口 7 项与 Facade 入口）在"进入再退出"之后逐项都无效；进入、退出之后页面的 Worker 都回到 1 个', async ({ page, context, browserName }) => {
    // 与查看者的那一份条件一致（P3 审查 B10）
    await grantClipboard(context, browserName)
    const s = await scene('switch-m0')
    await loginThroughApi(page, s.author)
    await openReader(page, s.documentId, OPENED)
    await expectSingleWorker(page)
    await enterEditing(page, OPENED)
    await expectSingleWorker(page)
    await exitEditing(page, OPENED)
    await expectSingleWorker(page)
    await expect(enterEditButton(page)).toBeVisible()

    const watched = watch(page, s.documentId)
    await expectEntriesUnchanged(page, [...UI_ENTRIES, ...PROBE_FACADE_ENTRIES])
    expect(watched.saves).toEqual([])
    expect(watched.pageErrors).toEqual([])
  })

  test('US-M3-01 界面上还能碰到的其他入口（查找替换、格式与撤销重做的快捷键、工作表标签与菜单、图片、批注、冻结线与分隔线、筛选、"搜索功能"、快速求和）在"进入再退出"之后同样无效', async ({ page, context, browserName }) => {
    await grantClipboard(context, browserName)
    const s = await scene('switch-other')
    await loginThroughApi(page, s.author)
    await openReader(page, s.documentId, OPENED)
    await enterEditing(page, OPENED)
    await exitEditing(page, OPENED)

    const watched = watch(page, s.documentId)
    await expectEntriesUnchanged(page, OTHER_READ_ONLY_ENTRIES)
    // 工作表的顺序与可见的标签都没变（"隐藏"表仍然隐藏）
    await expect(page.getByRole('tablist', { name: '工作表标签页' }).getByRole('tab')).toHaveText(['数据', '汇总', '功能', '筛选'])
    expect(watched.saves).toEqual([])
    expect(watched.pageErrors).toEqual([])
  })
})

test.describe('阅读与编辑的切换保留视图（M3-P2 设计 §3.3）', { tag: '@test-build' }, () => {
  test('进入编辑、退出编辑之后：同一张工作表、同一个可见区域、同一个选区', async ({ page }) => {
    await loginThroughApi(page, await createUser('view-state'))
    const documentId = await createSheetThroughApi(page)
    // 两张表：在第二张表上往下、往右滚（第 41 行在最上面；列数不多，往右滚到头时 SDK 按能滚到的最远处停），选中 K45:L47
    await openAndEnterEditing(page, documentId)
    await appendSheet(page)
    await expect(sheetTab(page, '工作表2')).toHaveAttribute('aria-selected', 'true')
    await saveAndWait(page)
    await scrollAndSelect(page, 40, 8, 'K45:L47')
    await expect.poll(async () => editorView(page)).toMatchObject({ sheet: '工作表2', top: 40, range: 'K45:L47', current: 'K45' })
    const expected = await editorView(page)
    expect(expected.left, '往右滚过了').toBeGreaterThan(0)

    // 退出编辑：以只读重建，视图照旧
    await exitEditing(page)
    await expect(sheetTab(page, '工作表2')).toHaveAttribute('aria-selected', 'true')
    expect(await editorView(page)).toEqual(expected)

    // 再进入编辑：以可编辑重建，视图照旧
    await enterEditing(page)
    await expect(sheetTab(page, '工作表2')).toHaveAttribute('aria-selected', 'true')
    expect(await editorView(page)).toEqual(expected)
    await expect(saveStatus(page)).toHaveText('已保存到云端')
  })
})

/** 计算进行中切换用的表：A 列的公式个数与 E 列的行数 */
const HEAVY_ROWS = 1000

/** 第 i 个公式（从 0 开始）按定义算出的值：E 列第 i 行以下（不含）的和，再加 i */
function heavyFormulaValue(i: number): number {
  return HEAVY_ROWS * (HEAVY_ROWS + 1) / 2 - i * (i + 1) / 2 + i
}

/**
 * A1:A1000 是 =SUMPRODUCT($E$1:$E$1000*(ROW($E$1:$E$1000)>i))+i，E1:E1000 是 1…1000。公式都带缓存值（按定义算出），
 * 打开时那一轮不用重算（打开时只算没有值的公式，WHEN_EMPTY）；强制重算这 1000 个公式（各算 1000 格）本机要 0.9 秒（WebKit）
 * 到 1.7 秒（Chromium、Chrome）
 */
function sheetWithHeavyRecalculation(unitId: string): string {
  const cellData: Record<number, Record<number, { f?: string, v: number, t: number }>> = {}
  for (let i = 0; i < HEAVY_ROWS; i += 1) {
    cellData[i] = {
      0: { f: `=SUMPRODUCT($E$1:$E$${HEAVY_ROWS}*(ROW($E$1:$E$${HEAVY_ROWS})>${i}))+${i}`, v: heavyFormulaValue(i), t: 2 },
      4: { v: i + 1, t: 2 },
    }
  }
  const sheet = SHEET_TEMPLATE.sheets['sheet-1']
  return JSON.stringify({ ...SHEET_TEMPLATE, id: unitId, sheets: { 'sheet-1': { ...sheet, cellData } } })
}

const CALCULATION_START = 'formula.mutation.set-formula-calculation-start'
const CALCULATION_NOTIFICATION = 'formula.mutation.set-formula-calculation-notification'
const CALCULATION_RESULT = 'formula.mutation.set-formula-calculation-result'

/**
 * 命令日志里一轮计算已经开始：开始计算的 mutation 执行之后的第一条通知就是 Worker 送回的开始通知（engine-formula 的
 * calculate-formula.service.ts:146-147 在计算的最前面送出）。探针的执行后事件排在 SDK 的监听之后，看到它时 SDK 已经设下了计时器
 */
function calculationStarted(commands: readonly ProbeCommand[]): boolean {
  const executed = commands.filter(command => command.phase === 'executed').map(command => command.id)
  const start = executed.indexOf(CALCULATION_START)
  return start >= 0 && executed.includes(CALCULATION_NOTIFICATION, start + 1)
}

// 公式计算进行中切换（main 16f8a1d 的 CI 上 save.spec.ts"计算进行中又改了一处"偶发的页面异常）：sheets-formula 的 TriggerCalculationController
// 收到一轮计算的开始通知时设一个 1 秒的计时器（到点显示"正在分析公式..."的进度），这一轮算完时清掉，销毁时却不清（trigger-calculation.controller.ts
// 的 _initialExecuteFormulaProcessListener 与 dispose）。切换一律重建：旧的编辑器在这 1 秒里被销毁、这一轮又还没算完，到点时计时器调用已销毁的
// 语言服务（LocaleService.t），抛出"Locale not initialized"，页面里一条没接住的异常——打开含公式的表格马上点"编辑"就会遇到。
// 构造要确定：打开时那一轮在渲染完成之后就开始，探针在就绪之后才装上，看不到它的开始；所以阅读时经探针让全部公式重算（与 links.spec.ts 的
// recalculate 相同，执行选项带 onlyLocal，阅读时同样执行），看到这一轮的开始通知就点"编辑"。本机实测（三个浏览器）开始到旧的编辑器销毁约 0.1 秒，
// 远在 1 秒之内；重算要 0.9–1.7 秒，销毁时这一轮还没算完——用例核对这一点（旧的编辑器的命令日志里没有结果），不成立时这条用例什么也没测到
test.describe('US-M3-01 公式计算进行中点"编辑"：销毁的旧编辑器留下的计时器不再抛出异常', { tag: '@test-build' }, () => {
  test('US-M3-01 阅读时一轮计算刚开始就点"编辑"：旧的编辑器销毁时这一轮还没算完；进入编辑、过了 SDK 的 1 秒计时器之后，页面里没有没接住的异常', async ({ page, pageErrors }) => {
    const owner = await createUser('switch-calculating')
    const documentId = await createDocument(owner, '计算中切换', sheetWithHeavyRecalculation)
    await loginThroughApi(page, owner)
    await openReader(page, documentId)
    // 阅读的编辑器的探针：销毁时它退订命令事件，日志停在销毁的那一刻
    const reading = await page.evaluateHandle(() => window.__nerveEditorProbe)
    const mark = await commandMark(page)
    expect(await runFacade(page, async ({ api }) => api.executeCommand('formula.mutation.set-trigger-formula-calculation-start', { forceCalculation: true }, { onlyLocal: true }))).toEqual({})
    await expect.poll(async () => calculationStarted(await probeCommands(page, mark)), { intervals: [10], message: '这一轮计算开始了（SDK 收到开始的通知就设下 1 秒的计时器）' }).toBe(true)

    // 立即点"编辑"。steady 在新的编辑器画完之后 3 秒：那时旧的编辑器的计时器早已到点
    await enterEditing(page, 'steady')
    const executed = await reading.evaluate((probe, after) => probe?.commands(after).filter(command => command.phase === 'executed').map(command => command.id) ?? [], mark)
    await reading.dispose()
    expect(executed).toContain(CALCULATION_START)
    expect(executed, '旧的编辑器销毁时这一轮还没算完（没有结果写回），它的计时器还挂着').not.toContain(CALCULATION_RESULT)
    expect(pageErrors.list(), '页面里没有没接住的异常（旧的编辑器的计时器调用已销毁的语言服务）').toEqual([])
  })
})

test.describe('US-M3-12 失去编辑权之后另存为副本（M3-P2 设计 §3.2、§3.4）', () => {
  test('US-M3-12 空间刚被归档（还读得到、不能编辑了）：另存为副本，副本是本页的内容、标题带上失效时的时间、在自己的个人空间；本页按最新的版本回到阅读，链接打开副本', async ({ page }) => {
    const lead = await createUser('copy-lost-lead')
    const editor = await createUser('copy-lost-editor')
    const space = await createTeamSpace('会被归档', lead, [[lead, 'admin'], [editor, 'editor']])
    const documentId = await createDocumentIn(space.id, lead, '共同的表')
    await loginThroughApi(page, editor)
    await openAndEnterEditing(page, documentId)
    await typeInCell(page, 'A1', '本页的修改')
    await archiveSpace(space.id)

    // 保存得知不能编辑了（403）：本页换成只读、显示本页的内容，给"另存为副本"与"放弃本页的修改"
    await saveButton(page).click()
    const lost = lostNotice(page)
    await expect(lost).toContainText('编辑权已失效：你已没有编辑这份文档的权限（空间已归档，只能查看）。本页的修改没有保存：可以另存为副本，或者放弃这些修改。')
    await waitForEditorAccess(page, 'read')

    // 另存为副本：成功之后本页按服务器上的最新版本回到阅读（只能查看），读屏状态区说明已另存为副本，链接在新标签页打开它
    await lost.getByRole('button', { name: '另存为副本', exact: true }).click()
    await expect(lostNotice(page)).toHaveCount(0)
    const notice = page.locator('#editor-chrome').getByRole('status').filter({ hasText: '已另存为副本' })
    await expect(notice).toContainText(/已另存为副本《共同的表（冲突副本 \d{4}-\d{2}-\d{2} \d{2}:\d{2}）》。/)
    await expect(saveStatus(page)).toHaveText('只能查看')
    await waitForEditorAccess(page, 'read')
    const link = notice.getByRole('link', { name: '打开副本（新标签页）', exact: true })
    await expect(link).toHaveAttribute('target', '_blank')
    const copyId = (await link.getAttribute('href') ?? '').split('/').at(-1) ?? ''
    expect(copyId).toMatch(/^[\da-f-]{36}$/)

    // 副本：本页的内容，在自己的个人空间（归档的空间里不能新建）；原文档没有变
    expect(cellOf((await savedContent(page, copyId)).snapshot, 'A1')?.v).toBe('本页的修改')
    const placed = await withDatabase(async client => (await client.query<{ space_id: string, title: string }>('SELECT space_id, title FROM documents WHERE id = $1', [copyId])).rows[0])
    expect(placed?.space_id).toBe(editor.personalSpaceId)
    expect(placed?.title).toMatch(/^共同的表（冲突副本 \d{4}-\d{2}-\d{2} \d{2}:\d{2}）$/)
    const original = await savedContent(page, documentId)
    expect([original.revision, cellOf(original.snapshot, 'A1')]).toEqual([1, undefined])

    // 链接打开副本：自己的文档，能编辑
    const [opened] = await Promise.all([page.context().waitForEvent('page'), link.click()])
    await waitForEditorAccess(opened, 'read')
    await enterEditing(opened)
    await expect(saveStatus(opened)).toHaveText('已保存到云端')
  })

  test('US-M3-12 失去编辑权时编辑器没能重新打开（公式 Worker 的脚本加载不了，审查 A3）：留在失去编辑权，焦点从销毁的编辑器交给"另存为副本"（复验 C2）；Worker 仍起不来时另存为副本，副本建好、说明与链接照旧，不是整页的"编辑器加载失败"（复验 C1）；Worker 恢复之后重新加载，回到阅读', async ({ page, pageErrors }) => {
    pageErrors.expectErrors()
    const lead = await createUser('reopen-failed-lead')
    const editor = await createUser('reopen-failed-editor')
    const space = await createTeamSpace('重建失败', lead, [[lead, 'admin'], [editor, 'editor']])
    const documentId = await createDocumentIn(space.id, lead, '共同的表')
    await loginThroughApi(page, editor)
    await openAndEnterEditing(page, documentId)
    await typeInCell(page, 'A1', '本页的修改')

    // 从现在起公式 Worker 的脚本加载不了（路由让浏览器的缓存失效，每次新建都去取）：以只读重建、按最新的内容重建都会失败
    const workerScript = '**/assets/formula.worker-*.js'
    await page.route(workerScript, async route => route.abort())
    await archiveSpace(space.id)

    // 心跳得知不能编辑了（403）：留在失去编辑权，说明编辑器没能重新打开；焦点原在单元格里，交给"另存为副本"
    const lost = lostNotice(page)
    await expect(lost).toContainText('编辑器没能重新打开，表格暂时显示不出来；本页的修改已经取出，另存为副本照常可用', { timeout: 30_000 })
    await expect(editorSurface(page)).toHaveAttribute('data-editor-state', 'failed')
    const saveCopy = lost.getByRole('button', { name: '另存为副本', exact: true })
    await expect(saveCopy).toBeFocused()
    expect(await wouldPromptOnLeave(page)).toBe(true)

    // 键盘按"另存为副本"：副本建好；按最新的内容重建又失败，留在失去编辑权——说明已另存为副本、链接照旧，可以重新加载，离开不再提示
    await page.keyboard.press('Enter')
    await expect(lost).toContainText(/已另存为副本《共同的表（冲突副本 \d{4}-\d{2}-\d{2} \d{2}:\d{2}）》。/)
    await expect(lost).toContainText('没能载入最新的版本')
    await expect(page.getByText('编辑器加载失败，请刷新页面重试')).toHaveCount(0)
    await expect(editorSurface(page)).toHaveAttribute('data-editor-state', 'failed')
    const link = lost.getByRole('link', { name: '打开副本（新标签页）', exact: true })
    await expect(link).toHaveAttribute('target', '_blank')
    expect(await wouldPromptOnLeave(page)).toBe(false)
    const copyId = (await link.getAttribute('href') ?? '').split('/').at(-1) ?? ''
    expect(cellOf((await savedContent(page, copyId)).snapshot, 'A1')?.v).toBe('本页的修改')

    // Worker 恢复：重新加载，按服务器上的最新版本回到阅读（只能查看），读屏状态区说明已另存为副本
    await page.unroute(workerScript)
    await lost.getByRole('button', { name: '重新加载', exact: true }).click()
    await expect(lostNotice(page)).toHaveCount(0)
    await waitForEditorAccess(page, 'read')
    await expect(saveStatus(page)).toHaveText('只能查看')
    await expect(page.locator('#editor-chrome').getByRole('status').filter({ hasText: '已另存为副本' })).toBeVisible()
    // 页面错误只有编辑器建不起来的那两次（以只读重建、按最新的内容重建）
    expect(pageErrors.list()).toEqual([expect.stringMatching(/^SheetEditorLoadError: 公式 Worker 起不来/), expect.stringMatching(/^SheetEditorLoadError: 公式 Worker 起不来/)])
  })
})

// 进入、退出编辑没有成功时焦点不落到 body（审查 A2，规范 §2.4）：进入中、退出中按钮留着（标为不可用、说正在进入或退出），没有成功时
// 焦点还在它上面；按钮随权限消失时焦点交给页头的返回链接。都用键盘按（焦点在按钮上）
test.describe('US-M3-01 进入、退出编辑没有成功时焦点留在页头（审查 A2）', () => {
  /** 页头里返回所在空间的链接（一直在） */
  function backLink(page: Page) {
    return page.locator('#editor-chrome').getByRole('banner').getByRole('link').first()
  }

  /** 焦点在哪里：body、页头与说明（#editor-chrome）里，或者别处（重建出来的编辑器的输入框） */
  async function focusPlace(page: Page): Promise<'body' | 'chrome' | 'editor'> {
    return page.evaluate(() => {
      const active = document.activeElement
      if (active === null || active === document.body)
        return 'body'
      return document.querySelector('#editor-chrome')?.contains(active) === true ? 'chrome' : 'editor'
    })
  }

  test('US-M3-01 键盘按"编辑""退出编辑"成功之后：焦点在重建出来的编辑器里，不留在页头，也不落到 body（按钮在切换期间留着，不改变成功时的去处）', async ({ page }) => {
    await loginThroughApi(page, await createUser('focus-success'))
    const documentId = await createSheetThroughApi(page)
    await openReader(page, documentId)
    await enterEditButton(page).focus()
    await page.keyboard.press('Enter')
    await waitForEditorAccess(page, 'edit')
    await expect.poll(async () => focusPlace(page)).toBe('editor')
    await exitEditButton(page).focus()
    await page.keyboard.press('Enter')
    await waitForEditorAccess(page, 'read')
    await expect.poll(async () => focusPlace(page)).toBe('editor')
  })

  test('US-M3-01 点"编辑"时空间刚被归档（403）：说明没能进入编辑，"编辑"随之消失，焦点交给返回链接', async ({ page }) => {
    const lead = await createUser('focus-denied-lead', '组长')
    const me = await createUser('focus-denied-me', '我')
    const space = await createTeamSpace('焦点与归档', lead, [[lead, 'admin'], [me, 'editor']])
    const documentId = await createDocumentIn(space.id, lead, '共同的表')
    await loginThroughApi(page, me)
    await openReader(page, documentId)
    await archiveSpace(space.id)
    await enterEditButton(page).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('alert').filter({ hasText: '没能进入编辑' })).toBeVisible()
    await expect(enterEditButton(page)).toHaveCount(0)
    await expect(backLink(page)).toBeFocused()
  })

  test('US-M3-01 点"编辑"被别人占着：留在阅读，焦点还在"编辑"上；进入之后断网时按"退出编辑"、保存失败：留在编辑，焦点还在"退出编辑"上', async ({ page, anotherDevice }) => {
    const lead = await createUser('focus-held-lead', '组长')
    const me = await createUser('focus-held-me', '我')
    const other = await createUser('focus-held-other', '别人')
    const space = await createTeamSpace('焦点与占用', lead, [[lead, 'admin'], [me, 'editor'], [other, 'editor']])
    const documentId = await createDocumentIn(space.id, lead, '共同的表')
    await loginThroughApi(anotherDevice, other)
    await openAndEnterEditing(anotherDevice, documentId)

    // 我：键盘按"编辑"，被占用、留在阅读（"编辑"在进入期间说正在进入），焦点还在它上面
    await loginThroughApi(page, me)
    await openReader(page, documentId)
    const acquired = page.waitForResponse(response => new URL(response.url()).pathname === `/api/documents/${documentId}/edit-lease` && response.request().method() === 'POST')
    await enterEditButton(page).focus()
    await page.keyboard.press('Enter')
    expect((await acquired).status()).toBe(409)
    await expect(editingNotice(page)).toBeVisible()
    await expect(enterEditButton(page)).toBeFocused()

    // 别人退出编辑；我进入编辑、改一处，断网时键盘按"退出编辑"：保存失败，留在编辑，焦点还在"退出编辑"上
    await exitEditing(anotherDevice)
    await enterEditing(page)
    await typeInCell(page, 'A1', 'x')
    await expect(saveStatus(page)).toHaveText('有未保存的修改')
    const isContent = (url: URL): boolean => url.pathname === `/api/documents/${documentId}/content`
    await page.route(isContent, async route => route.request().method() === 'PUT' ? route.abort('internetdisconnected') : route.continue())
    await exitEditButton(page).focus()
    await page.keyboard.press('Enter')
    // 网络错误：会自动重试（M3-P4 设计 §3.8），留在编辑
    await expect(saveStatus(page)).toHaveText('保存失败，稍后自动重试')
    await expect(exitEditButton(page)).toBeFocused()
    await page.unroute(isContent)
  })
})
