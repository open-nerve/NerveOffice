// 只读入口的逐项检查（M2-P3 设计 §3.7；M3-P2 设计 §4 的 E2E 一行）：原来写在 specs/editor/read-only.spec.ts 里，
// M3-P2 起"进入再退出编辑"之后（以只读重建的编辑器）要跑同一套检查（specs/editor/edit-mode.spec.ts 的 US-M3-01），抽到这里两边共用。
// - M0 的界面入口（UI_ENTRIES，7 项）、界面上还能碰到的其他入口（OTHER_UI_ENTRIES）与经探针调用的 Facade 入口（PROBE_FACADE_ENTRIES：
//   共用清单 apps/web/src/editor/testing/read-only-entries.ts 的 FACADE_ENTRIES）：每项给出只读与能编辑两种打开方式下等到的信号；
// - 每项都等到确定的信号再比较，不用固定时长的等待（命令被只读守卫取消、被 SDK 的权限检查拦下，或者执行完；没有控制点的手势
//   先确认没有意外弹出的提示，再点一个单元格、等名称框显示它）；
// - expectEntriesUnchanged：只读时逐项试，每项之后内存里的内容与开始时相同、没有改动文档的 mutation 执行。
// 用到探针（只在测试构建里）：调用方的用例打上 @test-build。
import type { BrowserContext, Locator, Page } from '@playwright/test'
import type { EntryOutcome, FacadeEntry } from './read-only.ts'
import { activeImageCount, cellCenter, cellRect, clickCell, commandMark, formulaBarText, nameBox, probeCommands, probeSnapshot, runFacade, waitForCommand } from './editor-probe.ts'
import { expect, test } from './fixtures.ts'
import { deleteDrawingKey, featureSearchKeys, pressUniverShortcut, quickSumKeys } from './keyboard.ts'
import { SAMPLE_CELLS, SAMPLE_SHEETS } from './read-only-sample.ts'
import { ALERT, closePermissionAlert, expectUnchanged, FACADE_ENTRIES, LOOK_ONCE, nextFrames, permissionAlert, SHORTCUT_OUTCOMES } from './read-only.ts'
import { sheetCanvas, sheetTab } from './sheet.ts'

/**
 * 一步操作之后等到的信号：执行完、被取消、被 SDK 的权限检查拦下（与页面自检共用的 EntryOutcome，拦下时 SDK 弹出提示，关掉它），
 * 或者不产生这条命令（只读时这个手势没有控制点）：之后点 thenClick 这一格，等名称框显示它，确认手势已经处理完。
 * 点之前先确认没有意外弹出的提示：弹出时点击被它挡住，会一直等到超时
 */
type Outcome = EntryOutcome | { readonly absent: string, readonly thenClick: string }

async function settle(page: Page, mark: number, outcome: Outcome): Promise<void> {
  if ('executed' in outcome) {
    await waitForCommand(page, mark, { phase: 'executed', id: outcome.executed })
  }
  else if ('canceled' in outcome) {
    await waitForCommand(page, mark, { phase: 'before', id: outcome.canceled, canceled: true })
  }
  else if ('blocked' in outcome) {
    await waitForCommand(page, mark, { phase: 'before', id: outcome.blocked, canceled: false })
    await closePermissionAlert(page, outcome.alert)
    expect(await probeCommands(page, mark)).not.toContainEqual(expect.objectContaining({ phase: 'executed', id: outcome.blocked }))
  }
  else {
    await nextFrames(page)
    await expect(permissionAlert(page), `不应该弹出提示（${outcome.absent}）`).toHaveCount(0, LOOK_ONCE)
    await clickCell(page, outcome.thenClick)
    expect((await probeCommands(page, mark)).map(command => command.id)).not.toContain(outcome.absent)
  }
}

export type Mode = 'read' | 'edit'

/** 做一步操作，按打开的方式等到对应的信号 */
export async function step(page: Page, mode: Mode, act: () => Promise<unknown>, outcomes: { readonly read?: Outcome, readonly edit?: Outcome }): Promise<void> {
  const mark = await commandMark(page)
  await act()
  const outcome = outcomes[mode]
  if (outcome !== undefined)
    await settle(page, mark, outcome)
}

export interface Entry {
  readonly name: string
  readonly run: (page: Page, mode: Mode) => Promise<void>
  /** 能编辑时也不改动：超链接在 M5 之前被入口守卫取消（P4 设计 §3.6.8） */
  readonly unchangedWhenEditable?: true
}

/** 画布左上角在页面上的位置 */
async function canvasOrigin(page: Page): Promise<{ x: number, y: number }> {
  const box = await sheetCanvas(page).boundingBox()
  if (box === null)
    throw new Error('表格的画布不可见')
  return { x: box.x, y: box.y }
}

/** 切到一张工作表 */
export async function showSheet(page: Page, name: string): Promise<void> {
  await sheetTab(page, name).click()
  await expect(sheetTab(page, name)).toHaveAttribute('aria-selected', 'true')
}

interface Point {
  readonly x: number
  readonly y: number
}

/** 鼠标移到页面上的这一点，读画布的光标。每次挪一个像素：同一个位置再移动一次，浏览器不一定再送出移动的事件 */
async function cursorAt(page: Page, point: Point, nudge: number): Promise<string> {
  await page.mouse.move(point.x + nudge, point.y)
  return sheetCanvas(page).evaluate(canvas => getComputedStyle(canvas).cursor)
}

/**
 * 等到页面上这一点有画出来的图片：鼠标移上去光标是 grab（drawing-ui 给画出来的每张图片挂的，与能不能编辑无关，
 * lib/es/index.js 的 _addHoverForImage）。刚切到有图片的表时图片可能还没画好，点到的是下面的单元格
 */
async function expectImageAt(page: Page, point: Point): Promise<void> {
  let nudge = 0
  await expect.poll(async () => {
    nudge = 1 - nudge
    return cursorAt(page, point, nudge)
  }, { message: '等这里的浮动图片画出来（鼠标移上去是 grab）' }).toBe('grab')
}

/** "功能"表 J2 上的浮动图片（120×80，锚在 J2 的左上角）画出来之后，它的中心在页面上的位置 */
async function imageCenter(page: Page): Promise<Point> {
  const origin = await canvasOrigin(page)
  const j2 = await cellRect(page, 'J2')
  const center = { x: origin.x + j2.startX + 60, y: origin.y + j2.startY + 40 }
  await expectImageAt(page, center)
  return center
}

/**
 * 点图片：能编辑时等探针报告选中了一张；只读时图片没有变换框（只读守卫把图片设为不可编辑），点了也不选中。
 * 只点一次：SDK 把间隔很短的两次按下当作双击，双击图片会打开图片库
 */
async function clickImage(page: Page, mode: Mode, center: Point): Promise<void> {
  await page.mouse.click(center.x, center.y)
  if (mode === 'edit')
    await expect.poll(async () => activeImageCount(page), { message: '等图片被选中' }).toBe(1)
}

/**
 * 只读时（手势处理完之后）：mark 之后没有移动、删除图片的命令，图片没有被选中，还在原处（原来的中心仍是 grab），不在 moved 这一点
 */
async function expectImageUnmoved(page: Page, mark: number, center: Point, moved?: Point): Promise<void> {
  const imageCommands = (await probeCommands(page, mark)).filter(command => ['sheet.command.set-sheet-image', 'sheet.command.remove-sheet-image'].includes(command.id))
  expect(imageCommands, '没有移动、删除图片的命令').toEqual([])
  expect(await activeImageCount(page), '图片没有被选中').toBe(0)
  await expectImageAt(page, center)
  if (moved !== undefined)
    expect(await cursorAt(page, moved, 0), '拖到的位置没有图片').not.toBe('grab')
}

/** 键入（M0 的第一个界面入口）：归档空间的用例也用它 */
export const TYPING: Entry = {
  name: '键入：K3 键入 123 回车',
  run: async (page, mode) => {
    await clickCell(page, 'K3')
    // 只读时第一个字要打开单元格编辑器，被权限检查拦下（弹出提示，后面的字进不了单元格）；关掉提示后回车照常把选区下移
    await step(page, mode, async () => page.keyboard.type('123'), {
      read: { blocked: 'sheet.operation.set-cell-edit-visible', alert: ALERT.edit },
      edit: { executed: 'sheet.operation.set-cell-edit-visible' },
    })
    await step(page, mode, async () => page.keyboard.press('Enter'), {
      read: { executed: 'sheet.command.move-selection-enter-tab' },
      edit: { executed: 'sheet.command.set-range-values' },
    })
  },
}

/** 编辑栏的编辑框（点它）与接收输入的元素（SDK 聚焦的是它：docs-ui 给编辑器的 id） */
export function formulaBarEditor(page: Page): Locator {
  return page.locator('[data-u-comp="formula-bar"] [data-u-comp="formula-editor"]')
}

export function formulaBarInput(page: Page): Locator {
  return page.locator('[id="__editor___INTERNAL_EDITOR__DOCS_FORMULA_BAR"]')
}

/** 编辑栏内部文档的单元：只读时这个单元上不应该有插入文字等命令（编辑栏没有收到输入） */
export const FORMULA_BAR_UNIT = '__INTERNAL_EDITOR__DOCS_FORMULA_BAR'

/**
 * 在名称框上按下、拖到编辑栏的编辑框上松开（P3 审查 A1 的复现）：按下不在编辑框上，只读守卫拦不到；
 * 松开时编辑框自己的 mouseup 会聚焦编辑栏的编辑器
 */
export async function slipOntoFormulaBar(page: Page): Promise<void> {
  const from = await nameBox(page).boundingBox()
  const to = await formulaBarEditor(page).boundingBox()
  if (from === null || to === null)
    throw new Error('名称框或编辑栏的编辑框不可见')
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 6 })
  await page.mouse.up()
}

/** 按查找的快捷键打开查找面板，查"苹果"（"数据"表里 A2 与 G2 两处），关掉 */
export async function findApple(page: Page): Promise<void> {
  await step(page, 'read', async () => pressUniverShortcut(page, 'F'), SHORTCUT_OUTCOMES.find)
  const find = page.getByRole('dialog', { name: '查找' })
  await find.getByRole('textbox', { name: '输入查找内容' }).fill('苹果')
  await find.getByRole('textbox', { name: '输入查找内容' }).press('Enter')
  await expect(find).toContainText(/[12]\/2/)
  await find.getByRole('button', { name: 'Close' }).click()
  await expect(find).toBeHidden()
}

// M0 的界面入口（U 类 7 项，spikes/m0/e2e/v09-read-mode.spec.ts 的 37–102、115–132 行）
export const UI_ENTRIES: readonly Entry[] = [
  TYPING,
  {
    name: '删除：A2 按 Delete',
    run: async (page, mode) => {
      await clickCell(page, 'A2')
      await step(page, mode, async () => page.keyboard.press('Delete'), SHORTCUT_OUTCOMES.clear)
    },
  },
  {
    name: '粘贴：复制 A2，粘贴到 K6',
    run: async (page, mode) => {
      await clickCell(page, 'A2')
      await step(page, mode, async () => pressUniverShortcut(page, 'C'), { read: { executed: 'univer.command.copy' }, edit: { executed: 'univer.command.copy' } })
      await clickCell(page, 'K6')
      // 粘贴由浏览器的 paste 事件触发：按系统的修饰键
      await step(page, mode, async () => page.keyboard.press('ControlOrMeta+V'), {
        read: { blocked: 'sheet.command.paste-by-short-key', alert: ALERT.paste },
        edit: { executed: 'sheet.command.paste-by-short-key' },
      })
    },
  },
  {
    name: '剪切后粘贴：剪切 A3，粘贴到 K7',
    run: async (page, mode) => {
      await clickCell(page, 'A3')
      await step(page, mode, async () => pressUniverShortcut(page, 'X'), {
        read: { blocked: 'univer.command.cut', alert: ALERT.cut },
        edit: { executed: 'univer.command.cut' },
      })
      await clickCell(page, 'K7')
      await step(page, mode, async () => page.keyboard.press('ControlOrMeta+V'), {
        read: { blocked: 'sheet.command.paste-by-short-key', alert: ALERT.paste },
        edit: { executed: 'sheet.command.paste-by-short-key' },
      })
    },
  },
  {
    name: '拖动填充柄：B2 的填充柄拖到 B4',
    run: async (page, mode) => {
      await clickCell(page, 'B2')
      const origin = await canvasOrigin(page)
      const from = await cellRect(page, 'B2')
      const to = await cellRect(page, 'B4')
      // 只读时选区没有填充柄，这一拖只是选择，不产生填充的命令
      await step(page, mode, async () => {
        await page.mouse.move(origin.x + from.endX - 1, origin.y + from.endY - 1)
        await page.mouse.down()
        await page.mouse.move(origin.x + from.endX - 1, origin.y + to.endY - 2, { steps: 8 })
        await page.mouse.up()
      }, {
        read: { absent: 'sheet.command.auto-fill', thenClick: 'D12' },
        edit: { executed: 'sheet.command.auto-fill' },
      })
    },
  },
  {
    name: '编辑栏：选中 K5，点编辑栏，键入后回车',
    run: async (page, mode) => {
      await clickCell(page, 'K5')
      // 只读时编辑栏点不进去（只读守卫在页面上拦下落在编辑框上的指针事件）：焦点还在表格上，键入的字交给单元格，照常被权限检查拦下
      await formulaBarEditor(page).click()
      await (mode === 'edit' ? expect(formulaBarInput(page)).toBeFocused() : expect(formulaBarInput(page)).not.toBeFocused())
      await step(page, mode, async () => page.keyboard.type('编辑栏输入'), {
        read: { blocked: 'sheet.operation.set-cell-edit-visible', alert: ALERT.edit },
        edit: { executed: 'doc.command.insert-text' },
      })
      await step(page, mode, async () => page.keyboard.press('Enter'), {
        read: { executed: 'sheet.command.move-selection-enter-tab' },
        edit: { executed: 'sheet.command.set-range-values' },
      })
    },
  },
  {
    name: '拖动行高：第 5、6 行之间的分隔线往下拖 30 像素',
    run: async (page, mode) => {
      const origin = await canvasOrigin(page)
      const a5 = await cellRect(page, 'A5')
      // 行标题的中间（A5 的左边就是行标题的宽度）
      const x = origin.x + a5.startX / 2
      const y = origin.y + a5.endY
      // 只读时没有调整行高的分隔线，这一拖只是选择行，不产生调整行高的命令
      await step(page, mode, async () => {
        await page.mouse.move(x, y - 8)
        await page.mouse.move(x, y, { steps: 4 })
        await page.mouse.down()
        await page.mouse.move(x, y + 30, { steps: 6 })
        await page.mouse.up()
      }, {
        read: { absent: 'sheet.command.delta-row-height', thenClick: 'D12' },
        edit: { executed: 'sheet.command.delta-row-height' },
      })
    },
  },
]

/**
 * 查找替换：把"苹果"全部替换为"苹果X"。只读时打不开替换（只读守卫在执行前取消打开替换的操作）：查找面板里没有"替换 / 高级查找"
 * （只读守卫藏起它，DEF-028：原来显示着、点了没有反应），替换的快捷键同样进不了替换，查找照常。能编辑时的对照看得到这个链接、点了打开替换。
 * 写成函数声明：lint 的 playwright/no-standalone-expect 把跟在内联箭头函数参数之后的 expect 误判为不在用例里
 */
async function findAndReplaceAll(page: Page, mode: Mode): Promise<void> {
  await clickCell(page, 'C8')
  await pressUniverShortcut(page, 'F')
  const find = page.getByRole('dialog', { name: '查找' })
  const findText = find.getByRole('textbox', { name: '输入查找内容' })
  await findText.fill('苹果')
  await findText.press('Enter')
  // "数据"表里 A2 与 G2（公式的结果）两处
  await expect(find).toContainText(/[12]\/2/)
  const advanced = find.getByText('替换 / 高级查找', { exact: true })
  const replaceText = find.getByRole('textbox', { name: '输入替换内容' })
  if (mode === 'read') {
    // 链接在面板里（SDK 照常渲染它），只是藏起来了：看不见、点不到
    await expect(advanced).toHaveCount(1)
    await expect(advanced).toBeHidden()
    await expect(replaceText).toHaveCount(0)
    await expect(find).toContainText(/[12]\/2/)
    await find.getByRole('button', { name: 'Close' }).click()
    await expect(find).toBeHidden()
    // 替换的快捷键：苹果的平台上也是 Control+H（find-replace 的 find-replace.shortcut.ts:78-88，mac 绑定的是 MAC_CTRL）
    await step(page, mode, async () => page.keyboard.press('Control+H'), { read: SHORTCUT_OUTCOMES.replace.read })
    await expect(find).toHaveCount(0)
    return
  }
  await step(page, mode, async () => advanced.click(), { edit: { executed: 'ui.operation.open-replace-dialog' } })
  await replaceText.fill('苹果X')
  await find.getByRole('button', { name: '替换全部', exact: true }).click()
  await step(page, mode, async () => page.getByRole('dialog', { name: '确定要替换所有的匹配项吗？' }).getByRole('button', { name: '确定', exact: true }).click(), {
    edit: { executed: 'ui.command.replace-all-matches' },
  })
  await find.getByRole('button', { name: 'Close' }).click()
  await expect(find).toBeHidden()
}

// 界面上还能碰到的其他入口（只读时的界面没有工具栏与右键菜单，但快捷键、工作表标签、全部工作表的菜单、图片、批注的浮层与查找替换还在）
export const OTHER_UI_ENTRIES: readonly Entry[] = [
  { name: '查找替换：把"苹果"全部替换为"苹果X"（只读时打不开替换）', run: findAndReplaceAll },
  {
    name: '格式的快捷键：A2 按 Ctrl/Cmd+B、I、U',
    run: async (page, mode) => {
      await clickCell(page, 'A2')
      for (const key of ['B', 'I', 'U']) {
        await step(page, mode, async () => pressUniverShortcut(page, key), SHORTCUT_OUTCOMES.style)
      }
    },
  },
  {
    name: '双击工作表标签"汇总"：不能进入改名',
    run: async (page, mode) => {
      const tab = sheetTab(page, SAMPLE_SHEETS.summary.name)
      await tab.dblclick()
      await expect(tab).toHaveAttribute('aria-selected', 'true')
      // 能编辑时第二下按下就把标签的名字变成可编辑的（SDK 在按下的处理里同步设置，slide-tab-bar.ts:467-471）；只读时没有改名的权限
      const editableName = tab.locator('[contenteditable="true"]')
      if (mode === 'read') {
        await expect(editableName).toHaveCount(0)
        return
      }
      await expect(editableName).toHaveCount(1)
      await step(page, mode, async () => {
        // 改名的输入框里全选由浏览器处理：按系统的修饰键
        await page.keyboard.press('ControlOrMeta+A')
        await page.keyboard.type('汇总二')
        await page.keyboard.press('Enter')
      }, { edit: { executed: 'sheet.command.set-worksheet-name' } })
    },
  },
  {
    name: '拖动工作表标签：长按"汇总"拖到最前',
    run: async (page, mode) => {
      const from = await sheetTab(page, SAMPLE_SHEETS.summary.name).boundingBox()
      const to = await sheetTab(page, SAMPLE_SHEETS.data.name).boundingBox()
      if (from === null || to === null)
        throw new Error('工作表标签不可见')
      // 拖动时这个标签脱离标签栏（固定定位），按组件标记找它
      const dragged = page.locator('[data-u-comp="slide-tab-item"]').filter({ hasText: SAMPLE_SHEETS.summary.name })
      await step(page, mode, async () => {
        await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
        await page.mouse.down()
        // 按住 300 毫秒之后才进入拖动（SDK 的长按，slide-tab-bar.ts:477-487），进入时标签的光标变成 move：等这个状态，不等固定时长
        await expect(dragged).toHaveCSS('cursor', 'move')
        await page.mouse.move(to.x + 2, to.y + to.height / 2, { steps: 10 })
        // 拖到的位置在动画帧里结算（slide-tab-bar.ts 的 _autoScrollFrame）：等两帧，松开时用的是最后的位置
        await nextFrames(page)
        await page.mouse.up()
      }, {
        read: { blocked: 'sheet.command.set-worksheet-order', alert: ALERT.sheet },
        edit: { executed: 'sheet.command.set-worksheet-order' },
      })
    },
  },
  {
    name: '全部工作表的菜单：点隐藏的"隐藏"表（取消隐藏）',
    run: async (page, mode) => {
      await allSheetsMenuButton(page).click()
      await step(page, mode, async () => page.getByRole('menuitem', { name: SAMPLE_SHEETS.hidden.name, exact: true }).click(), {
        read: { blocked: 'sheet.command.set-worksheet-show', alert: ALERT.sheet },
        edit: { executed: 'sheet.command.set-worksheet-show' },
      })
    },
  },
  {
    name: '删除浮动图片：点图片后按删除键',
    run: async (page, mode) => {
      await showSheet(page, SAMPLE_SHEETS.features.name)
      const image = await imageCenter(page)
      const mark = await commandMark(page)
      await clickImage(page, mode, image)
      // 只读时图片没有被选中，删除键删的是选中的单元格（被权限检查拦下），不是图片
      const deleteKey = await deleteDrawingKey(page)
      await step(page, mode, async () => page.keyboard.press(deleteKey), {
        read: SHORTCUT_OUTCOMES.clear.read,
        edit: { executed: 'sheet.command.remove-sheet-image' },
      })
      if (mode === 'read')
        await expectImageUnmoved(page, mark, image)
    },
  },
  {
    name: '拖动浮动图片："功能"表 J2 的图片',
    // 修复之前，只读时拖动被拦下之后图片在界面上停在拖到的位置（模型没变，切换工作表后复原）
    run: async (page, mode) => {
      await showSheet(page, SAMPLE_SHEETS.features.name)
      const image = await imageCenter(page)
      const mark = await commandMark(page)
      await clickImage(page, mode, image)
      const target = { x: image.x + 100, y: image.y + 60 }
      // 只读时图片没有变换框，这一拖什么命令都不产生：之后点一个单元格，等名称框显示它
      await step(page, mode, async () => {
        await page.mouse.move(image.x, image.y)
        await page.mouse.down()
        await page.mouse.move(target.x, target.y, { steps: 10 })
        await page.mouse.up()
      }, {
        read: { absent: 'sheet.command.set-sheet-image', thenClick: 'A12' },
        edit: { executed: 'sheet.command.set-sheet-image' },
      })
      if (mode === 'read')
        await expectImageUnmoved(page, mark, image, target)
    },
  },
  {
    name: '改批注：悬停 H1，在批注的浮层里续写，点别处',
    run: async (page, mode) => {
      await showSheet(page, SAMPLE_SHEETS.features.name)
      await sheetCanvas(page).hover({ position: await cellCenter(page, 'H1') })
      // 只读时批注浮层的文本框是只读的（只读守卫给它设 readOnly）：键入之后内容不变，离开时也就没有写回批注的命令
      const note = page.getByRole('textbox', { name: '在此输入' })
      await expect(note).toHaveValue(SAMPLE_CELLS.note)
      await expect(note).toHaveJSProperty('readOnly', mode === 'read')
      await note.click()
      await page.keyboard.press('End')
      await page.keyboard.type('（改）')
      await expect(note).toHaveValue(mode === 'read' ? SAMPLE_CELLS.note : `${SAMPLE_CELLS.note}（改）`)
      await step(page, mode, async () => clickCell(page, 'B8'), {
        read: { absent: 'sheet.command.update-note', thenClick: 'C9' },
        edit: { executed: 'sheet.mutation.update-note' },
      })
    },
  },
  { name: '拖动冻结线："数据"表第 1 行下面的冻结线（D 列处）拖到第 4 行下面', run: dragFreezeLine },
  { name: '拖动冻结区域的行高："数据"表第 1 行（冻结）下面的分隔线往下拖 30 像素', run: dragFrozenRowHeight },
  { name: '拖动第 1 行与 A 列的分隔线："汇总"表（没有冻结），各往下、往右拖 30 像素（DEF-027）', run: dragFirstRowAndColumnDividers },
  { name: '筛选按钮："筛选"表 A1 的筛选按钮', run: openFilterPanel },
  { name: '"搜索功能"面板：按 Ctrl/Cmd+Shift+P（只读时打不开）', run: openFeatureSearch },
  { name: '快速求和："数据"表选中空的 B10，按 Alt+=（苹果的平台上 Cmd+Option+=）', run: quickSum },
]

/**
 * "搜索功能"面板（M2-P6 复核 F1）：候选项直接取自功能区与右键菜单的菜单登记，只读时界面上隐藏的编辑功能（格式刷、清除格式、冻结、
 * 剪切、删除、粘贴等）也列在里面。只读时打开它的操作在执行前被只读守卫取消：面板不出现，内容不变。
 * 能编辑时同一个快捷键弹出面板（对照），在面板里搜"粗体"并执行，A2 确实变成粗体：面板里的确是编辑功能
 */
async function openFeatureSearch(page: Page, mode: Mode): Promise<void> {
  await showSheet(page, SAMPLE_SHEETS.data.name)
  await clickCell(page, 'A2')
  const panel = page.getByRole('dialog', { name: '搜索功能' })
  // 与快捷键的回归（read-only-shortcuts.spec.ts）同样的看法：按下之后等两帧（对话框在动画帧里渲染）、只看一次。
  // 能编辑时这样看得到面板，这是只读时"没有面板"与那份回归的两帧的校准；之后再等到确定的信号
  const mark = await commandMark(page)
  await page.keyboard.press(await featureSearchKeys(page))
  await nextFrames(page)
  if (mode === 'read') {
    await expect(panel).toHaveCount(0, LOOK_ONCE)
    await settle(page, mark, SHORTCUT_OUTCOMES.featureSearch.read)
    return
  }
  await expect(panel).toBeVisible(LOOK_ONCE)
  await settle(page, mark, SHORTCUT_OUTCOMES.featureSearch.edit)
  await panel.getByPlaceholder('输入功能或菜单名称…').fill('粗体')
  await step(page, mode, async () => panel.getByRole('option').filter({ hasText: '粗体' }).first().click(), {
    edit: { executed: 'sheet.command.set-style' },
  })
}

/**
 * 快速求和（M2-P6 复核 F2）：选中空的 B10（上面的 B2:B9 是数字与公式），按快速求和的快捷键。
 * 只读时这个操作在执行前被只读守卫取消：编辑栏显示的仍是 B10 真实的内容（空），也没有弹出提示，内容不变。修复之前它不管单元格编辑器
 * 打没打开，直接往编辑栏写入"=SUM(B2:B9"，编辑栏一直显示这个文档里没有的公式，直到选区移开。
 * 能编辑时同一操作打开单元格编辑器、填好求和公式（编辑栏显示它），回车之后 B10 是这个公式（对照）
 */
async function quickSum(page: Page, mode: Mode): Promise<void> {
  await showSheet(page, SAMPLE_SHEETS.data.name)
  await clickCell(page, 'B10')
  // 选区移过来时编辑栏换成 B10 的内容（空）
  await expect.poll(async () => formulaBarText(page), { message: '编辑栏显示 B10 的内容' }).toBe('')
  // 与快捷键的回归同样的看法：按下之后等两帧、只看一次（能编辑时这样看得到求和公式，是校准）；之后再等到确定的信号
  const mark = await commandMark(page)
  await page.keyboard.press(await quickSumKeys(page))
  await nextFrames(page)
  if (mode === 'read') {
    expect(await formulaBarText(page), '编辑栏显示的是 B10 真实的内容').toBe('')
    await expect(permissionAlert(page)).toHaveCount(0, LOOK_ONCE)
    await settle(page, mark, SHORTCUT_OUTCOMES.quickSum.read)
    return
  }
  expect(await formulaBarText(page), '能编辑时编辑栏显示填好的求和公式').toBe('=SUM(B2:B9')
  await settle(page, mark, SHORTCUT_OUTCOMES.quickSum.edit)
  await step(page, mode, async () => page.keyboard.press('Enter'), { edit: { executed: 'sheet.command.set-range-values' } })
}

/**
 * 拖动冻结线（P3 审查 B2）。SDK 没有注册冻结线的权限拦截：修复之前只读时冻结线照样显示可以拖动的光标、拖得动，松开时的
 * set-frozen 被防火墙取消，界面上的冻结线却停在拖到的位置。只读守卫补上拦截之后，移上不是 grab，按下不开始拖动：
 * 没有 set-frozen 的尝试（它只在拖动之后松开时执行），界面上的冻结线也就没有动过；模型里的冻结由 expectUnchanged 核对
 */
async function dragFreezeLine(page: Page, mode: Mode): Promise<void> {
  await showSheet(page, SAMPLE_SHEETS.data.name)
  const origin = await canvasOrigin(page)
  const d1 = await cellRect(page, 'D1')
  const d4 = await cellRect(page, 'D4')
  const line = { x: origin.x + (d1.startX + d1.endX) / 2, y: origin.y + d1.endY - 1 }
  await page.mouse.move(line.x, line.y + 6)
  await page.mouse.move(line.x, line.y, { steps: 3 })
  // 移上之后等两帧再读一次光标（不重试）：能编辑时这样读到的是可以拖动的 grab，这是只读时"不是 grab"的校准
  await nextFrames(page)
  const cursor = await sheetCanvas(page).evaluate(canvas => getComputedStyle(canvas).cursor)
  expect(cursor === 'grab', `冻结线上的光标是 ${cursor}`).toBe(mode === 'edit')
  await step(page, mode, async () => {
    await page.mouse.down()
    await page.mouse.move(line.x, origin.y + d4.endY - 2, { steps: 8 })
    await page.mouse.up()
  }, {
    read: { absent: 'sheet.command.set-frozen', thenClick: 'F12' },
    edit: { executed: 'sheet.command.set-frozen' },
  })
}

/**
 * 移到分隔线上（from 是旁边的一点，to 是分隔线上），等两帧之后读一次画布的光标（不重试）：能编辑时这样读到的是调整的光标，
 * 这是只读时"不是调整的光标"的校准
 */
async function cursorOnDivider(page: Page, from: Point, to: Point): Promise<string> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.move(to.x, to.y, { steps: 4 })
  await nextFrames(page)
  return sheetCanvas(page).evaluate(canvas => getComputedStyle(canvas).cursor)
}

/** 拖动第 1 行下面的分隔线（行标题的中间）往下 30 像素：只读时没有控制点（不是 row-resize，不产生调整行高的命令） */
async function dragFirstRowDivider(page: Page, mode: Mode, thenClick: string): Promise<void> {
  const origin = await canvasOrigin(page)
  const a1 = await cellRect(page, 'A1')
  // 行标题的中间（A1 的左边就是行标题的宽度），第 1 行的下边
  const divider = { x: origin.x + a1.startX / 2, y: origin.y + a1.endY - 1 }
  const cursor = await cursorOnDivider(page, { x: divider.x, y: divider.y - 8 }, divider)
  expect(cursor === 'row-resize', `第 1 行的分隔线上的光标是 ${cursor}`).toBe(mode === 'edit')
  await step(page, mode, async () => {
    await page.mouse.down()
    await page.mouse.move(divider.x, divider.y + 30, { steps: 6 })
    await page.mouse.up()
  }, {
    read: { absent: 'sheet.command.delta-row-height', thenClick },
    edit: { executed: 'sheet.command.delta-row-height' },
  })
}

/**
 * 拖动冻结区域（第 1 行冻结）的行高：原来只读时 SDK 在这里仍显示调整行高的光标、拖动之后被权限检查拦下（P3 审查 B7 登记为
 * "冻结区域的分隔线"，DEF-027）；根因其实是第 1 行（索引 0），见下一项。只读守卫补上拦截之后与别的分隔线一样没有控制点
 */
async function dragFrozenRowHeight(page: Page, mode: Mode): Promise<void> {
  await showSheet(page, SAMPLE_SHEETS.data.name)
  await dragFirstRowDivider(page, mode, 'F12')
}

/**
 * 没有冻结的表（"汇总"）上第 1 行、A 列的分隔线（DEF-027 的根因，M3-P2 S3 的 E2E 核实）：SDK 判断行高、列宽的权限时把索引 0 当作
 * 没有给出、一律放行（sheets-ui 的 _initHeaderResizePermissionInterceptor），只读时这两条分隔线照样显示调整的光标、拖得动，
 * 松开时被权限检查拦下；别的行列（"拖动行高"那一项）没有。只读守卫在这个拦截点上排在 SDK 之前、一律不允许
 */
async function dragFirstRowAndColumnDividers(page: Page, mode: Mode): Promise<void> {
  await showSheet(page, SAMPLE_SHEETS.summary.name)
  await dragFirstRowDivider(page, mode, 'D12')
  const origin = await canvasOrigin(page)
  const a1 = await cellRect(page, 'A1')
  // 列标题的中间（A1 的上边就是列标题的高度），A 列的右边
  const divider = { x: origin.x + a1.endX - 1, y: origin.y + a1.startY / 2 }
  const cursor = await cursorOnDivider(page, { x: divider.x - 8, y: divider.y }, divider)
  expect(cursor === 'col-resize', `A 列的分隔线上的光标是 ${cursor}`).toBe(mode === 'edit')
  await step(page, mode, async () => {
    await page.mouse.down()
    await page.mouse.move(divider.x + 30, divider.y, { steps: 6 })
    await page.mouse.up()
  }, {
    read: { absent: 'sheet.command.delta-column-width', thenClick: 'E13' },
    edit: { executed: 'sheet.command.delta-column-width' },
  })
}

/**
 * 点筛选按钮：只读时打开筛选面板被权限检查拦下，提示是只读的说法（P3 审查 B8：原文是"你没有权限使用筛选。"）；
 * 能编辑时打开面板，清除这一列的筛选条件（样本里 A 列只显示"研发""运营"）
 */
async function openFilterPanel(page: Page, mode: Mode): Promise<void> {
  await showSheet(page, SAMPLE_SHEETS.filter.name)
  const origin = await canvasOrigin(page)
  const a1 = await cellRect(page, 'A1')
  // 筛选按钮画在表头单元格的右侧
  await step(page, mode, async () => page.mouse.click(origin.x + a1.endX - 10, origin.y + (a1.startY + a1.endY) / 2), {
    read: { blocked: 'sheet.operation.open-filter-panel', alert: ALERT.filter },
    edit: { executed: 'sheet.operation.open-filter-panel' },
  })
  if (mode === 'read')
    return
  await step(page, mode, async () => page.getByRole('button', { name: '清除筛选', exact: true }).click(), {
    edit: { executed: 'sheet.command.set-filter-criteria' },
  })
}

/** 撤销与重做的快捷键（只读时撤销栈本来就是空的：断言它们被只读守卫取消；能编辑时的对照见单独的用例） */
async function undoAndRedo(page: Page, mode: Mode): Promise<void> {
  await step(page, mode, async () => pressUniverShortcut(page, 'Z'), SHORTCUT_OUTCOMES.undo)
  // 重做的快捷键：各平台都是 Ctrl/Cmd+Y（苹果的平台另有 Cmd+Shift+Z，ui 的 shared-shortcut.controller.ts）
  await step(page, mode, async () => pressUniverShortcut(page, 'Y'), SHORTCUT_OUTCOMES.redo)
}

/** 工作表标签栏左边"全部工作表"的菜单按钮（图标按钮，没有可访问的名称：按下拉菜单的触发器与 SDK 的组件标记定位） */
export function allSheetsMenuButton(page: Page): Locator {
  return page.locator('[data-slot="dropdown-menu-trigger"]').filter({ has: page.locator('[data-u-comp="sheet-bar-append-button"]') })
}

/** Facade 入口作为一项：经探针调用（调用抛出的错误接住了，不是页面错误；能编辑时不应该有） */
function facadeEntry(entry: FacadeEntry): Entry {
  return {
    name: `Facade：${entry.name}`,
    unchangedWhenEditable: entry.unchangedWhenEditable,
    run: async (page, mode) => {
      let outcome: Awaited<ReturnType<typeof runFacade>> = {}
      await step(page, mode, async () => {
        outcome = await runFacade(page, entry.call)
      }, { read: entry.read, edit: entry.edit })
      if (mode === 'edit')
        expect(outcome.error, `${entry.name}：能编辑时调用不应该出错`).toBeUndefined()
    },
  }
}

/** 复制之后读剪贴板核对内容：Chromium 内核（Chromium、Chrome）要先授权 */
export async function grantClipboard(context: BrowserContext, browserName: string): Promise<void> {
  if (browserName === 'chromium')
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
}

/** 撤销与重做的快捷键作为一项（只读时撤销栈本来就是空的，被只读守卫取消；能编辑时的对照见 read-only.spec.ts 的单独用例） */
const UNDO_AND_REDO: Entry = {
  name: '撤销与重做的快捷键：被只读守卫取消',
  run: async (page, mode) => {
    await clickCell(page, 'A5')
    await undoAndRedo(page, mode)
  },
}

/** 只读时逐项试的其他入口：OTHER_UI_ENTRIES 的前两项（查找替换、格式的快捷键）之后插入撤销与重做 */
export const OTHER_READ_ONLY_ENTRIES: readonly Entry[] = [...OTHER_UI_ENTRIES.slice(0, 2), UNDO_AND_REDO, ...OTHER_UI_ENTRIES.slice(2)]

/** 经探针调用的 Facade 入口（M0 的 21 项，另加取消已有的超链接），每个入口一项 */
export const PROBE_FACADE_ENTRIES: readonly Entry[] = FACADE_ENTRIES.map(facadeEntry)

/**
 * 只读时逐项试 entries（每项一个 test.step，失败时直接看到是哪一项）：每项之后内存里的内容与开始时相同，
 * 这一项也没有改动文档的 mutation 执行（support/read-only.ts 的 expectUnchanged）。开始时的内容取自探针（这一刻的编辑器）
 */
export async function expectEntriesUnchanged(page: Page, entries: readonly Entry[]): Promise<void> {
  const opened = await probeSnapshot(page)
  for (const entry of entries) {
    await test.step(entry.name, async () => {
      const mark = await commandMark(page)
      await entry.run(page, 'read')
      await expectUnchanged(page, opened, mark)
    })
  }
}
