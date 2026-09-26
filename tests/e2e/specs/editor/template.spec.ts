// 模板与档案（P4 设计 §3.4、§3.6.8、§3.10）：新建的文档打开后立即保存，快照与模板逐字节相同（id 除外），即模板仍然收敛；
// M5 之前图片与超链接的入口不存在：菜单里没有，Ctrl/Cmd+K 没有反应，粘贴图片文件不产生图片。
import { sheetSnapshotFor } from '@nerve-office/contracts'
import { createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'
import { createSheetThroughApi, openEditor, saveAndWait, savedContent, selectCell } from '../../support/sheet.ts'

/** 1×1 的 PNG */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test.describe('US-M1-06 新建的表格用收敛的模板', () => {
  test('新建的文档打开后立即保存：快照与模板逐字节相同（id 除外），打开不算修改', async ({ page }) => {
    await loginThroughApi(page, await createUser('template-converges'))
    const documentId = await createSheetThroughApi(page)
    const created = await savedContent(page, documentId)
    await openEditor(page, documentId, 'steady')
    await saveAndWait(page)
    const saved = await savedContent(page, documentId)
    expect(saved.revision).toBe(2)
    expect(saved.text).toBe(sheetSnapshotFor(saved.snapshot.id))
    expect(saved.text).toBe(created.text)
  })
})

test.describe('US-M1-09 M5 之前没有图片与超链接的入口', () => {
  test('插入菜单与右键菜单里没有图片、链接与保护；Ctrl/Cmd+K 没有反应', async ({ page }) => {
    await loginThroughApi(page, await createUser('guards-menus'))
    const documentId = await createSheetThroughApi(page)
    await openEditor(page, documentId, 'steady')
    await page.getByRole('tab', { name: '插入', exact: true }).click()
    const toolbar = page.getByRole('toolbar', { name: '插入' })
    await expect(toolbar).toBeVisible()
    await expect(toolbar.getByRole('button', { name: /图片|链接/ })).toHaveCount(0)
    await page.getByRole('tab', { name: '开始', exact: true }).click()

    await selectCell(page, 'B2', { button: 'right' })
    await expect(page.getByText('选择性复制')).toBeVisible()
    await expect(page.getByText(/^(?:插入链接|链接|超链接|保护|保护区域|插入图片|图片)$/).filter({ visible: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.getByText('选择性复制')).toBeHidden()

    await selectCell(page, 'B2')
    await page.keyboard.press('ControlOrMeta+k')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByText(/链接/).filter({ visible: true })).toHaveCount(0)
  })

  test('粘贴图片文件：不产生图片', async ({ page }) => {
    await loginThroughApi(page, await createUser('guards-paste'))
    const documentId = await createSheetThroughApi(page)
    await openEditor(page, documentId, 'steady')
    await selectCell(page, 'C3')
    await page.evaluate((base64) => {
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0))
      const data = new DataTransfer()
      data.items.add(new File([bytes], 'picture.png', { type: 'image/png' }))
      const target = document.activeElement ?? document.body
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }, PNG)
    await saveAndWait(page)
    const { resources } = (await savedContent(page, documentId)).snapshot
    expect(resources.find(resource => resource.name === 'SHEET_DRAWING_PLUGIN')?.data).toBe('{}')
  })
})
