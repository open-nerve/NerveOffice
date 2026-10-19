import type { Page } from '@playwright/test'
import type { Workbook } from '../../support/sheet.ts'
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { uploadAsset } from '../../support/asset-protocol.ts'
import { probeFormulasSettled, probeSnapshot, setCellValue } from '../../support/editor-probe.ts'
import { expect, test } from '../../support/fixtures.ts'
import { drawingsIn, expectImagePixels, imageFailureSentinel, prepareImageDocument } from '../../support/image-editor.ts'
import { cellOf, EDITOR_TEST_TIMEOUT, enterEditing, exitEditing, reloadAndEnterEditing, saveAndWait, savedContent, sheetCanvas, waitForEditorAccess } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

const sample = (name: string): string => fileURLToPath(new URL(`../../../../apps/api/src/modules/assets/testdata/${name}`, import.meta.url))

/** 测试构建显式启用正式适配；文件对话框与合成剪贴板不计入 Finder/Excel 原生证据。 */
async function open(page: Page) {
  const prepared = await prepareImageDocument(page)
  await page.goto(`/documents/${prepared.documentId}?imageInput=enabled`)
  await waitForEditorAccess(page, 'read', 'steady')
  await enterEditing(page, 'steady')
  await expect(page.getByRole('button', { name: '测试：插入浮图', exact: true })).toBeVisible()
  return prepared
}

async function focusCell(page: Page, a1: string): Promise<void> {
  const position = await page.evaluate((a1) => {
    const sheet = window.__nerveEditorProbe?.univerAPI.getActiveWorkbook().getActiveSheet()
    if (!sheet)
      throw new Error('没有实际工作表')
    const cell = sheet.getRange(a1).getCell()
    return { x: (cell.startX + cell.endX) / 2, y: (cell.startY + cell.endY) / 2 }
  }, a1)
  await sheetCanvas(page).click({ position })
}

async function choose(page: Page, kind: 'float' | 'cell', names: readonly string[]): Promise<void> {
  const picker = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: kind === 'float' ? '测试：插入浮图' : '测试：插入单元格图片', exact: true }).click()
  await (await picker).setFiles(names.map(sample))
}

async function command(page: Page, name: 'undo' | 'redo'): Promise<void> {
  expect(await page.evaluate(async name => window.__nerveEditorProbe?.univerAPI.executeCommand(`univer.command.${name}`), name)).toBe(true)
}

async function selectFirstImage(page: Page): Promise<void> {
  // SDK 自行识别 500 ms 内的同点双击并打开图库；先经真实画布取消旧选集，再单击选图。
  await focusCell(page, 'B12')
  await expect.poll(async () => page.evaluate(() => window.__nerveEditorProbe?.images.selected())).toEqual([])
  const image = drawingsIn(await probeSnapshot(page)).first
  if (image === undefined)
    throw new Error('没有实际浮图')
  await sheetCanvas(page).click({ position: { x: image.transform.left + image.transform.width / 2, y: image.transform.top + image.transform.height / 2 } })
  await expect.poll(async () => page.evaluate(() => window.__nerveEditorProbe?.images.selected())).toEqual(['first'])
  await expect(page.locator('[data-u-comp="gallery-close"]')).toHaveCount(0)
}

async function expectClipboardPixels(page: Page, source: string, bytes: Buffer): Promise<void> {
  const original = await page.request.get(source)
  expect(original.status()).toBe(200)
  expect((await sharp(bytes).metadata()).format).toBe('png')
  if (original.headers()['content-type'] === 'image/png') {
    expect(bytes).toEqual(await original.body())
    return
  }
  // 与同一浏览器直接解码规范源的像素比较；WebKit 与 libvips 的 JPEG 解码会有实质差异。
  // 不读取编辑器缓存或调用产品转换器，确保错误图片、尺寸、占位和色值变化都会失败。
  const expected = await page.evaluate(async (source) => {
    const image = new Image()
    const canvas = document.createElement('canvas')
    try {
      image.src = source
      await image.decode()
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')
      if (context === null)
        throw new Error('没有图片对照画布')
      context.drawImage(image, 0, 0)
      return { width: canvas.width, height: canvas.height, rgba: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data) }
    }
    finally {
      image.src = ''
      canvas.width = 0
      canvas.height = 0
    }
  }, source)
  const received = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  expect(received.info).toMatchObject({ width: expected.width, height: expected.height, channels: 4 })
  expect(Array.from(received.data)).toEqual(expected.rgba)
}

test.describe('系统图片输入受控浏览器回归', { tag: '@test-build' }, () => {
  test('四格式文件选择走真实上传与插入；浮图和单元格图片可撤销重做、保存重开', async ({ page }) => {
    const { documentId } = await open(page)
    const locations = ['J2', 'J8', 'J14', 'M2']
    const formats = ['rgba-text.png', 'orientation.jpg', 'static.webp', 'single.gif']
    const inserted: string[] = []
    for (const [index, name] of formats.entries()) {
      await focusCell(page, locations[index]!)
      const before = Object.keys(drawingsIn(await probeSnapshot(page)))
      await choose(page, 'float', [name])
      await expect(page.locator('[data-slot="image-operation"]')).toContainText('插入图片已完成。')
      const drawings = drawingsIn(await probeSnapshot(page))
      const added = Object.keys(drawings).filter(id => !before.includes(id))
      expect(added).toHaveLength(1)
      const id = added[0]!
      inserted.push(id)
      expect(drawings[id]?.source).toMatch(/^\/api\/assets\/[0-9a-f-]+$/)
      const original = await sharp(await readFile(sample(name))).rotate().toBuffer({ resolveWithObject: true })
      await expect.poll(async () => page.evaluate((id) => {
        const image = window.__nerveEditorProbe?.images.element(id)
        return image?.complete ? { width: image.naturalWidth, height: image.naturalHeight } : undefined
      }, id)).toEqual({ width: original.info.width, height: original.info.height })
    }
    await expectImagePixels(page, 'J2')
    await command(page, 'undo')
    expect(Object.keys(drawingsIn(await probeSnapshot(page)))).not.toContain(inserted.at(-1))
    await command(page, 'redo')
    expect(Object.keys(drawingsIn(await probeSnapshot(page)))).toEqual(expect.arrayContaining(inserted))

    await setCellValue(page, 'C8', '=40+2')
    await expect.poll(async () => probeFormulasSettled(page)).toBe(true)
    const beforeCell = cellOf(JSON.parse(await probeSnapshot(page)) as Workbook, 'C8')
    expect(beforeCell?.f).toBe('=40+2')
    await focusCell(page, 'C8')
    await choose(page, 'cell', ['rgba-text.png'])
    await expect(page.locator('[data-slot="image-operation"]')).toContainText('插入图片已完成。')
    await expectImagePixels(page, 'C8')
    const imageCell = cellOf(JSON.parse(await probeSnapshot(page)) as Workbook, 'C8')
    // 正常命令以 null 清公式，SDK save() 会省去清空后的字段。
    expect(imageCell?.f).toBeUndefined()
    expect(imageCell?.p).toMatchObject({ drawingsOrder: [expect.any(String)] })
    await command(page, 'undo')
    expect(cellOf(JSON.parse(await probeSnapshot(page)) as Workbook, 'C8')).toEqual(beforeCell)
    await command(page, 'redo')
    await expectImagePixels(page, 'C8')
    await saveAndWait(page)
    expect(JSON.stringify((await savedContent(page, documentId)).snapshot)).not.toMatch(/blob:|data:image/)
    await reloadAndEnterEditing(page, 'steady')
    await expectImagePixels(page, 'J2')
    await expectImagePixels(page, 'C8')
    expect(Object.keys(drawingsIn(await probeSnapshot(page)))).toEqual(expect.arrayContaining(inserted))
  })

  test('表格带图片预览仍贴单元格且零上传；无文件普通粘贴保留原路径，HTML 分类不加载资源', async ({ page }) => {
    const { documentId } = await open(page)
    const png = Array.from(await readFile(sample('rgba-text.png')))
    const uploads: string[] = []
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/assets')
        uploads.push(request.url())
    })
    await focusCell(page, 'B12')
    const result = await page.evaluate((png) => {
      const data = new DataTransfer()
      data.items.add(new File([new Uint8Array(png)], 'preview.png', { type: 'image/png' }))
      data.setData('text/html', '<table><tr><td>表格正文</td><td>42</td></tr></table><img src="/image-input-preview-sentinel.png">')
      data.setData('text/plain', '表格正文\t42')
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
      document.activeElement?.dispatchEvent(event)
      return event.defaultPrevented
    }, png)
    expect(result).toBe(true)
    await expect.poll(async () => cellOf(JSON.parse(await probeSnapshot(page)) as Workbook, 'B12')?.v).toBe('表格正文')
    expect(cellOf(JSON.parse(await probeSnapshot(page)) as Workbook, 'C12')?.v).toBe(42)
    expect(uploads).toHaveLength(0)

    await focusCell(page, 'B14')
    await page.evaluate(() => {
      const data = new DataTransfer()
      data.setData('text/plain', '普通文字')
      document.activeElement?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    })
    await expect.poll(async () => cellOf(JSON.parse(await probeSnapshot(page)) as Workbook, 'B14')?.v).toBe('普通文字')

    const sentinels: string[] = []
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/image-input-inert-'))
        sentinels.push(request.url())
    })
    expect(await page.evaluate(() => window.__nerveEditorProbe?.images.classify({ files: [], html: '<img src="/image-input-inert-image"><script src="/image-input-inert-script"></script><link rel="stylesheet" href="/image-input-inert-style">' }))).toEqual({ kind: 'reject', reason: 'image-without-file' })
    await imageFailureSentinel(page, documentId, '分类之后继续编辑保存')
    expect(sentinels).toHaveLength(0)
    expect(uploads).toHaveLength(0)
  })

  test('多文件按序插入；混合不合格批次零上传，拒绝后可以继续编辑保存', async ({ page }) => {
    const { documentId } = await open(page)
    await focusCell(page, 'J8')
    const before = Object.keys(drawingsIn(await probeSnapshot(page)))
    await choose(page, 'float', ['rgba-text.png', 'single.gif'])
    await expect(page.locator('[data-slot="image-operation"]')).toHaveText('插入图片已完成。已插入 2/2 张图片。')
    expect(Object.keys(drawingsIn(await probeSnapshot(page))).filter(id => !before.includes(id))).toHaveLength(2)
    let uploads = 0
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/assets')
        uploads += 1
    })
    await focusCell(page, 'B12')
    expect(await page.evaluate(async () => window.__nerveEditorProbe?.images.input?.insertFiles([
      new File(['valid metadata'], 'one.png', { type: 'image/png' }),
      new File(['invalid metadata'], 'two.svg', { type: 'image/svg+xml' }),
    ]))).toBe(false)
    await expect(page.locator('[data-slot="image-operation"]')).toContainText('文件格式须与后缀一致')
    expect(uploads).toBe(0)
    await imageFailureSentinel(page, documentId, '批次拒绝后仍可保存')
  })

  test('真实浮图经受控系统接口导出四格式像素；剪切失败不删除，成功可撤销且无迟到空文本', async ({ page }) => {
    const { asset, documentId } = await open(page)
    const clipboard = await page.evaluateHandle(() => {
      const state = { denied: true, pngs: [] as number[][], text: [] as string[], lastCommandCompletedAt: 0 }
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        readText: async () => '',
        write: async (items: readonly ClipboardItem[]) => {
          if (state.denied)
            throw new DOMException('controlled permission denial', 'NotAllowedError')
          for (const item of items)
            state.pngs.push(Array.from(new Uint8Array(await (await item.getType('image/png')).arrayBuffer())))
        },
        writeText: async (text: string) => { state.text.push(text) },
      } })
      return state
    })
    await selectFirstImage(page)
    expect(await page.evaluate(async () => window.__nerveEditorProbe?.univerAPI.executeCommand('univer.command.cut'))).toBe(false)
    await expect(page.locator('[data-slot="image-operation"]')).toContainText('浏览器未允许访问剪贴板')
    expect(drawingsIn(await probeSnapshot(page)).first?.source).toBe(asset.url)
    await clipboard.evaluate((state) => {
      state.denied = false
    })
    const alternatives = [asset, await uploadAsset(page, 'orientation.jpg', 'image/jpeg', 'jpg'), await uploadAsset(page, 'static.webp', 'image/webp', 'webp'), await uploadAsset(page, 'single.gif', 'image/gif', 'gif')]
    for (const [index, source] of alternatives.entries()) {
      expect(await page.evaluate(async (source) => {
        const probe = window.__nerveEditorProbe
        if (!probe)
          throw new Error('没有编辑器探针')
        const snapshot = JSON.parse(probe.snapshot()) as { id: string, resources: { name: string, data: string }[] }
        const resource = snapshot.resources.find(item => item.name === 'SHEET_DRAWING_PLUGIN')
        if (!resource)
          throw new Error('没有浮图资源')
        const image = (JSON.parse(resource.data) as { images: { data: { first: object } } }).images.data.first
        return probe.univerAPI.executeCommand('sheet.command.set-sheet-image', { unitId: snapshot.id, drawings: [{ ...image, source }] })
      }, source.url)).toBe(true)
      await expect.poll(async () => page.evaluate(() => {
        const image = window.__nerveEditorProbe?.images.element('first')
        return image?.complete ? { width: image.naturalWidth, height: image.naturalHeight } : undefined
      })).toEqual({ width: source.width, height: source.height })
      await selectFirstImage(page)
      expect(await page.evaluate(async () => window.__nerveEditorProbe?.univerAPI.executeCommand('univer.command.copy'))).toBe(true)
      expect(await clipboard.evaluate(state => state.pngs.length)).toBe(index + 1)
      const bytes = Buffer.from(await clipboard.evaluate((state, index) => state.pngs[index]!, index))
      await test.info().attach(`clipboard-format-${index}.png`, { body: bytes, contentType: 'image/png' })
      await expectClipboardPixels(page, source.url, bytes)
      expect(await clipboard.evaluate(state => state.pngs.length)).toBe(index + 1)
    }
    expect(await page.evaluate(async () => window.__nerveEditorProbe?.univerAPI.executeCommand('univer.command.cut'))).toBe(true)
    await clipboard.evaluate((state) => {
      state.lastCommandCompletedAt = performance.now()
    })
    expect(drawingsIn(await probeSnapshot(page)).first).toBeUndefined()
    await command(page, 'undo')
    expect(drawingsIn(await probeSnapshot(page)).first?.source).toBe(alternatives.at(-1)?.url)
    await imageFailureSentinel(page, documentId, '系统复制与剪切后仍可保存')
    // 原 SDK 空文本回退延迟为 200 ms；明确跨过该边界再检查，不能只看 write Promise。
    await expect.poll(async () => clipboard.evaluate(state => performance.now() - state.lastCommandCompletedAt)).toBeGreaterThan(250)
    expect(await clipboard.evaluate(state => state.text)).toEqual([])
  })

  test('右键命令在受控系统接口拒绝后可重试，图片实际上传，表格预览不读取也不上传', async ({ page }) => {
    const { documentId } = await open(page)
    const png = Array.from(await readFile(sample('rgba-text.png')))
    const clipboard = await page.evaluateHandle((png) => {
      const state = { kind: 'denied', reads: 0, previews: 0 }
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        readText: async () => '',
        read: async () => {
          state.reads += 1
          if (state.kind === 'denied')
            throw new DOMException('controlled permission denial', 'NotAllowedError')
          if (state.kind === 'table') {
            return [{ types: ['image/png', 'text/html'], getType: async (type: string) => {
              if (type === 'image/png') {
                state.previews += 1
                throw new Error('不能读取的预览')
              }
              return new Blob(['<table><tr><td>右键表格</td></tr></table>'], { type: 'text/html' })
            } }]
          }
          return [new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })]
        },
      } })
      return state
    }, png)
    await focusCell(page, 'J2')
    expect(await page.evaluate(async () => window.__nerveEditorProbe?.univerAPI.executeCommand('univer.command.paste'))).toBe(false)
    await expect(page.locator('[data-slot="image-operation"]')).toContainText('浏览器未允许访问剪贴板')
    await clipboard.evaluate((state) => {
      state.kind = 'image'
    })
    expect(await page.evaluate(async () => window.__nerveEditorProbe?.univerAPI.executeCommand('univer.command.paste'))).toBe(true)
    await expectImagePixels(page, 'J2')
    let tableUploads = 0
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/assets')
        tableUploads += 1
    })
    await focusCell(page, 'B12')
    await clipboard.evaluate((state) => {
      state.kind = 'table'
    })
    const before = Object.keys(drawingsIn(await probeSnapshot(page)))
    expect(await page.evaluate(async () => window.__nerveEditorProbe?.univerAPI.executeCommand('univer.command.paste'))).toBe(true)
    expect(cellOf(JSON.parse(await probeSnapshot(page)) as Workbook, 'B12')?.v).toBe('右键表格')
    expect(Object.keys(drawingsIn(await probeSnapshot(page)))).toEqual(before)
    expect(await clipboard.evaluate(state => ({ reads: state.reads, previews: state.previews }))).toEqual({ reads: 3, previews: 0 })
    await imageFailureSentinel(page, documentId, '右键拒绝重试后仍可保存')
    expect(tableUploads).toBe(0)
  })

  test('单元格图片复制保留原件，剪切可撤销；阅读模式仍可复制但不能剪切或插入', async ({ page }) => {
    const { asset, documentId } = await open(page)
    const clipboard = await page.evaluateHandle(() => {
      const state = { pngs: [] as number[][] }
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        readText: async () => '',
        write: async (items: readonly ClipboardItem[]) => {
          for (const item of items)
            state.pngs.push(Array.from(new Uint8Array(await (await item.getType('image/png')).arrayBuffer())))
        },
      } })
      return state
    })
    await focusCell(page, 'A8')
    const before = cellOf(JSON.parse(await probeSnapshot(page)) as Workbook, 'A8')
    expect(before?.p).toMatchObject({ drawingsOrder: [expect.any(String)] })
    expect(await page.evaluate(async () => window.__nerveEditorProbe?.univerAPI.executeCommand('univer.command.copy'))).toBe(true)
    expect(Buffer.from(await clipboard.evaluate(state => state.pngs[0]!))).toEqual(await (await page.request.get(asset.url)).body())
    expect(cellOf(JSON.parse(await probeSnapshot(page)) as Workbook, 'A8')).toEqual(before)
    expect(await page.evaluate(async () => window.__nerveEditorProbe?.univerAPI.executeCommand('univer.command.cut'))).toBe(true)
    expect(cellOf(JSON.parse(await probeSnapshot(page)) as Workbook, 'A8')?.p).toBeUndefined()
    await command(page, 'undo')
    expect(cellOf(JSON.parse(await probeSnapshot(page)) as Workbook, 'A8')).toEqual(before)
    await imageFailureSentinel(page, documentId, '单元格图片剪切撤销后仍可保存')
    await exitEditing(page, 'steady')
    // 当前格内图片的再次点击会进入 SDK 预览；用真实方向键选择，保持复制目标在表格中。
    await focusCell(page, 'B8')
    await page.keyboard.press('ArrowLeft')
    await expect.poll(async () => page.evaluate(() => window.__nerveEditorProbe?.univerAPI.getActiveWorkbook().getActiveCell()?.getA1Notation())).toBe('A8')
    await expect(page.locator('[data-u-comp="gallery-close"]')).toHaveCount(0)
    const readOnly = await probeSnapshot(page)
    const copied = await clipboard.evaluate(state => state.pngs.length)
    expect(await page.evaluate(async () => window.__nerveEditorProbe?.univerAPI.executeCommand('univer.command.copy'))).toBe(true)
    expect(await clipboard.evaluate(state => state.pngs.length)).toBe(copied + 1)
    expect(await page.evaluate(async () => window.__nerveEditorProbe?.univerAPI.executeCommand('univer.command.cut'))).toBe(false)
    let uploads = 0
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/assets')
        uploads += 1
    })
    expect(await page.evaluate(async () => window.__nerveEditorProbe?.images.input?.insertFiles([new File(['image'], 'one.png', { type: 'image/png' })]))).toBe(false)
    expect(uploads).toBe(0)
    expect(await probeSnapshot(page)).toBe(readOnly)
  })

  test('普通表格复制走 SDK，有预览和无文件的表格粘贴均保留公式且零图片上传', async ({ page }) => {
    const { documentId } = await open(page)
    await setCellValue(page, 'B12', '=40+2')
    await expect.poll(async () => probeFormulasSettled(page)).toBe(true)
    await focusCell(page, 'B12')
    const clipboard = await page.evaluateHandle(() => {
      const formulaMime = 'web application/x-univer-sheets-formula'
      const formula = JSON.stringify({ rowCount: 1, columnCount: 1, origin: { row: 11, column: 1 }, formulas: [{ row: 0, column: 0, f: '=40+2' }] })
      const state = { copied: {} as Record<string, string>, reads: 0, formula, formulaMime }
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        readText: async () => '',
        write: async (items: readonly ClipboardItem[]) => {
          for (const item of items) {
            for (const type of item.types)
              state.copied[type] = await (await item.getType(type)).text()
          }
        },
        read: async () => {
          state.reads += 1
          return [{ types: [formulaMime], getType: async () => new Blob([formula], { type: formulaMime }) }]
        },
      } })
      return state
    })
    expect(await page.evaluate(async () => window.__nerveEditorProbe?.univerAPI.executeCommand('univer.command.copy'))).toBe(true)
    expect(await clipboard.evaluate(state => state.copied['text/plain'])).toBe('42')
    expect(await clipboard.evaluate(state => state.copied['text/html'])).toContain('<table')
    expect(await clipboard.evaluate(state => Object.keys(state.copied))).not.toContain('image/png')
    // 去掉同实例 copy-id，确保公式来自系统 payload，不是 SDK 内存里的复制缓存。
    const payload = await clipboard.evaluate(state => ({ html: state.copied['text/html']!.replace(/data-copy-id="[^"]*"/g, ''), formula: state.formula, formulaMime: state.formulaMime }))
    const png = Array.from(await readFile(sample('rgba-text.png')))
    let uploads = 0
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/assets')
        uploads += 1
    })
    await focusCell(page, 'C12')
    await page.evaluate(({ payload, png }) => {
      const data = new DataTransfer()
      data.items.add(new File([new Uint8Array(png)], 'preview.png', { type: 'image/png' }))
      data.setData('text/html', payload.html)
      data.setData('text/plain', '42')
      data.setData(payload.formulaMime, payload.formula)
      document.activeElement?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }, { payload, png })
    await expect.poll(async () => cellOf(JSON.parse(await probeSnapshot(page)) as Workbook, 'C12')?.f).toBe('=40+2')
    expect(await clipboard.evaluate(state => state.reads)).toBe(0)
    await focusCell(page, 'D12')
    await page.evaluate((payload) => {
      const data = new DataTransfer()
      data.setData('text/html', payload.html)
      data.setData('text/plain', '42')
      document.activeElement?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }, payload)
    await expect.poll(async () => cellOf(JSON.parse(await probeSnapshot(page)) as Workbook, 'D12')?.f).toBe('=40+2')
    expect(await clipboard.evaluate(state => state.reads)).toBe(1)
    await imageFailureSentinel(page, documentId, '表格公式与预览分类后仍可保存')
    expect(uploads).toBe(0)
  })

  test('文件 drop 在编辑区同步阻止导航并插入；域外和文字输入不上传，旧图片选集不劫持宿主焦点', async ({ page }) => {
    const { documentId } = await open(page)
    const png = Array.from(await readFile(sample('rgba-text.png')))
    const originalUrl = page.url()
    let uploads = 0
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/assets')
        uploads += 1
    })
    await focusCell(page, 'J2')
    const before = Object.keys(drawingsIn(await probeSnapshot(page)))
    const prevented = await sheetCanvas(page).evaluate((canvas, png) => {
      const data = new DataTransfer()
      data.items.add(new File([new Uint8Array(png)], 'drop.png', { type: 'image/png' }))
      return ['dragover', 'drop'].map((type) => {
        const event = new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true })
        canvas.dispatchEvent(event)
        return event.defaultPrevented
      })
    }, png)
    expect(prevented).toEqual([true, true])
    await expect(page.locator('[data-slot="image-operation"]')).toContainText('插入图片已完成。')
    expect(Object.keys(drawingsIn(await probeSnapshot(page))).filter(id => !before.includes(id))).toHaveLength(1)
    await expectImagePixels(page, 'J2')
    expect(uploads).toBe(1)
    expect(page.url()).toBe(originalUrl)
    await selectFirstImage(page)
    const host = await page.evaluateHandle((png) => {
      const input = document.createElement('input')
      input.setAttribute('aria-label', '宿主焦点验证')
      document.body.append(input)
      input.focus()
      input.value = '保留宿主文字'
      input.select()
      const state = { copies: 0, writes: [] as string[][][], textWrites: [] as string[], lastCopyAt: 0 }
      input.addEventListener('copy', (event) => {
        if (event.isTrusted) {
          state.copies += 1
          state.lastCopyAt = performance.now()
        }
      })
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        readText: async () => '',
        write: async (items: readonly ClipboardItem[]) => {
          state.writes.push(items.map(item => Array.from(item.types)))
        },
        writeText: async (text: string) => { state.textWrites.push(text) },
      } })
      const data = new DataTransfer()
      data.items.add(new File([new Uint8Array(png)], 'outside.png', { type: 'image/png' }))
      const event = new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true })
      input.dispatchEvent(event)
      return { input, state, prevented: event.defaultPrevented }
    }, png)
    try {
      expect(await host.evaluate(current => current.prevented)).toBe(false)
      expect(await page.evaluate(() => window.__nerveEditorProbe?.images.selected())).toEqual(['first'])
      await page.keyboard.press('ControlOrMeta+C')
      expect(await host.evaluate(current => current.state.copies)).toBe(1)
      await expect.poll(async () => host.evaluate(current => performance.now() - current.state.lastCopyAt)).toBeGreaterThan(250)
      expect(await host.evaluate(current => ({ writes: current.state.writes, textWrites: current.state.textWrites }))).toEqual({ writes: [], textWrites: [] })
      expect(await page.evaluate(async () => window.__nerveEditorProbe?.images.input?.insertFiles([new File(['image'], 'one.png', { type: 'image/png' })]))).toBe(false)
      expect(await host.evaluate(current => ({ value: current.input.value, active: document.activeElement === current.input }))).toEqual({ value: '保留宿主文字', active: true })
      expect(uploads).toBe(1)
    }
    finally {
      await host.evaluate(current => current.input.remove())
      await host.dispose()
    }
    await focusCell(page, 'B14')
    await page.keyboard.type('文字编辑')
    const inEditor = await sheetCanvas(page).evaluate((canvas, png) => {
      const data = new DataTransfer()
      data.items.add(new File([new Uint8Array(png)], 'editing.png', { type: 'image/png' }))
      const event = new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true })
      canvas.dispatchEvent(event)
      return event.defaultPrevented
    }, png)
    expect(inEditor).toBe(true)
    await expect(page.locator('[data-slot="image-operation"]')).toContainText('当前无法操作该位置')
    await page.keyboard.press('Enter')
    await expect.poll(async () => cellOf(JSON.parse(await probeSnapshot(page)) as Workbook, 'B14')?.v).toBe('文字编辑')
    await imageFailureSentinel(page, documentId, '拖放拒绝后仍可保存')
    expect(uploads).toBe(1)
    expect(page.url()).toBe(originalUrl)
  })

  for (const scenario of [
    { name: '换选区', interrupt: async (page: Page) => focusCell(page, 'B14'), resume: async () => {} },
    { name: '取消', interrupt: async (page: Page) => page.getByRole('button', { name: '测试：取消图片操作', exact: true }).click(), resume: async () => {} },
    { name: '退出编辑', interrupt: async (page: Page) => exitEditing(page, 'steady'), resume: async (page: Page) => enterEditing(page, 'steady') },
  ]) {
    test(`上传响应晚于${scenario.name}，本次任务失败且不会迟到插图，后续可以重试`, async ({ page }) => {
      const { documentId } = await open(page)
      await focusCell(page, 'J2')
      const before = Object.keys(drawingsIn(await probeSnapshot(page)))
      let release = () => {}
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      let captured = false
      let completed = false
      await page.route('**/api/assets', async (route) => {
        try {
          const response = await route.fetch()
          expect(response.status()).toBe(201)
          captured = true
          await held
          await route.fulfill({ response })
        }
        finally {
          completed = true
        }
      })
      const png = Array.from(await readFile(sample('rgba-text.png')))
      const inserting = page.evaluate(async png => window.__nerveEditorProbe?.images.input?.insertFiles([new File([new Uint8Array(png)], 'late.png', { type: 'image/png' })]), png)
      try {
        await expect.poll(() => captured).toBe(true)
        await scenario.interrupt(page)
        expect(await inserting).toBe(false)
        release()
        await expect.poll(() => completed).toBe(true)
        await page.unroute('**/api/assets')
        expect(Object.keys(drawingsIn(await probeSnapshot(page)))).toEqual(before)
        await scenario.resume(page)
        await focusCell(page, 'J2')
        await choose(page, 'float', ['rgba-text.png'])
        await expect(page.locator('[data-slot="image-operation"]')).toContainText('插入图片已完成。')
        expect(Object.keys(drawingsIn(await probeSnapshot(page))).filter(id => !before.includes(id))).toHaveLength(1)
        await expectImagePixels(page, 'J2')
        await imageFailureSentinel(page, documentId, `${scenario.name}后重试仍可保存`)
      }
      finally {
        release()
        await expect.poll(() => !captured || completed).toBe(true)
        await page.unroute('**/api/assets')
        await inserting
      }
    })
  }
})
