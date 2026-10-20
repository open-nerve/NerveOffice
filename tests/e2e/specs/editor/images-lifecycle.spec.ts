import type { RebuildCalculationGate } from '../../../../apps/web/src/editor/testing/rebuild-calculation-gate.ts'
import { readFile } from 'node:fs/promises'
import { installRebuildCalculationGate } from '../../../../apps/web/src/editor/testing/rebuild-calculation-gate.ts'
import { FORMULA_MODE_PARAM, FORMULA_MODE_VALUES } from '../../../../apps/web/src/editor/testing/selftest-report.ts'
import { createDocument, createUser, grantDocument } from '../../support/database.ts'
import { probeSnapshot } from '../../support/editor-probe.ts'
import { expect, test } from '../../support/fixtures.ts'
import { expectImagePixels, imageFailureSentinel, prepareImageDocument } from '../../support/image-editor.ts'
import { imageSample } from '../../support/image-sample.ts'
import { logoutWithOpenEditor } from '../../support/logout.ts'
import { actAs, loginThroughApi, loginThroughUi } from '../../support/session.ts'
import { EDITOR_TEST_TIMEOUT, enterEditing, exitEditing, openAndEnterEditing, openReader, waitForEditorAccess } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

test.describe('US-M5-07 图片身份与旧实例的实际回收', { tag: '@test-build' }, () => {
  test('首次读取还没完成时恢复联网，旧请求取消后本实例三种图片都能恢复', async ({ page, context }) => {
    const { asset, documentId } = await prepareImageDocument(page)
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let captured = false
    let completed = false
    const path = `**${asset.url}`
    await page.route(path, async (route) => {
      if (captured) {
        await route.continue()
        return
      }
      captured = true
      try {
        const response = await route.fetch()
        await held
        await route.fulfill({ response })
      }
      finally {
        completed = true
      }
    })
    try {
      await openReader(page, documentId, 'steady')
      await expect.poll(() => captured).toBe(true)
      await context.setOffline(true)
      await context.setOffline(false)
      for (const a1 of ['C3', 'A8', 'D8'])
        await expectImagePixels(page, a1)
      release()
      await expect.poll(() => completed).toBe(true)
      await enterEditing(page, 'steady')
      await imageFailureSentinel(page, documentId, '首次慢读取取消后仍能保存')
    }
    finally {
      release()
      await expect.poll(() => !captured || completed).toBe(true)
      await page.unroute(path)
    }
  })

  test('主线程公式还在等停止通知时，旧实例的图片已经同步清除', async ({ page }, testInfo) => {
    const { asset, documentId } = await prepareImageDocument(page, { includeFormulas: true })
    await page.goto(`/documents/${documentId}?${new URLSearchParams({ [FORMULA_MODE_PARAM]: FORMULA_MODE_VALUES['main-thread'] }).toString()}`)
    await waitForEditorAccess(page, 'read', 'steady')
    await expect.poll(async () => page.evaluate(() => window.__nerveEditorProbe?.formulasSettled()), { timeout: 90_000 }).toBe(true)
    await expectImagePixels(page, 'C3')
    const observer = await page.evaluateHandle((source) => {
      const probe = window.__nerveEditorProbe
      if (!probe || probe.formulaMode !== 'main-thread')
        throw new Error('没有实际主线程编辑器')
      const elements = [probe.images.element('first'), probe.images.element('second'), probe.images.cached(source)]
      if (elements.some(image => !image?.src.startsWith('blob:')))
        throw new Error('旧原件还没有加载')
      const api = probe.univerAPI as unknown as {
        Event: { CommandExecuted: string }
        addEvent: (event: string, listener: (event: { id: string }) => void) => { dispose: () => void }
      }
      let stopped: { at: number, cleared: boolean, completed: boolean } | undefined
      let notifiedAfterStop: number | undefined
      const subscription = api.addEvent(api.Event.CommandExecuted, (event) => {
        if (event.id === 'formula.mutation.set-formula-calculation-stop')
          stopped = { at: performance.now(), cleared: elements.every(image => !image?.src.startsWith('blob:')), completed: probe.formulaProgress().completed }
        if (stopped && event.id === 'formula.mutation.set-formula-calculation-notification')
          notifiedAfterStop = performance.now()
      })
      return { result: () => ({ stopped, notifiedAfterStop }), dispose: () => subscription.dispose() }
    }, asset.url)
    const gate = await page.evaluateHandle<RebuildCalculationGate>(`(${installRebuildCalculationGate.toString()})(${JSON.stringify(documentId)}, "enter", window.__nerveEditorProbe)`)
    try {
      await enterEditing(page, 'steady')
      expect(await gate.evaluate(current => current.result())).toMatchObject({ kind: 'released' })
      const result = await observer.evaluate(current => current.result())
      expect(result.stopped).toMatchObject({ cleared: true, completed: false })
      expect(result.notifiedAfterStop).toBeGreaterThanOrEqual(result.stopped?.at ?? Number.POSITIVE_INFINITY)
      await testInfo.attach('清图先于公式结束', { body: JSON.stringify(result), contentType: 'application/json' })
      await expectImagePixels(page, 'C3')
      await imageFailureSentinel(page, documentId, '公式退出后新实例保存哨兵')
    }
    finally {
      await gate.evaluate(current => current.dispose())
      await observer.evaluate(current => current.dispose())
      await gate.dispose()
      await observer.dispose()
    }
  })

  test('真实工作簿在 Ready 前构造失败，只报告原始加载失败，之后仍能正常打开图片文档', async ({ page, pageErrors }) => {
    const { asset, documentId, owner } = await prepareImageDocument(page)
    const brokenId = await createDocument(owner, 'Ready 前构造失败', (unitId) => {
      // 按现有损坏文档夹具写库；真实页面、插件和 Workbook 构造器处理，不替换 SDK 或吞异常。
      const snapshot = JSON.parse(imageSample(unitId, asset.url)) as { sheets: Record<string, unknown> }
      snapshot.sheets.images = null
      return JSON.stringify(snapshot)
    })
    pageErrors.expectErrors()
    await page.goto(`/documents/${brokenId}`)
    const brokenUrl = page.url()
    await expect(page.getByText('编辑器加载失败，请刷新页面重试', { exact: true })).toBeVisible()
    await openAndEnterEditing(page, documentId, 'steady')
    await expectImagePixels(page, 'C3')
    await imageFailureSentinel(page, documentId, '加载失败后新文档保存哨兵')
    expect(pageErrors.list()).toEqual([`SheetEditorLoadError: 用快照创建工作簿时出错（${brokenUrl}）`])
  })

  test('本人退出和换人后清掉三种旧像素，本人重新登录才恢复；晚读取不能复活旧图', async ({ page, context }) => {
    const { asset, documentId, owner } = await prepareImageDocument(page)
    await openAndEnterEditing(page, documentId, 'steady')
    for (const a1 of ['C3', 'A8', 'D8'])
      await expectImagePixels(page, a1)
    const old = await page.evaluateHandle(() => window.__nerveEditorProbe?.images.element('first'))
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let captured = false
    let completed = false
    const path = `**${asset.url}`
    await page.route(path, async (route) => {
      try {
        const response = await route.fetch()
        captured = true
        await held
        await route.fulfill({ response })
      }
      finally {
        completed = true
      }
    })
    const other = await context.newPage()
    try {
      await context.setOffline(true)
      await context.setOffline(false)
      await expect.poll(() => captured).toBe(true)
      // 已解码元素本身已被清除，旧对象仍由 JSHandle 持有，不能靠垃圾回收冒充清理。
      await expect.poll(async () => old.evaluate(image => image?.src.startsWith('blob:'))).toBe(false)
      await other.goto('/')
      await logoutWithOpenEditor(other)
      await expect(page.getByRole('alert').filter({ hasText: '登录已过期或已在别处退出' })).toBeVisible()
      release()
      await expect.poll(() => completed).toBe(true)
      await page.unroute(path)
      for (const a1 of ['C3', 'A8', 'D8'])
        await expectImagePixels(page, a1, false)
      const replacement = await createUser('image-other')
      await loginThroughUi(other, replacement)
      await expect(other.getByRole('heading', { name: '我的空间', exact: true })).toBeVisible()
      for (const a1 of ['C3', 'A8', 'D8'])
        await expectImagePixels(page, a1, false)
      expect(await old.evaluate(image => image?.src.startsWith('blob:'))).toBe(false)
      // 真实重新登录入口发出会话通知；仅改 Cookie 不足以验证页面接线。
      await logoutWithOpenEditor(other)
      await loginThroughUi(other, owner)
      for (const a1 of ['C3', 'A8', 'D8'])
        await expectImagePixels(page, a1)
      await imageFailureSentinel(page, documentId, '本人回来后仍能编辑保存')
    }
    finally {
      release()
      await expect.poll(() => !captured || completed).toBe(true)
      await page.unroute(path)
      await old.dispose()
      await other.close()
    }
  })

  test('真实分享撤销时清图，重新授予后由新的状态查询恢复，不需要重开页面', async ({ page, anotherDevice }) => {
    const { documentId, owner } = await prepareImageDocument(anotherDevice)
    const reader = await createUser('image-reader')
    await grantDocument(documentId, reader, 'viewer', owner)
    await loginThroughApi(page, reader)
    await page.clock.install()
    await openReader(page, documentId, 'steady')
    for (const a1 of ['C3', 'A8', 'D8'])
      await expectImagePixels(page, a1)
    const old = await page.evaluateHandle(() => window.__nerveEditorProbe?.images.element('first'))
    await actAs(anotherDevice, 'DELETE', `/api/documents/${documentId}/grants/${reader.id}`)
    const denied = page.waitForResponse(response => response.url().includes(`/api/documents/${documentId}/edit-lease`) && response.status() === 404)
    await page.clock.fastForward(30_000)
    await denied
    await expect.poll(async () => old.evaluate(image => image?.src.startsWith('blob:'))).toBe(false)
    for (const a1 of ['C3', 'A8', 'D8'])
      await expectImagePixels(page, a1, false)
    await actAs(anotherDevice, 'PUT', `/api/documents/${documentId}/grants/${reader.id}`, { role: 'viewer' })
    await page.clock.fastForward(30_000)
    for (const a1 of ['C3', 'A8', 'D8'])
      await expectImagePixels(page, a1)
    await old.dispose()
  })

  test('阅读和编辑之间重建时旧原件立即清除，新实例独立读取；旧元素不会被新实例重新赋图', async ({ page }) => {
    const { asset, documentId } = await prepareImageDocument(page)
    await openReader(page, documentId, 'steady')
    await expectImagePixels(page, 'C3')
    const old = await page.evaluateHandle(() => window.__nerveEditorProbe?.images.element('first'))
    const decoded = await page.evaluateHandle(source => window.__nerveEditorProbe?.images.cached(source), asset.url)
    await enterEditing(page, 'steady')
    await expectImagePixels(page, 'C3')
    expect(await old.evaluate(image => image?.src.startsWith('blob:'))).toBe(false)
    expect(await decoded.evaluate(image => image?.src.startsWith('blob:'))).toBe(false)
    const editing = await page.evaluateHandle(() => window.__nerveEditorProbe?.images.element('first'))
    await exitEditing(page, 'steady')
    await expectImagePixels(page, 'C3')
    expect(await old.evaluate(image => image?.src.startsWith('blob:'))).toBe(false)
    expect(await editing.evaluate(image => image?.src.startsWith('blob:'))).toBe(false)
    await old.dispose()
    await decoded.dispose()
    await editing.dispose()
  })

  test('真实上传已经到达服务端、回包晚于实例退役：旧上传返回 null，新实例不接手', async ({ page }, testInfo) => {
    const { documentId } = await prepareImageDocument(page)
    await openAndEnterEditing(page, documentId, 'steady')
    const bytes = await readFile(new URL('../../../../apps/api/src/modules/assets/testdata/palette.png', import.meta.url))
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
    const uploading = page.evaluate(async data => window.__nerveEditorProbe?.images.upload(new File([new Uint8Array(data)], 'palette.png', { type: 'image/png' })), [...bytes])
    try {
      await expect.poll(() => captured).toBe(true)
      await testInfo.attach('退出前实际快照', { body: await probeSnapshot(page), contentType: 'application/json' })
      await exitEditing(page, 'steady')
      await testInfo.attach('退出后实际快照', { body: await probeSnapshot(page), contentType: 'application/json' })
      await testInfo.attach('退出后公式命令', { body: JSON.stringify(await page.evaluate(() => window.__nerveEditorProbe?.commands().filter(command => command.id.includes('formula')))), contentType: 'application/json' })
      expect(await uploading).toBeNull()
      release()
      await expect.poll(() => completed).toBe(true)
      await expectImagePixels(page, 'C3')
      await expectImagePixels(page, 'A8')
      await expectImagePixels(page, 'D8')
      await enterEditing(page, 'steady')
      await imageFailureSentinel(page, documentId, '旧上传退役后新实例仍可保存')
    }
    finally {
      release()
      await expect.poll(() => !captured || completed).toBe(true)
      await page.unroute('**/api/assets')
    }
  })
})
