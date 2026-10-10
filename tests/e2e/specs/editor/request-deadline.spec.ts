// M4-P2 S2、DEF-041：真实 HTTP 响应头/正文悬挂；保存已经提交仍按未知结果重放。
// 使用测试构建暂停定时自动保存，按钮驱动的两次上传可逐一比较；页面时钟只加快等待，不替换网络或正文流。
import { advanceUntil, pauseTime } from '../../support/autosave.ts'
import { createUser, editLeaseEndReason, revisionOf } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, enterEditing, exitEditButton, saveAndWait, saveButton, savedContent, saveStatus, typeInCell, waitForEditorAccess } from '../../support/sheet.ts'
import { startResponseStall } from '../../support/stalled-response.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

test.describe('完整请求时限与未知结果', { tag: '@test-build' }, () => {
  for (const stage of ['headers', 'body', 'error-body'] as const) {
    test(`保存已提交但 ${stage} 挂住：30 秒仍等待、60 秒超时，原样重试只确认原修订`, async ({ page }) => {
      await page.clock.install()
      await loginThroughApi(page, await createUser('deadline-save'))
      const documentId = await createSheetThroughApi(page)
      const stalled = await startResponseStall('PUT', `/api/documents/${documentId}/content`, stage)
      try {
        await page.goto(`${stalled.origin}/documents/${documentId}`)
        await waitForEditorAccess(page, 'read')
        await enterEditing(page)
        await typeInCell(page, 'A1', '超时后也只保存一次')
        await saveButton(page).focus()
        await pauseTime(page)
        await page.keyboard.press('Enter')
        await advanceUntil(page, async () => stalled.received(), '真实后端完整回答后暂停响应')
        expect(stalled.status()).toBe(200)
        expect(await revisionOf(documentId)).toBe(2)
        await page.clock.fastForward(30_000)
        await expect(saveStatus(page)).toHaveText('保存中…')
        expect(stalled.closed()).toBe(false)
        await page.clock.fastForward(31_000)
        await expect(saveStatus(page)).toHaveText('保存失败，稍后自动重试')
        await expect(page.getByRole('alert')).toHaveText('保存失败：网络没有回应，请稍后重试')
        await expect.poll(() => stalled.closed()).toBe(true)
        expect(stalled.fingerprints()).toHaveLength(1)

        await page.clock.resume()
        await saveAndWait(page)
        const sent = stalled.fingerprints()
        expect(sent).toHaveLength(2)
        // 哈希同时覆盖 URL 的 requestId/序号/基准/代次、租约头与原 gzip 字节；不把内容或令牌输出到证据。
        expect(sent[1]).toBe(sent[0])
        expect(await revisionOf(documentId)).toBe(2)
        const saved = await savedContent(page, documentId)
        expect(cellOf(saved.snapshot, 'A1')?.v).toBe('超时后也只保存一次')
        stalled.release()
        await expect(saveStatus(page)).toHaveText('已保存到云端')
        await expect(page.getByRole('alert')).toHaveCount(0)
      }
      finally {
        await stalled.close()
      }
    })
  }

  test('keepalive 释放回包挂住：页面 5 秒后照常退出，请求 10 秒后中止', async ({ page }) => {
    await page.clock.install()
    await loginThroughApi(page, await createUser('deadline-release'))
    const documentId = await createSheetThroughApi(page)
    const stalled = await startResponseStall('DELETE', `/api/documents/${documentId}/edit-lease`, 'headers')
    let cancelled = false
    page.on('requestfailed', (request) => {
      if (request.method() === 'DELETE' && new URL(request.url()).pathname === `/api/documents/${documentId}/edit-lease`)
        cancelled = true
    })
    try {
      await page.goto(`${stalled.origin}/documents/${documentId}`)
      await waitForEditorAccess(page, 'read')
      await enterEditing(page)
      await exitEditButton(page).focus()
      await pauseTime(page)
      await page.keyboard.press('Enter')
      await advanceUntil(page, async () => stalled.received(), '后端已释放，响应仍未发到浏览器')
      expect(stalled.status()).toBe(204)
      expect(await editLeaseEndReason(documentId)).toBe('released')
      await page.clock.fastForward(5_001)
      await advanceUntil(page, async () => {
        const surface = page.locator('#sheet-editor')
        return await surface.getAttribute('data-editor-access') === 'read' && ['ready', 'steady'].includes(await surface.getAttribute('data-editor-state') ?? '')
      }, '5 秒释放等待结束后只读编辑器就绪')
      expect(cancelled).toBe(false)
      expect(stalled.closed()).toBe(false)
      await page.clock.fastForward(5_000)
      await expect.poll(() => cancelled).toBe(true)
      stalled.release()
      await page.clock.resume()
      await waitForEditorAccess(page, 'read')
    }
    finally {
      await stalled.close()
    }
  })
})
