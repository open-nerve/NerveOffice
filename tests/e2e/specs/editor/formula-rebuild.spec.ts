// 主线程公式模式下在计算中重建（M3-P4 设计 §3.14，S1 真实 Safari 复核的 F2；S5 的规避）。主线程模式（M4 的退路，M3 里只有测试构建
// 经地址参数选它）下，编辑器在一轮公式计算进行中被销毁（阅读与编辑之间一律重建）时，这一轮不会自己停下：运行时销毁时把停止标记复位，
// 旧的循环在让出点之后接着跑，用已经清空的函数表把只会得出 #NAME? 的语法树写进 engine-formula 模块级的缓存，之后同一页里新建的编辑器
// 算到这些格时命中它们（S1 实测 110–350 个公式得出 #NAME?）。规避：销毁之前先执行停止的 mutation、等这一轮结束的通知再销毁
// （apps/web/src/editor/formula-round-stop.ts），编辑器槽位等它销毁完才新建。
// 这里在阅读时让全部公式重算、这一轮一开始就点"编辑"，编辑时同样重算、一开始就点"退出编辑"（没有修改，退出不等公式），两次都在计算中销毁
// 旧的编辑器；最后在阅读的编辑器里再强制重算一遍，全部公式按定义核对（与页面自检的 formula.rebuild-during-calc 同一份样本与核对）。
// 旧的编辑器的命令日志（探针销毁时退订，日志留着）证明重建确实发生在计算中、销毁之前停下了这一轮；两次停下各等了多久写进附件。
// 用到测试构建的公式模式开关与探针：标签 @test-build
import type { JSHandle, Page } from '@playwright/test'
import type { ProbeCommand } from '../../support/editor-probe.ts'
import { verifyFormulaSnapshot } from '../../../../apps/web/src/editor/testing/capture-samples.ts'
import { FORMULA_MODE_PARAM, FORMULA_MODE_VALUES } from '../../../../apps/web/src/editor/testing/selftest-report.ts'
import { formulaSampleFor } from '../../support/capture-samples.ts'
import { createDocument, createUser, revisionOf } from '../../support/database.ts'
import { commandMark, probeCommands, probeFormulaMode, probeFormulasSettled, probeSnapshot, runFacade } from '../../support/editor-probe.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'
import { EDITOR_TEST_TIMEOUT, enterEditButton, enterEditing, exitEditing, waitForEditorAccess } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

// engine-formula 的 mutation（apps/web 的 internal-api/formula-protocol.ts 的 FORMULA_PROTOCOL 登记着它们；E2E 不引用 Univer，写字面量）
const CALCULATION_START = 'formula.mutation.set-formula-calculation-start'
const CALCULATION_STOP = 'formula.mutation.set-formula-calculation-stop'
const CALCULATION_NOTIFICATION = 'formula.mutation.set-formula-calculation-notification'
const CALCULATION_RESULT = 'formula.mutation.set-formula-calculation-result'

/** 一轮强制全量重算（811 个公式，其中 600 个 1 万行的 SUMPRODUCT）最多等多久：本机主线程 2–5 秒，CI 慢几倍 */
const ROUND_TIMEOUT_MS = 90_000

/** 阅读的编辑器里的探针（销毁时它退订命令事件，日志停在销毁的那一刻） */
type ProbeHandle = JSHandle<Window['__nerveEditorProbe']>

/** 让全部公式重算（与强制重算的打开同一条 mutation，带 onlyLocal：不算修改，阅读时也不被防火墙取消） */
async function recalculateAll(page: Page): Promise<void> {
  expect(await runFacade(page, async ({ api }) => api.executeCommand('formula.mutation.set-trigger-formula-calculation-start', { forceCalculation: true }, { onlyLocal: true }))).toEqual({})
}

/** mark 之后执行了的命令 */
function executedAfter(commands: readonly ProbeCommand[], mark: number): ProbeCommand[] {
  return commands.filter(command => command.seq > mark && command.phase === 'executed')
}

/** mark 之后的一轮已经开始：开始的 mutation 之后有了它的通知（主线程上开始就同步送出第一条进度通知） */
function roundStarted(commands: readonly ProbeCommand[], mark: number): boolean {
  const executed = executedAfter(commands, mark).map(command => command.id)
  const start = executed.indexOf(CALCULATION_START)
  return start >= 0 && executed.includes(CALCULATION_NOTIFICATION, start + 1)
}

/**
 * 等公式收齐（打开时、进入编辑时的那一轮，或者强制重算的那一轮）。打开时的那一轮在渲染完成之后才开始（触发服务 10 ms 的防抖）：
 * 调用方先等到 steady（渲染完成之后 3 秒），免得在它开始之前就读到"收齐"
 */
async function untilSettled(page: Page, message: string): Promise<void> {
  await expect.poll(async () => probeFormulasSettled(page), { message, timeout: ROUND_TIMEOUT_MS, intervals: [50] }).toBe(true)
}

/**
 * 在计算中重建：这个编辑器里让全部公式重算，这一轮一开始就做 rebuild（点"编辑"或"退出编辑"，等新的编辑器就绪）。
 * 交回旧的编辑器在这一轮里的命令（mark 之后执行了的），用来核对重建发生在计算中、销毁之前停下了它
 */
async function rebuildDuringRound(page: Page, rebuild: () => Promise<void>): Promise<ProbeCommand[]> {
  const old: ProbeHandle = await page.evaluateHandle(() => window.__nerveEditorProbe)
  const mark = await commandMark(page)
  await recalculateAll(page)
  await expect.poll(async () => roundStarted(await probeCommands(page, mark), mark), { intervals: [5], message: '强制重算的这一轮开始了', timeout: ROUND_TIMEOUT_MS }).toBe(true)
  await rebuild()
  const commands = await old.evaluate((probe, after) => probe?.commands(after) ?? [], mark) as ProbeCommand[]
  await old.dispose()
  return executedAfter(commands, mark)
}

/** 旧的编辑器在计算中被重建：这一轮没有结果；销毁之前执行了停止的 mutation、收到了之后的通知。交回停下等了多久（毫秒） */
function stoppedMidRound(executed: readonly ProbeCommand[], what: string): number {
  const ids = executed.map(command => command.id)
  expect(ids, `${what}：这一轮开始了`).toContain(CALCULATION_START)
  expect(ids, `${what}：旧的编辑器销毁之前这一轮没有算完（没有结果）——重建发生在计算中`).not.toContain(CALCULATION_RESULT)
  const stop = executed.find(command => command.id === CALCULATION_STOP)
  expect(stop, `${what}：销毁之前执行了停止的 mutation`).toBeDefined()
  const ended = executed.filter(command => command.id === CALCULATION_NOTIFICATION && command.seq > (stop?.seq ?? 0)).at(-1)
  expect(ended, `${what}：停下之后收到了这一轮的通知（结束的那一条是最后一条）`).toBeDefined()
  return Math.round((ended?.at ?? 0) - (stop?.at ?? 0))
}

test.describe('US-M3-03 主线程公式模式下在计算中重建（M3-P4 设计 §3.14）', { tag: '@test-build' }, () => {
  test('US-M3-03 阅读时强制重算一开始就点"编辑"、编辑时强制重算一开始就点"退出编辑"：两次都在计算中重建（销毁之前先停下这一轮）；之后在同一页里再强制重算，全部公式与按定义算出的一致，没有 #NAME?；没有保存', async ({ page }, testInfo) => {
    const owner = await createUser('rebuild-main')
    const documentId = await createDocument(owner, '主线程计算中重建', formulaSampleFor)
    await loginThroughApi(page, owner)
    await page.goto(`/documents/${documentId}?${new URLSearchParams({ [FORMULA_MODE_PARAM]: FORMULA_MODE_VALUES['main-thread'] }).toString()}`)
    await waitForEditorAccess(page, 'read', 'steady')
    await expect(enterEditButton(page)).toBeVisible()
    expect(await probeFormulaMode(page)).toBe('main-thread')
    await untilSettled(page, '打开时算没有缓存值的公式')

    const entering = await rebuildDuringRound(page, async () => enterEditing(page, 'steady'))
    const enterStopMs = stoppedMidRound(entering, '点"编辑"')
    expect(await probeFormulaMode(page)).toBe('main-thread')
    await untilSettled(page, '进入编辑之后打开时的那一轮')

    const exiting = await rebuildDuringRound(page, async () => exitEditing(page, 'steady'))
    const exitStopMs = stoppedMidRound(exiting, '点"退出编辑"')
    await untilSettled(page, '退出编辑之后打开时的那一轮')

    // 同一页里再强制重算一遍：前两次销毁时的那一轮若没停下，坏掉的语法树就在缓存里，这一遍算到它们得出 #NAME?
    const mark = await commandMark(page)
    await recalculateAll(page)
    await expect.poll(async () => executedAfter(await probeCommands(page, mark), mark).some(command => command.id === CALCULATION_START), { message: '最后一遍强制重算开始了', timeout: ROUND_TIMEOUT_MS }).toBe(true)
    await untilSettled(page, '最后一遍强制重算')
    const verdict = verifyFormulaSnapshot(await probeSnapshot(page))
    await testInfo.attach('formula-rebuild', { body: JSON.stringify({ enterStopMs, exitStopMs, verdict }, null, 2), contentType: 'application/json' })
    expect(verdict.checked).toBeGreaterThan(800)
    expect({ staleCount: verdict.staleCount, stale: verdict.stale, errors: verdict.errors }).toEqual({ staleCount: 0, stale: [], errors: {} })
    expect(await revisionOf(documentId), '只是打开、进入与退出编辑，没有修改，不保存').toBe(1)
  })
})
