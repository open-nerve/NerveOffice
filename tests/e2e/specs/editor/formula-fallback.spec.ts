// US-M4-13：不依赖测试构建的 Worker 退路。相同用例运行于真实生产容器；结果以服务端正文和租约代次验收。
// 回归断点：去掉启动重试/运行期监听、丢掉未提交输入、换实例时重新申请租约、保存旧公式缓存，都会破坏下面的断言。
import type { Page, Request } from '@playwright/test'
import { CURRENT_CLIENT } from '../../support/client-format.ts'
import { createDocument, createUser, editLeaseEpoch, revisionOf, withDatabase } from '../../support/database.ts'
import { e2eOrigin } from '../../support/environment.ts'
import { expect, test } from '../../support/fixtures.ts'
import { expectFormulaCombination, formulaCombinationFor } from '../../support/formula-combination.ts'
import { blockFormulaWorker, failFormulaWorker, formulaRecoveryNotice } from '../../support/formula-worker-fault.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, EDITOR_TEST_TIMEOUT, enterEditing, exitEditing, expectFoundOnce, isSaveRequest, openAndEnterEditing, openReader, saveAndWait, savedContent, saveStatus, typeInCell, waitForEditorAccess } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

const READY = '公式已改用当前页面计算，大表格可能暂时卡顿。'

function traffic(page: Page, documentId: string) {
  const reports: Request[] = []
  const leases: string[] = []
  const saves: Request[] = []
  const external: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.protocol !== 'data:' && url.origin !== e2eOrigin())
      external.push(request.url())
    if (url.pathname === `/api/documents/${documentId}/open-check-failures` && request.method() === 'POST')
      reports.push(request)
    if (url.pathname === `/api/documents/${documentId}/edit-lease` && ['POST', 'DELETE'].includes(request.method()))
      leases.push(request.method())
    if (isSaveRequest(request))
      saves.push(request)
  })
  return { reports, leases, saves, external }
}

function expectedReport(failure: string, access: 'read' | 'edit', trigger: string, revision: number) {
  return {
    kind: 'formula-worker',
    failure,
    access,
    trigger,
    revision,
    ...CURRENT_CLIENT,
    clientBuild: expect.stringMatching(new RegExp(`^${CURRENT_CLIENT.clientBuild.replaceAll('.', '\\.')}(?:\\+[\\w.-]+)?$`)),
  }
}

async function formulasPending(documentId: string): Promise<boolean | undefined> {
  return withDatabase(async client => (await client.query<{ formulas_pending: boolean }>('SELECT formulas_pending FROM documents WHERE id = $1', [documentId])).rows[0]?.formulas_pending)
}

test('US-M4-13 启动脚本失败：自动改用主线程，阅读不申请租约，公式与 IMAGE 限制正确保存，重新打开仍保留内容', async ({ page }) => {
  const owner = await createUser('formula-start-fallback')
  await loginThroughApi(page, owner)
  const id = await createDocument(owner, 'formula-start-fallback', formulaCombinationFor)
  const recorded = traffic(page, id)
  const fault = await blockFormulaWorker(page)
  await openReader(page, id, 'steady')
  await expect(formulaRecoveryNotice(page)).toHaveText(READY)
  expect(fault.attempts(), '实际脚本请求被阻断').toBe(1)
  expect(recorded.leases).toEqual([])
  expect(recorded.saves).toEqual([])
  expect(await revisionOf(id)).toBe(1)
  await expect.poll(() => recorded.reports.length).toBe(1)
  expect(recorded.reports[0]?.postDataJSON()).toEqual(expectedReport('error-before-ready', 'read', 'open', 1))
  expect((await recorded.reports[0]?.response())?.status()).toBe(204)

  await enterEditing(page, 'steady')
  expect(fault.attempts(), '本页后续重建沿用主线程').toBe(1)
  expect(await editLeaseEpoch(id)).toBe(1)
  await typeInCell(page, 'A1', '20')
  await typeInCell(page, 'A2', '=A1+22')
  await typeInCell(page, 'B1', '=IMAGE("https://example.com/picture.png")')
  await typeInCell(page, 'C1', '退化后仍可保存')
  await saveAndWait(page)
  const saved = await savedContent(page, id)
  expect(cellOf(saved.snapshot, 'A2')).toMatchObject({ f: '=A1+22', v: 42 })
  expectFormulaCombination(saved.snapshot, 20, 42)
  expect(cellOf(saved.snapshot, 'B1')).toMatchObject({ v: '#VALUE!' })
  expect(cellOf(saved.snapshot, 'C1')).toMatchObject({ v: '退化后仍可保存' })
  expect(await formulasPending(id)).toBe(false)
  expect(recorded.external).toEqual([])
  expect(recorded.reports).toHaveLength(1)
  expect(recorded.leases).toEqual(['POST'])
  expect(page.workers().filter(worker => /\/formula\.worker-/.test(worker.url()))).toEqual([])

  await exitEditing(page, 'steady')
  const revision = await revisionOf(id)
  await page.reload()
  await waitForEditorAccess(page, 'read', 'steady')
  await expect(formulaRecoveryNotice(page)).toHaveText(READY)
  await expectFoundOnce(page, '退化后仍可保存')
  expect(fault.attempts()).toBe(2)
  expect(recorded.leases).toEqual(['POST', 'DELETE'])
  expect(await revisionOf(id)).toBe(revision)
  expect(cellOf((await savedContent(page, id)).snapshot, 'A2')).toMatchObject({ f: '=A1+22', v: 42 })
  expectFormulaCombination((await savedContent(page, id)).snapshot, 20, 42)
})

test('US-M4-13 运行期错误：离线时保留尚未提交的单元格，原租约恢复后保存重新计算的结果', async ({ page, context }) => {
  const owner = await createUser('formula-runtime')
  await loginThroughApi(page, owner)
  const id = await createDocument(owner, 'formula-runtime', formulaCombinationFor)
  const recorded = traffic(page, id)
  await openAndEnterEditing(page, id, 'steady')
  await typeInCell(page, 'A1', '20')
  await typeInCell(page, 'A2', '=A1+22')
  await saveAndWait(page)
  const before = await savedContent(page, id)
  expect(cellOf(before.snapshot, 'A2')).toMatchObject({ v: 42 })
  expectFormulaCombination(before.snapshot, 20, 42)
  expect(await editLeaseEpoch(id)).toBe(1)
  await context.setOffline(true)
  try {
    await expect.poll(async () => page.evaluate(() => navigator.onLine)).toBe(false)
    await typeInCell(page, 'A1', '37', false)
    const old = await failFormulaWorker(page)
    await expect(formulaRecoveryNotice(page)).toHaveText(READY)
    await waitForEditorAccess(page, 'edit', 'steady')
    expect(page.workers()).not.toContain(old)
    await expect(saveStatus(page)).not.toHaveText('已保存到云端')
    expect(await revisionOf(id), '离线不能把新正文写入服务器').toBe(before.revision)
    await expect.poll(() => recorded.reports.length).toBe(1)
    expect(recorded.reports[0]?.postDataJSON()).toEqual(expectedReport('error-after-ready', 'edit', 'formula-recovery', before.revision))
  }
  finally {
    await context.setOffline(false)
  }
  await saveAndWait(page)
  const saved = await savedContent(page, id)
  expect(cellOf(saved.snapshot, 'A1')).toMatchObject({ v: 37 })
  expect(cellOf(saved.snapshot, 'A2')).toMatchObject({ f: '=A1+22', v: 59 })
  expectFormulaCombination(saved.snapshot, 37, 59)
  expect(await formulasPending(id)).toBe(false)
  expect(await editLeaseEpoch(id)).toBe(1)
  expect(recorded.leases).toEqual(['POST'])
  expect(recorded.reports, '同一页首错只上报一次，离线失败不重发').toHaveLength(1)
  await exitEditing(page, 'steady')
  await page.reload()
  await waitForEditorAccess(page, 'read', 'steady')
  expect(cellOf((await savedContent(page, id)).snapshot, 'A2')).toMatchObject({ f: '=A1+22', v: 59 })
  expectFormulaCombination((await savedContent(page, id)).snapshot, 37, 59)
})
