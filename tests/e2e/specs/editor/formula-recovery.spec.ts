// 真实 Worker 出错与页面边界的交错。探针只读取计算/正文，自检故障只使用既有测试构建开关。
// 回归断点：阅读恢复误存、组字屏障吞掉 compositionend、不完整新实例被接纳、失败重试丢掉冻结正文。
import type { Page, Request } from '@playwright/test'
import type { Workbook } from '../../support/sheet.ts'
import { sheetSnapshotFor } from '@nerve-office/contracts'
import { recordWrites } from '../../support/autosave.ts'
import { startComposition } from '../../support/composition.ts'
import { createDocument, createUser, editLeaseEpoch, revisionOf } from '../../support/database.ts'
import { probeFormulaMode, probeFormulasSettled, probeSnapshot } from '../../support/editor-probe.ts'
import { expect, test } from '../../support/fixtures.ts'
import { failFormulaWorker, formulaRecoveryNotice } from '../../support/formula-worker-fault.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, openAndEnterEditing, openReader, saveAndWait, saveButton, savedContent, selectCell, typeInCell, waitForEditorAccess } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })
const READY = '公式已改用当前页面计算，大表格可能暂时卡顿。'

function staleFormula(unitId: string): string {
  const snapshot = JSON.parse(sheetSnapshotFor(unitId)) as { sheets: Record<string, { cellData: unknown }> }
  const sheet = snapshot.sheets['sheet-1']
  if (sheet === undefined)
    throw new Error('模板没有第一张表')
  sheet.cellData = { 0: { 0: { v: 3, t: 2 } }, 1: { 0: { f: '=A1*2', v: 999, t: 2 } } }
  return JSON.stringify(snapshot)
}

function noteAtD4(text: string): string | undefined {
  const snapshot = JSON.parse(text) as { resources: { name: string, data: string }[] }
  const data = snapshot.resources.find(resource => resource.name === 'SHEET_NOTE_PLUGIN')?.data
  return data === undefined || data === '' ? undefined : (JSON.parse(data) as Record<string, Record<string, Record<string, { note?: string }>>>)['sheet-1']?.[3]?.[3]?.note
}

async function profileFault(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate((enabled) => {
    const url = new URL(location.href)
    if (enabled)
      url.searchParams.set('profileFault', 'note')
    else
      url.searchParams.delete('profileFault')
    history.replaceState(history.state, '', url)
  }, enabled)
}

test.describe('US-M4-13 运行期恢复的输入与自检边界', { tag: '@test-build' }, () => {
  test('US-M4-13 阅读时出错：主线程强制重算旧缓存，不申请编辑权、不保存', async ({ page }) => {
    const owner = await createUser('formula-read')
    const id = await createDocument(owner, '阅读时公式恢复', staleFormula)
    await loginThroughApi(page, owner)
    const writes = recordWrites(page, id)
    await openReader(page, id, 'steady')
    expect(await probeFormulaMode(page)).toBe('worker')
    const old = await failFormulaWorker(page)
    await expect(formulaRecoveryNotice(page)).toHaveText(READY)
    await waitForEditorAccess(page, 'read', 'steady')
    expect(await probeFormulaMode(page)).toBe('main-thread')
    await expect.poll(async () => probeFormulasSettled(page)).toBe(true)
    expect(cellOf(JSON.parse(await probeSnapshot(page)) as Workbook, 'A2')).toMatchObject({ f: '=A1*2', v: 6 })
    expect(page.workers()).not.toContain(old)
    expect(writes).toEqual({ saves: [], releases: [] })
    expect(await editLeaseEpoch(id)).toBeUndefined()
    expect(await revisionOf(id)).toBe(1)
    expect(cellOf((await savedContent(page, id)).snapshot, 'A2')).toMatchObject({ v: 999 })
  })

  test('US-M4-13 批注组字中出错：等待选定，不销毁输入框；组合结束后保留中文与已有正文', async ({ page, browserName }) => {
    await loginThroughApi(page, await createUser('formula-ime'))
    const id = await createSheetThroughApi(page)
    await openAndEnterEditing(page, id, 'steady')
    await typeInCell(page, 'C1', '组字前的正文')
    await selectCell(page, 'D4', { button: 'right' })
    await page.getByRole('button', { name: '添加批注' }).click()
    const input = page.getByRole('textbox', { name: '在此输入' })
    await input.click()
    const composition = await startComposition(page, browserName)
    await composition.update('ni hao')
    await expect.poll(async () => noteAtD4(await probeSnapshot(page))).toBe('ni hao')
    const old = await failFormulaWorker(page)
    await expect(formulaRecoveryNotice(page)).toHaveText('请先完成当前输入，页面随后恢复公式计算。')
    expect(page.workers()).toContain(old)
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('ni hao')
    await expect(saveButton(page)).toHaveAttribute('aria-disabled', 'true')
    await composition.commit('你好')
    await expect(formulaRecoveryNotice(page)).toHaveText(READY)
    await waitForEditorAccess(page, 'edit', 'steady')
    await saveAndWait(page)
    const saved = await savedContent(page, id)
    expect(noteAtD4(saved.text)).toBe('你好')
    expect(cellOf(saved.snapshot, 'C1')).toMatchObject({ v: '组字前的正文' })
    expect(await editLeaseEpoch(id)).toBe(1)
  })

  test('US-M4-13 主线程重建的自检失败：不保存缺项实例，修复档案后点重试仍保留重建前的输入', async ({ page }) => {
    await loginThroughApi(page, await createUser('formula-retry'))
    const id = await createSheetThroughApi(page)
    const reports: Request[] = []
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/documents/${id}/open-check-failures`)
        reports.push(request)
    })
    await openAndEnterEditing(page, id, 'steady')
    const writes = recordWrites(page, id)
    await typeInCell(page, 'A1', '恢复前保留', false)
    await profileFault(page, true)
    await failFormulaWorker(page)
    await expect(formulaRecoveryNotice(page)).toContainText('重建后的表格未完整载入，原内容仍保留在本页。')
    await expect(saveButton(page)).toHaveAttribute('aria-disabled', 'true')
    expect(writes.saves).toEqual([])
    expect(await revisionOf(id)).toBe(1)
    await expect.poll(() => reports.length).toBe(2)
    expect(reports[0]?.postDataJSON()).toMatchObject({ kind: 'formula-worker', failure: 'error-after-ready', trigger: 'formula-recovery' })
    expect(reports[1]?.postDataJSON()).toMatchObject({ trigger: 'formula-recovery', failures: [{ kind: 'profile-missing-hook', resource: 'SHEET_NOTE_PLUGIN' }] })
    await profileFault(page, false)
    await page.getByRole('button', { name: '重试公式恢复', exact: true }).click()
    await expect(formulaRecoveryNotice(page)).toHaveText(READY)
    await waitForEditorAccess(page, 'edit', 'steady')
    expect(await probeFormulaMode(page)).toBe('main-thread')
    await saveAndWait(page)
    expect(cellOf((await savedContent(page, id)).snapshot, 'A1')).toMatchObject({ v: '恢复前保留' })
    expect(await editLeaseEpoch(id)).toBe(1)
    expect(reports).toHaveLength(2)
  })
})
