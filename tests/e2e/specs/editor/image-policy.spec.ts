import type { Page } from '@playwright/test'
import type { Workbook } from '../../support/sheet.ts'
import { Buffer } from 'node:buffer'
import { gunzipSync, gzipSync } from 'node:zlib'
import { FORMULA_MODE_PARAM, FORMULA_MODE_VALUES } from '../../../../apps/web/src/editor/testing/selftest-report.ts'
import { saveAssetSnapshot, uploadAsset } from '../../support/asset-protocol.ts'
import { createUser } from '../../support/database.ts'
import { probeChangeSeq, probeFormulaMode, probeFormulasSettled, probeSnapshot, setCellValue } from '../../support/editor-probe.ts'
import { expect, test } from '../../support/fixtures.ts'
import { drawingsIn, expectImagePixels, imageFailureSentinel, imagePixels, prepareImageDocument } from '../../support/image-editor.ts'
import { imageSample } from '../../support/image-sample.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, enterEditing, exitEditing, isSaveRequest, openAndEnterEditing, reloadAndEnterEditing, saveAndWait, saveButton, savedContent, waitForEditorAccess } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

const REJECTED_CELLS = ['B1', 'C1', 'D1', 'E1', 'F1', 'G1']

/** 首次打开只含非法来源公式，没有任何可先读取该地址的合法图片，避免缓存掩盖来源检查。 */
async function prepareFormulaDocument(page: Page) {
  await loginThroughApi(page, await createUser('image-provenance'))
  const asset = await uploadAsset(page)
  const documentId = await createSheetThroughApi(page, 'IMAGE 来源证明')
  const unitId = (await savedContent(page, documentId)).snapshot.id
  const snapshot = JSON.parse(imageSample(unitId, asset.url)) as {
    sheets: Record<string, { cellData: Record<string, Record<string, { v?: string, f?: string }>> }>
    resources: { name: string, data: string }[]
  }
  const sheet = snapshot.sheets.images
  if (!sheet)
    throw new Error('图片样本缺少工作表')
  const id = asset.url.slice('/api/assets/'.length)
  sheet.cellData = {
    0: {
      0: { v: asset.url },
      1: { f: `=IMAGE("/api/assets/"&"${id}")` },
      2: { f: '=IMAGE(A1)' },
      3: { f: `=IMAGE(CONCAT("/api/assets/","${id}"))` },
      4: { f: `=IMAGE({"${asset.url}"})` },
      5: { f: '=IMAGE(IF(TRUE,A1,A1))' },
      6: { f: '=IMAGE(LEFT(A1,LEN(A1)))' },
    },
    1: { 1: { f: '=IF(FALSE,IMAGE(A1),123)' } },
  }
  snapshot.resources = snapshot.resources.map(resource => resource.name === 'SHEET_DRAWING_PLUGIN' ? { ...resource, data: '{}' } : resource)
  await saveAssetSnapshot(page, documentId, JSON.stringify(snapshot))
  return { asset, documentId }
}

async function expectRejectedFormulas(page: Page) {
  await expect.poll(async () => probeFormulasSettled(page)).toBe(true)
  await expect.poll(async () => {
    const snapshot = JSON.parse(await probeSnapshot(page)) as Workbook
    return REJECTED_CELLS.map(a1 => cellOf(snapshot, a1)?.v)
  }).toEqual(REJECTED_CELLS.map(() => '#VALUE!'))
  expect(cellOf(JSON.parse(await probeSnapshot(page)) as Workbook, 'B2')?.v).toBe(123)
}

test.describe('图片来源、写入边界与保存位置', { tag: '@test-build' }, () => {
  for (const mode of ['worker', 'main-thread'] as const) {
    test(`${mode}：首次打开非法 IMAGE 来源零读取，字面量与参数尺寸在重开后保持`, async ({ page }, testInfo) => {
      const { asset, documentId } = await prepareFormulaDocument(page)
      let reads = 0
      page.on('request', (request) => {
        if (request.method() === 'GET' && new URL(request.url()).pathname === asset.url)
          reads += 1
      })
      await page.goto(`/documents/${documentId}?${new URLSearchParams({ [FORMULA_MODE_PARAM]: FORMULA_MODE_VALUES[mode] })}`)
      await waitForEditorAccess(page, 'read', 'steady')
      expect(await probeFormulaMode(page)).toBe(mode)
      await expectRejectedFormulas(page)
      expect(reads).toBe(0)
      await enterEditing(page, 'steady')
      await expectRejectedFormulas(page)
      expect(reads).toBe(0)

      // 固定 SDK 的参数为 source、altText、sizing、height、width；3 为自定义尺寸，0 为适应单元格。
      await setCellValue(page, 'G8', `=IMAGE("${asset.url}","",3,60,70)`)
      await setCellValue(page, 'H8', `=IMAGE("${new URL(asset.url, page.url()).href}","",0)`)
      await expectImagePixels(page, 'G8')
      await expectImagePixels(page, 'H8')
      expect(reads).toBeGreaterThan(0)
      const before = await imagePixels(page, 'G8')
      await saveAndWait(page)
      await exitEditing(page, 'steady')
      await page.reload()
      await waitForEditorAccess(page, 'read', 'steady')
      await expectRejectedFormulas(page)
      await enterEditing(page, 'steady')
      expect(await probeFormulaMode(page)).toBe(mode)
      await expectRejectedFormulas(page)
      await expectImagePixels(page, 'G8')
      await expectImagePixels(page, 'H8')
      const after = await imagePixels(page, 'G8')
      expect({ width: after.imageWidth, height: after.imageHeight }).toEqual({ width: before.imageWidth, height: before.imageHeight })
      await testInfo.attach('来源与重开尺寸', { body: JSON.stringify({ mode, reads, before, after }), contentType: 'application/json' })
      await imageFailureSentinel(page, documentId, `${mode} 来源检查后的编辑保存`)
    })
  }

  test('实际图片命令整批拒绝非法来源，同源绝对地址规范化且撤销重做和重开稳定', async ({ page }) => {
    const { asset, documentId } = await prepareImageDocument(page)
    const replacement = await uploadAsset(page, 'palette.png')
    let replacementReads = 0
    page.on('request', (request) => {
      if (request.method() === 'GET' && new URL(request.url()).pathname === replacement.url)
        replacementReads += 1
    })
    await openAndEnterEditing(page, documentId, 'steady')
    await expectImagePixels(page, 'C3')
    await expect.poll(async () => probeFormulasSettled(page)).toBe(true)
    const before = drawingsIn(await probeSnapshot(page))
    const sequence = await probeChangeSeq(page)
    const replace = async (mixed: boolean) => page.evaluate(async ({ source, mixed }) => {
      const probe = window.__nerveEditorProbe
      if (!probe)
        throw new Error('没有编辑器探针')
      const snapshot = JSON.parse(probe.snapshot()) as { id: string, resources: { name: string, data: string }[] }
      const resource = snapshot.resources.find(item => item.name === 'SHEET_DRAWING_PLUGIN')
      if (!resource)
        throw new Error('没有实际图片模型')
      const images = (JSON.parse(resource.data) as { images: { data: Record<string, object> } }).images.data
      // 独立命令 payload；不调用会在命令前修改模型的 FOverGridImage.setSource。
      const drawings = [{ ...images.first, source, base64Cache: source }]
      if (mixed)
        drawings.push({ ...images.second, source: 'https://example.invalid/private-image', base64Cache: 'https://example.invalid/private-image' })
      return probe.univerAPI.executeCommand('sheet.command.set-sheet-image', { unitId: snapshot.id, drawings })
    }, { source: new URL(replacement.url, page.url()).href, mixed })

    expect(await replace(true)).toBe(false)
    expect(drawingsIn(await probeSnapshot(page))).toEqual(before)
    expect(await probeChangeSeq(page)).toBe(sequence)
    expect(replacementReads).toBe(0)
    expect(await replace(false)).toBe(true)
    await expect.poll(async () => drawingsIn(await probeSnapshot(page)).first).toMatchObject({ source: replacement.url, base64Cache: replacement.url })
    await expect.poll(() => replacementReads).toBeGreaterThan(0)
    expect(await page.evaluate(async () => window.__nerveEditorProbe?.univerAPI.executeCommand('univer.command.undo'))).toBe(true)
    expect(drawingsIn(await probeSnapshot(page)).first?.source).toBe(asset.url)
    expect(await page.evaluate(async () => window.__nerveEditorProbe?.univerAPI.executeCommand('univer.command.redo'))).toBe(true)
    expect(drawingsIn(await probeSnapshot(page)).first?.source).toBe(replacement.url)
    await imageFailureSentinel(page, documentId, '整批拒绝后仍能保存')
    const changed = drawingsIn(await probeSnapshot(page))
    await exitEditing(page, 'steady')
    await reloadAndEnterEditing(page, 'steady')
    expect(drawingsIn(await probeSnapshot(page))).toEqual(changed)
    await expectImagePixels(page, 'F3')
  })

  test('真实后端拒绝的图片错误显示工作表与单元格，修正后保存不受影响', async ({ page }) => {
    const { documentId } = await prepareImageDocument(page)
    await openAndEnterEditing(page, documentId, 'steady')
    await expectImagePixels(page, 'D8')
    const original = await savedContent(page, documentId)
    const invalid = 'https://example.invalid/private-content-marker'
    const path = `**/api/documents/${documentId}/content?**`
    // 只在传输处损坏一份真实上传正文，再送给真实后端；没有伪造错误响应或绕开后端检查。
    await page.route(path, async (route) => {
      const request = route.request()
      if (!isSaveRequest(request)) {
        await route.continue()
        return
      }
      const body = request.postDataBuffer()
      if (!body)
        throw new Error('真实保存缺少正文')
      const snapshot = JSON.parse(gunzipSync(body).toString('utf8')) as { sheets: Record<string, { cellData: Record<string, Record<string, unknown>> }> }
      const sheet = snapshot.sheets.images
      if (!sheet)
        throw new Error('实际快照缺少工作表')
      sheet.cellData['2'] = { ...sheet.cellData['2'], 1: { p: { source: invalid } } }
      const headers = await request.allHeaders()
      delete headers['content-length']
      await route.continue({ headers, postData: gzipSync(Buffer.from(JSON.stringify(snapshot))) })
    })
    await setCellValue(page, 'J12', '服务端位置错误前的修改')
    const rejected = page.waitForResponse(response => isSaveRequest(response.request()))
    await saveButton(page).click()
    const response = await rejected
    expect(response.status()).toBe(422)
    const body = await response.text()
    expect(JSON.parse(body)).toMatchObject({ error: { code: 'SNAPSHOT_INVALID', details: { rule: 'image-source', imageLocations: [{ kind: 'cell', sheetId: 'images', row: 2, column: 1 }] } } })
    expect(body).not.toContain(invalid)
    expect(body).not.toContain('图片复核')
    await expect(page.getByText('保存失败：表格里有不能保存的图片。请检查：工作表「图片复核」的 B3', { exact: true })).toBeVisible()
    expect(await savedContent(page, documentId)).toEqual(original)
    await page.unroute(path)
    await imageFailureSentinel(page, documentId, '修正图片来源后的真实保存')
    expect((await savedContent(page, documentId)).revision).toBe(original.revision + 1)
  })
})
