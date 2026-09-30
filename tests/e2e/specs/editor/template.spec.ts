// 模板与档案（P4 设计 §3.4、§3.6.8、§3.10）：新建的文档打开后立即保存，快照与模板逐字节相同（id 除外），即模板仍然收敛；
// M5 之前图片与超链接的入口不存在：菜单里没有，Ctrl/Cmd+K 没有反应，粘贴图片文件不产生图片。
// 键入网址时 SDK 的自动识别不是入口，M1 保留（DEF-021）：这里锁定它的行为，M3 实现链接地址的判定时据此修改。
import { sheetSnapshotFor } from '@nerve-office/contracts'
import { createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, openEditor, saveAndWait, savedContent, selectCell, typeInCell } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

/** 1×1 的 PNG */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** 富文本里链接的地址（CustomRangeType.HYPERLINK 是 0） */
function linksIn(cell: ReturnType<typeof cellOf>): string[] {
  return (cell?.p?.body?.customRanges ?? []).filter(range => range.rangeType === 0).map(range => range.properties?.url ?? '')
}

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

  test('键入网址：SDK 自动识别为链接，地址是键入的原文，没有协议时补 https://（不经入口守卫，DEF-021）；普通文字不变', async ({ page }) => {
    await loginThroughApi(page, await createUser('guards-autolink'))
    const documentId = await createSheetThroughApi(page)
    await openEditor(page, documentId, 'steady')
    await typeInCell(page, 'A1', 'https://example.com/page')
    await typeInCell(page, 'A3', 'example.com')
    await typeInCell(page, 'A5', 'plain text')
    await saveAndWait(page)
    const { snapshot } = await savedContent(page, documentId)
    expect(cellOf(snapshot, 'A1')?.v).toBe('https://example.com/page')
    expect(linksIn(cellOf(snapshot, 'A1'))).toEqual(['https://example.com/page'])
    expect(linksIn(cellOf(snapshot, 'A3'))).toEqual(['https://example.com'])
    expect(cellOf(snapshot, 'A5')).toMatchObject({ v: 'plain text' })
    expect(cellOf(snapshot, 'A5')?.p).toBeUndefined()
  })

  test('键入邮箱、粘贴纯文本的网址：同样被识别为链接，地址是原文（邮箱写成 mailto://，粘贴的不补协议；DEF-021）', async ({ page }) => {
    await loginThroughApi(page, await createUser('guards-autolink-paste'))
    const documentId = await createSheetThroughApi(page)
    await openEditor(page, documentId, 'steady')
    await typeInCell(page, 'A1', 'user@example.com')
    for (const [cell, text] of [['C1', 'example.org'], ['C2', 'https://paste.example/p?q=1']] as const) {
      await selectCell(page, cell)
      await page.evaluate((plain) => {
        const data = new DataTransfer()
        data.setData('text/plain', plain)
        const target = document.activeElement ?? document.body
        target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
      }, text)
    }
    await saveAndWait(page)
    const { snapshot } = await savedContent(page, documentId)
    expect(linksIn(cellOf(snapshot, 'A1'))).toEqual(['mailto://user@example.com'])
    expect(linksIn(cellOf(snapshot, 'C1'))).toEqual(['example.org'])
    expect(linksIn(cellOf(snapshot, 'C2'))).toEqual(['https://paste.example/p?q=1'])
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
