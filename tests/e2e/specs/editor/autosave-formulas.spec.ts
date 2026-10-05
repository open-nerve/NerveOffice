// 保存下来的公式结果与重新计算的一致（US-M3-03；M3-P4 设计 §3.2、§3.5、§3.6、§3.16，A18）：自动保存捕获之前等公式收齐（逐表收齐、
// 不漏掉排队的下一轮、被 stop 的一轮不算）与组合输入结束；超过上限照常保存并记"公式待更新"、收齐之后补存；带标记的文档进入编辑时强制全量重算再保存；
// 阅读页的说明；DEF-020 的回归。
// 公式计算的几条在公式 Worker 与主线程两种模式下各跑一遍（主线程模式经测试构建的地址参数选，M3-P4 设计 §3.14；S1 的 testing/formula-mode.ts）。
// 样本是 M0 的五类公式场景缩小的一份（support/capture-samples.ts 的 AUTOSAVE_FORMULA_SAMPLE：链、聚合、跨表、SUMPRODUCT、易变函数，
// 公式不带缓存值），存下的值按定义独立核对（apps/web/src/editor/testing/capture-samples.ts 的 verifyFormulaSnapshot，与页面自检同一份）。
// 主线程模式下在一轮计算进行中重建编辑器会让公式得出 #NAME?（S1 的 F2，S5 规避）：这里阅读、进入编辑之前都等公式收齐。
// 节奏与 autosave.spec.ts 相同：Playwright 的时钟停住时间，只在往前拨时走（runFor 逐帧；support/autosave.ts 的 skipAhead 一跳到终点），
// 捕获与上传的时刻按调度的日志断言；
// 公式在 Worker 或主线程里算是真实的时间（主线程模式按 MessageChannel 让出，不受时钟影响），停住时让到点的计时器执行再看。
// 控制与探针只在测试构建里：标签 @test-build
import type { Page } from '@playwright/test'
import type { FormulaSample } from '../../../../apps/web/src/editor/testing/capture-samples.ts'
import type { SelftestFormulaMode } from '../../../../apps/web/src/editor/testing/selftest-report.ts'
import { SHEET_TEMPLATE } from '@nerve-office/contracts'
import { verifyFormulaSnapshot } from '../../../../apps/web/src/editor/testing/capture-samples.ts'
import { FORMULA_MODE_PARAM, FORMULA_MODE_VALUES } from '../../../../apps/web/src/editor/testing/selftest-report.ts'
import { advanceTo, advanceUntil, autosaveLog, capturesOf, logNow, pausedNow, pauseTime, recordWrites, releaseAutosave, saveParam, SDK_CALCULATION_DEBOUNCE_MS, setAutosaveLimits, settleAfterEdit, skipAhead, uploadedText, uploadsOf } from '../../support/autosave.ts'
import { AUTOSAVE_FORMULA_SAMPLE, AUTOSAVE_STOP_SAMPLE, autosaveFormulaSampleFor, autosaveStopSampleFor } from '../../support/capture-samples.ts'
import { createDocument, createDocumentIn, createTeamSpace, createUser, revisionOf, withDatabase } from '../../support/database.ts'
import { commandMark, probeCommands, probeFormulaMode, probeFormulasSettled, probeSnapshot, setCellValue, waitForCommand } from '../../support/editor-probe.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, enterEditButton, enterEditing, exitEditing, openAndEnterEditing, openReader, savedContent, saveStatus, selectCell, typeInCell, waitForEditorAccess } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

const FIRST_SHEET = 'sheet-1'

/** 公式的两种模式（测试构建的开关）在用例标题里的说法 */
const FORMULA_MODES: Readonly<Record<SelftestFormulaMode, string>> = { 'worker': '公式在 Worker 里算', 'main-thread': '公式在主线程算' }

/** 命令日志里的公式协议（engine-formula 的 mutation） */
const FORMULA_START = 'formula.mutation.set-formula-calculation-start'
const FORMULA_STOP = 'formula.mutation.set-formula-calculation-stop'
const FORMULA_RESULT = 'formula.mutation.set-formula-calculation-result'
/** 强制全量重算的触发（带"公式待更新"的文档进入编辑时 SDK 执行的同一条，FORCED） */
const FORMULA_FORCE_TRIGGER = 'formula.mutation.set-trigger-formula-calculation-start'

/** 样本里的表名 */
const { aggregate: AGGREGATE, chain: CHAIN } = AUTOSAVE_FORMULA_SAMPLE
const { heavy: HEAVY } = AUTOSAVE_STOP_SAMPLE

/** 阅读页一直在的读屏状态区（"公式待更新"的说明在这里） */
function statusRegion(page: Page) {
  return page.locator('#editor-chrome [data-slot="status-region"]')
}

/** 能编辑的人与查看者看到的说明（i18n 的 mode.formulasPending） */
const PENDING_NOTE = '这份表格的公式结果可能还没更新（上次保存时公式还没算完）'
const PENDING_NOTE_EDITOR = `${PENDING_NOTE}，进入编辑之后会自动重算并保存`

/** 文档的"公式待更新"（服务端记在文档上，M3-P3） */
async function formulasPendingOf(documentId: string): Promise<boolean | undefined> {
  return withDatabase(async client => (await client.query<{ formulas_pending: boolean }>('SELECT formulas_pending FROM documents WHERE id = $1', [documentId])).rows[0]?.formulas_pending)
}

async function setFormulasPending(documentId: string, pending: boolean): Promise<void> {
  await withDatabase(async client => client.query('UPDATE documents SET formulas_pending = $2 WHERE id = $1', [documentId, pending]))
}

/** 一份快照里的公式与按定义算出的不同的格（按样本的规模核对）：空的才对 */
function staleIn(snapshotText: string, sample: FormulaSample = AUTOSAVE_FORMULA_SAMPLE): readonly string[] {
  const verdict = verifyFormulaSnapshot(snapshotText, 8, sample)
  return verdict.staleCount === 0 ? [] : [`${verdict.staleCount} 个：${verdict.stale.join('、')}`]
}

/** 以只读打开（打开即阅读），地址带上公式模式的开关；等到页头有了阅读时的样子 */
async function openReaderIn(page: Page, documentId: string, mode: SelftestFormulaMode): Promise<void> {
  await page.goto(`/documents/${documentId}?${new URLSearchParams({ [FORMULA_MODE_PARAM]: FORMULA_MODE_VALUES[mode] }).toString()}`)
  await waitForEditorAccess(page, 'read')
}

/** 这个编辑器打开时算的公式都算完了，而且都对（样本的公式不带缓存值，打开时全部算一遍） */
async function formulasComputed(page: Page, sample: FormulaSample): Promise<void> {
  await expect.poll(async () => probeFormulasSettled(page), { message: '打开时的计算收齐了', intervals: [50] }).toBe(true)
  await expect.poll(async () => staleIn(await probeSnapshot(page), sample), { message: '打开时算出的公式都与定义一致', intervals: [50] }).toEqual([])
}

/**
 * 以 mode 打开公式样本、进入编辑：阅读时的计算收齐之后再点"编辑"（主线程模式在计算中重建会出错，S1 的 F2），进入之后等可编辑的编辑器
 * 打开时的计算也收齐；放开定时的自动保存
 */
async function editFormulaSample(page: Page, documentId: string, mode: SelftestFormulaMode, sample: FormulaSample = AUTOSAVE_FORMULA_SAMPLE): Promise<void> {
  await openReaderIn(page, documentId, mode)
  expect(await probeFormulaMode(page)).toBe(mode)
  await formulasComputed(page, sample)
  await enterEditing(page)
  expect(await probeFormulaMode(page)).toBe(mode)
  await formulasComputed(page, sample)
  await releaseAutosave(page)
}

/** 一个装上时钟、登录了的作者与一份公式样本（默认 AUTOSAVE_FORMULA_SAMPLE 的那一份） */
async function formulaSample(page: Page, prefix: string, snapshotFor = autosaveFormulaSampleFor): Promise<string> {
  const owner = await createUser(prefix)
  const documentId = await createDocument(owner, '公式样本', snapshotFor)
  await loginThroughApi(page, owner)
  await page.clock.install()
  return documentId
}

/**
 * 在页面里改 first（工作表名、A1 写法、值），等它引起的这一轮开始（开始一轮的 mutation 执行完），在紧接着的微任务里改 second——
 * 这一轮一定还在算（结果经宏任务回来：Worker 的消息，主线程模式按 MessageChannel 让出，引擎在算第一个公式之前就让出一次）。
 * stop 为真时同时发 SDK 遇到相交的修改时发的那条 stop（engine-formula 的触发服务等 10 ms 的防抖之后才判断，那时这一轮可能已经算完，
 * 这里在同一刻发，确定落在计算中）。只装上监听、改 first：这一轮在 SDK 的计算防抖到点时才开始，调用方往前拨时钟；改了 second 之后
 * window 上的标记为真
 */
async function editDuringCalculation(page: Page, first: readonly [string, string, number], second: readonly [string, string, number], stop: boolean): Promise<void> {
  await page.evaluate(({ first, second, stop, start, stopId }) => {
    interface CommandEventLike { readonly id: string }
    interface FacadeEvents {
      readonly Event: { readonly CommandExecuted: string }
      readonly addEvent: (event: string, callback: (event: CommandEventLike) => void) => { readonly dispose: () => void }
      readonly executeCommand: (id: string, params?: object, options?: object) => Promise<boolean>
    }
    const api = window.__nerveEditorProbe?.univerAPI
    if (api === undefined)
      throw new Error('页面里没有编辑器的探针')
    const events = api as unknown as FacadeEvents
    const workbook = api.getActiveWorkbook()
    const marker = window as unknown as { __secondEditDone?: boolean }
    marker.__secondEditDone = false
    const subscription = events.addEvent(events.Event.CommandExecuted, (event) => {
      if (event.id !== start)
        return
      subscription.dispose()
      queueMicrotask(() => {
        workbook.getSheetByName(second[0]).getRange(second[1]).setValue(second[2])
        if (stop)
          void events.executeCommand(stopId, {}, { onlyLocal: true })
        marker.__secondEditDone = true
      })
    })
    workbook.getSheetByName(first[0]).getRange(first[1]).setValue(first[2])
  }, { first, second, stop, start: FORMULA_START, stopId: FORMULA_STOP })
}

/** 编辑器页上 editDuringCalculation 的第二处改完了没有 */
async function secondEditDone(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __secondEditDone?: boolean }).__secondEditDone === true)
}

/** A1 是 1，A2 是 =A1*2 而缓存值是错的（上次保存时公式还没算完）：按定义 A2 = 2 */
function staleFormulas(unitId: string): string {
  const sheet = SHEET_TEMPLATE.sheets[FIRST_SHEET]
  const cellData = { 0: { 0: { v: 1, t: 2 } }, 1: { 0: { f: '=A1*2', v: 999, t: 2 } } }
  return JSON.stringify({ ...SHEET_TEMPLATE, id: unitId, sheets: { [FIRST_SHEET]: { ...sheet, cellData } } })
}

test.describe('US-M3-03 保存下来的公式结果与重新计算的一致', { tag: '@test-build' }, () => {
  for (const [mode, label] of Object.entries(FORMULA_MODES) as [SelftestFormulaMode, string][]) {
    test(`US-M3-03 M0 的五类公式场景（${label}）：改链的起点、改聚合的一格，自动保存存下的依赖链、聚合、跨表、SUMPRODUCT 与易变函数的值都与按定义算出的一致；捕获在停 1 秒、公式收齐之后，不带标记`, async ({ page }) => {
      const documentId = await formulaSample(page, 'formulas-scenarios')
      await editFormulaSample(page, documentId, mode)
      const writes = recordWrites(page, documentId)
      // 第一处：链的起点（链 49 层与依赖它的跨表、易变函数重算）；第二处：聚合的第一格（SUM、AVERAGE、COUNTIF 与依赖它们的跨表、
      // 40 个 SUMPRODUCT、易变函数重算）。每一处：停不到 1 秒不捕获，之后在公式收齐时捕获、停 2 秒上传，上传的值与定义一致
      await pauseTime(page)
      for (const [index, [sheet, cell, value]] of ([[CHAIN.name, 'A1', 7], [AGGREGATE.name, 'B1', 1_000]] as const).entries()) {
        const changedAt = await pausedNow(page)
        await setCellValue(page, cell, value, sheet)
        await skipAhead(page, 999)
        expect(capturesOf(await logNow(page))).toHaveLength(index)
        await advanceUntil(page, async () => capturesOf(await autosaveLog(page)).length === index + 1, '这一处修改捕获了')
        const capture = capturesOf(await autosaveLog(page))[index]
        expect(capture).toMatchObject({ trigger: 'quiet', seq: index + 1, formulasPending: false })
        expect(capture?.at).toBeGreaterThanOrEqual(changedAt + 1_000)
        await advanceTo(page, changedAt + 2_000)
        await advanceUntil(page, async () => uploadsOf(await autosaveLog(page)).length === index + 1, '这一处修改上传了')
        expect(uploadsOf(await autosaveLog(page))[index]).toMatchObject({ trigger: 'quiet', seq: index + 1, outcome: { kind: 'saved' } })
        expect(uploadsOf(await autosaveLog(page))[index]?.startedAt).toBeGreaterThanOrEqual(changedAt + 2_000)
        expect(staleIn(uploadedText(writes.saves[index]))).toEqual([])
      }
      expect(writes.saves.map(save => saveParam(save, 'formulasPending'))).toEqual(['false', 'false'])
      await expect(saveStatus(page)).toHaveText('已保存到云端')
      await page.clock.resume()
      const saved = await savedContent(page, documentId)
      expect(staleIn(saved.text)).toEqual([])
      expect([saved.revision, await formulasPendingOf(documentId)]).toEqual([3, false])
    })

    test(`US-M3-03 静默窗口内再改一次（${label}）：改链的起点、0.5 秒后改聚合的一格——不在第一处之后 1 秒捕获，在第二处之后 1 秒、两轮都收齐时捕获，存下的值包含两处修改`, async ({ page }) => {
      const documentId = await formulaSample(page, 'formulas-quiet-window')
      await editFormulaSample(page, documentId, mode)
      const writes = recordWrites(page, documentId)
      const start = await pauseTime(page)
      await setCellValue(page, 'A1', 11, CHAIN.name)
      await skipAhead(page, 500)
      await setCellValue(page, 'B1', 5, AGGREGATE.name)
      // 第一处之后 1 秒多、第二处之后不到 1 秒：没有捕获
      await skipAhead(page, 999)
      expect(capturesOf(await logNow(page))).toEqual([])
      await advanceUntil(page, async () => capturesOf(await autosaveLog(page)).length === 1, '两处修改捕获了')
      const [capture] = capturesOf(await autosaveLog(page))
      expect(capture).toMatchObject({ trigger: 'quiet', seq: 2, formulasPending: false })
      expect(capture?.at).toBeGreaterThanOrEqual(start + 1_500)
      await advanceTo(page, start + 2_500)
      await advanceUntil(page, async () => writes.saves.length === 1, '两处修改上传了')
      const uploaded = uploadedText(writes.saves[0])
      expect(staleIn(uploaded)).toEqual([])
      expect(JSON.parse(uploaded)).toMatchObject({ sheets: { [CHAIN.id]: { cellData: { 0: { 0: { v: 11 } } } }, [AGGREGATE.id]: { cellData: { 0: { 1: { v: 5 } } } } } })
      await page.clock.resume()
    })

    test(`US-M3-03 计算进行中再改一次、改的是别处（${label}）：改聚合的一格，这一轮开始的那一刻改链的起点（不相交，排到下一轮）——等两轮都算完才捕获，存下的值包含两处修改`, async ({ page }) => {
      const documentId = await formulaSample(page, 'formulas-during-queued')
      await editFormulaSample(page, documentId, mode)
      const writes = recordWrites(page, documentId)
      const start = await pauseTime(page)
      const mark = await commandMark(page)
      await editDuringCalculation(page, [AGGREGATE.name, 'B1', 300], [CHAIN.name, 'A1', 13], false)
      // SDK 的计算防抖到点：这一轮开始，紧接着改第二处（修改的时刻是 start + 10）
      await page.clock.runFor(10)
      await expect.poll(async () => secondEditDone(page)).toBe(true)
      await skipAhead(page, 999)
      expect(capturesOf(await logNow(page))).toEqual([])
      await advanceUntil(page, async () => capturesOf(await autosaveLog(page)).length === 1, '两轮都算完之后捕获了')
      const [capture] = capturesOf(await autosaveLog(page))
      expect(capture).toMatchObject({ trigger: 'quiet', seq: 2, formulasPending: false })
      expect(capture?.at).toBeGreaterThanOrEqual(start + 1_010)
      await advanceTo(page, start + 2_010)
      await advanceUntil(page, async () => writes.saves.length === 1, '两处修改上传了')
      expect(staleIn(uploadedText(writes.saves[0]))).toEqual([])
      const executed = (await probeCommands(page, mark)).filter(command => command.phase === 'executed').map(command => command.id)
      expect(executed.filter(id => id === FORMULA_START).length).toBeGreaterThanOrEqual(2)
      expect(executed).not.toContain(FORMULA_STOP)
      await page.clock.resume()
    })

    test(`US-M3-03 计算进行中再改一次、改的是同一处（${label}）：重表的一格引起的一轮（520 个 SUMPRODUCT）开始的那一刻再改同一格，这一轮被 stop——被 stop 的一轮不算收齐，等重新开始的一轮算完才捕获，存下的是第二次的值`, async ({ page }) => {
      const documentId = await formulaSample(page, 'formulas-during-stop', autosaveStopSampleFor)
      await editFormulaSample(page, documentId, mode, AUTOSAVE_STOP_SAMPLE)
      const writes = recordWrites(page, documentId)
      const start = await pauseTime(page)
      const mark = await commandMark(page)
      await editDuringCalculation(page, [HEAVY.name, 'A1', 1_000], [HEAVY.name, 'A1', 5], true)
      await page.clock.runFor(10)
      await expect.poll(async () => secondEditDone(page)).toBe(true)
      await skipAhead(page, 999)
      expect(capturesOf(await logNow(page))).toEqual([])
      await advanceUntil(page, async () => capturesOf(await autosaveLog(page)).length === 1, '重新开始的一轮算完之后捕获了')
      const [capture] = capturesOf(await autosaveLog(page))
      expect(capture).toMatchObject({ trigger: 'quiet', seq: 2, formulasPending: false })
      expect(capture?.at).toBeGreaterThanOrEqual(start + 1_010)
      await advanceTo(page, start + 2_010)
      await advanceUntil(page, async () => writes.saves.length === 1, '第二次的值上传了')
      const uploaded = uploadedText(writes.saves[0])
      expect(staleIn(uploaded, AUTOSAVE_STOP_SAMPLE)).toEqual([])
      expect(JSON.parse(uploaded)).toMatchObject({ sheets: { [HEAVY.id]: { cellData: { 0: { 0: { v: 5 } } } } } })
      // 第一轮真的被停下了：它没有结果，第一条结果在重新开始的那一轮之后
      const executed = (await probeCommands(page, mark)).filter(command => command.phase === 'executed').map(command => command.id)
      const starts = executed.flatMap((id, index) => id === FORMULA_START ? [index] : [])
      expect(starts.length).toBeGreaterThanOrEqual(2)
      expect(executed).toContain(FORMULA_STOP)
      expect(executed.findIndex(id => id === FORMULA_RESULT), '被 stop 的那一轮没有结果').toBeGreaterThan(starts[1] ?? Number.POSITIVE_INFINITY)
      await page.clock.resume()
    })

    test(`US-M3-03 静默到点时公式还没收齐（${label}：改了无关的一格，静默到点之前 1 毫秒强制重算排上了一轮）——到点不捕获，等这一轮算完才捕获，存下的是算完的值`, async ({ page }) => {
      // A2 = A1 × 2 的缓存值是错的（999）、没有"公式待更新"：进入编辑时不重算（SDK 只算没有结果的公式），本页显示的就是错的值
      const owner = await createUser('formulas-queued')
      const documentId = await createDocument(owner, '静默到点时在排队', staleFormulas)
      await loginThroughApi(page, owner)
      await page.clock.install()
      await openReaderIn(page, documentId, mode)
      await expect(enterEditButton(page)).toBeVisible()
      await enterEditing(page)
      expect(await probeFormulaMode(page)).toBe(mode)
      await releaseAutosave(page)
      const writes = recordWrites(page, documentId)
      const start = await pauseTime(page)
      // 改一格无关的（不牵动公式）：它引起的那一轮马上算完
      await setCellValue(page, 'C1', '无关的修改')
      await settleAfterEdit(page)
      expect(JSON.parse(await probeSnapshot(page))).toMatchObject({ sheets: { [FIRST_SHEET]: { cellData: { 1: { 0: { v: 999 } } } } } })
      // 静默到点（start + 1000）之前 1 毫秒强制重算（与带"公式待更新"的文档进入编辑时同一条 mutation，带 onlyLocal：不算修改）：
      // 这一轮在 SDK 的计算防抖之后（start + 1009）才开始，到点的那一刻公式还在排队、没收齐
      await skipAhead(page, 1_000 - SDK_CALCULATION_DEBOUNCE_MS - 1)
      await page.evaluate(async (id) => {
        await window.__nerveEditorProbe?.univerAPI.executeCommand(id, { forceCalculation: true }, { onlyLocal: true })
      }, FORMULA_FORCE_TRIGGER)
      expect(await probeFormulasSettled(page)).toBe(false)
      await page.clock.runFor(1)
      expect(capturesOf(await logNow(page))).toEqual([])
      // 这一轮开始、算完之后才捕获（不早于它开始的那一刻），存下的是重算的值
      await advanceUntil(page, async () => capturesOf(await autosaveLog(page)).length === 1, '这一轮算完之后捕获了')
      const [capture] = capturesOf(await autosaveLog(page))
      expect(capture).toMatchObject({ trigger: 'quiet', seq: 1, formulasPending: false })
      expect(capture?.at).toBeGreaterThanOrEqual(start + 1_009)
      await advanceTo(page, start + 2_000)
      await advanceUntil(page, async () => writes.saves.length === 1, '捕获的那一份上传了')
      const uploaded = JSON.parse(uploadedText(writes.saves[0])) as { sheets: Record<string, { cellData: Record<string, Record<string, unknown>> }> }
      expect(uploaded.sheets[FIRST_SHEET]?.cellData[1]?.[0]).toMatchObject({ f: '=A1*2', v: 2 })
      expect(uploaded.sheets[FIRST_SHEET]?.cellData[0]?.[2]).toMatchObject({ v: '无关的修改' })
      await page.clock.resume()
    })

    test(`US-M3-03 超过捕获的上限（${label}，测试构建把上限调到 5 毫秒）：照常捕获并带"公式待更新"上传，服务端记下，阅读者看到说明；收齐之后自动补存，标记清掉，存下的值与定义一致`, async ({ page, anotherDevice }) => {
      const lead = await createUser('formulas-cap-lead')
      const colleague = await createUser('formulas-cap-colleague')
      const space = await createTeamSpace('公式待更新', lead, [[lead, 'admin'], [colleague, 'editor']])
      const documentId = await createDocumentIn(space.id, lead, '公式样本', { snapshotFor: autosaveFormulaSampleFor })
      await loginThroughApi(page, lead)
      await page.clock.install()
      await editFormulaSample(page, documentId, mode)
      const writes = recordWrites(page, documentId)
      // 上限 5 毫秒：SDK 的计算防抖（10 毫秒）还没到，这一轮还在排队（没收齐）；上传的静默 6 毫秒：带标记的那一份在这一轮开始之前就上传
      await setAutosaveLimits(page, { captureMaxMs: 5, uploadQuietMs: 6 })
      const start = await pauseTime(page)
      await setCellValue(page, 'B1', 1_000, AGGREGATE.name)
      await page.clock.runFor(6)
      await expect.poll(async () => uploadsOf(await logNow(page))).toMatchObject([{ trigger: 'quiet', startedAt: start + 6, seq: 1, outcome: { kind: 'saved' } }])
      expect(capturesOf(await autosaveLog(page))).toMatchObject([{ trigger: 'cap', at: start + 5, seq: 1, formulasPending: true }])
      expect(saveParam(writes.saves[0], 'formulasPending')).toBe('true')
      // 带标记的那一份里，依赖这一格的公式还是旧值
      expect(staleIn(uploadedText(writes.saves[0]))).not.toEqual([])
      expect(await formulasPendingOf(documentId)).toBe(true)
      await expect(saveStatus(page)).toHaveText('公式结果尚未保存（算完之后自动保存）')

      // 能编辑的同事这时打开：阅读页说明公式结果可能还没更新、进入编辑之后会重算
      await loginThroughApi(anotherDevice, colleague)
      await openReader(anotherDevice, documentId)
      await expect(statusRegion(anotherDevice)).toContainText(PENDING_NOTE_EDITOR)

      // 往前拨：SDK 的计算防抖到点，这一轮开始、算完（真实的时间），收齐之后补捕获（不带标记）、上传
      await advanceUntil(page, async () => uploadsOf(await autosaveLog(page)).length === 2, '收齐之后补存了')
      const log = await autosaveLog(page)
      expect(capturesOf(log)[1]).toMatchObject({ trigger: 'formulas', seq: 1, formulasPending: false })
      expect(uploadsOf(log)[1]).toMatchObject({ outcome: { kind: 'saved' } })
      expect(saveParam(writes.saves[1], 'formulasPending')).toBe('false')
      await expect(saveStatus(page)).toHaveText('已保存到云端')
      await page.clock.resume()
      const saved = await savedContent(page, documentId)
      expect(staleIn(saved.text)).toEqual([])
      expect([saved.revision, await formulasPendingOf(documentId)]).toEqual([3, false])
    })

    test(`US-M3-03 带"公式待更新"的文档（${label}）：阅读页说明；进入编辑时强制全量重算，算完之后自动补存（没改也存一次），服务端清掉标记，存下的是重算的结果`, async ({ page }) => {
      const owner = await createUser('formulas-forced')
      const documentId = await createDocument(owner, '公式待更新', staleFormulas)
      await setFormulasPending(documentId, true)
      await loginThroughApi(page, owner)
      await openReaderIn(page, documentId, mode)
      await expect(enterEditButton(page)).toBeVisible()
      expect(await probeFormulaMode(page)).toBe(mode)
      await expect(statusRegion(page)).toContainText(PENDING_NOTE_EDITOR)

      const writes = recordWrites(page, documentId)
      await enterEditing(page)
      // 进入编辑一律重建：同一个地址，模式不变
      expect(await probeFormulaMode(page)).toBe(mode)
      await releaseAutosave(page)
      // 补存不等用户的修改：公式收齐就补捕获，照上传的规则上传（没有修改时不等静默）
      await expect.poll(() => writes.saves.length).toBe(1)
      await expect(saveStatus(page)).toHaveText('已保存到云端')
      expect(saveParam(writes.saves[0], 'formulasPending')).toBe('false')
      const saved = (await savedContent(page, documentId)).snapshot
      expect(cellOf(saved, 'A2')).toMatchObject({ f: '=A1*2', v: 2 })
      expect(await formulasPendingOf(documentId)).toBe(false)
      expect(await revisionOf(documentId)).toBe(2)
      // 没有修改：那一次是公式收齐之后的补捕获（强制重算那一轮算完之前不算收齐），不带标记
      const log = await autosaveLog(page)
      expect(capturesOf(log)).toMatchObject([{ trigger: 'formulas', seq: 0, formulasPending: false }])
      expect(uploadsOf(log)).toMatchObject([{ outcome: { kind: 'saved' } }])

      await exitEditing(page)
      await expect(statusRegion(page)).not.toContainText(PENDING_NOTE)
    })

    test(`US-M3-03 DEF-020（${label}）：Cmd/Ctrl+K 被入口守卫取消之后（执行栈里留着它）改公式的依赖，自动保存存下的公式值正确`, async ({ page }) => {
      await loginThroughApi(page, await createUser('formulas-def020'))
      const documentId = await createSheetThroughApi(page)
      await page.clock.install()
      await openReaderIn(page, documentId, mode)
      // 快捷键要等 SDK 到 steady（之前不可用）
      await enterEditing(page, 'steady')
      expect(await probeFormulaMode(page)).toBe(mode)
      await typeInCell(page, 'A1', '1')
      await typeInCell(page, 'A2', '=A1*2')
      // 入口守卫取消插入超链接（M5 之前没有它）：被取消的命令留在 SDK 的执行栈里，之后命令之外的 mutation（Worker 的写回等）带上它的 trigger
      await selectCell(page, 'C3')
      const mark = await commandMark(page)
      await page.keyboard.press('ControlOrMeta+k')
      await waitForCommand(page, mark, { phase: 'before', id: 'sheet.operation.insert-hyper-link-toolbar', canceled: true })
      const writes = recordWrites(page, documentId)
      await releaseAutosave(page)
      const start = await pauseTime(page)
      await typeInCell(page, 'A1', '5')
      await skipAhead(page, 1_999)
      expect(uploadsOf(await logNow(page))).toEqual([])
      await advanceUntil(page, async () => uploadsOf(await autosaveLog(page)).length === 1, '改了依赖之后上传了')
      expect(uploadsOf(await autosaveLog(page))[0]).toMatchObject({ trigger: 'quiet', outcome: { kind: 'saved' } })
      expect(uploadsOf(await autosaveLog(page))[0]?.startedAt).toBeGreaterThanOrEqual(start + 2_000)
      expect(capturesOf(await autosaveLog(page)).at(-1)).toMatchObject({ formulasPending: false })
      const uploaded = JSON.parse(uploadedText(writes.saves.at(-1))) as { sheets: Record<string, { cellData: Record<string, Record<string, unknown>> }> }
      expect(uploaded.sheets[FIRST_SHEET]?.cellData[1]?.[0]).toMatchObject({ f: '=A1*2', v: 10 })
      await page.clock.resume()
      expect(cellOf((await savedContent(page, documentId)).snapshot, 'A2')).toMatchObject({ f: '=A1*2', v: 10 })
      expect(await formulasPendingOf(documentId)).toBe(false)
    })
  }

  test('US-M3-03 阅读页的"公式待更新"说明随每 30 秒的检查出现、消失：能编辑的人说进入编辑之后会自动重算并保存，查看者只说前半句', async ({ page, anotherDevice }) => {
    const lead = await createUser('formulas-note-lead')
    const viewer = await createUser('formulas-note-viewer')
    const space = await createTeamSpace('公式说明', lead, [[lead, 'admin'], [viewer, 'viewer']])
    const documentId = await createDocumentIn(space.id, lead, '共同的表')
    await loginThroughApi(page, lead)
    await loginThroughApi(anotherDevice, viewer)
    // 两边都装上时钟（打开之前），之后时间照常流动；要检查的时候往前拨 30 秒
    await page.clock.install()
    await anotherDevice.clock.install()
    await openReader(page, documentId)
    await openReader(anotherDevice, documentId)
    await expect(statusRegion(page)).not.toContainText(PENDING_NOTE)
    await expect(statusRegion(anotherDevice)).not.toContainText(PENDING_NOTE)

    // 这一版记上"公式待更新"（同一个修订号）：下一次检查时两边都说明
    await setFormulasPending(documentId, true)
    await page.clock.fastForward(30_000)
    await anotherDevice.clock.fastForward(30_000)
    await expect(statusRegion(page)).toContainText(PENDING_NOTE_EDITOR)
    await expect(statusRegion(anotherDevice)).toContainText(PENDING_NOTE)
    await expect(statusRegion(anotherDevice)).not.toContainText('进入编辑之后会自动重算并保存')

    // 补存清掉了标记：下一次检查时说明消失
    await setFormulasPending(documentId, false)
    await page.clock.fastForward(30_000)
    await anotherDevice.clock.fastForward(30_000)
    await expect(statusRegion(page)).not.toContainText(PENDING_NOTE)
    await expect(statusRegion(anotherDevice)).not.toContainText(PENDING_NOTE)
  })

  test('US-M3-03 组合输入（输入法组字）：批注里组字期间不捕获（SDK 按 300 ms 防抖把拼音写进批注，是一处修改）；组合结束之后停 1 秒捕获，存下的是选定的文字', async ({ page, browserName }) => {
    await page.clock.install()
    await loginThroughApi(page, await createUser('formulas-composition'))
    const documentId = await createSheetThroughApi(page)
    await openAndEnterEditing(page, documentId)
    const writes = recordWrites(page, documentId)
    await releaseAutosave(page)
    await selectCell(page, 'D4', { button: 'right' })
    await page.getByRole('button', { name: '添加批注' }).click()
    await page.getByRole('textbox', { name: '在此输入' }).click()
    // 打开时浮层按输入框的尺寸写回批注（SDK 的 300 ms 防抖），可能是一处修改：停住时间、拨过它（500 毫秒），让它捕获（1 秒）、
    // 上传完（2 秒），之后的修改都来自组字
    await pauseTime(page)
    await skipAhead(page, 500)
    await skipAhead(page, 1_000)
    await skipAhead(page, 1_000)
    await expect.poll(async () => {
      await page.clock.runFor(0)
      return saveStatus(page).textContent()
    }).toBe('已保存到云端')
    const captured = capturesOf(await autosaveLog(page)).length
    const uploaded = uploadsOf(await autosaveLog(page)).length
    const saves = writes.saves.length
    const start = await page.evaluate(() => performance.now())

    const composition = await startComposition(page, browserName)
    await composition.update('ni hao')
    // SDK 的防抖到点：组字中的拼音写进了批注（模型里有它，这是一处修改）
    await skipAhead(page, 300)
    await expect.poll(async () => noteOf(await probeSnapshot(page))).toBe('ni hao')
    // 那一处修改之后 1 秒的静默已经过了：组字中不捕获（3 秒的上限还没到）
    await skipAhead(page, 1_200)
    expect(capturesOf(await logNow(page))).toHaveLength(captured)
    // 选定"你好"、组合结束（start + 1500）；SDK 的防抖到点写进批注（start + 1800），停 1 秒之后捕获
    await composition.commit('你好')
    await skipAhead(page, 300)
    await expect.poll(async () => noteOf(await probeSnapshot(page))).toBe('你好')
    await skipAhead(page, 999)
    expect(capturesOf(await logNow(page))).toHaveLength(captured)
    await page.clock.runFor(1)
    await expect.poll(async () => capturesOf(await logNow(page)).length).toBe(captured + 1)
    expect(capturesOf(await autosaveLog(page)).at(-1)).toMatchObject({ trigger: 'quiet', at: start + 2_800 })
    await skipAhead(page, 1_000)
    await expect.poll(async () => uploadsOf(await logNow(page)).slice(uploaded)).toMatchObject([{ trigger: 'quiet', startedAt: start + 3_800, outcome: { kind: 'saved' } }])
    expect(writes.saves).toHaveLength(saves + 1)
    expect(noteOf(uploadedText(writes.saves.at(-1)))).toBe('你好')
    await page.clock.resume()
    expect(noteOf((await savedContent(page, documentId)).text)).toBe('你好')
  })
})

/** 快照里第一张表 D4 的批注 */
function noteOf(snapshotText: string): string | undefined {
  const snapshot = JSON.parse(snapshotText) as { resources: { name: string, data: string }[] }
  const data = snapshot.resources.find(resource => resource.name === 'SHEET_NOTE_PLUGIN')?.data
  if (data === undefined || data === '')
    return undefined
  return (JSON.parse(data) as Record<string, Record<string, Record<string, { note?: string }>>>)[FIRST_SHEET]?.[3]?.[3]?.note
}

/** 一次组合输入：update 是组字中的文字，commit 选定并结束 */
interface Composition {
  readonly update: (text: string) => Promise<void>
  readonly commit: (text: string) => Promise<void>
}

/**
 * 在获得焦点的输入框里开始组字（M3-P4 设计 §3.6）：Chromium 内核（chromium、chrome、msedge）经 CDP 的 Input.imeSetComposition 驱动
 * 浏览器自己的组合输入（M0-P5 的做法），选定用 Input.insertText；WebKit 没有这个协议，派发合成的 compositionstart、compositionupdate、
 * compositionend，组字中的文字经 textarea 原型上的 value 写进去并派发 input（与页面自检的 composition 场景相同，React 才认得出值变了）。
 * 真实的输入法在自动化里驱动不了，登记为人工核对的盲区
 */
async function startComposition(page: Page, browserName: string): Promise<Composition> {
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page)
    return {
      update: async (text) => {
        await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
      },
      commit: async (text) => {
        await cdp.send('Input.insertText', { text })
      },
    }
  }
  await page.evaluate(() => {
    document.activeElement?.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, composed: true, data: '' }))
  })
  const type = async (text: string, phase: 'update' | 'end'): Promise<void> => page.evaluate(({ text, phase }) => {
    const input = document.activeElement
    if (!(input instanceof HTMLTextAreaElement))
      throw new Error('焦点不在批注的输入框上')
    input.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, composed: true, data: text }))
    Reflect.set(HTMLTextAreaElement.prototype, 'value', text, input)
    input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, isComposing: true, inputType: 'insertCompositionText', data: text }))
    if (phase === 'end')
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, composed: true, data: text }))
  }, { text, phase })
  return {
    update: async text => type(text, 'update'),
    commit: async text => type(text, 'end'),
  }
}
