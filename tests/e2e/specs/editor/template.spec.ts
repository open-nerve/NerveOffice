// 模板与档案（P4 设计 §3.4、§3.6.8、§3.10）：新建的文档打开后立即保存，上传的快照与模板逐字节相同（id 除外），即模板仍然收敛
// （M3-P3 起看上传的正文：内容相同的保存服务端不存，设计 §3.11）；
// M5 之前图片与超链接的入口不存在：菜单里没有，Ctrl/Cmd+K 没有反应，粘贴图片文件不产生图片。
// 键入、粘贴网址时 SDK 的自动识别不是入口，照常保留；M3-P3 起写进单元格之前改成规范写法、不合法的去掉链接（DEF-021，
// editor/profile/link-policy.ts）：这里核对存下的是规范写法，各条路径（编辑栏、单元格编辑器、HTML、HYPERLINK()）与撤销重做见 links.spec.ts。
import { sheetSnapshotFor } from '@nerve-office/contracts'
import { createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { pressUniverShortcut } from '../../support/keyboard.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, openAndEnterEditing, saveAndCapture, saveAndWait, savedContent, selectCell, typeInCell } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

/** 1×1 的 PNG */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** 富文本里链接的地址（CustomRangeType.HYPERLINK 是 0） */
function linksIn(cell: ReturnType<typeof cellOf>): string[] {
  return (cell?.p?.body?.customRanges ?? []).filter(range => range.rangeType === 0).map(range => range.properties?.url ?? '')
}

test.describe('US-M1-06 新建的表格用收敛的模板', () => {
  // M3-P3 起内容相同的保存不存这次的字节（设计 §3.7）：收敛看本页上传的正文（本页捕获的），服务器上的随之不变、修订号不增加
  test('新建的文档打开后立即保存：上传的快照与模板逐字节相同（id 除外），打开不算修改；内容相同，修订号不增加', async ({ page }) => {
    await loginThroughApi(page, await createUser('template-converges'))
    const documentId = await createSheetThroughApi(page)
    const created = await savedContent(page, documentId)
    await openAndEnterEditing(page, documentId, 'steady')
    const { uploaded, answer } = await saveAndCapture(page)
    expect(uploaded).toBe(sheetSnapshotFor(created.snapshot.id))
    expect(uploaded).toBe(created.text)
    expect(answer).toMatchObject({ revision: 1, unchanged: true })
    const saved = await savedContent(page, documentId)
    expect([saved.revision, saved.text]).toEqual([1, created.text])
  })
})

test.describe('US-M1-09 M5 之前没有图片与超链接的入口', () => {
  test('插入菜单与右键菜单里没有图片、链接与保护；Ctrl/Cmd+K 没有反应', async ({ page }) => {
    await loginThroughApi(page, await createUser('guards-menus'))
    const documentId = await createSheetThroughApi(page)
    await openAndEnterEditing(page, documentId, 'steady')
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
    // Univer 按页面的平台取主修饰键（Linux 上的 WebKit 也自称 Mac）：ControlOrMeta 在那里按下的 Control+K 根本不是它的快捷键，这一步就白测了
    await pressUniverShortcut(page, 'K')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByText(/链接/).filter({ visible: true })).toHaveCount(0)
  })

  test('键入网址：SDK 自动识别为链接（不经入口守卫），存下的是规范写法（没有协议时 SDK 补的 https:// 之外再补上路径的 /，DEF-021）；文字是键入的原文，普通文字不变', async ({ page }) => {
    await loginThroughApi(page, await createUser('guards-autolink'))
    const documentId = await createSheetThroughApi(page)
    await openAndEnterEditing(page, documentId, 'steady')
    await typeInCell(page, 'A1', 'https://example.com/page')
    await typeInCell(page, 'A3', 'example.com')
    await typeInCell(page, 'A5', 'plain text')
    await saveAndWait(page)
    const { snapshot } = await savedContent(page, documentId)
    expect(cellOf(snapshot, 'A1')?.v).toBe('https://example.com/page')
    expect(linksIn(cellOf(snapshot, 'A1'))).toEqual(['https://example.com/page'])
    expect(cellOf(snapshot, 'A3')?.v).toBe('example.com')
    expect(linksIn(cellOf(snapshot, 'A3'))).toEqual(['https://example.com/'])
    expect(cellOf(snapshot, 'A5')).toMatchObject({ v: 'plain text' })
    expect(cellOf(snapshot, 'A5')?.p).toBeUndefined()
  })

  test('键入邮箱、粘贴纯文本的网址：存下的是规范写法（邮箱是 mailto:），粘贴的没有协议的写法不合法，去掉链接、保留文字（DEF-021）', async ({ page }) => {
    await loginThroughApi(page, await createUser('guards-autolink-paste'))
    const documentId = await createSheetThroughApi(page)
    await openAndEnterEditing(page, documentId, 'steady')
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
    expect(linksIn(cellOf(snapshot, 'A1'))).toEqual(['mailto:user@example.com'])
    expect(linksIn(cellOf(snapshot, 'C1'))).toEqual([])
    expect(cellOf(snapshot, 'C1')?.p?.body?.dataStream).toBe('example.org\r\n')
    expect(linksIn(cellOf(snapshot, 'C2'))).toEqual(['https://paste.example/p?q=1'])
  })

  test('粘贴图片文件：不产生图片', async ({ page }) => {
    await loginThroughApi(page, await createUser('guards-paste'))
    const documentId = await createSheetThroughApi(page)
    await openAndEnterEditing(page, documentId, 'steady')
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
