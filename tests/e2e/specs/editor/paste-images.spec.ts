// 在单元格编辑器与编辑栏里粘贴带图片的内容（DEF-035 的旁支，M3-P2 设计 §3.3）：M5 之前不开放图片（P4 设计 §3.6.8），
// 单元格的富文本里也不能出现图片（单元格图片：地址是 data URL 或外链，P3 的完整校验会拒收这样的快照）。
// 核实的结论（M3-P2 S3，Chromium 与 WebKit 上合成的 paste 事件，图片文件与带 <img> 的 HTML）：
// - 编辑栏在编辑时（先键入过），docs-ui 按 source 方式粘贴，图片转成内部文档里的 drawings，回车之后写进单元格（p.drawings、
//   drawingsOrder），外链的图片画出来时还触发 CSP 的违规——入口守卫取消带图片的 doc.command.inner-paste（editor/profile/entry-guards.ts）；
// - 单元格编辑器按纯文字粘贴：只认 text/plain，没有时什么也不贴，不会写进图片——不拦，这里核对它照旧；
// - 表格上的粘贴（选中单元格、不在编辑）不把 <img> 写进单元格，图片文件走插入浮动图片（本来就被入口守卫取消）。
// 合成的 paste 事件派发在获得焦点的输入元素上（docs-ui 在那里监听粘贴），与真实的粘贴走同一条路（读 clipboardData）。
// 用到探针（只在测试构建里）：标签 @test-build
import type { Page } from '@playwright/test'
import type { Workbook } from '../../support/sheet.ts'
import { createUser } from '../../support/database.ts'
import { commandMark, probeSnapshot, waitForCommand } from '../../support/editor-probe.ts'
import { expect, test } from '../../support/fixtures.ts'
import { nextFrames } from '../../support/read-only.ts'
import { loginThroughApi } from '../../support/session.ts'
import { createSheetThroughApi, EDITOR_TEST_TIMEOUT, openEditor, selectCell } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

type Clipboard = 'image-file' | 'image-html' | 'image-html-and-text' | 'text'

/** 1×1 的 PNG（base64） */
const PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

/** 在获得焦点的元素上派发一次合成的粘贴：剪贴板里是 clipboard 这一种内容。返回事件是否被页面处理（取消了浏览器的默认粘贴） */
async function paste(page: Page, clipboard: Clipboard): Promise<boolean> {
  return page.evaluate(({ kind, png }) => {
    const data = new DataTransfer()
    if (kind === 'image-html' || kind === 'image-html-and-text')
      data.setData('text/html', '<meta charset="utf-8"><img src="https://example.com/x.png" width="20" height="20">')
    if (kind === 'image-html-and-text' || kind === 'text')
      data.setData('text/plain', 'xyz')
    if (kind === 'image-file')
      data.items.add(new File([Uint8Array.from(atob(png), char => char.charCodeAt(0))], 'x.png', { type: 'image/png' }))
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
    document.activeElement?.dispatchEvent(event)
    return event.defaultPrevented
  }, { kind: clipboard, png: PIXEL_PNG })
}

/** 内存里第一张表的 B2 */
async function b2(page: Page): Promise<{ readonly v?: unknown, readonly p?: { readonly drawings?: Record<string, unknown>, readonly drawingsOrder?: readonly string[] } } | undefined> {
  const workbook = JSON.parse(await probeSnapshot(page)) as Workbook
  return workbook.sheets[workbook.sheetOrder[0] ?? '']?.cellData[1]?.[1] as never
}

/** 选中 B2，点编辑栏的编辑框，键入一个字（编辑栏进入编辑：这时粘贴才贴得进去） */
async function editInFormulaBar(page: Page): Promise<void> {
  await selectCell(page, 'B2')
  await page.locator('[data-u-comp="formula-bar"] [data-u-comp="formula-editor"]').click()
  await expect(page.locator('[id="__editor___INTERNAL_EDITOR__DOCS_FORMULA_BAR"]')).toBeFocused()
  await page.keyboard.type('a')
  await nextFrames(page)
}

/** 选中 B2 键入一个字（单元格编辑器打开） */
async function editInCell(page: Page): Promise<void> {
  await selectCell(page, 'B2')
  await page.keyboard.type('a')
  await expect(page.locator('[id="__editor___INTERNAL_EDITOR__DOCS_NORMAL"]')).toBeFocused()
  await nextFrames(page)
}

/** 回车提交，等这一格写进工作簿 */
async function commit(page: Page): Promise<void> {
  const mark = await commandMark(page)
  await page.keyboard.press('Enter')
  await waitForCommand(page, mark, { phase: 'executed', id: 'sheet.command.set-range-values' })
}

async function open(page: Page, prefix: string): Promise<void> {
  await loginThroughApi(page, await createUser(prefix))
  await openEditor(page, await createSheetThroughApi(page), 'steady')
}

test.describe('在单元格编辑器与编辑栏里粘贴带图片的内容：单元格里不会有图片（DEF-035 的旁支）', { tag: '@test-build' }, () => {
  for (const clipboard of ['image-file', 'image-html', 'image-html-and-text'] as const) {
    test(`编辑栏在编辑时粘贴（${clipboard}）：整次粘贴被入口守卫取消，回车之后 B2 只有键入的字，没有图片（外链的图片也就不加载）`, async ({ page }) => {
      await open(page, 'paste-bar')
      await editInFormulaBar(page)
      const mark = await commandMark(page)
      expect(await paste(page, clipboard)).toBe(true)
      await waitForCommand(page, mark, { phase: 'before', id: 'doc.command.inner-paste', canceled: true })
      await commit(page)
      const cell = await b2(page)
      expect(cell?.v).toBe('a')
      expect(cell?.p?.drawings ?? {}).toEqual({})
      expect(cell?.p?.drawingsOrder ?? []).toEqual([])
    })
  }

  test('对照：编辑栏在编辑时粘贴纯文字照常贴进去（粘贴的路径是通的，上面的"没有图片"不是空断言）', async ({ page }) => {
    await open(page, 'paste-bar-text')
    await editInFormulaBar(page)
    const mark = await commandMark(page)
    expect(await paste(page, 'text')).toBe(true)
    await waitForCommand(page, mark, { phase: 'executed', id: 'doc.command.inner-paste' })
    await commit(page)
    // 编辑栏贴进来的是富文本：值在 p 的正文里
    const cell = await b2(page)
    expect(JSON.stringify(cell)).toContain('axyz')
    expect(cell?.p?.drawings ?? {}).toEqual({})
  })

  test('单元格编辑器按纯文字粘贴（不拦）：带图片与文字的 HTML 贴进去只有文字；只有图片时什么也不贴', async ({ page }) => {
    await open(page, 'paste-cell')
    await editInCell(page)
    const mark = await commandMark(page)
    await paste(page, 'image-html-and-text')
    await waitForCommand(page, mark, { phase: 'executed', id: 'doc.command.inner-paste' })
    await paste(page, 'image-file')
    await paste(page, 'image-html')
    await commit(page)
    const cell = await b2(page)
    expect(cell?.p?.drawings ?? {}).toEqual({})
    expect(cell?.p?.drawingsOrder ?? []).toEqual([])
    // 只贴进了文字：单元格的值是键入的字加上剪贴板里的文字（富文本时值在 p 的正文里）
    expect(JSON.stringify(cell)).toContain('axyz')
  })
})
