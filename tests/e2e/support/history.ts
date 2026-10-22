import type { Page } from '@playwright/test'
import type { Workbook } from './sheet.ts'
import { documentHistoryListResponseSchema } from '@nerve-office/contracts'
import sharp from 'sharp'
import { saveAssetSnapshot, uploadAsset } from './asset-protocol.ts'
import { createDocument, createUser, withDatabase } from './database.ts'
import { expect } from './fixtures.ts'
import { imageSample } from './image-sample.ts'
import { readOnlySampleFor, SAMPLE_SHEETS } from './read-only-sample.ts'
import { loginThroughApi } from './session.ts'
import { cellOf, savedContent, sheetCanvas } from './sheet.ts'

/** 存量文档首次正式保存采样；不改数据库时钟、小时占位或不可变历史。 */
export async function prepareHistory(page: Page, prefix: string) {
  const owner = await createUser(prefix)
  await loginThroughApi(page, owner)
  const asset = await uploadAsset(page)
  const documentId = await createDocument(owner, '历史图片与表格')
  const unitId = (await savedContent(page, documentId)).snapshot.id
  const snapshot = JSON.parse(imageSample(unitId, asset.url)) as { sheets: Record<string, { cellData: Record<string, Record<string, unknown>> }> }
  const cells = snapshot.sheets.images?.cellData
  const rich = cellOf(JSON.parse(readOnlySampleFor(unitId)) as Workbook, 'H2', SAMPLE_SHEETS.features.id)?.p
  if (cells === undefined || rich?.body === undefined)
    throw new Error('历史样本缺少 SDK 的图片工作表或链接结构')
  cells['10'] = { 0: { p: { ...rich, body: { ...rich.body, customRanges: rich.body.customRanges?.map(range => ({ ...range, properties: { ...range.properties, url: 'https://example.invalid/history' } })) } } } }
  cells['11'] = { 0: { v: '历史金额' }, 1: { v: 42, t: 2, s: { bg: { rgb: '#ffe699' }, bl: 1 } } }
  cells['12'] = { 0: { f: '=SUM(B12,8)', v: 50, t: 2 } }
  const text = JSON.stringify(snapshot)
  await saveAssetSnapshot(page, documentId, text)
  const response = await page.request.get(`/api/documents/${documentId}/history`)
  expect(response.status(), await response.text()).toBe(200)
  const history = documentHistoryListResponseSchema.parse(await response.json()).items.find(item => item.revision === 2)
  if (history === undefined)
    throw new Error('正式保存未生成修订 2 的小时历史')
  return { owner, asset, documentId, history, text }
}

/** 固定样本里 C3 的真实浮图；只观察公开画布截图，不依赖测试构建或 SDK 探针。 */
export async function expectHistoryImage(page: Page): Promise<void> {
  await expect.poll(async () => {
    const box = await sheetCanvas(page).boundingBox()
    if (box === null)
      return false
    const clip = { x: box.x + 46 + 2 * 80 + 4, y: box.y + 60 + 4, width: 112, height: 72 }
    const { data } = await sharp(await page.screenshot({ clip, scale: 'css' })).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    let red = 0
    let blue = 0
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] ?? 0
      const g = data[i + 1] ?? 0
      const b = data[i + 2] ?? 0
      if (r > 150 && g < 80 && b < 100)
        red += 1
      if (b > 100 && r < 100 && g < 150)
        blue += 1
    }
    return red > 10 && blue > 10
  }, { message: '历史/副本的实际画布应显示上传样本的红蓝像素' }).toBe(true)
}

/** 用合法 INSERT 布置未知格式，保留资源关系；不关闭不可变触发器、不 UPDATE 原记录。只用于未打开页面的独立测试数据。 */
export async function replaceHistoryFormat(historyId: string, formatVersion: number): Promise<void> {
  await withDatabase(async (client) => {
    await client.query('BEGIN')
    try {
      const row = (await client.query<{ data: Record<string, unknown> }>('SELECT to_jsonb(c) AS data FROM document_checkpoints c WHERE id = $1', [historyId])).rows[0]
      if (row === undefined)
        throw new Error('格式夹具找不到历史')
      const assets = (await client.query<{ asset_id: string }>('SELECT asset_id FROM document_checkpoint_assets WHERE checkpoint_id = $1', [historyId])).rows
      await client.query('DELETE FROM document_checkpoints WHERE id = $1', [historyId])
      await client.query('INSERT INTO document_checkpoints SELECT * FROM jsonb_populate_record(NULL::document_checkpoints, $1::jsonb)', [JSON.stringify({ ...row.data, format_version: formatVersion })])
      for (const asset of assets)
        await client.query('INSERT INTO document_checkpoint_assets (checkpoint_id, asset_id) VALUES ($1, $2)', [historyId, asset.asset_id])
      await client.query('COMMIT')
    }
    catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  })
}
