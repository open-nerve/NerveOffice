// US-M3-14 写入之前改写自动识别的链接（M3-P3 设计 §3.6，DEF-021）。
// SDK 自动识别出的链接（单元格里键入、编辑栏里键入与粘贴、选中单元格粘贴纯文本、单元格编辑器里粘贴、粘贴带链接的 HTML）与 HYPERLINK() 的结果，
// 写进单元格之前由链接的改写器（apps/web/src/editor/profile/link-policy.ts）改成规范写法，不合法的去掉链接、保留文字。每条路径都核对：
// - 页面里（探针给出的内存快照）是规范写法，或者链接已去掉、文字还在；
// - 撤销两步、重做两步之后与之前相同（改写不单独进撤销栈，重做出来的就是改写之后的）；
// - 保存之后服务器上的内容与页面里的相同，其中每个链接都通过服务端的核对（contracts 的 checkCellLinks）；
// - HYPERLINK() 的结果：链接的 rangeId 与段落的 paragraphId 由位置与序号确定，强制重算、撤销重做、重开（打开时要重算）之后内容不变。
// 改写依赖 SDK 的内部约定（执行前事件的参数就是处理器与撤销栈用的同一个对象，internal-api 的 CELL_LINK_PROTOCOL）：SDK 升级之后改成复制参数时，
// 这组用例先失败。另有跨引擎的同一组地址：经探针调用页面里打包的 canonicalLink，每个浏览器的结果都等于 Node 的单元测试用的那张表；
// 以及跨引擎的性质检验：逐字符扫描与随机拼出的地址交给每个浏览器，浏览器判为合法的规范写法交给测试进程里的 contracts（与服务端同一份判定）
// 再判定一次，要求合法且相等——页面按本引擎的结果改写，服务端只收等于规范写法的地址，不相等的那份表格在这个浏览器里就存不进去（审查 B1）。
// 合成的 paste 事件派发在获得焦点的元素上（SDK 在那里监听粘贴，与真实的粘贴走同一条路，paste-images.spec.ts 同样的做法）。
// 用到探针（只在测试构建里）：标签 @test-build
import type { CanonicalLink, LinkAddressInvalidReason } from '@nerve-office/contracts'
import type { Page } from '@playwright/test'
import type { LinkAddressCase } from '../../../../packages/contracts/src/documents/link-address.test-support.ts'
import type { Workbook } from '../../support/sheet.ts'
import { canonicalContentText, canonicalLink, checkCellLinks } from '@nerve-office/contracts'
import { LINK_ADDRESS_CASES, LINK_SCAN_INPUTS, randomLinkAddresses } from '../../../../packages/contracts/src/documents/link-address.test-support.ts'
import { createUser } from '../../support/database.ts'
import { commandMark, probeCanonicalLinks, probeCommands, probeSnapshot, runFacade, waitForCommand } from '../../support/editor-probe.ts'
import { expect, test } from '../../support/fixtures.ts'
import { pressUniverShortcut } from '../../support/keyboard.ts'
import { formulaBarEditor, formulaBarInput } from '../../support/read-only-checks.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, enterEditing, openAndEnterEditing, openCellEditor, openReader, saveAndWait, savedContent, selectCell, waitForEditorAccess } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

/** 写单元格的 mutation：各条路径与公式的结果都经它写进单元格 */
const SET_RANGE_VALUES = 'sheet.mutation.set-range-values'

/** 单元格编辑器接收输入的元素（docs-ui 给编辑器的 id） */
const CELL_EDITOR_INPUT = '[id="__editor___INTERNAL_EDITOR__DOCS_NORMAL"]'

/** SDK 的链接浮层（鼠标停在带链接的单元格上时弹出，会挡住旁边的单元格）里的"复制"按钮 */
const LINK_POPUP = '[data-u-comp="cell-link-popup-copy"]'

type Cell = ReturnType<typeof cellOf>

async function open(page: Page, prefix: string): Promise<string> {
  await loginThroughApi(page, await createUser(prefix))
  const documentId = await createSheetThroughApi(page)
  await openAndEnterEditing(page, documentId, 'steady')
  return documentId
}

/** 内存里的快照（与保存时的捕获相同） */
async function shown(page: Page): Promise<Workbook> {
  return JSON.parse(await probeSnapshot(page)) as Workbook
}

/** 单元格里链接（CustomRangeType.HYPERLINK，0）的地址 */
function linksIn(cell: Cell): string[] {
  return (cell?.p?.body?.customRanges ?? []).filter(range => range.rangeType === 0).map(range => range.properties?.url ?? '')
}

/** 每个单元格的链接是不是都是期望的（没写的单元格不管） */
function expectLinks(workbook: Workbook, expected: Readonly<Record<string, readonly string[]>>): void {
  for (const [a1, links] of Object.entries(expected))
    expect(linksIn(cellOf(workbook, a1)), a1).toEqual(links)
}

/** 服务器上的内容里每个单元格的链接都通过服务端的核对（contracts 的 checkCellLinks）；返回核对过的链接数（用例据此确认不是空的核对） */
function expectServerAccepts(workbook: Workbook): number {
  const cells = Object.values(workbook.sheets).flatMap(sheet => Object.entries(sheet.cellData).flatMap(([row, columns]) => Object.entries(columns).map(([column, cell]) => ({ at: `${row},${column}`, cell }))))
  expect(cells.flatMap(({ at, cell }) => {
    const check = checkCellLinks(cell.p)
    return check.ok ? [] : [`${at}：${check.rule}`]
  })).toEqual([])
  return cells.reduce((count, { cell }) => count + linksIn(cell).length, 0)
}

/** 做 act，等写单元格的 mutation 执行完（这一格写进了工作簿） */
async function written(page: Page, act: () => Promise<unknown>): Promise<void> {
  const mark = await commandMark(page)
  await act()
  await waitForCommand(page, mark, { phase: 'executed', id: SET_RANGE_VALUES })
}

/** 在选中的单元格里键入、回车提交：等写进工作簿、选区下移（之后接着键入的就是下一格） */
async function typeDown(page: Page, text: string): Promise<void> {
  const mark = await commandMark(page)
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
  await waitForCommand(page, mark, { phase: 'executed', id: SET_RANGE_VALUES })
  await waitForCommand(page, mark, { phase: 'executed', id: 'sheet.command.move-selection-enter-tab' })
}

/** 选区下移一格（方向键），等它移过去 */
async function moveDown(page: Page): Promise<void> {
  const mark = await commandMark(page)
  await page.keyboard.press('ArrowDown')
  await waitForCommand(page, mark, { phase: 'executed', id: 'sheet.command.move-selection' })
}

/** 在获得焦点的元素上派发一次合成的粘贴：剪贴板里是 plain（text/plain）与 html（text/html，包进完整的文档） */
async function paste(page: Page, clipboard: { readonly plain: string, readonly html?: string }): Promise<void> {
  await page.evaluate(({ plain, html }) => {
    const data = new DataTransfer()
    if (html !== undefined)
      data.setData('text/html', `<html><body>${html}</body></html>`)
    data.setData('text/plain', plain)
    document.activeElement?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, clipboard)
}

/** 编辑器（单元格编辑器或编辑栏）里粘贴：等内部文档收下这次粘贴 */
async function pasteInEditor(page: Page, clipboard: { readonly plain: string, readonly html?: string }): Promise<void> {
  const mark = await commandMark(page)
  await paste(page, clipboard)
  await waitForCommand(page, mark, { phase: 'executed', id: 'doc.command.inner-paste' })
}

/** 鼠标移到表格之外，等链接的浮层收起：之后按位置点单元格不会点到浮层上 */
async function mouseAway(page: Page): Promise<void> {
  await page.mouse.move(1, 1)
  await expect(page.locator(LINK_POPUP).first()).toBeHidden()
}

/** 选中 a1，在编辑栏里编辑（点编辑框，做 act），回车提交 */
async function inFormulaBar(page: Page, a1: string, act: () => Promise<void>): Promise<void> {
  await mouseAway(page)
  await selectCell(page, a1)
  await formulaBarEditor(page).click()
  await expect(formulaBarInput(page)).toBeFocused()
  await act()
  await written(page, async () => page.keyboard.press('Enter'))
}

/** 双击 a1 打开单元格编辑器，粘贴，回车提交 */
async function pasteInCellEditor(page: Page, a1: string, clipboard: { readonly plain: string }): Promise<void> {
  await mouseAway(page)
  await openCellEditor(page, a1)
  await expect(page.locator(CELL_EDITOR_INPUT)).toBeFocused()
  await pasteInEditor(page, clipboard)
  await written(page, async () => page.keyboard.press('Enter'))
}

/** 撤销或重做一步（快捷键，按页面的平台取修饰键；重做在各平台都是 Ctrl/Cmd+Y），等它执行完 */
async function undoOrRedo(page: Page, which: 'undo' | 'redo'): Promise<void> {
  const mark = await commandMark(page)
  await pressUniverShortcut(page, which === 'undo' ? 'Z' : 'Y')
  await waitForCommand(page, mark, { phase: 'executed', id: `univer.command.${which}` })
}

/**
 * 强制全部公式重算（P4 进入编辑时就这样做；执行选项带 onlyLocal，阅读时同样执行），等这一轮的结果写回（fromFormula 的写入，
 * 执行选项带 applyFormulaCalculationResult）
 */
async function recalculate(page: Page): Promise<void> {
  const mark = await commandMark(page)
  expect(await runFacade(page, async ({ api }) => api.executeCommand('formula.mutation.set-trigger-formula-calculation-start', { forceCalculation: true }, { onlyLocal: true }))).toEqual({})
  await expect.poll(async () => probeCommands(page, mark)).toContainEqual(expect.objectContaining({ phase: 'executed', id: SET_RANGE_VALUES, flags: expect.arrayContaining(['applyFormulaCalculationResult']) }))
}

/** HYPERLINK() 用例里的四个公式格 */
function formulaCells(workbook: Workbook): Cell[] {
  return ['A1', 'A2', 'A3', 'A4'].map(a1 => cellOf(workbook, a1))
}

/**
 * 浏览器给出的结果与 Node 的相同：合法与否、规范写法都相同；不合法时原因相同，或者是 alsoReason——各引擎在不同的一步拒绝同一个地址
 * （主机里有空白：Node 与 WebKit 解析不了，Chromium 编成 %20、按主机的写法拒绝，contracts 的 link-address.ts）
 */
function sameAsNode(browser: CanonicalLink | undefined, node: CanonicalLink, alsoReason: LinkAddressInvalidReason | undefined): boolean {
  if (JSON.stringify(browser) === JSON.stringify(node))
    return true
  return browser?.ok === false && !node.ok && browser.reason === alsoReason
}

/** 跨引擎用例表的一条：浏览器的结果等于表里（Node）的，或者是表里声明的另一个原因 */
function matchesCase(browser: CanonicalLink | undefined, item: LinkAddressCase): boolean {
  return sameAsNode(browser, item.expected, item.alsoReason)
}

/** 撤销两步：两格回到空的；再重做两步：与之前完全相同（改写之后的写法就在撤销栈里） */
async function expectUndoRedoKeepsCanonical(page: Page, lastTwo: readonly [string, string], before: Workbook): Promise<void> {
  // 点一个空单元格让表格拿到焦点（选区不进撤销栈）
  await mouseAway(page)
  await selectCell(page, 'K20')
  await undoOrRedo(page, 'undo')
  await undoOrRedo(page, 'undo')
  const undone = await shown(page)
  for (const a1 of lastTwo)
    expect(cellOf(undone, a1)?.p, a1).toBeUndefined()
  await undoOrRedo(page, 'redo')
  await undoOrRedo(page, 'redo')
  expect(await shown(page)).toEqual(before)
}

test.describe('US-M3-14 写入之前把自动识别的链接改成规范写法（DEF-021）', { tag: '@test-build' }, () => {
  test('US-M3-14 单元格里键入、编辑栏里键入与粘贴：规范写法或去掉链接、文字不变；撤销两步重做两步之后不变；服务器上的与页面里的相同，每个链接都通过服务端的核对', async ({ page }) => {
    const documentId = await open(page, 'links-typed')
    await selectCell(page, 'A1')
    for (const text of ['https://example.com/page', 'example.com', 'user@example.com', 'ftp://example.com/x', 'HTTPS://Example.COM/A', '//example.com/p', 'plain text'])
      await typeDown(page, text)
    await inFormulaBar(page, 'C1', async () => page.keyboard.type('https://Formula-Bar.Example'))
    // 编辑栏在编辑时（先键入过）才收粘贴：带链接的 HTML 的相对地址按页面地址解析成本站的绝对地址（docs-ui 的 html-to-udm）
    await inFormulaBar(page, 'C3', async () => {
      await page.keyboard.type('x')
      await pasteInEditor(page, { plain: 'fbrel', html: '<a href="/fb/relative path">fbrel</a>' })
    })
    await inFormulaBar(page, 'C5', async () => {
      await page.keyboard.type('x')
      await pasteInEditor(page, { plain: 'https://Fb-Paste.Example/p' })
    })

    const before = await shown(page)
    expectLinks(before, {
      A1: ['https://example.com/page'],
      A2: ['https://example.com/'],
      A3: ['mailto:user@example.com'],
      A4: [],
      A5: ['https://example.com/A'],
      A6: ['https://example.com/p'],
      A7: [],
      C1: ['https://formula-bar.example/'],
      C3: [`${new URL(page.url()).origin}/fb/relative%20path`],
      C5: ['https://fb-paste.example/p'],
    })
    // 改的只是链接：单元格的值与正文都是键入的原文
    for (const [a1, text] of [['A2', 'example.com'], ['A4', 'ftp://example.com/x'], ['A5', 'HTTPS://Example.COM/A'], ['C1', 'https://Formula-Bar.Example']] as const) {
      expect(cellOf(before, a1)?.v, a1).toBe(text)
      expect(cellOf(before, a1)?.p?.body?.dataStream, a1).toBe(`${text}\r\n`)
    }
    expect(cellOf(before, 'A7')).toMatchObject({ v: 'plain text' })
    expect(cellOf(before, 'A7')?.p).toBeUndefined()
    expect(cellOf(before, 'C3')?.p?.body?.dataStream).toBe('xfbrel\r\n')
    expect(cellOf(before, 'C5')?.p?.body?.dataStream).toBe('xhttps://Fb-Paste.Example/p\r\n')

    await expectUndoRedoKeepsCanonical(page, ['C5', 'C3'], before)
    await saveAndWait(page)
    const saved = await savedContent(page, documentId)
    expect(saved.snapshot).toEqual(before)
    expect(expectServerAccepts(saved.snapshot)).toBe(8)
  })

  test('US-M3-14 选中单元格粘贴纯文本与带链接的 HTML、单元格编辑器里粘贴：规范写法或去掉链接、文字不变；撤销两步重做两步之后不变；服务器上的每个链接都通过服务端的核对', async ({ page }) => {
    const documentId = await open(page, 'links-pasted')
    // 选中单元格粘贴纯文本（sheets-ui 的剪贴板，原文作为地址）：E1 起往下
    await selectCell(page, 'E1')
    for (const plain of ['example.org', 'https://Paste.Example/p?q=1', 'user@example.com']) {
      await written(page, async () => paste(page, { plain }))
      await moveDown(page)
    }
    // 单元格编辑器里粘贴（core 的 fromPlainText，整段文字作为地址）
    await pasteInCellEditor(page, 'G1', { plain: 'https://Cell-Editor.Example' })
    // 选中单元格粘贴带链接的 HTML（sheets-ui 的 html-to-usm：绝对地址是解析之后的 href，相对地址原样）：I1 起往下
    await mouseAway(page)
    await selectCell(page, 'I1')
    const htmls = [
      ['abs', '<a href="HTTPS://Html.Example/a b">abs</a>'],
      ['nos', '<a href="relative-no-slash">nos</a>'],
      ['mail', '<a href="mailto:Someone@Example.com">mail</a>'],
      ['rel', '<a href="/relative/path x?y=1#h">rel</a>'],
    ] as const
    for (const [plain, html] of htmls) {
      await written(page, async () => paste(page, { plain, html }))
      await moveDown(page)
    }
    // 单元格编辑器里粘贴两行：链接只覆盖第二行，SDK 写出的地址却是整段文字（带换行）——改用链接覆盖的文字
    await pasteInCellEditor(page, 'G3', { plain: 'first line\nhttps://CE-Multi.Example/x' })

    const before = await shown(page)
    expectLinks(before, {
      E1: [],
      E2: ['https://paste.example/p?q=1'],
      E3: [],
      G1: ['https://cell-editor.example/'],
      G3: ['https://ce-multi.example/x'],
      I1: ['https://html.example/a%20b'],
      I2: [],
      I3: ['mailto:Someone@Example.com'],
      I4: ['/relative/path%20x?y=1#h'],
    })
    // 去掉链接的，文字还在
    expect(cellOf(before, 'E1')?.p?.body?.dataStream).toBe('example.org\r\n')
    expect(cellOf(before, 'E3')?.p?.body?.dataStream).toBe('user@example.com\r\n')
    expect(cellOf(before, 'I2')).toMatchObject({ v: 'nos' })

    await expectUndoRedoKeepsCanonical(page, ['G3', 'I4'], before)
    await saveAndWait(page)
    const saved = await savedContent(page, documentId)
    expect(saved.snapshot).toEqual(before)
    expect(expectServerAccepts(saved.snapshot)).toBe(6)
  })

  test('US-M3-14 HYPERLINK() 的结果：规范写法或去掉链接；链接与段落的标识由位置确定，强制重算、撤销两步重做两步、重开之后（阅读与编辑都重算）内容不变', async ({ page }) => {
    const documentId = await open(page, 'links-formula')
    await selectCell(page, 'B1')
    await typeDown(page, '1')
    await selectCell(page, 'A1')
    for (const formula of ['=HYPERLINK("https://Formula.Example/"&B1,"ok")', '=HYPERLINK("other.invalid-tld-x","bad")', '=HYPERLINK("#gid=sheet-1&range=B1","jump")', '=HYPERLINK("example.com","label")'])
      await typeDown(page, formula)
    // 公式在 Worker 里算，结果经 fromFormula 的写入回来
    await expect.poll(async () => {
      const workbook = await shown(page)
      return ['A1', 'A2', 'A3', 'A4'].map(a1 => cellOf(workbook, a1)?.p?.body?.dataStream)
    }).toEqual(['ok\r\n', 'bad\r\n', 'jump\r\n', 'label\r\n'])

    const computed = await shown(page)
    expectLinks(computed, { A1: ['https://formula.example/1'], A2: [], A3: ['#gid=sheet-1&range=B1'], A4: ['https://example.com/'] })
    // 第 k 个链接的 rangeId 是 formula-<行>-<列>-<k>，段落的 paragraphId 是 para_formula-<行>-<列>-<序号>（行、列从 0 起）
    for (const [a1, row] of [['A1', 0], ['A2', 1], ['A3', 2], ['A4', 3]] as const) {
      const body = cellOf(computed, a1)?.p?.body
      expect(body?.customRanges?.map(range => range.rangeId), a1).toEqual(a1 === 'A2' ? [] : [`formula-${row}-0-0`])
      expect(body?.paragraphs?.map(paragraph => paragraph.paragraphId), a1).toEqual([`para_formula-${row}-0-0`])
    }
    await saveAndWait(page)
    const first = await savedContent(page, documentId)
    expect(first.snapshot).toEqual(computed)
    expect(expectServerAccepts(first.snapshot)).toBe(3)

    // 强制重算（P4 进入编辑时就这样做）：SDK 给的随机值全换了，改写之后内容不变
    await recalculate(page)
    expect(await shown(page)).toEqual(computed)

    // 撤销两步（A4、A3 的公式）、重做两步：重算出来的仍是同样的内容，保存下来的与第一次相同
    await mouseAway(page)
    await selectCell(page, 'K20')
    await undoOrRedo(page, 'undo')
    await undoOrRedo(page, 'undo')
    const undone = await shown(page)
    expect(cellOf(undone, 'A4')?.f).toBeUndefined()
    expect(cellOf(undone, 'A3')?.f).toBeUndefined()
    await undoOrRedo(page, 'redo')
    await undoOrRedo(page, 'redo')
    await expect.poll(async () => shown(page)).toEqual(computed)
    await saveAndWait(page)
    expect((await savedContent(page, documentId)).snapshot).toEqual(first.snapshot)

    // 重开先阅读：改写器阅读时同样装着（阅读时也会重算，显示的要与编辑时一致）。强制重算一次、等结果写回，公式的结果与保存的逐项相同
    await page.reload()
    await waitForEditorAccess(page, 'read', 'steady')
    await recalculate(page)
    expect(formulaCells(await shown(page))).toEqual(formulaCells(first.snapshot))
    // 进入编辑（以可编辑重建；HYPERLINK() 的格子没有值，打开时重算：初次计算只算没有值的公式格）、保存：公式的结果与第一次逐项相同，
    // 整份内容的规范写法（服务端比较"内容相同"用的口径，contracts 的 canonicalContentText）也相同。逐字节不同的只有数据验证的空资源：
    // 重开之前是 {"sheet-1":[]}，重开之后是 {}，规范写法里"在而为空"与"不在"等价（M3-P3 设计 §3.2）
    await enterEditing(page, 'steady')
    await saveAndWait(page)
    const reopened = await savedContent(page, documentId)
    expect(formulaCells(reopened.snapshot)).toEqual(formulaCells(first.snapshot))
    expect(canonicalContentText(reopened.text)).toBe(canonicalContentText(first.text))
  })

  test('US-M3-14 链接地址的判定在每个浏览器里与 Node 相同：页面里打包的 canonicalLink 给出跨引擎用例表的结果，规范写法是不动点', async ({ page }) => {
    await loginThroughApi(page, await createUser('links-parity'))
    await openReader(page, await createSheetThroughApi(page))
    const results = await probeCanonicalLinks(page, LINK_ADDRESS_CASES.map(item => item.input))
    const mismatched = LINK_ADDRESS_CASES.flatMap((item, index) => matchesCase(results[index], item) ? [] : [{ note: item.note, input: item.input, expected: item.expected, actual: results[index] }])
    expect(mismatched).toEqual([])
    const hrefs = LINK_ADDRESS_CASES.flatMap(item => item.expected.ok ? [item.expected.href] : [])
    expect(hrefs.length).toBeGreaterThan(40)
    expect(await probeCanonicalLinks(page, hrefs)).toEqual(hrefs.map(href => ({ ok: true, href })))
  })

  test('US-M3-14 跨引擎的性质检验：逐字符扫描与随机拼出的地址，浏览器判为合法的规范写法交给 Node（与服务端同一份判定）仍合法且相等，也是浏览器里的不动点；每个地址的结果与 Node 相同', async ({ page }) => {
    await loginThroughApi(page, await createUser('links-property'))
    await openReader(page, await createSheetThroughApi(page))
    const inputs = [...LINK_SCAN_INPUTS, ...randomLinkAddresses(3000, 2026)]
    const results = await probeCanonicalLinks(page, inputs)
    expect(results).toHaveLength(inputs.length)
    // 承重的一条：浏览器写下的规范写法，服务端（Node）判为合法、而且就等于它的规范写法
    const refusedByNode = results.flatMap((result, index) => {
      if (!result.ok)
        return []
      const server = canonicalLink(result.href)
      return server.ok && server.href === result.href ? [] : [{ input: inputs[index], browser: result.href, node: server }]
    })
    expect(refusedByNode).toEqual([])
    // 浏览器里也是不动点；不是空的核对
    const hrefs = [...new Set(results.flatMap(result => result.ok ? [result.href] : []))]
    expect(hrefs.length).toBeGreaterThan(1500)
    expect(await probeCanonicalLinks(page, hrefs)).toEqual(hrefs.map(href => ({ ok: true, href })))
    // 更强的一条：同一个地址，浏览器与 Node 的结果相同（同一个公式在哪个浏览器里重算，存下的都一样）。
    // 它成立的前提：扫描与随机拼接的片段里没有 RTL 字符（希伯来文、阿拉伯文等）。IDNA 的 Bidi 规则只有浏览器核对到同一个域名里
    // 其余的标签，这样的地址 Node 收、浏览器不收（contracts 的 link-address.ts 的 HOST）；以后加进 RTL 字符时，这条要允许"Node 收、浏览器不收"
    const differing = inputs.flatMap((input, index) => {
      const node = canonicalLink(input)
      return sameAsNode(results[index], node, node.ok || node.reason !== 'unparsable' ? undefined : 'host') ? [] : [{ input, browser: results[index], node }]
    })
    expect(differing).toEqual([])
  })
})
