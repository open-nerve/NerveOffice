import type { Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { probeSnapshot } from '../../support/editor-probe.ts'
import { expect, test } from '../../support/fixtures.ts'
import { drawingsIn, prepareImageDocument } from '../../support/image-editor.ts'
import { EDITOR_TEST_TIMEOUT, enterEditing, exitEditing, sheetCanvas, waitForEditorAccess } from '../../support/sheet.ts'

interface Recording {
  identity: { pageId: string, method: string }
  complete: boolean
  records: { seq: number, type: string, sha256?: string, inputSequence?: number, value?: { snapshot: unknown } }[]
}

async function report(page: Page): Promise<Recording> {
  return JSON.parse(await page.locator('[data-slot="image-input-test-record"]').innerText()) as Recording
}

test('原生记录器的合成校准：事件、摘要、正式插入与重建身份对应，不能当成原生通过', { tag: '@test-build' }, async ({ page }, info) => {
  test.setTimeout(EDITOR_TEST_TIMEOUT)
  const { documentId } = await prepareImageDocument(page)
  await page.goto(`/documents/${documentId}?imageInput=enabled&nativeImageRun=calibration&nativeImageCase=synthetic-paste`)
  await waitForEditorAccess(page, 'read', 'steady')
  await enterEditing(page, 'steady')
  await expect(page.getByRole('button', { name: '开始记录受控样本', exact: true })).toBeVisible()
  expect((await report(page)).records).toEqual([])
  await sheetCanvas(page).click({ position: { x: 180, y: 100 } })
  await page.getByRole('button', { name: '开始记录受控样本', exact: true }).click()
  await page.getByRole('button', { name: '记录当前状态', exact: true }).click()
  const original = await report(page)
  const initialCount = Object.keys(drawingsIn(await probeSnapshot(page))).length
  const bytes = await readFile(new URL('../../../../apps/api/src/modules/assets/testdata/rgba-text.png', import.meta.url))
  await sheetCanvas(page).evaluate((canvas, bytes) => {
    const data = new DataTransfer()
    data.items.add(new File([new Uint8Array(bytes)], 'calibration.png', { type: 'image/png' }))
    canvas.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
  }, Array.from(bytes))
  await expect(page.locator('[data-slot="image-operation"]')).toHaveText('粘贴已完成。已插入 1/1 张图片。')
  await expect.poll(async () => (await report(page)).records.some(item => item.type === 'file-digest')).toBe(true)
  await page.getByRole('button', { name: '记录当前状态', exact: true }).click()
  const completed = await report(page)
  expect(completed.complete).toBe(true)
  expect(completed.identity).toEqual(original.identity)
  expect(completed.identity.method).toBe('observed-events')
  const input = completed.records.find(item => item.type === 'paste')
  expect(input).toMatchObject({ isTrusted: false, defaultPrevented: false, files: [{ type: 'image/png', size: bytes.length }] })
  expect(completed.records).toContainEqual(expect.objectContaining({ type: 'file-digest', inputSequence: input?.seq, sha256: createHash('sha256').update(bytes).digest('hex') }))
  expect(completed.records).toContainEqual(expect.objectContaining({ type: 'event-settled', inputSequence: input?.seq, defaultPrevented: true }))
  const recordedSnapshot = completed.records.filter(item => item.type === 'state').at(-1)?.value?.snapshot
  expect(drawingsIn(JSON.stringify(recordedSnapshot))).toEqual(drawingsIn(await probeSnapshot(page)))
  expect(Object.keys(drawingsIn(await probeSnapshot(page)))).toHaveLength(initialCount + 1)
  await info.attach('synthetic-recording.json', { body: JSON.stringify(completed, null, 2), contentType: 'application/json' })
  await exitEditing(page, 'steady')
  const rebuilt = await report(page)
  expect(rebuilt.identity.pageId).not.toBe(original.identity.pageId)
  expect(rebuilt.records).toEqual([])
})
