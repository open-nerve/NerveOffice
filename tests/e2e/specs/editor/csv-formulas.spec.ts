// 实际公式计算和真实下载；生产容器也运行，不注入 SDK 结果或使用探针。
import type { Page } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { CSV_FORMULA_SHEET, csvFormulaSampleFor, downloadCsv } from '../../support/csv.ts'
import { createDocument, createUser, withDatabase } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { blockFormulaWorker, formulaRecoveryNotice } from '../../support/formula-worker-fault.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, EDITOR_TEST_TIMEOUT, openAndEnterEditing, saveAndWait, savedContent } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

const EXPECTED = Buffer.from('\uFEFF"1","2","3","1,234.50","2024-01-01","\t =1+2","行一\n""行二""","-12.5"\r\n"4","5","6","","","","",""\r\n', 'utf8')
const READY = '公式已改用当前页面计算，大表格可能暂时卡顿。'

const modes = [
  { name: 'Worker', setup: async (_page: Page) => ({ attempts: () => 0 }), attempts: 0, workers: 1, notice: [] },
  { name: '启动失败后主线程', setup: blockFormulaWorker, attempts: 1, workers: 0, notice: [READY] },
]

for (const mode of modes) {
  test(`US-M5-12 ${mode.name} 实际重算数组公式，导出完整溢出及格式显示值，正文不被下载修改`, async ({ page }) => {
    const user = await createUser('csv-formulas')
    await loginThroughApi(page, user)
    const id = await createDocument(user, 'CSV公式导出', csvFormulaSampleFor)
    const marked = await withDatabase(async client => client.query('UPDATE documents SET formulas_pending = true WHERE id = $1', [id]))
    expect(marked.rowCount).toBe(1)
    const original = await savedContent(page, id)
    expect(cellOf(original.snapshot, 'A1')).toMatchObject({ f: '=SEQUENCE(2,3)', v: 999 })
    expect(cellOf(original.snapshot, 'B1')).toBeUndefined()
    const fault = await mode.setup(page)
    await openAndEnterEditing(page, id, 'steady')
    await expect(formulaRecoveryNotice(page)).toHaveText(mode.notice)
    expect(fault.attempts()).toBe(mode.attempts)
    expect(page.workers().filter(worker => /\/formula\.worker-/.test(worker.url()))).toHaveLength(mode.workers)
    await saveAndWait(page)
    const before = await savedContent(page, id)
    expect(cellOf(before.snapshot, 'A1')).toMatchObject({ f: '=SEQUENCE(2,3)', v: 1 })
    const downloaded = await downloadCsv(page, CSV_FORMULA_SHEET)
    expect(downloaded.name).toBe('CSV公式导出-CSV计算样本.csv')
    expect(downloaded.bytes).toEqual(EXPECTED)
    expect(await savedContent(page, id)).toEqual(before)
  })
}
