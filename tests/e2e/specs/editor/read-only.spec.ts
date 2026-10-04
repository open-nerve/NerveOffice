// 查看者的只读（M2-P3 设计 §3.3–§3.7、§4 的 E2E 一行，US-M2-11）：查看者与归档空间里的文档只能看不能改。
// 只读样本（support/read-only-sample.ts：5 张表、浮动图片、批注、超链接、数据验证、条件格式、筛选）写进团队空间，查看者打开后
// 逐项试 M0 的 28 个表格编辑入口（M0-P3 报告 §5）、界面上还能碰到的入口（编辑栏、工作表标签与全部工作表的菜单、图片、批注的浮层、
// 冻结线与冻结区域的行高、筛选按钮、查找替换，以及格式、撤销与重做、"搜索功能"、快速求和这几个快捷键），
// 与经 Facade 直接执行的写公式的 mutation（防火墙要排在 SDK 自己的执行前监听之前，M2-P6 复核 F3）。
// 覆盖的边界：SDK 注册的全部快捷键另由 read-only-shortcuts.spec.ts 逐个按遍（M2-P6 复核 F1、F2 之后，这里只留有专门对照的几个）；
// 鼠标、触控与输入法的入口没有清单可以遍历，靠这里逐项列出与审查（M2-P6 复核 S4 另外试过约 60 个界面动作，没有发现改动）：
// - 画布上的内容读不出来：比较测试构建的探针给出的内存快照（support/editor-probe.ts，比较的口径见 contentOf）；
// - 每项都等到确定的信号再比较，不用固定时长的等待：命令被只读守卫取消、被 SDK 的权限检查拦下（它弹出提示，关掉），或者执行完；
//   只读时没有控制点的手势（填充柄、行列的分隔线、冻结线、浮动图片）不产生命令：先确认没有意外弹出的提示，再点一个单元格，
//   等名称框显示它（界面的输入按顺序处理）。第 1 行、A 列的分隔线原来不同（DEF-027）：SDK 把索引 0 当作没有给出、一律放行，
//   只读时那里照样显示调整的光标、拖动之后被权限检查拦下（冻结首行的表上看起来像是"冻结区域"的问题）；M3-P2 起只读守卫补上拦截，
//   与别的分隔线一样没有控制点；
// - 对照：作者（能编辑）逐项做同样的事，每项确实改动了内存快照（每项用新写的文档，并行执行），只读时的"没变"才不是空断言；
// - 另有界面的隐藏（同样以作者的界面作对照）、还能读、打开不产生改动、服务端拒绝保存、公式在 Worker 里算出结果、归档空间。
// S3 的 E2E 发现的 5 个问题与 P3 审查之后的修复（只读守卫 editor/read-only/、语言包 editor/profile/locale.ts）：编辑栏点不进去
// （点编辑框、从别处按下在编辑框上松开之后，查找、复制、方向键照常）；拦下操作的提示是只读的说法（含筛选按钮）；浮动图片点不中、
// 拖不动；冻结线拖不动；只读时打不开替换；批注浮层的文本框只读。M2-P6 复核之后：只读时打不开"搜索功能"面板，快速求和没有反应
// （编辑栏不再显示文档里没有的公式）。M3-P2 S3：第 1 行、A 列的分隔线拖不动（DEF-027）；查找面板上没有"替换 / 高级查找"（DEF-028）。
// Univer 自己的快捷键按页面的平台判断取修饰键（support/keyboard.ts：Linux 上的 WebKit 也报 Mac 的 UA）。
// 与快捷键回归共用的部分（写好样本的团队空间与成员、页面错误与保存请求的收集、内容的核对、权限检查的提示）在 support/read-only.ts。
// 各项入口、逐项的步骤与等到的信号在 support/read-only-checks.ts：M3-P2 起"进入再退出编辑"之后（以只读重建）跑同一套（edit-mode.spec.ts）。
// Facade 入口的清单、快捷键入口的预期与提示的说法和测试构建的页面自检共用（apps/web/src/editor/testing/read-only-entries.ts，
// 真实 Safari 上的复核，M3-P2 设计 §3.5），经 support/read-only.ts 转出：改入口或预期时两边一起变。
// 用到探针（只在测试构建里）：标签 @test-build，外部模式测生产镜像时按标签排除（playwright.config.ts）；
// 文件末尾的冒烟用例不用探针，生产镜像上也跑（容器 E2E）。
import type { Locator, Page } from '@playwright/test'
import type { Entry, Mode } from '../../support/read-only-checks.ts'
import type { Scene } from '../../support/read-only.ts'
import type { Workbook } from '../../support/sheet.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { SNAPSHOT_UPLOAD_CONTENT_TYPE } from '@nerve-office/contracts'
import { archiveSpace } from '../../support/database.ts'
import { cellCenter, clickCell, commandMark, contentOf, nameBox, probeCommands, probeSnapshot, runFacade, waitForCommand } from '../../support/editor-probe.ts'
import { e2eOrigin } from '../../support/environment.ts'
import { expect, test } from '../../support/fixtures.ts'
import { pressUniverShortcut } from '../../support/keyboard.ts'
import { allSheetsMenuButton, expectEntriesUnchanged, findApple, FORMULA_BAR_UNIT, formulaBarEditor, formulaBarInput, grantClipboard, OTHER_READ_ONLY_ENTRIES, OTHER_UI_ENTRIES, PROBE_FACADE_ENTRIES, showSheet, slipOntoFormulaBar, step, TYPING, UI_ENTRIES } from '../../support/read-only-checks.ts'
import { SAMPLE_CELLS, SAMPLE_FORMULAS, SAMPLE_SHEETS, sampleWithoutFormulaValuesFor } from '../../support/read-only-sample.ts'
import { ALERT, closePermissionAlert, documentChangeAttempts, expectUnchanged, FORMULA_MUTATION_CELL, LOOK_ONCE, nextFrames, OPENED, openReadOnly, scene, SHORTCUT_OUTCOMES, unitIdOf, watch, writeFormulaMutation } from '../../support/read-only.ts'
import { loginThroughApi } from '../../support/session.ts'
import { EDITOR_TEST_TIMEOUT, openAndEnterEditing, resourceOf, saveButton, savedContent, selectCell, sheetCanvas, sheetTab, waitForEditorAccess } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

/** 快照里 sheetId 这张工作表 A1 写法的一格的值（v）；没有时为 undefined */
function cellValueIn(snapshotText: string, sheetId: string, a1: string): unknown {
  const match = /^([A-Z])(\d+)$/.exec(a1)
  if (match === null)
    throw new Error(`不支持的单元格写法：${a1}`)
  const row = Number(match[2]) - 1
  const column = (match[1] ?? 'A').charCodeAt(0) - 'A'.charCodeAt(0)
  return (JSON.parse(snapshotText) as Workbook).sheets[sheetId]?.cellData[row]?.[column]?.v
}

/** 新增工作表的按钮：标签栏里同样标记的图标按钮中，不在"全部工作表"下拉菜单触发器里的那个（sheets-ui 的 SheetBar.tsx:100-111） */
function addSheetButton(page: Page): Locator {
  return page.locator('[data-u-comp="sheet-bar-append-button"]:not([data-slot="dropdown-menu-trigger"] > *)')
}

/** "数据"表 K40（writeFormulaMutation 写的那一格）的公式 */
function formulaOfK40(snapshotText: string): string | undefined {
  return (JSON.parse(snapshotText) as Workbook).sheets[SAMPLE_SHEETS.data.id]?.cellData[FORMULA_MUTATION_CELL.row]?.[FORMULA_MUTATION_CELL.column]?.f
}

test.describe('US-M2-11 查看者打开有阅读权限的表格，只能看不能改', { tag: '@test-build' }, () => {
  test('打开不产生改动：内存快照与服务器上的内容逐字节相同，保护类资源为空，没有保存请求；服务端拒绝查看者的保存', async ({ page }) => {
    const s = await scene('ro-open')
    const watched = watch(page, s.documentId)
    await openReadOnly(page, s.viewer, s.documentId)
    const stored = await savedContent(page, s.documentId)
    // 样本已经收敛（打开之后保存的字节就是它自己），所以不用规范化，逐字节比较
    const snapshot = await probeSnapshot(page)
    expect(snapshot).toBe(stored.text)
    // 探针在就绪时装上：从就绪到 steady，没有改动文档的 mutation 的尝试（被防火墙取消的也没有，P3 审查 B9）
    expect(await documentChangeAttempts(page, 0, unitIdOf(snapshot))).toEqual([])
    // 不写保护类资源（不用 setReadOnly()，不创建保护规则），也没有本地授权服务的资源（ADR-009）
    const workbook = JSON.parse(snapshot) as Workbook
    for (const name of ['SHEET_RANGE_PROTECTION_PLUGIN', 'SHEET_WORKSHEET_PROTECTION_PLUGIN', 'SHEET_WORKSHEET_PROTECTION_POINT_PLUGIN'])
      expect(resourceOf(workbook, name) ?? {}, name).toEqual({})
    expect(workbook.resources.map(resource => resource.name)).not.toContain('SHEET_AuthzIoMockService_PLUGIN')
    expect(watched.saves).toEqual([])
    expect(watched.pageErrors).toEqual([])

    // 前端的只读只是体验层，写入的边界在服务端（ADR-011）：查看者直接调保存的接口也被拒绝，内容不变。
    // 代次是必填的参数（M3-P1）；查看者申请不了编辑权，没有租约照样发出：先被"能编辑"拒绝（403），到不了租约那一步
    const { csrfToken } = await (await page.request.get('/api/auth/session')).json() as { csrfToken: string }
    const edited = { ...workbook, name: '查看者改过' }
    const query = new URLSearchParams({ baseRevision: String(stored.revision), requestId: randomUUID(), clientInstanceId: randomUUID(), localSeq: '1', writeEpoch: '0' })
    const response = await page.request.put(`/api/documents/${s.documentId}/content?${query.toString()}`, {
      data: zlib.gzipSync(Buffer.from(JSON.stringify(edited), 'utf8')),
      headers: { 'content-type': SNAPSHOT_UPLOAD_CONTENT_TYPE, 'origin': e2eOrigin(), 'x-csrf-token': csrfToken },
    })
    expect(response.status(), await response.text()).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'PERMISSION_DENIED' } })
    const after = await savedContent(page, s.documentId)
    expect([after.revision, after.text]).toEqual([stored.revision, stored.text])
  })

  test('界面没有编辑入口：没有工具栏、右键不弹出菜单、没有底栏菜单与新增工作表按钮，页头只能查看、没有保存按钮（对照：作者打开同一份文档时都有）', async ({ page, anotherDevice }) => {
    const s = await scene('ro-chrome')
    // 对照：能编辑时这些入口都在，下面只读时的"没有"才不是空断言
    const authorWatched = watch(anotherDevice, s.documentId)
    await loginThroughApi(anotherDevice, s.author)
    await openAndEnterEditing(anotherDevice, s.documentId, OPENED)
    await expectEditingChrome(anotherDevice, 'edit')
    expect(authorWatched.pageErrors).toEqual([])

    const watched = watch(page, s.documentId)
    await openReadOnly(page, s.viewer, s.documentId)
    await expectEditingChrome(page, 'read')
    expect(watched.pageErrors).toEqual([])
  })

  test('界面入口（M0 的 7 项）都无效：键入、删除、粘贴、剪切后粘贴、拖动填充柄、编辑栏、拖动行高', async ({ page, context, browserName }) => {
    // 与对照组的条件一致（P3 审查 B10）
    await grantClipboard(context, browserName)
    const s = await scene('ro-ui')
    const watched = watch(page, s.documentId)
    await openReadOnly(page, s.viewer, s.documentId)
    await expectEntriesUnchanged(page, UI_ENTRIES)
    expect(watched.saves).toEqual([])
    expect(watched.pageErrors).toEqual([])
  })

  test('界面上还能碰到的其他入口都无效：查找替换（没有高级查找）、格式的快捷键、撤销与重做、双击与拖动工作表标签、全部工作表的菜单、拖动与删除图片、改批注、冻结线、冻结区域的行高、第 1 行与 A 列的分隔线、筛选按钮、"搜索功能"面板、快速求和', async ({ page, context, browserName }) => {
    // 与对照组的条件一致（P3 审查 B10）
    await grantClipboard(context, browserName)
    const s = await scene('ro-other')
    const watched = watch(page, s.documentId)
    await openReadOnly(page, s.viewer, s.documentId)
    await expectEntriesUnchanged(page, OTHER_READ_ONLY_ENTRIES)
    // 工作表的顺序与可见的标签都没变（"隐藏"表仍然隐藏）
    await expect(page.getByRole('tablist', { name: '工作表标签页' }).getByRole('tab')).toHaveText(['数据', '汇总', '功能', '筛选'])
    expect(watched.saves).toEqual([])
    expect(watched.pageErrors).toEqual([])
  })

  test('Facade 入口（M0 的 21 项，另加取消已有的超链接）经探针逐项都无效：被只读守卫取消，或被权限检查拦下', async ({ page }) => {
    const s = await scene('ro-facade')
    const watched = watch(page, s.documentId)
    await openReadOnly(page, s.viewer, s.documentId)
    await expectEntriesUnchanged(page, PROBE_FACADE_ENTRIES)
    expect(watched.saves).toEqual([])
    expect(watched.pageErrors).toEqual([])
  })

  // 防火墙要排在 SDK 自己的执行前监听之前（M2-P6 复核 F3，sheet-editor.ts 写明的不变量）：sheets-formula 的 UpdateFormulaController
  // 在每条 SetRangeValuesMutation 执行之前，先同步执行一条带 onlyLocal、fromFormula 的嵌套 mutation 把公式写进单元格。
  // 防火墙排在它后面时（例如把守卫的订阅都挪到创建工作簿之后），外面这条照样被取消，K40 却已经是公式，而且变更检测看不见
  test('经 Facade 直接执行写公式的 mutation：被只读守卫取消，SDK 的公式控制器也没有先把公式写进单元格（对照：作者执行时 K40 变成公式，先写的是带 onlyLocal、fromFormula 的嵌套 mutation）', async ({ page, anotherDevice }) => {
    const s = await scene('ro-formula-write')
    // 对照：能编辑时这条 mutation 照常执行，执行之前 SDK 先写了嵌套的那条（只读时要在它之前就取消）
    await loginThroughApi(anotherDevice, s.author)
    await openAndEnterEditing(anotherDevice, s.documentId, OPENED)
    const authorMark = await commandMark(anotherDevice)
    expect(await runFacade(anotherDevice, writeFormulaMutation)).toEqual({})
    await waitForCommand(anotherDevice, authorMark, { phase: 'executed', id: 'sheet.mutation.set-range-values', flags: [] })
    expect(formulaOfK40(await probeSnapshot(anotherDevice))).toBe('=1+1')
    expect(await probeCommands(anotherDevice, authorMark)).toContainEqual(expect.objectContaining({ phase: 'executed', id: 'sheet.mutation.set-range-values', flags: expect.arrayContaining(['onlyLocal', 'fromFormula']) }))

    const watched = watch(page, s.documentId)
    await openReadOnly(page, s.viewer, s.documentId)
    const opened = await probeSnapshot(page)
    const mark = await commandMark(page)
    // 被取消时 Facade 抛出的 CanceledError 由命令服务接住，调用方拿到 false，不是页面错误
    expect(await runFacade(page, writeFormulaMutation)).toEqual({})
    await waitForCommand(page, mark, { phase: 'before', id: 'sheet.mutation.set-range-values', canceled: true })
    expect(formulaOfK40(await probeSnapshot(page))).toBeUndefined()
    await expectUnchanged(page, opened, mark)
    // 连带 onlyLocal、fromFormula 的嵌套写入也没有：这次调用之后，本文档上一条 mutation 都没有执行
    expect((await probeCommands(page, mark)).filter(command => command.phase === 'executed' && command.kind === 'mutation' && command.unitId === unitIdOf(opened))).toEqual([])
    expect(watched.saves).toEqual([])
    expect(watched.pageErrors).toEqual([])
  })

  // 对照：能编辑时，同一批入口确实改动了内存快照。每项一个用例、用新写的文档（互不影响，失败时直接看到是哪一项）；
  // 作者有未保存的修改，用例结束时关页面不会提示
  test.describe('对照：能编辑时，同一批入口确实改动了内存快照', () => {
    // 每项用自己的文档、互不影响：并行执行（P3 审查 B6）
    test.describe.configure({ mode: 'parallel' })
    for (const entry of [...UI_ENTRIES, ...OTHER_UI_ENTRIES, ...PROBE_FACADE_ENTRIES]) {
      test(entry.name, async ({ page, context, browserName }) => {
        await grantClipboard(context, browserName)
        const s = await scene('ro-ctl')
        const watched = watch(page, s.documentId)
        await loginThroughApi(page, s.author)
        expect(await changeWhenEditable(page, s, entry)).toBe(expectedWhenEditable(entry))
        // 样本在能编辑时同样正常打开、做这一项：没有页面错误（CSP 违规由夹具核对）
        expect(watched.pageErrors).toEqual([])
      })
    }
  })

  test('对照：能编辑时，撤销与重做的快捷键确实撤销与重做', async ({ page }) => {
    const s = await scene('ro-ctl-undo')
    await loginThroughApi(page, s.author)
    await openAndEnterEditing(page, s.documentId, OPENED)
    const opened = contentOf(await probeSnapshot(page))
    await clickCell(page, 'A2')
    await step(page, 'edit', async () => pressUniverShortcut(page, 'B'), { edit: { executed: 'sheet.command.set-style' } })
    const bold = contentOf(await probeSnapshot(page))
    expect(bold).not.toEqual(opened)
    const mark = await commandMark(page)
    await pressUniverShortcut(page, 'Z')
    await waitForCommand(page, mark, { phase: 'executed', id: 'univer.command.undo' })
    expect(contentOf(await probeSnapshot(page))).toEqual(opened)
    await pressUniverShortcut(page, 'Y')
    await waitForCommand(page, mark, { phase: 'executed', id: 'univer.command.redo' })
    expect(contentOf(await probeSnapshot(page))).toEqual(bold)
  })

  test('还能读：切换工作表、选中单元格、复制、查找、悬停看批注', async ({ page, context, browserName }) => {
    const s = await scene('ro-read')
    const watched = watch(page, s.documentId)
    await grantClipboard(context, browserName)
    await openReadOnly(page, s.viewer, s.documentId)
    const opened = await probeSnapshot(page)
    const mark = await commandMark(page)

    for (const sheet of [SAMPLE_SHEETS.summary, SAMPLE_SHEETS.features, SAMPLE_SHEETS.filter, SAMPLE_SHEETS.data])
      await showSheet(page, sheet.name)
    await clickCell(page, 'C3')

    await clickCell(page, 'A2')
    await step(page, 'read', async () => pressUniverShortcut(page, 'C'), { read: { executed: 'univer.command.copy' } })
    await expectClipboardText(page, browserName, SAMPLE_CELLS.a2)

    await pressUniverShortcut(page, 'F')
    const find = page.getByRole('dialog', { name: '查找' })
    await find.getByRole('textbox', { name: '输入查找内容' }).fill('苹果')
    await find.getByRole('textbox', { name: '输入查找内容' }).press('Enter')
    await expect(find).toContainText(/[12]\/2/)
    await find.getByRole('button', { name: 'Close' }).click()
    await expect(find).toBeHidden()

    await showSheet(page, SAMPLE_SHEETS.features.name)
    await sheetCanvas(page).hover({ position: await cellCenter(page, 'H1') })
    const note = page.getByRole('textbox', { name: '在此输入' })
    await expect(note).toHaveValue(SAMPLE_CELLS.note)
    // 批注的文本框是只读的：文字照常显示（M2-P3 S3 之后的修复）
    await expect(note).toHaveJSProperty('readOnly', true)

    await expectUnchanged(page, opened, mark)
    expect(watched.saves).toEqual([])
    expect(watched.pageErrors).toEqual([])
  })

  test('编辑栏点不进去：点编辑框、从名称框按下在编辑框上松开之后，查找、复制、方向键与格式的快捷键照常（M2-P3 S3 之后与 P3 审查 A1 之后的修复）', async ({ page, context, browserName }) => {
    const s = await scene('ro-bar')
    const watched = watch(page, s.documentId)
    await grantClipboard(context, browserName)
    await openReadOnly(page, s.viewer, s.documentId)
    const opened = await probeSnapshot(page)
    const mark = await commandMark(page)

    await clickCell(page, 'K5')
    await formulaBarEditor(page).click()
    await expect(formulaBarInput(page)).not.toBeFocused()
    // 键入的字交给单元格：被权限检查拦下；回车照常把选区下移
    await step(page, 'read', async () => page.keyboard.type('abc'), { read: { blocked: 'sheet.operation.set-cell-edit-visible', alert: ALERT.edit } })
    await step(page, 'read', async () => page.keyboard.press('Enter'), { read: { executed: 'sheet.command.move-selection-enter-tab' } })

    // 修复之前，这时查找的快捷键失效（编辑栏的编辑器一直处于激活），格式的快捷键转给了编辑栏的文字编辑器
    await clickCell(page, 'C8')
    await findApple(page)

    await clickCell(page, 'A2')
    await step(page, 'read', async () => pressUniverShortcut(page, 'C'), { read: { executed: 'univer.command.copy' } })
    await expectClipboardText(page, browserName, SAMPLE_CELLS.a2)
    await step(page, 'read', async () => pressUniverShortcut(page, 'B'), { read: SHORTCUT_OUTCOMES.style.read })

    // 在名称框上按下、拖到编辑框上松开（P3 审查 A1）：编辑框自己的 mouseup 照样聚焦编辑栏的编辑器（SDK 随之在编辑栏的内部文档里
    // 设光标，这是复现了那条路径的证据），只读守卫马上放开
    const slipped = await commandMark(page)
    await slipOntoFormulaBar(page)
    await waitForCommand(page, slipped, { phase: 'executed', id: 'doc.operation.set-selections', unitId: FORMULA_BAR_UNIT })
    await expect(formulaBarInput(page)).not.toBeFocused()
    // 焦点已经离开编辑栏：键入的字不进编辑栏的内部文档（修复之前会进去）
    await page.keyboard.type('xyz')
    // 点回表格之后，查找与方向键照常（修复之前都失效）
    await clickCell(page, 'C8')
    await findApple(page)
    await clickCell(page, 'A2')
    await step(page, 'read', async () => page.keyboard.press('ArrowDown'), { read: { executed: 'sheet.command.move-selection' } })
    await expect(nameBox(page)).toHaveValue('A3')

    // 编辑栏自始至终没有收到输入：它的内部文档上只有设光标的操作（松开时 SDK 设的与放开时清掉的），没有插入文字，也没有 mutation
    expect((await probeCommands(page, mark)).filter(command => command.unitId === FORMULA_BAR_UNIT && command.id !== 'doc.operation.set-selections')).toEqual([])
    await expectUnchanged(page, opened, mark)
    expect(watched.saves).toEqual([])
    expect(watched.pageErrors).toEqual([])
  })

  test('公式在 Worker 里算出结果：缓存值缺失的文档，查看者打开之后结果照常出现，结果的写回没有被防火墙取消（P3 审查 B5）', async ({ page }) => {
    const s = await scene('ro-formula', sampleWithoutFormulaValuesFor)
    const watched = watch(page, s.documentId)
    await openReadOnly(page, s.viewer, s.documentId)
    const stored = await savedContent(page, s.documentId)
    // 服务器上的文档里这几格没有结果；打开时 SDK 只算没有结果的公式（缓存值在的不重算），所以出现的结果一定是 Worker 算出来的
    for (const formula of SAMPLE_FORMULAS)
      expect(cellValueIn(stored.text, formula.sheetId, formula.cell), `${formula.cell}：服务器上没有结果`).toBeUndefined()
    await expect.poll(async () => {
      const snapshot = await probeSnapshot(page)
      return SAMPLE_FORMULAS.map(formula => cellValueIn(snapshot, formula.sheetId, formula.cell))
    }, { message: '等公式的结果出现在内存里' }).toEqual(SAMPLE_FORMULAS.map(formula => formula.value))
    const snapshot = await probeSnapshot(page)
    expect(await documentChangeAttempts(page, 0, unitIdOf(snapshot)), '没有被取消的修改').toEqual([])
    // 只读不保存：服务器上的内容不变
    const after = await savedContent(page, s.documentId)
    expect([after.revision, after.text]).toEqual([stored.revision, stored.text])
    expect(watched.saves).toEqual([])
    expect(watched.pageErrors).toEqual([])
  })

  test('归档空间里的文档：空间管理员打开同样只读（只能查看、没有工具栏、键入无效）', async ({ page }) => {
    const s = await scene('ro-archive')
    await loginThroughApi(page, s.author)
    await openAndEnterEditing(page, s.documentId, OPENED)
    // 归档之前：空间管理员能编辑
    await expect(saveButton(page)).toBeVisible()
    await archiveSpace(s.spaceId)

    const watched = watch(page, s.documentId)
    await page.reload()
    await waitForEditorAccess(page, 'read', OPENED)
    await expect(page.locator('#editor-chrome').getByText('只能查看', { exact: true })).toBeVisible()
    await expect(saveButton(page)).toHaveCount(0)
    await expect(page.getByRole('toolbar')).toHaveCount(0)
    const opened = await probeSnapshot(page)
    const mark = await commandMark(page)
    await TYPING.run(page, 'read')
    await expectUnchanged(page, opened, mark)
    expect(watched.saves).toEqual([])
    expect(watched.pageErrors).toEqual([])
  })
})

type Change = 'changed' | 'unchanged'

/** 作者（能编辑）打开样本，做这一项：内存里的内容有没有变 */
async function changeWhenEditable(page: Page, s: Scene, entry: Entry): Promise<Change> {
  await openAndEnterEditing(page, s.documentId, OPENED)
  const opened = contentOf(await probeSnapshot(page))
  await entry.run(page, 'edit')
  return JSON.stringify(contentOf(await probeSnapshot(page))) === JSON.stringify(opened) ? 'unchanged' : 'changed'
}

/** 能编辑时每项都改动了内存里的内容，超链接除外（M5 之前被入口守卫取消） */
function expectedWhenEditable(entry: Entry): Change {
  return entry.unchangedWhenEditable ? 'unchanged' : 'changed'
}

/** 剪贴板里的文字是 expected。无头 WebKit 读不了剪贴板（M0-P3 报告 §5.2），在 WebKit 上只跳过读取这一步 */
async function expectClipboardText(page: Page, browserName: string, expected: string): Promise<void> {
  if (browserName === 'chromium')
    expect(await page.evaluate(async () => navigator.clipboard.readText())).toBe(expected)
}

/**
 * 编辑入口在不在：能编辑时都在，只读时都没有。
 * 右键菜单在动画帧里弹出（ui 的 ContextMenu.tsx 的 handleContextMenu）：右键之后先等选区移过去（右键已经处理），再等两帧，
 * 然后只看一次（不重试）：能编辑时这样看得到菜单，这是只读时"没有菜单"的校准（P3 审查 B14）
 */
async function expectEditingChrome(page: Page, mode: Mode): Promise<void> {
  const present = mode === 'edit'
  const count = async (locator: Locator): Promise<void> => present ? expect(locator.first()).toBeVisible() : expect(locator).toHaveCount(0)
  const countNow = async (locator: Locator): Promise<void> => present
    ? expect(locator.first(), '等两帧之后菜单已经弹出').toBeVisible(LOOK_ONCE)
    : expect(locator).toHaveCount(0, LOOK_ONCE)
  // 页头：能编辑时有保存按钮；只读时显示"只能查看"
  await count(saveButton(page))
  await expect(page.locator('#editor-chrome').getByText('只能查看', { exact: true })).toHaveCount(present ? 0 : 1)
  // 工具栏：功能区的标签页、工具栏与其中的命令按钮
  await count(page.getByRole('tab', { name: '开始', exact: true }))
  await count(page.getByRole('toolbar'))
  await count(page.locator('[data-u-command]'))
  // 底栏：网格线开关（底栏菜单）与新增工作表按钮；"全部工作表"的菜单两种方式都在（切换工作表是阅读）
  await count(page.getByRole('button', { name: '切换网格线' }))
  await count(addSheetButton(page))
  await expect(allSheetsMenuButton(page)).toBeVisible()

  // 右键单元格与工作表标签
  await sheetCanvas(page).click({ button: 'right', position: await cellCenter(page, 'C3') })
  await expect(nameBox(page)).toHaveValue('C3')
  await nextFrames(page)
  await countNow(page.getByText('选择性复制', { exact: true }))
  await page.keyboard.press('Escape')
  await sheetTab(page, SAMPLE_SHEETS.summary.name).click({ button: 'right' })
  await expect(sheetTab(page, SAMPLE_SHEETS.summary.name)).toHaveAttribute('aria-selected', 'true')
  await nextFrames(page)
  await countNow(page.getByRole('button', { name: '重命名', exact: true }))
  await page.keyboard.press('Escape')
}

// 生产镜像上也跑的冒烟（P3 审查 B4）：不用探针、不打 @test-build，外部模式（容器 E2E）照常执行。
// 只核对界面与服务器看得到的结果：只读的页头、没有工具栏、键入被只读的提示拦下、保存的快捷键不发请求、服务器上的内容不变
test.describe('US-M2-11 查看者打开有阅读权限的表格，只能看不能改（冒烟：生产构建）', () => {
  test('查看者打开：页头只能查看、没有工具栏与保存按钮；键入被只读的提示拦下；Ctrl/Cmd+S 不发保存请求；服务器上的内容不变', async ({ page }) => {
    const s = await scene('ro-smoke')
    const watched = watch(page, s.documentId)
    await openReadOnly(page, s.viewer, s.documentId)
    const stored = await savedContent(page, s.documentId)
    await expect(page.getByRole('toolbar')).toHaveCount(0)
    await expect(saveButton(page)).toHaveCount(0)

    // 键入：打开单元格编辑器被权限检查拦下，弹出只读的提示；关掉之后照常
    await selectCell(page, 'K3')
    await page.keyboard.type('1')
    await closePermissionAlert(page, ALERT.edit)
    // 保存的快捷键（编辑器页自己的，按系统的修饰键）：只读时不保存，也不交给浏览器（不弹出另存网页）
    await page.keyboard.press('ControlOrMeta+s')
    // 之后的一次操作处理完，说明快捷键已经处理过：再键入一次，同样被拦下
    await page.keyboard.type('2')
    await closePermissionAlert(page, ALERT.edit)

    const after = await savedContent(page, s.documentId)
    expect([after.revision, after.text]).toEqual([stored.revision, stored.text])
    expect(watched.saves).toEqual([])
    expect(watched.pageErrors).toEqual([])
  })
})
