// 故障只改上行的自制快照，真实 API 决定拒绝与位置；不是伪造错误响应。
// 本页模型保留正常输入，撤去故障后从同页再次保存，证明拒绝没有丢掉用户修改。
import type { Route } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { gunzipSync, gzipSync } from 'node:zlib'
import { createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, expectFoundOnce, isSaveRequest, openAndEnterEditing, saveAndWait, saveButton, savedContent, typeInCell } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

function corruptLink(ranges: unknown, onCorrupt: () => void): (route: Route) => Promise<void> {
  return async (route) => {
    const request = route.request()
    if (!isSaveRequest(request)) {
      await route.continue()
      return
    }
    const body = request.postDataBuffer()
    if (!body)
      throw new Error('真实保存缺少正文')
    const snapshot = JSON.parse(gunzipSync(body).toString('utf8')) as { sheets: Record<string, { cellData: Record<string, Record<string, unknown>> }> }
    const sheet = snapshot.sheets['sheet-1']
    if (!sheet)
      throw new Error('真实快照缺少工作表')
    sheet.cellData['2'] = { ...sheet.cellData['2'], 1: { p: { body: { dataStream: 'private display\r\n', customRanges: ranges } } } }
    const headers = await request.allHeaders()
    delete headers['content-length']
    onCorrupt()
    await route.continue({ headers, postData: gzipSync(Buffer.from(JSON.stringify(snapshot))) })
  }
}

test('US-M5-08 三种链接保存拒绝指出 B3，原正文和本页修改保留，撤去故障后可继续保存', async ({ page }) => {
  await loginThroughApi(page, await createUser('link-locations'))
  const documentId = await createSheetThroughApi(page)
  await openAndEnterEditing(page, documentId, 'steady')
  const badRange = (url: string, rangeId: string) => [{ rangeType: 0, rangeId, startIndex: 0, endIndex: 2, properties: { url } }]
  const cases = [
    { rule: 'link-address', ranges: badRange('https://private.example', 'link1') },
    { rule: 'link-range-id', ranges: badRange('https://private.example/', 'bad id') },
    { rule: 'link-structure', ranges: 'private display text' },
  ]
  for (const { rule, ranges } of cases) {
    await test.step(rule, async () => {
      const original = await savedContent(page, documentId)
      const sheetName = original.snapshot.sheets['sheet-1']?.name
      expect(sheetName).toBeTruthy()
      const pattern = `**/api/documents/${documentId}/content?*`
      let corrupted = 0
      const handler = corruptLink(ranges, () => {
        corrupted += 1
      })
      await page.route(pattern, handler)
      try {
        const responsePromise = page.waitForResponse(response => isSaveRequest(response.request()) && response.status() === 422)
        const text = `保留的修改-${rule}`
        await typeInCell(page, 'B3', text)
        await saveButton(page).click()
        const response = await responsePromise
        const body = await response.text()
        expect(JSON.parse(body)).toMatchObject({ error: {
          code: 'SNAPSHOT_INVALID',
          details: { rule, linkLocations: [{ kind: 'cell', sheetId: 'sheet-1', row: 2, column: 1 }] },
        } })
        expect(corrupted).toBeGreaterThan(0)
        expect(body).not.toMatch(/private|保留的修改/)
        await expect(page.getByText(`保存失败：表格里有不能保存的链接。请检查：工作表「${sheetName}」的 B3`, { exact: true })).toBeVisible()
        expect(await savedContent(page, documentId)).toEqual(original)
        await expectFoundOnce(page, text)
        await page.unroute(pattern, handler)
        await saveAndWait(page)
        const saved = await savedContent(page, documentId)
        expect(saved.revision).toBe(original.revision + 1)
        expect(cellOf(saved.snapshot, 'B3')?.v).toBe(text)
      }
      finally {
        await page.unroute(pattern, handler)
      }
    })
  }
})
