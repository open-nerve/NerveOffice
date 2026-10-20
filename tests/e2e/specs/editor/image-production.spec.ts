// 普通产品 URL 和公开界面，不依赖 editor probe、测试面板或输入开关；容器也执行。
import type { Page, Route } from '@playwright/test'
import type { Buffer } from 'node:buffer'
import type { Workbook } from '../../support/sheet.ts'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { SHEET_TEMPLATE } from '@nerve-office/contracts'
import sharp from 'sharp'
import { createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { pressUniverShortcut } from '../../support/keyboard.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, enterEditing, exitEditing, openAndEnterEditing, reloadAndEnterEditing, resourceOf, ribbon, saveAndCapture, saveAndWait, savedContent, selectCell, sheetCanvas, typeInCell, waitForEditorAccess } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

const files = ['rgba-text.png', 'orientation.jpg', 'static.webp', 'single.gif'] as const
const sample = (name: string): string => fileURLToPath(new URL(`../../../../apps/api/src/modules/assets/testdata/${name}`, import.meta.url))
const operation = (page: Page) => page.locator('[data-slot="image-operation"]')
const locations = ['A1', 'D1', 'G1', 'J1'] as const
const geometry = SHEET_TEMPLATE.sheets['sheet-1']

interface Drawing {
  readonly source: string
  readonly transform: { readonly width: number, readonly height: number }
  readonly sheetTransform?: { readonly from: { readonly row: number, readonly column: number } }
}

/** 直接检查服务器模型；单元格图必须在目标格富文本里，浮图必须在对应工作表绘图资源里。 */
function imageAt(snapshot: Workbook, kind: 'float' | 'cell', index: number): Drawing {
  const sheetId = snapshot.sheetOrder[0]!
  const floats = (resourceOf(snapshot, 'SHEET_DRAWING_PLUGIN') as Record<string, { data: Record<string, Drawing> }> | undefined)?.[sheetId]?.data ?? {}
  const document = cellOf(snapshot, locations[index]!)?.p as { drawingsOrder: string[], drawings: Record<string, Drawing> } | undefined
  let drawing: Drawing
  if (kind === 'float') {
    expect(document).toBeUndefined()
    const matches = Object.values(floats).filter(value => value.sheetTransform?.from.row === 0 && value.sheetTransform.from.column === index * 3)
    expect(matches).toHaveLength(1)
    drawing = matches[0]!
    expect(drawing).toMatchObject({ unitId: snapshot.id, subUnitId: sheetId, sheetTransform: { from: { row: 0, column: index * 3, rowOffset: 0, columnOffset: 0 } } })
  }
  else {
    expect(Object.keys(floats)).toHaveLength(0)
    expect(document?.drawingsOrder).toHaveLength(1)
    expect(Object.keys(document!.drawings)).toEqual(document!.drawingsOrder)
    drawing = document!.drawings[document!.drawingsOrder[0]!]!
    expect(document).toMatchObject({ body: { customBlocks: [{ blockId: document!.drawingsOrder[0] }] } })
  }
  expect(drawing).toMatchObject({ drawingType: 0, imageSourceType: 'URL', source: expect.stringMatching(/^\/api\/assets\/[\da-f-]{36}$/) })
  expect(drawing.transform.width).toBeGreaterThan(0)
  expect(drawing.transform.height).toBeGreaterThan(0)
  return drawing
}

/** 独立检查实际保存内容里的资源引用，包括绘图资源的 JSON 字符串和单元格富文本。 */
function sources(snapshot: Workbook): string[] {
  return [...new Set(JSON.stringify(snapshot).match(/\/api\/assets\/[\da-f-]{36}/g) ?? [])].sort()
}

async function open(page: Page, title = '正式图片入口') {
  const owner = await createUser('image-production')
  await loginThroughApi(page, owner)
  const documentId = await createSheetThroughApi(page, title)
  await openAndEnterEditing(page, documentId, 'steady')
  expect(new URL(page.url()).search).toBe('')
  await expect(page.locator('[data-slot="image-input-test-controls"]')).toHaveCount(0)
  return { owner, documentId }
}

async function choose(page: Page, kind: 'float' | 'cell', names: readonly string[]) {
  const insert = await ribbon(page, '插入')
  const images = insert.getByRole('button', { name: '图片', exact: true })
  await expect(images).toBeVisible()
  await images.click()
  const picker = page.waitForEvent('filechooser', { timeout: 10_000 })
  await page.getByRole('menuitem', { name: kind === 'float' ? '浮动图片' : '单元格图片', exact: true }).click()
  await (await picker).setFiles(names.map(sample))
}

async function sourceBytes(page: Page, paths: readonly string[]) {
  const values: Buffer[] = []
  for (const path of paths) {
    const response = await page.request.get(path)
    expect(response.status()).toBe(200)
    expect(response.headers()['x-asset-status']).toBe('200')
    values.push(await response.body())
  }
  return values
}

/** 只截本张图片的目标区域；模板的固定几何与选格 helper 相同，不访问 SDK 探针或图片缓存。 */
async function imagePixelsAt(page: Page, kind: 'float' | 'cell', index: number, drawing: Drawing) {
  const box = await sheetCanvas(page).boundingBox()
  expect(box).not.toBeNull()
  const clip = {
    x: box!.x + geometry.rowHeader.width + index * 3 * geometry.defaultColumnWidth + 2,
    y: box!.y + geometry.columnHeader.height + 2,
    width: kind === 'float' ? drawing.transform.width - 4 : geometry.defaultColumnWidth - 4,
    height: kind === 'float' ? drawing.transform.height - 4 : geometry.defaultRowHeight - 4,
  }
  const { data, info } = await sharp(await page.screenshot({ clip, scale: 'css' })).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let red = 0
  let blue = 0
  let redX = 0
  let blueX = 0
  for (let offset = 0; offset < data.length; offset += 4) {
    const r = data[offset]!
    const g = data[offset + 1]!
    const b = data[offset + 2]!
    if (r > 150 && g < 80 && b < 100) {
      red += 1
      redX += (offset / 4) % info.width
    }
    if (b > 100 && r < 100 && g < 150) {
      blue += 1
      blueX += (offset / 4) % info.width
    }
  }
  return { red, blue, redToRight: redX / Math.max(1, red) > blueX / Math.max(1, blue) }
}

function imageVisible(pixels: Awaited<ReturnType<typeof imagePixelsAt>>, index: number): boolean {
  // 独立样本清单：GIF 全红；JPEG 原方向经纠正后红区在右；PNG/WebP 红区在左。
  return pixels.red > 10 && (index === 3 ? pixels.blue === 0 : pixels.blue > 10 && pixels.redToRight === (index === 1))
}

async function expectImageAt(page: Page, snapshot: Workbook, kind: 'float' | 'cell', index: number): Promise<void> {
  const drawing = imageAt(snapshot, kind, index)
  await expect.poll(async () => imageVisible(await imagePixelsAt(page, kind, index, drawing), index), { message: `${kind} ${files[index]} 必须在 ${locations[index]} 呈现对应样本像素` }).toBe(true)
}

/** WebKit 的 setOffline 同时破坏内存 Blob 读取；此故事阻断 HTTP(S)、覆盖 onLine 并发送合成 offline 事件，保留本地 I/O。 */
async function offlineWithLocalClipboard(page: Page, refusedRequests: string[]): Promise<() => Promise<void>> {
  const http = /^https?:\/\//
  const reject = async (route: Route): Promise<void> => {
    refusedRequests.push(route.request().url())
    await route.abort('internetdisconnected')
  }
  await page.route(http, reject)
  const restoreOnline = await page.evaluateHandle(() => {
    const previous = Object.getOwnPropertyDescriptor(navigator, 'onLine')
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    window.dispatchEvent(new Event('offline'))
    return () => {
      if (previous === undefined)
        Reflect.deleteProperty(navigator, 'onLine')
      else
        Object.defineProperty(navigator, 'onLine', previous)
      window.dispatchEvent(new Event('online'))
    }
  })
  return async () => {
    await page.unroute(http, reject)
    await restoreOnline.evaluate(restore => restore())
    await restoreOnline.dispose()
  }
}

for (const kind of ['float', 'cell'] as const) {
  test(`US-M5-05 正式${kind}四格式插入、撤销重做、保存重开与二次保存`, async ({ page }) => {
    const { documentId } = await open(page)
    for (const [index, file] of files.entries()) {
      await selectCell(page, locations[index]!)
      await choose(page, kind, [file])
      await expect(operation(page)).toContainText('插入图片已完成。')
      await saveAndWait(page)
      const snapshot = (await savedContent(page, documentId)).snapshot
      expect(sources(snapshot)).toHaveLength(index + 1)
      const response = await page.request.get(imageAt(snapshot, kind, index).source)
      expect((await sharp(await response.body()).metadata()).format).toBe(['png', 'jpeg', 'webp', 'gif'][index])
      await selectCell(page, 'N15')
      await expectImageAt(page, snapshot, kind, index)
    }
    const first = await savedContent(page, documentId)
    expect(first.text).not.toMatch(/blob:|data:image/)
    const before = await sourceBytes(page, sources(first.snapshot))
    const formats = await Promise.all(before.map(async bytes => (await sharp(bytes).metadata()).format))
    expect(formats.sort()).toEqual(['gif', 'jpeg', 'png', 'webp'])
    const png = (await Promise.all(before.map(async bytes => ({ bytes, format: (await sharp(bytes).metadata()).format })))).find(value => value.format === 'png')!
    expect(png).toBeDefined()
    const expected = await sharp(await readFile(sample('rgba-text.png'))).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const actual = await sharp(png.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    expect(actual.info).toMatchObject({ width: expected.info.width, height: expected.info.height, channels: 4 })
    expect(actual.data).toEqual(expected.data)

    // 上一轮刚点过 N15；换一格，避免 SDK 将连续同点识别成双击编辑而吞掉撤销快捷键。
    await selectCell(page, 'M15')
    await pressUniverShortcut(page, 'Z')
    await saveAndWait(page)
    expect(sources((await savedContent(page, documentId)).snapshot)).toHaveLength(3)
    await selectCell(page, 'N15')
    await pressUniverShortcut(page, 'Y')
    await saveAndWait(page)
    expect((await savedContent(page, documentId)).text).toBe(first.text)
    await exitEditing(page, 'steady')
    await reloadAndEnterEditing(page, 'steady')
    const second = await saveAndCapture(page)
    expect(second.answer.unchanged).toBe(true)
    expect((await savedContent(page, documentId)).text).toBe(first.text)
    expect(await sourceBytes(page, sources(first.snapshot))).toEqual(before)
    for (const index of files.keys())
      await expectImageAt(page, first.snapshot, kind, index)
  })
}

test('逐图像素反例：只让 GIF 读取失败，另外三张图不能掩盖目标位置的缺图', async ({ page }) => {
  const { documentId } = await open(page)
  for (const [index, file] of files.entries()) {
    await selectCell(page, locations[index]!)
    await choose(page, 'float', [file])
    await expect(operation(page)).toContainText('插入图片已完成。')
  }
  await saveAndWait(page)
  const { snapshot } = await savedContent(page, documentId)
  await selectCell(page, 'N15')
  for (const index of files.keys())
    await expectImageAt(page, snapshot, 'float', index)
  const gif = imageAt(snapshot, 'float', 3)
  const route = `**${gif.source}`
  await exitEditing(page, 'steady')
  await page.route(route, async request => request.fulfill({ status: 200, headers: { 'Content-Type': 'image/png', 'X-Asset-Status': '503' }, body: 'controlled unavailable' }))
  await reloadAndEnterEditing(page, 'steady')
  await expect(page.getByText('部分图片暂时无法显示', { exact: true })).toBeVisible()
  for (const index of [0, 1, 2])
    await expectImageAt(page, snapshot, 'float', index)
  expect(imageVisible(await imagePixelsAt(page, 'float', 3, gif), 3)).toBe(false)
  expect(sources((await savedContent(page, documentId)).snapshot)).toEqual(sources(snapshot))
  await page.unroute(route)
  await page.getByRole('button', { name: '重新加载图片', exact: true }).click()
  await expectImageAt(page, snapshot, 'float', 3)
})

test('US-M5-09 正式插图后从列表复制，删除原文档不破坏副本图片', async ({ page }) => {
  const title = '带图片的原文档'
  const { documentId, owner } = await open(page, title)
  await selectCell(page, 'A1')
  await choose(page, 'float', ['rgba-text.png'])
  await expect(operation(page)).toContainText('插入图片已完成。')
  await saveAndWait(page)
  const original = await savedContent(page, documentId)
  const paths = sources(original.snapshot)
  expect(paths).toHaveLength(1)
  const bytes = await sourceBytes(page, paths)
  await exitEditing(page, 'steady')
  await page.goto(`/spaces/${owner.personalSpaceId}`)
  await page.getByRole('button', { name: `操作 ${title}`, exact: true }).click()
  await page.getByRole('button', { name: '复制', exact: true }).click()
  await page.getByRole('form', { name: '复制' }).getByRole('button', { name: '复制到这里', exact: true }).click()
  const copyLink = page.getByRole('link', { name: '打开副本', exact: true })
  await expect(copyLink).toBeVisible()
  const copyId = (await copyLink.getAttribute('href'))!.split('/').at(-1)!
  expect(copyId).not.toBe(documentId)
  expect((await savedContent(page, copyId)).text).toBe(original.text)
  await page.getByRole('button', { name: `操作 ${title}`, exact: true }).click()
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.getByText(`已把「${title}」移到回收站`)).toBeVisible()
  await openAndEnterEditing(page, copyId, 'steady')
  expect(await sourceBytes(page, paths)).toEqual(bytes)
  await expectImageAt(page, original.snapshot, 'float', 0)
  await typeInCell(page, 'K12', '副本仍可正常编辑')
  await saveAndWait(page)
  expect(cellOf((await savedContent(page, copyId)).snapshot, 'K12')?.v).toBe('副本仍可正常编辑')
  expect(sources((await savedContent(page, copyId)).snapshot)).toEqual(paths)
  expect((await page.request.get(`/api/documents/${documentId}`)).status()).toBe(404)
})

test('US-M5-06 正式入口拒绝坏图片与离线上传，只读重建不开放插入', async ({ page, context }) => {
  const { documentId } = await open(page)
  await typeInCell(page, 'K12', '保留正文')
  await saveAndWait(page)
  const before = await savedContent(page, documentId)
  await selectCell(page, 'A1')
  await choose(page, 'float', ['html-disguised.png'])
  await expect(operation(page)).toHaveText('插入图片未完成。图片无法处理，请检查格式或使用较小的图片。')
  await saveAndWait(page)
  expect((await savedContent(page, documentId)).text).toBe(before.text)
  const uploads: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/assets')
      uploads.push(request.url())
  })
  await context.setOffline(true)
  try {
    await selectCell(page, 'A1')
    const insert = await ribbon(page, '插入')
    await insert.getByRole('button', { name: '图片', exact: true }).click()
    await page.getByRole('menuitem', { name: '浮动图片', exact: true }).click()
    await expect(operation(page)).toContainText('插入图片未完成。当前无法操作该位置')
    expect(uploads).toEqual([])
  }
  finally {
    await context.setOffline(false)
  }
  await typeInCell(page, 'K13', '失败后继续编辑')
  await saveAndWait(page)
  expect(cellOf((await savedContent(page, documentId)).snapshot, 'K13')?.v).toBe('失败后继续编辑')
  expect(sources((await savedContent(page, documentId)).snapshot)).toEqual([])
  await exitEditing(page, 'steady')
  await waitForEditorAccess(page, 'read', 'steady')
  await expect(page.getByRole('toolbar', { name: '插入' })).toHaveCount(0)
  expect(uploads).toEqual([])
  await enterEditing(page, 'steady')
  await selectCell(page, 'A1')
  await choose(page, 'float', ['rgba-text.png'])
  await expect(operation(page)).toContainText('插入图片已完成。')
  await saveAndWait(page)
  expect(sources((await savedContent(page, documentId)).snapshot)).toHaveLength(1)
})

test('正式图片接管不阻断离线表格复制、剪切、右键与带预览的公式粘贴', async ({ page }) => {
  const { documentId } = await open(page)
  await typeInCell(page, 'A10', '=40+2')
  await typeInCell(page, 'B10', '剪切正文')
  await saveAndWait(page)
  expect(cellOf((await savedContent(page, documentId)).snapshot, 'A10')?.v).toBe(42)
  // 只替换浏览器剪贴板 I/O，菜单、快捷键、正式适配和 SDK 均实际执行；不算原生环境补验。
  const clipboard = await page.evaluateHandle(() => {
    const formulaMime = 'web application/x-univer-sheets-formula'
    const formula = JSON.stringify({ rowCount: 1, columnCount: 1, origin: { row: 9, column: 0 }, formulas: [{ row: 0, column: 0, f: '=40+2' }] })
    const state = { writes: [] as Record<string, string>[], reads: 0, previewReads: 0, formula, formulaMime }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      readText: async () => '',
      write: async (items: readonly ClipboardItem[]) => {
        const copied: Record<string, string> = {}
        for (const item of items) {
          for (const type of item.types)
            copied[type] = await (await item.getType(type)).text()
        }
        state.writes.push(copied)
      },
      read: async () => {
        state.reads += 1
        const copied = state.writes.at(-1)!
        const contents: Record<string, string> = { 'text/plain': copied['text/plain']!, 'text/html': copied['text/html']!.replace(/data-copy-id="[^"]*"/g, ''), [formulaMime]: formula }
        return [{ types: [...Object.keys(contents), 'image/png'], getType: async (type: string) => {
          if (type === 'image/png') {
            state.previewReads += 1
            throw new Error('表格预览不应被读取')
          }
          return new Blob([contents[type]!], { type })
        } }]
      },
    } })
    return state
  })
  const resourceRequests: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/assets'))
      resourceRequests.push(request.url())
  })
  const refusedRequests: string[] = []
  const restoreOnline = await offlineWithLocalClipboard(page, refusedRequests)
  try {
    expect(await page.evaluate(() => navigator.onLine)).toBe(false)
    expect(await page.evaluate(async () => {
      try {
        await fetch('/api/health/ready', { cache: 'no-store' })
        return false
      }
      catch {
        return true
      }
    })).toBe(true)
    expect(refusedRequests.map(url => new URL(url).pathname)).toContain('/api/health/ready')
    await selectCell(page, 'A1')
    const insert = await ribbon(page, '插入')
    await insert.getByRole('button', { name: '图片', exact: true }).click()
    await page.getByRole('menuitem', { name: '浮动图片', exact: true }).click()
    await expect(operation(page)).toContainText('插入图片未完成。当前无法操作该位置')
    await selectCell(page, 'B10')
    await pressUniverShortcut(page, 'X')
    await expect.poll(async () => clipboard.evaluate(state => state.writes[0]?.['text/plain'])).toBe('剪切正文')
    await selectCell(page, 'A10')
    await pressUniverShortcut(page, 'C')
    await expect.poll(async () => clipboard.evaluate(state => state.writes[1]?.['text/plain'])).toBe('42')
    expect(await clipboard.evaluate(state => Object.keys(state.writes[1]!))).not.toContain('image/png')
    await selectCell(page, 'C10', { button: 'right' })
    await page.getByRole('button', { name: '粘贴', exact: true }).click()
    await expect(operation(page)).toContainText('已完成')
    expect(await clipboard.evaluate(state => state.reads)).toBe(1)
    const payload = await clipboard.evaluate(state => ({ html: state.writes[1]!['text/html']!.replace(/data-copy-id="[^"]*"/g, ''), formula: state.formula, formulaMime: state.formulaMime }))
    const png = Array.from(await readFile(sample('rgba-text.png')))
    await selectCell(page, 'D10')
    await page.evaluate(({ payload, png }) => {
      const data = new DataTransfer()
      data.items.add(new File([new Uint8Array(png)], 'preview.png', { type: 'image/png' }))
      data.setData('text/html', payload.html)
      data.setData('text/plain', '42')
      data.setData(payload.formulaMime, payload.formula)
      document.activeElement?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }, { payload, png })
    await expect(operation(page)).toContainText('已完成')
    expect(await clipboard.evaluate(state => ({ reads: state.reads, previews: state.previewReads }))).toEqual({ reads: 1, previews: 0 })
    expect(resourceRequests).toEqual([])
  }
  finally {
    await restoreOnline()
  }
  await saveAndWait(page)
  const after = (await savedContent(page, documentId)).snapshot
  for (const cell of ['A10', 'C10', 'D10'])
    expect(cellOf(after, cell)).toMatchObject({ f: '=40+2', v: 42 })
  expect(cellOf(after, 'B10')?.v).toBe('剪切正文')
  expect(sources(after)).toEqual([])
  expect(resourceRequests).toEqual([])
  await clipboard.dispose()
})
