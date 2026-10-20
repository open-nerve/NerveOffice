import type { Page } from '@playwright/test'
import sharp from 'sharp'
import { saveAssetSnapshot, uploadAsset } from './asset-protocol.ts'
import { formulaSampleFor } from './capture-samples.ts'
import { createUser } from './database.ts'
import { probeSnapshot, setCellValue } from './editor-probe.ts'
import { expect } from './fixtures.ts'
import { imageSample } from './image-sample.ts'
import { loginThroughApi } from './session.ts'
import { createSheetThroughApi, saveAndWait, savedContent, sheetCanvas } from './sheet.ts'

export async function prepareImageDocument(page: Page, options: { secondAnchor?: '0' | '1', includeFormulas?: boolean, portrait?: boolean } = {}) {
  const owner = await createUser('sdk-images')
  await loginThroughApi(page, owner)
  const asset = options.portrait ? await uploadAsset(page, 'orientation.jpg', 'image/jpeg', 'jpg') : await uploadAsset(page)
  const documentId = await createSheetThroughApi(page, '图片实例浏览器复核')
  const unitId = (await savedContent(page, documentId)).snapshot.id
  let snapshot = imageSample(unitId, asset.url, options.secondAnchor)
  if (options.includeFormulas) {
    const images = JSON.parse(snapshot) as { sheetOrder: string[], sheets: Record<string, unknown> }
    const formulas = JSON.parse(formulaSampleFor(unitId)) as { sheetOrder: string[], sheets: Record<string, unknown> }
    images.sheetOrder.push(...formulas.sheetOrder)
    Object.assign(images.sheets, formulas.sheets)
    snapshot = JSON.stringify(images)
  }
  await saveAssetSnapshot(page, documentId, snapshot)
  return { asset, documentId, owner }
}

export interface ImageDrawing {
  readonly source: string
  readonly transform: { left: number, top: number, width: number, height: number }
  readonly sheetTransform: { from: { row: number, column: number }, to: { row: number, column: number } }
  readonly axisAlignSheetTransform: ImageDrawing['sheetTransform']
}

export function drawingsIn(snapshot: string): Record<string, ImageDrawing> {
  const parsed = JSON.parse(snapshot) as { resources: { name: string, data: string }[] }
  const resource = parsed.resources.find(item => item.name === 'SHEET_DRAWING_PLUGIN')
  if (!resource)
    throw new Error('快照里没有图片资源')
  return (JSON.parse(resource.data) as { images: { data: Record<string, ImageDrawing> } }).images.data
}

/** 分析浏览器实际截图；WebKit 的 SDK 空表画布已禁止 getImageData，不能用画布读回代替可见像素。 */
export async function imagePixels(page: Page, a1: string): Promise<{ red: number, blue: number, ink: number, imageWidth: number, imageHeight: number }> {
  const clip = await sheetCanvas(page).evaluate((canvas: HTMLCanvasElement, a1) => {
    const sheet = window.__nerveEditorProbe?.univerAPI.getActiveWorkbook().getActiveSheet()
    if (!sheet)
      throw new Error('没有实际编辑器')
    const rect = sheet.getRange(a1).getCell()
    const canvasBox = canvas.getBoundingClientRect()
    return { x: canvasBox.x + rect.startX + 2, y: canvasBox.y + rect.startY + 2, width: rect.endX - rect.startX - 4, height: rect.endY - rect.startY - 4 }
  }, a1)
  const { data, info } = await sharp(await page.screenshot({ clip, scale: 'css' })).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let red = 0
  let blue = 0
  let ink = 0
  let minX = info.width
  let maxX = -1
  let minY = info.height
  let maxY = -1
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0
    const g = data[i + 1] ?? 0
    const b = data[i + 2] ?? 0
    if (r > 150 && g < 80 && b < 100)
      red += 1
    if (b > 100 && r < 100 && g < 150)
      blue += 1
    if (r < 100 && g < 100 && b < 100)
      ink += 1
    if ((r > 150 && g < 80 && b < 100) || (b > 100 && r < 100 && g < 150)) {
      const x = (i / 4) % info.width
      const y = Math.floor(i / 4 / info.width)
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
    }
  }
  return { red, blue, ink, imageWidth: maxX < 0 ? 0 : maxX - minX + 1, imageHeight: maxY < 0 ? 0 : maxY - minY + 1 }
}

export async function expectImagePixels(page: Page, a1: string, present = true): Promise<void> {
  await expect.poll(async () => {
    const pixels = await imagePixels(page, a1)
    return present ? pixels.red > 10 && pixels.blue > 10 : pixels.red === 0 && pixels.blue === 0
  }, { message: `${a1} 的真实图片像素应${present ? '可见' : '被清除'}` }).toBe(true)
}

/** 故障之后继续走真正的编辑、绘制和保存捕获，不只看页面没有报错。 */
export async function imageFailureSentinel(page: Page, documentId: string, value: string): Promise<void> {
  await setCellValue(page, 'J12', value)
  await expect.poll(async () => (await imagePixels(page, 'J12')).ink).toBeGreaterThan(10)
  await saveAndWait(page)
  const snapshot = await probeSnapshot(page)
  expect(snapshot).toContain(value)
  expect(snapshot).not.toMatch(/blob:|data:image/)
  const saved = await savedContent(page, documentId)
  expect(JSON.stringify(saved.snapshot)).toContain(value)
  expect(await sheetCanvas(page).screenshot()).not.toHaveLength(0)
}
