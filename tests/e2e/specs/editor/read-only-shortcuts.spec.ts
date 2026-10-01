// 只读时逐个按遍 SDK 注册的全部快捷键（M2-P6 复核 F1、F2 之后，US-M2-11）。
// 复核时审查者把全部已注册的快捷键（1.0.1 在苹果的平台上 143 项、78 种组合）在只读页上逐个按了一遍，才发现"搜索功能"面板（F1）
// 与快速求和（F2）。这里把那次扫查变成回归：经测试构建的探针取到 SDK 当前注册的全部快捷键（SDK 升级新增的入口也在里面），
// 按页面的平台算出每个组合怎么按（support/keyboard.ts：修饰键按页面的判断取，不按跑测试的机器取），逐个按，每按一个都核对：
// - 确实按到了 SDK（M2-P6 复验 N1）：浏览器收到的按键（页面上先于 SDK 装上的记录）按 SDK 的规则换算出的绑定就是这个组合的
//   （键名换算错、修饰键按错时失败）；SDK 按下时与 shortcut.service.ts 的 dispatch 一样，按优先级从高到低（同优先级按登记的先后）
//   逐项看前提条件、派发第一项满足的，所以组合里有没有前提条件的快捷键时一定派发，派发的是排在它前面（含它）的某一项，命令日志里
//   要有这条命令；守卫取消的几项（GUARDED_COMMANDS：打开替换、"搜索功能"、快速求和、撤销、重做）要在日志里是"取消"，而且没有一条执行。
//   后两条核对 SDK 与页面对平台的判断一致（判断不一致时 SDK 换算出的是别的绑定，派发不到）。都不会悄悄地少按；
// - 内存里的内容与打开时相同，没有改动文档的 mutation 执行；没有保存请求；没有页面错误；
// - 编辑栏显示的与当前单元格（选区的主单元格）的真实内容一致（F2：编辑栏显示文档里没有的公式）。"真实内容"按 SDK 自己的显示取：
//   先选别的单元格、再选回这一格，编辑栏从模型重新同步（只读时模型不变，每格只取一次）。读编辑栏的探针取不到编辑栏时抛错，
//   用例开头另有一次自检：有内容的单元格，编辑栏读得出它的内容（M2-P6 复验 N3：读取器失效时不能退化成"都是空串"）；
// - 没有弹出编辑类的面板或对话框（F1）。允许的只有三样：查找面板（查找是阅读；替换面板与它是同一个对话框、同样叫"查找"，
//   另核对里面没有替换的输入框与按钮，M2-P6 复验 N2）、权限检查拦下操作时的只读提示（核对说法之后关掉）、快捷键面板（侧栏里只列出
//   快捷键与说明，不能从那里执行）；别的对话框、菜单与列表、别的侧栏、新出现的界面部件（SDK 的 data-u-comp）都算失败，
//   失败信息里写着按的是哪个组合、出现了什么。
// 选区的三种状态各一个用例（M2-P6 复验 N5，并行执行）：选中一个空单元格、整行选中、整列选中。SDK 1.0.1 的快捷键绑定的命令里，
// 按选区的类型分支的只有隐藏行、隐藏列（sheets 的 set-row-visible.command.ts、set-col-visible.command.ts 只取整行、整列类型的选区，
// 在单元格上按什么也不做、走不到 mutation；按类型分支的另外几个命令——插入与移动行列、行高列宽、冻结——没有快捷键），所以加了这两种。
// 别的状态不另外按：整张表的选区类型两个命令都不取，与单元格一样；多个区域对它们只是多几处同类的选区。单元格编辑器开着、选中图片、
// 编辑栏聚焦这些状态只读时到不了（打开编辑器被权限检查拦下，图片点不中，编辑栏点不进去，read-only.spec.ts 逐项核对）。
// 怎么按：每个组合之前复位到"数据"表（空白区域，缩放 1、没有滚动；方向键、Tab、回车移到的也是空单元格），先点另一格再点目标
// （同一处连点两下会被当成双击、打开单元格编辑器），点画布也让键盘焦点回到表格，等名称框显示目标。按下之后等两帧再核对：
// 快捷键在按下时同步派发，对话框在动画帧里渲染。两帧够不够由对照校准：能编辑时同样的按法在两帧之内弹出"搜索功能"面板、
// 编辑栏显示求和公式（read-only.spec.ts 里这两项的对照）。
// 按不出来的组合直接失败（keyCode 没有对应的键名、不认得的修饰位：补上 support/keyboard.ts 的键名表）。只有非苹果的平台上带 MAC_CTRL
// 的绑定不按：SDK 只在苹果的平台上由 Control 键得出 MAC_CTRL，别的平台上没有按键能派发到它，写进附件"快捷键的覆盖"。
// 有前提条件、这个状态下没有派发的快捷键（单元格编辑器开着、文档编辑器等，只读时到不了那些状态）同样写进附件，不算失败。
// 用到探针：标签 @test-build（外部模式测生产镜像时排除）
import type { Page } from '@playwright/test'
import type { ProbeCommand, ProbeShortcut } from '../../support/editor-probe.ts'
import type { KeyEventFields, UniverPlatform } from '../../support/keyboard.ts'
import type { Watched } from '../../support/read-only.ts'
import { cellRect, clickCell, contentOf, formulaBarText, nameBox, probeShortcuts, probeSnapshot } from '../../support/editor-probe.ts'
import { expect, test } from '../../support/fixtures.ts'
import { bindingOf, effectiveBinding, shortcutKeys, univerPlatform } from '../../support/keyboard.ts'
import { SAMPLE_CELLS, SAMPLE_FORMULAS, SAMPLE_SHEETS } from '../../support/read-only-sample.ts'
import { ANY_READ_ONLY_ALERT, closePermissionAlert, documentChangesIn, nextFrames, openReadOnly, scene, unitIdOf, watch } from '../../support/read-only.ts'
import { sheetCanvas, sheetTab, SHORTCUT_SWEEP_TIMEOUT } from '../../support/sheet.ts'

// 一条用例按遍全部快捷键，比别的编辑器用例长得多：时限另取（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: SHORTCUT_SWEEP_TIMEOUT })

declare global {
  interface Window {
    /** 这份回归在页面上记下的按键（recordKeydowns）：每次按下之前清空 */
    __shortcutKeydowns?: KeyEventFields[]
  }
}

/**
 * 在页面上记下每次 keydown 的 keyCode 与修饰键（作为初始化脚本，在页面的脚本之前装上）：SDK 的快捷键服务同样在 window 的捕获阶段
 * 监听（ui 的 fromGlobalEvent），同一处的监听按装上的先后调用，所以这里总是先拿到按键，SDK 怎么处理它都不影响记录
 */
function recordKeydowns(): void {
  window.__shortcutKeydowns = []
  window.addEventListener('keydown', (event) => {
    window.__shortcutKeydowns?.push({ keyCode: event.keyCode, shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey })
  }, { capture: true })
}

/** "数据"表空白区域里的空单元格：第 20 行与 K 列都没有内容 */
const HOME = 'K20'
/** 复位时先点的另一格：同样是空白区域里的空单元格，离复位的目标足够远（两次点击不会被当成双击），不滚动也看得见 */
const AWAY = 'M17'

/**
 * 只读守卫取消的命令：执行前取消的界面操作（web 的 editor/read-only/read-only-guard.ts 的 READ_ONLY_GUARDED_COMMANDS），
 * 与撤销、重做（只读守卫在 BeforeUndo、BeforeRedo 取消）。E2E 引用不到 web 的代码，这里写一份，守卫的清单改了要同步：
 * 这份回归按它核对绑着这些命令的组合按下之后在日志里是"取消"
 */
const GUARDED_COMMANDS = [
  'ui.operation.open-replace-dialog',
  'ui.operation.open-feature-search',
  'formula-ui.operation.insert-function',
  'univer.command.undo',
  'univer.command.redo',
]

/** 查找面板（按可访问的名称）：查找是阅读，只读时照常（M2-P3 设计 §3.4） */
const FIND_DIALOG = '查找'
/**
 * 替换面板里的输入框与按钮（find-replace 的 views/dialog/FindReplaceDialog.tsx 的 ReplaceDialog；语言包 find-replace.dialog 的
 * replace-placeholder、replace、replace-all）。替换面板与查找面板是同一个对话框、同样叫"查找"（按 replaceRevealed 换内容），
 * 所以放行查找面板时另核对里面没有这些（M2-P6 复验 N2）；命令日志另核对打开替换没有执行（GUARDED_COMMANDS）
 */
const REPLACE_CONTROLS = ['输入替换内容', '替换', '替换全部']
/**
 * 允许打开的侧栏（按标题）：快捷键面板（ui 的 toggle-shortcut-panel，Ctrl/Cmd+\）只列出快捷键与说明，不能从那里执行；
 * 列出的编辑类快捷键按下时照样被拦下（这份回归逐个核对）
 */
const ALLOWED_SIDEBARS = ['快捷键面板']
/** 权限检查的提示的标题（它的正文另外核对：只读的说法） */
const ALERT_TITLE = '提示'
/** 允许新出现的界面部件（data-u-comp）：选中多格时状态栏里的统计（求和、计数等的选择），是阅读 */
const ALLOWED_NEW_PARTS = ['status-bar-statistic-picker']
/**
 * SDK 的通知与消息（ui 的 views/notification/Notification.tsx、design 的 Message，都是 sonner 的 toast）：只是提示
 * （例如没有剪贴板权限时复制失败，"无法访问剪贴板"），不是编辑的入口，记进附件。通知在右上角、可以关，复位时关掉：
 * 它盖住列标，整列选中的复位点不中（消息在上方居中、不能关，到不了画布）
 */
const TOAST = '[data-sonner-toast]'

/** 画布上的一点（相对画布的左上角） */
interface Point {
  readonly x: number
  readonly y: number
}

/** 当前工作表里一格的中心在画布上的位置（经 Facade 取，与 SDK 的布局一致） */
async function centerOf(page: Page, a1: string): Promise<Point> {
  const rect = await cellRect(page, a1)
  return { x: (rect.startX + rect.endX) / 2, y: (rect.startY + rect.endY) / 2 }
}

/** 按下每个组合之前的选区（M2-P6 复验 N5）：每种一个用例 */
interface SelectionState {
  readonly name: string
  /** 选区移过去之后名称框显示的 */
  readonly nameBox: string
  /** 选区的主单元格：编辑栏显示它；按下之后主单元格不是它时，附件里记下移到了哪里 */
  readonly current: string
  /** 复位时点哪里："数据"表在缩放 1、没有滚动时的布局（经 Facade 取） */
  readonly target: (page: Page) => Promise<Point>
}

const STATES: readonly SelectionState[] = [
  {
    name: '选中一个空单元格',
    nameBox: HOME,
    current: HOME,
    target: async page => centerOf(page, HOME),
  },
  {
    // 点第 20 行的行号（单元格的范围从行号的右边开始：行号在它的左边）
    name: '整行选中',
    nameBox: '20:20',
    current: 'A20',
    target: async (page) => {
      const rect = await cellRect(page, 'A20')
      return { x: rect.startX / 2, y: (rect.startY + rect.endY) / 2 }
    },
  },
  {
    // 点 K 列的列标（单元格的范围从列标的下边开始）
    name: '整列选中',
    nameBox: 'K:K',
    current: 'K1',
    target: async (page) => {
      const rect = await cellRect(page, 'K1')
      return { x: (rect.startX + rect.endX) / 2, y: rect.startY / 2 }
    },
  },
]

/** 一个组合：这个页面上怎么按，绑在它上面的快捷键，以及按下时 SDK 会派发什么 */
interface Combo {
  readonly binding: number
  readonly keys: string
  readonly items: readonly ProbeShortcut[]
  /**
   * 按下时可能派发的命令：按 SDK 的顺序（优先级从高到低，同优先级按登记的先后）排到第一项没有前提条件的为止
   * （它的前提一定满足，排在它后面的轮不到）；没有这样一项时是全部
   */
  readonly candidates: readonly string[]
  /** 组合里有没有前提条件的快捷键：按下时 SDK 一定派发 */
  readonly mustDispatch: boolean
  /** 绑在这个组合上的、守卫取消的命令 */
  readonly guarded: readonly string[]
}

/** 不按的组合与原因（只有 SDK 在这个平台上本来就派发不到的那种） */
interface Skipped {
  readonly binding: number
  readonly reason: string
  readonly ids: readonly string[]
}

/** 同一个组合上的几项按 SDK 的顺序排：优先级从高到低；同优先级保持登记的先后（探针给出的就是快捷键服务里的顺序，排序是稳定的） */
function dispatchOrder(items: readonly ProbeShortcut[]): ProbeShortcut[] {
  return [...items].sort((a, b) => b.priority - a.priority)
}

function comboOf(binding: number, keys: string, items: readonly ProbeShortcut[]): Combo {
  const ordered = dispatchOrder(items)
  const firstUnconditional = ordered.findIndex(item => !item.conditional)
  const reachable = firstUnconditional === -1 ? ordered : ordered.slice(0, firstUnconditional + 1)
  const ids = [...new Set(items.map(item => item.id))]
  return {
    binding,
    keys,
    items,
    candidates: [...new Set(reachable.map(item => item.id))],
    mustDispatch: firstUnconditional !== -1,
    guarded: ids.filter(id => GUARDED_COMMANDS.includes(id)),
  }
}

/**
 * 按页面的平台把快捷键归到组合（同一个组合上的几项只会派发其一）。unknown 是回归不知道怎么按的组合（用例因此失败），
 * skipped 是 SDK 在这个平台上本来就派发不到的组合
 */
function combosOf(shortcuts: readonly ProbeShortcut[], platform: UniverPlatform): { readonly combos: Combo[], readonly skipped: Skipped[], readonly unknown: string[] } {
  const byBinding = new Map<number, ProbeShortcut[]>()
  for (const item of shortcuts) {
    const binding = effectiveBinding(item, platform)
    if (binding !== undefined)
      byBinding.set(binding, [...byBinding.get(binding) ?? [], item])
  }
  const combos: Combo[] = []
  const skipped: Skipped[] = []
  const unknown: string[] = []
  for (const [binding, items] of [...byBinding].sort(([a], [b]) => a - b)) {
    const keys = shortcutKeys(binding, platform)
    const ids = [...new Set(items.map(item => item.id))]
    if ('keys' in keys)
      combos.push(comboOf(binding, keys.keys, items))
    else if ('unreachable' in keys)
      skipped.push({ binding, reason: keys.unreachable, ids })
    else
      unknown.push(`${keys.unknown}：${ids.join('、')}`)
  }
  return { combos, skipped, unknown }
}

/**
 * 页面上浮在表格之上的东西：对话框（名称、正文的开头与里面的输入框和按钮）、菜单与列表、展开的侧栏（它的标题）、
 * 对话框与侧栏之外看得见的界面部件，以及通知与消息（只记下，不核对）
 */
interface Surfaces {
  readonly dialogs: readonly { readonly name: string, readonly text: string, readonly controls: readonly string[] }[]
  readonly menus: readonly string[]
  /** 展开的侧栏的标题；没有展开时是 null */
  readonly sidebar: string | null
  readonly parts: readonly string[]
  readonly toasts: readonly string[]
}

async function surfaces(page: Page): Promise<Surfaces> {
  return page.evaluate((toast) => {
    const visible = (element: Element): boolean => element.checkVisibility()
    const nameOf = (element: Element): string => {
      const labelledBy = element.getAttribute('aria-labelledby')
      const label = labelledBy?.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ').trim()
      return label !== undefined && label !== '' ? label : (element.getAttribute('aria-label') ?? '')
    }
    const textOf = (element: Element): string => (element.textContent ?? '').trim().slice(0, 80)
    // 对话框里看得见的输入框（按可访问的名称或占位文字）与按钮（按文字）
    const controlsOf = (dialog: Element): string[] => [...dialog.querySelectorAll('input, textarea, button')].filter(visible).map(control => control.tagName === 'BUTTON' ? textOf(control) : (control.getAttribute('aria-label') ?? control.getAttribute('placeholder') ?? ''))
    const DIALOG = '[role="dialog"], [role="alertdialog"]'
    // SDK 的侧栏（ui 的 Sidebar）：展开时 aria-expanded 为真，标题在它的 header 里
    const SIDEBAR = '[data-u-comp="sidebar"]'
    const sidebar = document.querySelector(`${SIDEBAR}[aria-expanded="true"]`)
    return {
      dialogs: [...document.querySelectorAll(DIALOG)].filter(visible).map(element => ({ name: nameOf(element), text: textOf(element), controls: controlsOf(element) })),
      // 对话框里的列表算对话框的一部分（对话框按名称核对）
      menus: [...document.querySelectorAll('[role="menu"], [role="listbox"]')].filter(element => visible(element) && element.closest(DIALOG) === null).map(element => nameOf(element) || textOf(element)),
      sidebar: sidebar === null ? null : (sidebar.querySelector('header')?.textContent ?? '').trim(),
      parts: [...new Set([...document.querySelectorAll('[data-u-comp]')]
        .filter(element => visible(element) && element.closest(DIALOG) === null && element.parentElement?.closest(SIDEBAR) == null)
        .map(element => element.getAttribute('data-u-comp') ?? ''))].sort(),
      // 正在关的（data-removed）不算
      toasts: [...document.querySelectorAll(toast)].filter(element => visible(element) && element.getAttribute('data-removed') !== 'true').map(textOf),
    }
  }, TOAST)
}

/** 关掉能关的通知，等它们收起（收起时有动画，期间仍然挡着点击）；不能关的消息不在画布上，不管 */
async function dismissNotifications(page: Page): Promise<void> {
  const closable = page.locator(`${TOAST}:not([data-removed="true"]) [data-close-button]`)
  for (let count = await closable.count(); count > 0; count = await closable.count()) {
    await closable.first().click()
    await expect(closable, '等通知关掉').toHaveCount(count - 1)
  }
  await expect(page.locator(`${TOAST}[data-removed="true"]`), '等关掉的通知收起').toHaveCount(0)
}

/** 浮在表格之上的只有允许的：只读的提示、查找面板（里面没有替换）、快捷键面板；没有菜单与列表，界面部件只多了允许的 */
function expectOnlyAllowed(now: Surfaces, keys: string, baseParts: readonly string[]): void {
  const unexpectedDialogs = now.dialogs.filter(dialog => dialog.name !== FIND_DIALOG
    && !(dialog.name === ALERT_TITLE && ANY_READ_ONLY_ALERT.test(dialog.text) && !/保护|创建者/.test(dialog.text)))
  expect(unexpectedDialogs.map(({ name, text }) => ({ name, text })), `${keys}：不应该弹出这些对话框`).toEqual([])
  const replaceControls = now.dialogs.filter(dialog => dialog.name === FIND_DIALOG).flatMap(dialog => dialog.controls.filter(control => REPLACE_CONTROLS.includes(control)))
  expect(replaceControls, `${keys}：查找面板里不应该有替换的输入框与按钮（替换面板同样叫"查找"）`).toEqual([])
  expect(now.menus, `${keys}：不应该弹出菜单或列表`).toEqual([])
  expect([now.sidebar].filter(title => title !== null && !ALLOWED_SIDEBARS.includes(title)), `${keys}：不应该打开这个侧栏`).toEqual([])
  expect(now.parts.filter(part => !baseParts.includes(part) && !ALLOWED_NEW_PARTS.includes(part)), `${keys}：不应该出现新的界面部件`).toEqual([])
}

/**
 * 关掉允许出现的：权限检查的提示（先核对是只读的说法）、查找面板与快捷键面板。别的对话框、菜单与列表、别的侧栏、新出现的界面部件
 * 都算失败（按下之后两帧内出现的在按下之后就核对过；这里兜住更晚出现的，免得复位时的点击被挡住）
 */
async function closeAllowedSurfaces(page: Page, keys: string, baseParts: readonly string[]): Promise<void> {
  const now = await surfaces(page)
  expectOnlyAllowed(now, keys, baseParts)
  if (now.dialogs.some(dialog => dialog.name === ALERT_TITLE))
    await closePermissionAlert(page, ANY_READ_ONLY_ALERT)
  if (now.dialogs.some(dialog => dialog.name === FIND_DIALOG)) {
    const find = page.getByRole('dialog', { name: FIND_DIALOG })
    await find.getByRole('button', { name: 'Close' }).click()
    await expect(find).toBeHidden()
  }
  if (now.sidebar !== null) {
    await page.getByRole('button', { name: '关闭侧边栏' }).click()
    await expect.poll(async () => (await surfaces(page)).sidebar, { message: '等侧栏收起' }).toBeNull()
  }
  if (now.toasts.length > 0)
    await dismissNotifications(page)
}

/** 点画布上的一点（按画布现在的位置换算成页面的坐标：侧栏开合之后画布的位置可能变了） */
async function clickCanvas(page: Page, point: Point): Promise<void> {
  const box = await sheetCanvas(page).boundingBox()
  if (box === null)
    throw new Error('看不到表格的画布')
  await page.mouse.click(box.x + point.x, box.y + point.y)
}

/** 复位时点的两处：先点 away，再点 target */
interface ResetPoints {
  readonly away: Point
  readonly target: Point
}

/** 切到"数据"表，缩放回 1、滚回左上角（缩放与滚动只读时照常可用，单元格在画布上的位置按它们算） */
async function showDataAtOrigin(page: Page): Promise<void> {
  const data = SAMPLE_SHEETS.data.name
  const onData = await page.evaluate(name => window.__nerveEditorProbe?.univerAPI.getActiveWorkbook().getActiveSheet().getSheetName() === name, data)
  if (!onData) {
    const tab = sheetTab(page, data)
    await tab.click()
    await expect(tab).toHaveAttribute('aria-selected', 'true')
  }
  const moved = await page.evaluate(() => {
    const worksheet = window.__nerveEditorProbe?.univerAPI.getActiveWorkbook().getActiveSheet()
    if (worksheet === undefined)
      return false
    const scroll = worksheet.getScrollState()
    const zoomed = worksheet.getZoom() !== 1
    const scrolled = scroll.sheetViewStartRow !== 0 || scroll.sheetViewStartColumn !== 0
    if (zoomed)
      worksheet.zoom(1)
    if (scrolled)
      worksheet.scrollToCell(0, 0)
    return zoomed || scrolled
  })
  if (moved) {
    await expect.poll(async () => page.evaluate(() => {
      const worksheet = window.__nerveEditorProbe?.univerAPI.getActiveWorkbook().getActiveSheet()
      const scroll = worksheet?.getScrollState()
      return [worksheet?.getZoom(), scroll?.sheetViewStartRow, scroll?.sheetViewStartColumn]
    }), { message: '等缩放与滚动复位' }).toEqual([1, 0, 0])
    // 画布在动画帧里按新的缩放与滚动重画，之后单元格的位置才对
    await nextFrames(page)
  }
}

/** 选到这个状态：先点 away 再点 target，等名称框显示这个状态的选区（选区已经移过去） */
async function selectState(page: Page, state: SelectionState, points: ResetPoints): Promise<void> {
  await clickCanvas(page, points.away)
  await clickCanvas(page, points.target)
  await expect(nameBox(page), `复位到"${state.name}"：名称框显示 ${state.nameBox}（显示的是 ${AWAY} 时，多半是有东西挡住了第二次点击）`).toHaveValue(state.nameBox)
}

/**
 * 复位：关掉允许出现的东西（after 是上一个组合，这时才出现的不允许的东西算在它头上），切回"数据"表的左上角，选到这个状态
 */
async function resetTo(page: Page, state: SelectionState, points: ResetPoints, after: string, baseParts: readonly string[]): Promise<void> {
  await closeAllowedSurfaces(page, after, baseParts)
  await showDataAtOrigin(page)
  await selectState(page, state, points)
}

/** 按下之前：命令日志当前的最后一个序号（之后的命令都是这次按键带来的），清空按键的记录 */
async function markBeforePress(page: Page): Promise<number> {
  return page.evaluate(() => {
    const probe = window.__nerveEditorProbe
    if (probe === undefined || window.__shortcutKeydowns === undefined)
      throw new Error('页面里没有编辑器的探针或按键的记录')
    window.__shortcutKeydowns.length = 0
    return probe.commands().at(-1)?.seq ?? 0
  })
}

/** 按下之后的观察：当前的工作表与选区的主单元格、编辑栏显示的文字、mark 之后的命令日志、内存里的快照与这次的按键 */
interface Observation {
  readonly sheet: string
  readonly cell: string
  readonly formulaBar: string
  readonly commands: readonly ProbeCommand[]
  readonly snapshot: string
  readonly keydowns: readonly KeyEventFields[]
}

async function observe(page: Page, mark: number): Promise<Observation> {
  return page.evaluate((since) => {
    const probe = window.__nerveEditorProbe
    if (probe === undefined)
      throw new Error('页面里没有编辑器的探针')
    const worksheet = probe.univerAPI.getActiveWorkbook().getActiveSheet()
    const current = worksheet.getSelection()?.getCurrentCell()
    // 列号换成字母（A、B、…、Z、AA、…）
    const letters = (column: number): string => column < 26 ? String.fromCharCode(65 + column) : letters(Math.floor(column / 26) - 1) + letters(column % 26)
    return {
      sheet: worksheet.getSheetName(),
      cell: current == null ? '' : `${letters(current.actualColumn)}${current.actualRow + 1}`,
      formulaBar: probe.formulaBarText(),
      commands: probe.commands(since),
      snapshot: probe.snapshot(),
      keydowns: [...window.__shortcutKeydowns ?? []],
    }
  }, mark)
}

/**
 * 编辑栏对一格应该显示什么：按 SDK 自己的显示取。先选另一格、再选回这一格（经 Facade 设选区，与键盘、鼠标改选区同一条路：
 * 选区变化时 sheets-ui 按这一格的内容重新同步编辑栏），读编辑栏。只读时模型不变，每张表的每一格只取一次
 */
function formulaBarOracle(page: Page): (sheet: string, cell: string) => Promise<string> {
  const shown = new Map<string, string>()
  return async (sheet, cell) => {
    const key = `${sheet}!${cell}`
    const cached = shown.get(key)
    if (cached !== undefined)
      return cached
    await page.evaluate(([target, other]) => {
      const worksheet = window.__nerveEditorProbe?.univerAPI.getActiveWorkbook().getActiveSheet()
      worksheet?.getRange(other).activate()
      worksheet?.getRange(target).activate()
    }, [cell, cell === HOME ? AWAY : HOME] as const)
    await nextFrames(page)
    const text = await formulaBarText(page)
    shown.set(key, text)
    return text
  }
}

/**
 * 读编辑栏的自检（M2-P6 复验 N3）：有内容的单元格，编辑栏读出的是它的内容（文字与公式各一格）。读取器取错了编辑器、
 * 或者 SDK 改了编辑栏的文档时，这里失败，后面"编辑栏与单元格一致"的核对才不是两边都读出空串
 */
async function expectFormulaBarReadable(page: Page): Promise<void> {
  const formula = SAMPLE_FORMULAS.find(item => item.sheetId === SAMPLE_SHEETS.data.id && item.cell === 'G2')
  for (const [cell, text] of [['A2', SAMPLE_CELLS.a2], ['G2', formula?.formula ?? '']] as const) {
    await clickCell(page, cell)
    await expect.poll(async () => formulaBarText(page), { message: `读编辑栏的自检：选中 ${cell}，编辑栏显示它的内容` }).toBe(text)
  }
}

/** 每按一个组合都核对：内容不变、没有改动文档的 mutation、没有保存请求与页面错误 */
function expectNothingChanged(keys: string, observed: Observation, opened: unknown, unitId: string, watched: Watched): void {
  expect(contentOf(observed.snapshot), `${keys}：内存里的内容与打开时相同`).toEqual(opened)
  expect(documentChangesIn(observed.commands, unitId), `${keys}：没有改动文档的 mutation 执行`).toEqual([])
  expect(watched.saves, `${keys}：没有保存请求`).toEqual([])
  expect(watched.pageErrors, `${keys}：没有页面错误`).toEqual([])
}

/** 命令日志里的一条执行前的记录，写成"命令"或"命令（取消）" */
function attemptOf(command: ProbeCommand | undefined): string {
  return command === undefined ? '（没有派发）' : `${command.id}${command.canceled ? '（取消）' : ''}`
}

/** 一次按键写成"keyCode 与按着的修饰键" */
function describeKeydown(event: KeyEventFields | undefined): string {
  if (event === undefined)
    return '（没有收到按键）'
  const modifiers = (['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const).filter(key => event[key])
  return `keyCode ${event.keyCode}${modifiers.length === 0 ? '' : `，${modifiers.join('、')}`}`
}

/**
 * 确实按到了 SDK（M2-P6 复验 N1）：
 * - 浏览器收到的按键（这次按下的最后一个 keydown，前面的是修饰键自己）按 SDK 的规则换算出的绑定就是这个组合的；
 * - dispatched 是按下之后第一条绑在这个组合上的命令（执行前的记录）。组合里有没有前提条件的快捷键：一定派发，而且是 candidates 之一；
 *   绑着守卫取消的命令：派发的是它，而且被取消（前两条核对 SDK 与页面对平台的判断一致：按错了平台，SDK 换算出的是别的绑定）；
 * - 守卫取消的命令一条都没有执行（被取消的命令只有执行前的记录）
 */
function expectDispatched(combo: Combo, platform: UniverPlatform, observed: Observation, dispatched: ProbeCommand | undefined): void {
  const pressed = observed.keydowns.at(-1)
  expect(pressed === undefined ? '（没有收到按键）' : bindingOf(pressed, platform), `${combo.keys}：浏览器收到的按键（${describeKeydown(pressed)}）换算成这个组合的绑定`).toBe(combo.binding)
  if (combo.mustDispatch)
    expect(combo.candidates, `${combo.keys}：组合里有没有前提条件的快捷键，SDK 一定派发其中之一；命令日志里没有，说明按出去的组合没有到 SDK（键名或修饰键与 SDK 的判断不一致）`).toContain(dispatched?.id ?? '（没有派发）')
  if (combo.guarded.length > 0)
    expect(combo.guarded.map(id => `${id}（取消）`), `${combo.keys}：绑着守卫取消的命令，按下之后派发的是它、而且被只读守卫取消`).toContain(attemptOf(dispatched))
  const executedGuarded = observed.commands.filter(command => command.phase === 'executed' && GUARDED_COMMANDS.includes(command.id)).map(command => command.id)
  expect(executedGuarded, `${combo.keys}：守卫取消的命令不应该执行`).toEqual([])
}

/** 一个组合按下之后的记录（写进附件） */
interface ComboResult {
  readonly keys: string
  readonly ids: readonly string[]
  /** 有没有前提条件的快捷键（按下时一定派发） */
  readonly mustDispatch: boolean
  /** SDK 派发的命令（绑在这个组合上的第一条执行前的记录），被取消的标上"取消" */
  readonly dispatched: string
  /** 按下之后尝试过的命令（执行前的记录），被取消的标上"取消" */
  readonly attempted: readonly string[]
  /** 弹出的对话框的名称与打开的侧栏（允许的那几种） */
  readonly dialogs: readonly string[]
  /** 按下之后两帧内出现的通知与消息（没有时省略） */
  readonly toasts?: readonly string[]
  /** 选区的主单元格移到了哪里（没动时省略） */
  readonly movedTo?: string
}

test.describe('US-M2-11 查看者打开有阅读权限的表格，只能看不能改（快捷键）', { tag: '@test-build' }, () => {
  // 每种选区状态用自己的场景与文档，互不影响：并行执行
  test.describe.configure({ mode: 'parallel' })

  for (const state of STATES) {
    test(`只读时逐个按遍 SDK 注册的全部快捷键（${state.name}）：确实按到了 SDK、守卫取消的都被取消，内容不变、没有保存请求与页面错误，编辑栏显示的与当前单元格一致，没有弹出编辑类的面板或对话框`, async ({ page }) => {
      const s = await scene('ro-keys')
      const watched = watch(page, s.documentId)
      await page.addInitScript(recordKeydowns)
      await openReadOnly(page, s.viewer, s.documentId)
      const openedSnapshot = await probeSnapshot(page)
      const opened = contentOf(openedSnapshot)
      const unitId = unitIdOf(openedSnapshot)
      const platform = await univerPlatform(page)
      const shortcuts = await probeShortcuts(page)
      // 探针取到的是 SDK 的真实清单：守卫取消的命令都在里面（SDK 改名或去掉它们时这里先失败，回头核对只读守卫的清单）
      expect(shortcuts.map(item => item.id)).toEqual(expect.arrayContaining(GUARDED_COMMANDS))
      const { combos, skipped, unknown } = combosOf(shortcuts, platform)
      expect(unknown, '这些组合回归不知道怎么按：在 support/keyboard.ts 的键名表补上，不能少按').toEqual([])
      expect(GUARDED_COMMANDS.filter(id => !combos.some(combo => combo.guarded.includes(id))), '守卫取消的命令在这个平台上都有按得出来的组合').toEqual([])

      await expectFormulaBarReadable(page)
      const shownIn = formulaBarOracle(page)
      // 复位时点的位置：在缩放 1、没有滚动的"数据"表上取一次（每次复位都回到这个视图）
      await showDataAtOrigin(page)
      const points: ResetPoints = { away: await centerOf(page, AWAY), target: await state.target(page) }
      // 选到这个状态，记下这时看得见的界面部件（之后按下每个组合，新出现的只能是允许的那几种）；主单元格的编辑栏是空的（空单元格）
      await selectState(page, state, points)
      const baseParts = (await surfaces(page)).parts
      expect(await shownIn(SAMPLE_SHEETS.data.name, state.current), `${state.current} 是空单元格`).toBe('')

      const results: ComboResult[] = []
      /** 上一个按下的组合：复位时才出现的东西算在它头上 */
      let previous = '（开始之前）'
      for (const combo of combos) {
        const ids = [...new Set(combo.items.map(item => item.id))]

        await test.step(`${combo.keys}：${ids.join('、')}`, async () => {
          await resetTo(page, state, points, `${previous} 之后（复位时）`, baseParts)
          previous = combo.keys
          const mark = await markBeforePress(page)
          await page.keyboard.press(combo.keys)
          await nextFrames(page)
          const now = await surfaces(page)
          const observed = await observe(page, mark)
          const dispatched = observed.commands.find(command => command.phase === 'before' && ids.includes(command.id))
          expectOnlyAllowed(now, combo.keys, baseParts)
          expect(observed.formulaBar, `${combo.keys}：编辑栏显示的是 ${observed.sheet}!${observed.cell} 真实的内容`).toBe(await shownIn(observed.sheet, observed.cell))
          expectNothingChanged(combo.keys, observed, opened, unitId, watched)
          expectDispatched(combo, platform, observed, dispatched)
          results.push({
            keys: combo.keys,
            ids,
            mustDispatch: combo.mustDispatch,
            dispatched: attemptOf(dispatched),
            attempted: observed.commands.filter(command => command.phase === 'before').map(attemptOf),
            dialogs: [...now.dialogs.map(dialog => dialog.name), ...(now.sidebar === null ? [] : [`侧栏：${now.sidebar}`])],
            ...(now.toasts.length === 0 ? {} : { toasts: now.toasts }),
            ...(observed.sheet === SAMPLE_SHEETS.data.name && observed.cell === state.current ? {} : { movedTo: `${observed.sheet}!${observed.cell}` }),
          })
        })
      }
      // 最后一个组合弹出的也关掉，全程没有改动
      await closeAllowedSurfaces(page, `${previous} 之后（结束时）`, baseParts)
      expectNothingChanged('（结束）', await observe(page, 0), opened, unitId, watched)

      // 覆盖：按过的组合里派发到命令的、没有派发的（都是有前提条件的，这个状态下不满足），与不按的组合，都写进附件
      const coverage = {
        state: state.name,
        platform,
        shortcuts: shortcuts.length,
        combos: combos.length + skipped.length,
        pressed: combos.length,
        dispatched: results.filter(result => result.dispatched !== attemptOf(undefined)).length,
        notDispatched: results.filter(result => result.dispatched === attemptOf(undefined)).map(result => `${result.keys}：${result.ids.join('、')}`),
        skipped,
        results,
      }
      test.info().annotations.push({ type: '快捷键的覆盖', description: `${state.name}：${coverage.shortcuts} 项、${coverage.combos} 种组合：按了 ${coverage.pressed} 种，派发到命令的 ${coverage.dispatched} 种，不按的 ${skipped.length} 种` })
      await test.info().attach('快捷键的覆盖', { body: JSON.stringify(coverage, null, 2), contentType: 'application/json' })
    })
  }
})
