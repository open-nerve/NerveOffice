import { expectAssetHeaders, uploadAsset } from '../../support/asset-protocol.ts'
import { probeSnapshot, setCellValue } from '../../support/editor-probe.ts'
import { expect, test } from '../../support/fixtures.ts'
import { drawingsIn, expectImagePixels, imageFailureSentinel, imagePixels, prepareImageDocument as prepare } from '../../support/image-editor.ts'
import { EDITOR_TEST_TIMEOUT, exitEditing, openAndEnterEditing, reloadAndEnterEditing, saveAndWait, savedContent, sheetCanvas, sheetTab } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

test.describe('平台图片实例的实际 SDK 路径', { tag: '@test-build' }, () => {
  test('IMAGE 首次失败后恢复的实际图片尺寸，与重新打开后完全一致', async ({ page }, testInfo) => {
    // 原件纵向，平台占位横向；相同比例的样本会掩盖占位尺寸沿用。
    const { asset, documentId } = await prepare(page, { portrait: true })
    const path = `**${asset.url}`
    await page.route(path, async route => route.fulfill({ status: 200, headers: { 'Content-Type': 'image/png', 'X-Asset-Status': '503' }, body: 'unavailable' }))
    await openAndEnterEditing(page, documentId, 'steady')
    await expect(page.getByText('部分图片暂时无法显示', { exact: true })).toBeVisible()
    await page.unroute(path)
    await page.getByRole('button', { name: '重新加载图片', exact: true }).click()
    await expectImagePixels(page, 'D8')
    const restored = await imagePixels(page, 'D8')
    // 正常保存并释放编辑权，再重开核对图片；不依赖 unload 送达或租约过期。
    await exitEditing(page, 'steady')
    await reloadAndEnterEditing(page, 'steady')
    await expectImagePixels(page, 'D8')
    const reopened = await imagePixels(page, 'D8')
    await testInfo.attach('恢复与重开后的实际尺寸', { body: JSON.stringify({ restored, reopened }), contentType: 'application/json' })
    expect({ width: restored.imageWidth, height: restored.imageHeight }).toEqual({ width: reopened.imageWidth, height: reopened.imageHeight })
    await imageFailureSentinel(page, documentId, '图片尺寸恢复后保存哨兵')
  })

  test('实际 SDK 图元的原生图片损坏后，后续单元格仍能绘制和保存', async ({ page }) => {
    const { documentId } = await prepare(page)
    await openAndEnterEditing(page, documentId, 'steady')
    await expectImagePixels(page, 'C3')
    const broken = await page.evaluate(async () => {
      const images = window.__nerveEditorProbe?.images
      const image = images?.element('first')
      if (!image || !images)
        throw new Error('实际图片没有解码')
      // 只破坏该实际图元的原生元素；没有替换全局 Image/canvas，也没有修改模型或创建另一个渲染器。
      await new Promise<void>((resolve) => {
        // 让这个元素保持坏图，固定 SDK 内置占位图接管之前的绘制边界；不影响其他元素或画布。
        image.addEventListener('error', (event) => {
          event.stopImmediatePropagation()
          resolve()
        }, { capture: true, once: true })
        image.src = 'data:image/png;base64,AAAA'
      })
      images.redraw()
      return { complete: image.complete, width: image.naturalWidth }
    })
    expect(broken).toEqual({ complete: true, width: 0 })
    await imageFailureSentinel(page, documentId, '坏图之后的真实绘制哨兵')
  })

  test('浮图、单元格图片和 IMAGE 经正式资源读取，实际图元完成解码且模型无临时地址', async ({ page }, testInfo) => {
    const { asset, documentId } = await prepare(page)
    const replies: import('@playwright/test').Response[] = []
    page.on('response', (response) => {
      if (new URL(response.url()).pathname === asset.url)
        replies.push(response)
    })
    await openAndEnterEditing(page, documentId, 'steady')
    await expect.poll(async () => page.evaluate(() => {
      const images = window.__nerveEditorProbe?.images
      return ['first', 'second'].map((id) => {
        const image = images?.element(id)
        return image === undefined ? null : { complete: image.complete, width: image.naturalWidth, height: image.naturalHeight, blob: image.src.startsWith('blob:') }
      })
    })).toEqual(Array.from({ length: 2 }, () => ({ complete: true, width: asset.width, height: asset.height, blob: true })))
    expect(replies.length).toBeGreaterThan(0)
    for (const response of replies) {
      await expectAssetHeaders(response, 200, asset.mimeType)
      expect(response.request().resourceType()).toBe('fetch')
      expect((await response.request().allHeaders())['cache-control']).toMatch(/no-cache|no-store/)
    }
    const snapshot = await probeSnapshot(page)
    expect(snapshot).toContain(asset.url)
    expect(snapshot).not.toMatch(/blob:|data:image/)
    expect(await page.evaluate(() => window.__nerveEditorProbe?.openCheck)).toEqual({ ok: true })
    for (const a1 of ['C3', 'F3', 'A8', 'D8'])
      await expectImagePixels(page, a1)
    await testInfo.attach('实际编辑器图片', { body: await sheetCanvas(page).screenshot(), contentType: 'image/png' })
  })

  test('同源图片移动缩放、换源和撤销重做互不污染，切表及重开后二次保存稳定', async ({ page }) => {
    const { asset, documentId } = await prepare(page)
    const other = await uploadAsset(page, 'palette.png')
    await openAndEnterEditing(page, documentId, 'steady')
    await expectImagePixels(page, 'F3')
    const second = await page.evaluateHandle(() => window.__nerveEditorProbe?.images.element('second'))
    const secondSource = await second.evaluate(image => image?.src)
    expect(secondSource).toMatch(/^blob:/)
    expect(await page.evaluate(async (source) => {
      // FOverGridImage 是该次查询的值对象，每步从实际服务重新取；不把旧 transform 写回。
      const current = () => {
        const image = window.__nerveEditorProbe?.univerAPI.getActiveWorkbook().getActiveSheet().getImages().find(image => image.getId() === 'first')
        if (!image)
          throw new Error('没有第一张真实图片')
        return image
      }
      const moved = await current().setPositionAsync(9, 2)
      const resized = await current().setSizeAsync(160, 100)
      const probe = window.__nerveEditorProbe
      if (!probe)
        throw new Error('没有编辑器探针')
      const snapshot = JSON.parse(probe.snapshot()) as { id: string, resources: { name: string, data: string }[] }
      const resource = snapshot.resources.find(item => item.name === 'SHEET_DRAWING_PLUGIN')
      if (!resource)
        throw new Error('没有当前图片模型')
      const image = (JSON.parse(resource.data) as { images: { data: { first: object } } }).images.data.first
      // setSource 会先修改它持有的模型对象；正式命令使用独立 payload，保留正确的旧值与 undo。
      const replaced = await probe.univerAPI.executeCommand('sheet.command.set-sheet-image', { unitId: snapshot.id, drawings: [{ ...image, source }] })
      return [moved, resized, replaced]
    }, other.url)).toEqual([true, true, true])
    await expect.poll(async () => page.evaluate(() => window.__nerveEditorProbe?.images.element('first')?.src)).not.toBe(secondSource)
    expect(await second.evaluate(image => image?.src)).toBe(secondSource)
    await expectImagePixels(page, 'F3')
    await expect.poll(async () => drawingsIn(await probeSnapshot(page)).first).toMatchObject({ source: other.url, transform: { width: 160, height: 100 }, sheetTransform: { from: { row: 9, column: 2 } } })
    expect(await page.evaluate(async () => window.__nerveEditorProbe?.univerAPI.executeCommand('univer.command.undo'))).toBe(true)
    await expect.poll(async () => drawingsIn(await probeSnapshot(page)).first?.source).toBe(asset.url)
    expect(await page.evaluate(async () => window.__nerveEditorProbe?.univerAPI.executeCommand('univer.command.redo'))).toBe(true)
    await expect.poll(async () => drawingsIn(await probeSnapshot(page)).first?.source).toBe(other.url)
    const changed = drawingsIn(await probeSnapshot(page))
    await sheetTab(page, '切表对照').click()
    await sheetTab(page, '图片复核').click()
    await expectImagePixels(page, 'F3')
    await saveAndWait(page)
    expect(drawingsIn(await probeSnapshot(page))).toEqual(changed)
    await exitEditing(page, 'steady')
    await reloadAndEnterEditing(page, 'steady')
    await expectImagePixels(page, 'F3')
    expect(drawingsIn(await probeSnapshot(page))).toEqual(changed)
    await imageFailureSentinel(page, documentId, '图片变换后二次保存')
    expect(drawingsIn(JSON.stringify((await savedContent(page, documentId)).snapshot))).toEqual(changed)
    await second.dispose()
  })

  test('真实自动行高保持 Position 尺寸并更新锚点，Both 随行增高；显式行高撤销重做和重开稳定', async ({ page }) => {
    const { documentId } = await prepare(page, { secondAnchor: '1' })
    await openAndEnterEditing(page, documentId, 'steady')
    await setCellValue(page, 'A4', '自动行高')
    await page.evaluate(() => window.__nerveEditorProbe?.univerAPI.getActiveWorkbook().getActiveSheet().getRange('A4').setFontSize(48))
    await expect.poll(async () => drawingsIn(await probeSnapshot(page)).second?.transform.height).toBeGreaterThan(80)
    const automatic = drawingsIn(await probeSnapshot(page))
    expect(automatic.first).toMatchObject({ transform: { width: 120, height: 80 } })
    expect(automatic.first?.sheetTransform.to.row).toBeLessThan(6)
    expect(automatic.first?.axisAlignSheetTransform).toEqual(automatic.first?.sheetTransform)
    await expectImagePixels(page, 'C3')
    await expectImagePixels(page, 'F3')
    await page.evaluate(() => window.__nerveEditorProbe?.univerAPI.getActiveWorkbook().getActiveSheet().setRowHeight(3, 100))
    await expect.poll(async () => drawingsIn(await probeSnapshot(page)).second?.transform.height).toBe(160)
    const explicit = drawingsIn(await probeSnapshot(page))
    expect(explicit.first).toMatchObject({ transform: { width: 120, height: 80 } })
    expect(await page.evaluate(async () => window.__nerveEditorProbe?.univerAPI.executeCommand('univer.command.undo'))).toBe(true)
    await expect.poll(async () => drawingsIn(await probeSnapshot(page))).toEqual(automatic)
    expect(await page.evaluate(async () => window.__nerveEditorProbe?.univerAPI.executeCommand('univer.command.redo'))).toBe(true)
    await expect.poll(async () => drawingsIn(await probeSnapshot(page))).toEqual(explicit)
    await saveAndWait(page)
    await exitEditing(page, 'steady')
    await reloadAndEnterEditing(page, 'steady')
    expect(drawingsIn(await probeSnapshot(page))).toEqual(explicit)
    await imageFailureSentinel(page, documentId, '自动行高后第二次保存')
    expect(drawingsIn(JSON.stringify((await savedContent(page, documentId)).snapshot))).toEqual(explicit)
  })

  for (const failure of ['401', '404', '500', '503', 'broken', 'offline'] as const) {
    test(`图片 ${failure} 后仍能编辑绘制保存；明确重试恢复三种图片，不自动循环请求`, async ({ page }) => {
      const { asset, documentId } = await prepare(page)
      let reads = 0
      const path = `**${asset.url}`
      await page.route(path, async (route) => {
        reads += 1
        if (failure === 'offline') {
          await route.abort('internetdisconnected')
          return
        }
        if (failure === '401') {
          await route.fulfill({ status: 401, json: { error: { code: 'UNAUTHENTICATED', message: '图片会话验证失败', requestId: 'image-story' } } })
          return
        }
        await route.fulfill({ status: 200, contentType: 'image/png', headers: { 'x-asset-status': failure === 'broken' ? '200' : failure, 'cache-control': 'no-store' }, body: 'deliberately invalid image bytes' })
      })
      await openAndEnterEditing(page, documentId, 'steady')
      await expect(page.getByText('部分图片暂时无法显示', { exact: true })).toBeVisible()
      for (const a1 of ['C3', 'F3', 'A8', 'D8'])
        await expectImagePixels(page, a1, false)
      const before = reads
      expect(before).toBeGreaterThan(0)
      // 401 还触发既有本机会话撤权：本人复核后可新建一代；同代不重试。
      // 阅读、编辑各一实例，身份未变化最多各一读；真实撤权后最多各补一读。
      expect(before).toBeLessThanOrEqual(failure === '401' ? 4 : 2)
      await imageFailureSentinel(page, documentId, `${failure} 后编辑绘制与捕获`)
      expect(reads).toBe(before)
      await page.unroute(path)
      const response = page.waitForResponse(response => new URL(response.url()).pathname === asset.url)
      await page.getByRole('button', { name: '重新加载图片', exact: true }).click()
      await expectAssetHeaders(await response, 200, asset.mimeType)
      for (const a1 of ['C3', 'F3', 'A8', 'D8'])
        await expectImagePixels(page, a1)
      await expect(page.getByText('部分图片暂时无法显示', { exact: true })).toBeHidden()
      await imageFailureSentinel(page, documentId, `${failure} 恢复后二次保存`)
    })
  }
})
