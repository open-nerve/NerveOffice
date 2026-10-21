import type { Page } from '@playwright/test'
import { sheetSnapshotFor } from '@nerve-office/contracts'
import { FORMULA_MODE_PARAM, FORMULA_MODE_VALUES } from '../../../../apps/web/src/editor/testing/selftest-report.ts'
import { createDocument, createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { readOnlySampleFor } from '../../support/read-only-sample.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, EDITOR_TEST_TIMEOUT, enterEditing, exitEditing, savedContent, waitForEditorAccess } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

interface IdleGate {
  hold: () => void
  release: () => number
  stats: () => { pending: number, scheduled: number, canceled: number }
}

declare global {
  interface Window {
    __nerveDvIdleGate?: IdleGate
  }
}

/** 只控制浏览器调度边界，不替换校验服务；所有任务恢复后按原回调运行，异常照常暴露。 */
function installIdleGate() {
  const nativeRequest = window.requestIdleCallback?.bind(window) ?? ((callback: IdleRequestCallback) => window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 10 }), 1))
  const nativeCancel = window.cancelIdleCallback?.bind(window) ?? window.clearTimeout.bind(window)
  const pending = new Map<number, IdleRequestCallback>()
  let next = -1
  let holding = true
  let scheduled = 0
  let canceled = 0
  window.requestIdleCallback = (callback, options) => {
    if (!holding)
      return nativeRequest(callback, options)
    const handle = next--
    pending.set(handle, callback)
    scheduled++
    return handle
  }
  window.cancelIdleCallback = (handle) => {
    if (pending.delete(handle))
      canceled++
    else
      nativeCancel(handle)
  }
  window.__nerveDvIdleGate = {
    hold: () => { holding = true },
    release: () => {
      holding = false
      const callbacks = [...pending.values()]
      pending.clear()
      for (const callback of callbacks)
        callback({ didTimeout: false, timeRemaining: () => 10 })
      return callbacks.length
    },
    stats: () => ({ pending: pending.size, scheduled, canceled }),
  }
}

function sample(unitId: string): string {
  const snapshot = JSON.parse(sheetSnapshotFor(unitId)) as {
    sheetOrder: string[]
    sheets: Record<string, unknown>
    resources: { name: string, data: string }[]
  }
  snapshot.sheetOrder.push('dv-other')
  snapshot.sheets['dv-other'] = { id: 'dv-other', name: '校验表', rowCount: 100, columnCount: 26, cellData: { 0: { 0: { v: 5 } } } }
  const resource = snapshot.resources.find(item => item.name === 'SHEET_DATA_VALIDATION_PLUGIN')!
  resource.data = JSON.stringify({ 'dv-other': [{ uid: 'dv1', type: 'decimal', operator: 'between', formula1: '1', formula2: '10', allowBlank: true, showErrorMessage: false, ranges: [{ startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 }] }] })
  return JSON.stringify(snapshot)
}

async function status(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const workbook = window.__nerveEditorProbe!.univerAPI.getActiveWorkbook() as unknown as {
      getValidatorStatus: () => Promise<Record<string, { getValue: (row: number, col: number) => string | undefined }>>
    }
    const result = await workbook.getValidatorStatus()
    return result['dv-other']!.getValue(0, 0) ?? 'valid'
  })
}

test.describe('US-M5-04 数据验证实例退役', { tag: '@test-build' }, () => {
  for (const mode of ['worker', 'main-thread'] as const) {
    const query = mode === 'worker' ? '' : `?${new URLSearchParams({ [FORMULA_MODE_PARAM]: FORMULA_MODE_VALUES['main-thread'] })}`

    test(`${mode}：初始与后续非当前表校验排队时重建，旧任务取消，新实例仍校验并保留保存内容`, async ({ page }, testInfo) => {
      const owner = await createUser('dv-lifecycle')
      const id = await createDocument(owner, '数据校验退役', sample)
      await loginThroughApi(page, owner)
      await page.addInitScript(installIdleGate)
      await page.goto(`/documents/${id}${query}`)
      await waitForEditorAccess(page, 'read')
      expect(await page.evaluate(() => window.__nerveEditorProbe!.formulaMode)).toBe(mode)
      const first = await page.evaluate(() => window.__nerveDvIdleGate!.stats())
      expect(first.pending).toBeGreaterThan(0)
      await enterEditing(page)
      const rebuilt = await page.evaluate(() => window.__nerveDvIdleGate!.stats())
      expect(rebuilt.canceled).toBeGreaterThan(first.canceled)
      await page.evaluate(() => window.__nerveDvIdleGate!.release())
      await waitForEditorAccess(page, 'edit', 'steady')
      expect(await status(page)).toBe('valid')
      await page.evaluate(() => {
        window.__nerveDvIdleGate!.hold()
        // 准备非当前表脏区，实际 Facade 命令与保存路径照常执行。
        window.__nerveEditorProbe!.univerAPI.getActiveWorkbook().getSheetByName('校验表').getRange('A1').setValue(20)
      })
      await expect.poll(async () => page.evaluate(() => window.__nerveDvIdleGate!.stats().pending)).toBeGreaterThan(0)
      const dirty = await page.evaluate(() => window.__nerveDvIdleGate!.stats())
      await exitEditing(page)
      const retired = await page.evaluate(() => window.__nerveDvIdleGate!.stats())
      expect(retired.canceled).toBeGreaterThan(dirty.canceled)
      await page.evaluate(() => window.__nerveDvIdleGate!.release())
      await waitForEditorAccess(page, 'read', 'steady')
      expect(await status(page)).toBe('invalid')
      expect(cellOf((await savedContent(page, id)).snapshot, 'A1', 'dv-other')?.v).toBe(20)
      await testInfo.attach('实际空闲任务与取消', { body: JSON.stringify({ mode, first, rebuilt, dirty, retired }), contentType: 'application/json' })
    })

    test(`${mode}：默认表格插件在 Ready 前构造失败只报告原始错误，后续综合文档正常就绪`, async ({ page, pageErrors }) => {
      const owner = await createUser('dv-ready')
      const brokenId = await createDocument(owner, 'Ready 失败', (unitId) => {
        const snapshot = JSON.parse(readOnlySampleFor(unitId)) as { sheets: Record<string, unknown> }
        snapshot.sheets['sheet-1'] = null
        return JSON.stringify(snapshot)
      })
      const validId = await createDocument(owner, 'Ready 正常', readOnlySampleFor)
      await loginThroughApi(page, owner)
      pageErrors.expectErrors()
      await page.goto(`/documents/${brokenId}${query}`)
      const brokenUrl = page.url()
      await expect(page.getByText('编辑器加载失败，请刷新页面重试', { exact: true })).toBeVisible()
      await page.goto(`/documents/${validId}${query}`)
      await waitForEditorAccess(page, 'read', 'steady')
      expect(await page.evaluate(() => window.__nerveEditorProbe!.formulaMode)).toBe(mode)
      await enterEditing(page, 'steady')
      expect(pageErrors.list()).toEqual([`SheetEditorLoadError: 用快照创建工作簿时出错（${brokenUrl}）`])
    })
  }
})
