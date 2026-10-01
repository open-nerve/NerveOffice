// 只读时逐个按遍 SDK 注册的全部快捷键（M2-P6 复核 F1、F2 之后，US-M2-11）。
// 复核时审查者把全部已注册的快捷键（1.0.1 在苹果的平台上 143 项、78 种组合）在只读页上逐个按了一遍，才发现"搜索功能"面板（F1）
// 与快速求和（F2）。这里把那次扫查变成回归：经测试构建的探针取到 SDK 当前注册的全部快捷键（SDK 升级新增的入口也在里面），
// 按页面的平台算出每个组合怎么按（support/keyboard.ts：修饰键按页面的判断取，不按跑测试的机器取），逐个按，每按一个都核对：
// - 内存里的内容与打开时相同，没有改动文档的 mutation 执行；没有保存请求；没有页面错误；
// - 编辑栏显示的与当前单元格的真实内容一致（F2：编辑栏显示文档里没有的公式）。"真实内容"按 SDK 自己的显示取：先选别的单元格、
//   再选回这一格，编辑栏从模型重新同步（只读时模型不变，每格只取一次）；
// - 没有弹出编辑类的面板或对话框（F1）。允许的只有三样：查找面板（查找是阅读）、权限检查拦下操作时的只读提示（核对说法之后关掉）、
//   快捷键面板（侧栏里只列出快捷键与说明，不能从那里执行）；别的对话框、菜单与列表、别的侧栏、新出现的界面部件（SDK 的 data-u-comp）
//   都算失败，失败信息里写着按的是哪个组合、出现了什么。
// 怎么按：每个组合之前复位到"数据"表的 K20（空白区域里的空单元格，缩放 1、没有滚动；方向键、Tab、回车移到的也是空单元格），
// 先点另一格再点它（同一处连点两下会被当成双击、打开单元格编辑器），点画布也让键盘焦点回到表格。按下之后等两帧再核对：
// 快捷键在按下时同步派发，对话框在动画帧里渲染。两帧够不够由对照校准：能编辑时同样的按法在两帧之内弹出"搜索功能"面板、
// 编辑栏显示求和公式（read-only.spec.ts 里这两项的对照）。
// 按不出来的组合（keyCode 没有对应的键名；MAC_CTRL 只在苹果的平台上有效，而非苹果的平台上 SDK 本来就派发不到它）、
// 这个状态下没有派发的快捷键（有前提条件：单元格编辑器开着、选中了图片等，只读时到不了那些状态）都写进附件"快捷键的覆盖"，不算失败。
// 用到探针：标签 @test-build（外部模式测生产镜像时排除）
import type { Page } from '@playwright/test'
import type { ProbeCommand, ProbeShortcut } from '../../support/editor-probe.ts'
import type { UniverPlatform } from '../../support/keyboard.ts'
import type { Watched } from '../../support/read-only.ts'
import { cellCenter, commandMark, contentOf, formulaBarText, nameBox, probeCommands, probeShortcuts, probeSnapshot } from '../../support/editor-probe.ts'
import { expect, test } from '../../support/fixtures.ts'
import { effectiveBinding, shortcutKeys, univerPlatform } from '../../support/keyboard.ts'
import { SAMPLE_SHEETS } from '../../support/read-only-sample.ts'
import { ANY_READ_ONLY_ALERT, closePermissionAlert, documentChanges, nextFrames, openReadOnly, scene, unitIdOf, watch } from '../../support/read-only.ts'
import { EDITOR_TEST_TIMEOUT, sheetCanvas, sheetTab } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

/** 每个组合之前复位到的单元格："数据"表空白区域里的空单元格（第 20 行与 K 列都没有内容） */
const HOME = 'K20'
/** 复位时先点的另一格：同样是空白区域里的空单元格，离 HOME 足够远（两次点击不会被当成双击），不滚动也看得见 */
const AWAY = 'M17'

/** 允许出现的对话框（按可访问的名称）：查找是阅读，只读时照常（M2-P3 设计 §3.4） */
const ALLOWED_DIALOGS = ['查找']
/**
 * 允许打开的侧栏（按标题）：快捷键面板（ui 的 toggle-shortcut-panel，Ctrl/Cmd+\）只列出快捷键与说明，不能从那里执行；
 * 列出的编辑类快捷键按下时照样被拦下（这份回归逐个核对）
 */
const ALLOWED_SIDEBARS = ['快捷键面板']
/** 权限检查的提示的标题（它的正文另外核对：只读的说法） */
const ALERT_TITLE = '提示'
/** 允许新出现的界面部件（data-u-comp）：选中多格时状态栏里的统计（求和、计数等的选择），是阅读 */
const ALLOWED_NEW_PARTS = ['status-bar-statistic-picker']

/** 一个组合：这个页面上怎么按，绑在它上面的快捷键 */
interface Combo {
  readonly binding: number
  readonly keys: string
  readonly items: readonly ProbeShortcut[]
}

/** 按不出来的组合与原因 */
interface Unpressable {
  readonly binding: number
  readonly reason: string
  readonly ids: readonly string[]
}

/** 按页面的平台把快捷键归到组合（同一个组合上的几项只会派发其一：优先级高、前提条件满足的那项） */
function combosOf(shortcuts: readonly ProbeShortcut[], platform: UniverPlatform): { readonly combos: Combo[], readonly unpressable: Unpressable[] } {
  const byBinding = new Map<number, ProbeShortcut[]>()
  for (const item of shortcuts) {
    const binding = effectiveBinding(item, platform)
    if (binding !== undefined)
      byBinding.set(binding, [...byBinding.get(binding) ?? [], item])
  }
  const combos: Combo[] = []
  const unpressable: Unpressable[] = []
  for (const [binding, items] of [...byBinding].sort(([a], [b]) => a - b)) {
    const keys = shortcutKeys(binding, platform)
    if ('keys' in keys)
      combos.push({ binding, keys: keys.keys, items })
    else
      unpressable.push({ binding, reason: keys.unpressable, ids: items.map(item => item.id) })
  }
  return { combos, unpressable }
}

/** 页面上浮在表格之上的东西：对话框（名称与正文的开头）、菜单与列表、展开的侧栏（它的标题），以及对话框与侧栏之外看得见的界面部件 */
interface Surfaces {
  readonly dialogs: readonly { readonly name: string, readonly text: string }[]
  readonly menus: readonly string[]
  /** 展开的侧栏的标题；没有展开时是 null */
  readonly sidebar: string | null
  readonly parts: readonly string[]
}

async function surfaces(page: Page): Promise<Surfaces> {
  return page.evaluate(() => {
    const visible = (element: Element): boolean => element.checkVisibility()
    const nameOf = (element: Element): string => {
      const labelledBy = element.getAttribute('aria-labelledby')
      const label = labelledBy?.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ').trim()
      return label !== undefined && label !== '' ? label : (element.getAttribute('aria-label') ?? '')
    }
    const textOf = (element: Element): string => (element.textContent ?? '').trim().slice(0, 80)
    const DIALOG = '[role="dialog"], [role="alertdialog"]'
    // SDK 的侧栏（ui 的 Sidebar）：展开时 aria-expanded 为真，标题在它的 header 里
    const SIDEBAR = '[data-u-comp="sidebar"]'
    const sidebar = document.querySelector(`${SIDEBAR}[aria-expanded="true"]`)
    return {
      dialogs: [...document.querySelectorAll(DIALOG)].filter(visible).map(element => ({ name: nameOf(element), text: textOf(element) })),
      // 对话框里的列表算对话框的一部分（对话框按名称核对）
      menus: [...document.querySelectorAll('[role="menu"], [role="listbox"]')].filter(element => visible(element) && element.closest(DIALOG) === null).map(element => nameOf(element) || textOf(element)),
      sidebar: sidebar === null ? null : (sidebar.querySelector('header')?.textContent ?? '').trim(),
      parts: [...new Set([...document.querySelectorAll('[data-u-comp]')]
        .filter(element => visible(element) && element.closest(DIALOG) === null && element.parentElement?.closest(SIDEBAR) == null)
        .map(element => element.getAttribute('data-u-comp') ?? ''))].sort(),
    }
  })
}

/** 当前的工作表与单元格（选区的主单元格），以及编辑栏显示的文字 */
interface Position {
  readonly sheet: string
  readonly cell: string
  readonly formulaBar: string
}

async function position(page: Page): Promise<Position> {
  const where = await page.evaluate(() => {
    const workbook = window.__nerveEditorProbe?.univerAPI.getActiveWorkbook()
    return { sheet: workbook?.getActiveSheet().getSheetName() ?? '', cell: workbook?.getActiveCell()?.getA1Notation() ?? '' }
  })
  return { ...where, formulaBar: await formulaBarText(page) }
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

/** 点一格的中心：等名称框显示它（选区已经移过去） */
async function clickAt(page: Page, a1: string): Promise<void> {
  await sheetCanvas(page).click({ position: await cellCenter(page, a1) })
  await expect(nameBox(page)).toHaveValue(a1)
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
  const find = page.getByRole('dialog', { name: '查找' })
  if (await find.count() > 0) {
    await find.getByRole('button', { name: 'Close' }).click()
    await expect(find).toBeHidden()
  }
  if (now.sidebar !== null) {
    await page.getByRole('button', { name: '关闭侧边栏' }).click()
    await expect.poll(async () => (await surfaces(page)).sidebar, { message: '等侧栏收起' }).toBeNull()
  }
}

/** 浮在表格之上的只有允许的：只读的提示、查找面板、快捷键面板；没有菜单与列表，界面部件只多了允许的 */
function expectOnlyAllowed(now: Surfaces, keys: string, baseParts: readonly string[]): void {
  const unexpectedDialogs = now.dialogs.filter(dialog => !ALLOWED_DIALOGS.includes(dialog.name)
    && !(dialog.name === ALERT_TITLE && ANY_READ_ONLY_ALERT.test(dialog.text) && !/保护|创建者/.test(dialog.text)))
  expect(unexpectedDialogs, `${keys}：不应该弹出这些对话框`).toEqual([])
  expect(now.menus, `${keys}：不应该弹出菜单或列表`).toEqual([])
  expect([now.sidebar].filter(title => title !== null && !ALLOWED_SIDEBARS.includes(title)), `${keys}：不应该打开这个侧栏`).toEqual([])
  expect(now.parts.filter(part => !baseParts.includes(part) && !ALLOWED_NEW_PARTS.includes(part)), `${keys}：不应该出现新的界面部件`).toEqual([])
}

/**
 * 复位到"数据"表的 HOME：关掉允许出现的东西（after 是上一个组合，这时才出现的不允许的东西算在它头上），切回"数据"表，
 * 缩放回 1、滚回左上角（缩放与滚动只读时照常可用，单元格的位置按它们算），先点 AWAY 再点 HOME
 */
async function resetToHome(page: Page, after: string, baseParts: readonly string[]): Promise<void> {
  await closeAllowedSurfaces(page, after, baseParts)
  const data = sheetTab(page, SAMPLE_SHEETS.data.name)
  if (await data.getAttribute('aria-selected') !== 'true') {
    await data.click()
    await expect(data).toHaveAttribute('aria-selected', 'true')
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
  await clickAt(page, AWAY)
  await clickAt(page, HOME)
}

/** 一个组合按下之后的记录（写进附件） */
interface ComboResult {
  readonly keys: string
  readonly ids: readonly string[]
  /** 按下之后尝试过的命令（执行前的记录），被取消的标上 canceled */
  readonly attempted: readonly string[]
  /** 弹出的对话框的名称与打开的侧栏（允许的那几种） */
  readonly dialogs: readonly string[]
  /** 当前单元格移到了哪里（没动时省略） */
  readonly movedTo?: string
}

function attemptedOf(commands: readonly ProbeCommand[]): string[] {
  return commands.filter(command => command.phase === 'before').map(command => command.canceled ? `${command.id}（取消）` : command.id)
}

/** 每按一个组合都核对：内容不变、没有改动文档的 mutation、没有保存请求与页面错误 */
async function expectNothingChanged(page: Page, keys: string, baseline: string, mark: number, watched: Watched): Promise<void> {
  expect(contentOf(await probeSnapshot(page)), `${keys}：内存里的内容与打开时相同`).toEqual(contentOf(baseline))
  expect(await documentChanges(page, mark, unitIdOf(baseline)), `${keys}：没有改动文档的 mutation 执行`).toEqual([])
  expect(watched.saves, `${keys}：没有保存请求`).toEqual([])
  expect(watched.pageErrors, `${keys}：没有页面错误`).toEqual([])
}

test.describe('US-M2-11 查看者打开有阅读权限的表格，只能看不能改（快捷键）', { tag: '@test-build' }, () => {
  test('只读时逐个按遍 SDK 注册的全部快捷键：内容不变、没有保存请求与页面错误，编辑栏显示的与当前单元格一致，没有弹出编辑类的面板或对话框', async ({ page }) => {
    const s = await scene('ro-keys')
    const watched = watch(page, s.documentId)
    await openReadOnly(page, s.viewer, s.documentId)
    const opened = await probeSnapshot(page)
    const platform = await univerPlatform(page)
    const shortcuts = await probeShortcuts(page)
    // 探针取到的是 SDK 的真实清单：复核发现的两个入口都在里面（SDK 改名或去掉它们时这里先失败，回头核对只读守卫的清单）
    expect(shortcuts.map(item => item.id)).toEqual(expect.arrayContaining(['ui.operation.open-feature-search', 'formula-ui.operation.insert-function']))
    const { combos, unpressable } = combosOf(shortcuts, platform)
    const shownIn = formulaBarOracle(page)

    // 选到 HOME，记下这时看得见的界面部件（之后按下每个组合，新出现的只能是允许的那几种）；HOME 的编辑栏是空的（空单元格）
    await clickAt(page, AWAY)
    await clickAt(page, HOME)
    const baseParts = (await surfaces(page)).parts
    expect(await shownIn(SAMPLE_SHEETS.data.name, HOME), `${HOME} 是空单元格`).toBe('')

    const results: ComboResult[] = []
    /** 上一个按下的组合：复位时才出现的东西算在它头上 */
    let previous = '（开始之前）'
    for (const combo of combos) {
      const ids = [...new Set(combo.items.map(item => item.id))]

      await test.step(`${combo.keys}：${ids.join('、')}`, async () => {
        await resetToHome(page, `${previous} 之后（复位时）`, baseParts)
        previous = combo.keys
        const mark = await commandMark(page)
        await page.keyboard.press(combo.keys)
        await nextFrames(page)
        const now = await surfaces(page)
        const where = await position(page)
        expectOnlyAllowed(now, combo.keys, baseParts)
        expect(where.formulaBar, `${combo.keys}：编辑栏显示的是 ${where.sheet}!${where.cell} 真实的内容`).toBe(await shownIn(where.sheet, where.cell))
        await expectNothingChanged(page, combo.keys, opened, mark, watched)
        results.push({
          keys: combo.keys,
          ids,
          attempted: attemptedOf(await probeCommands(page, mark)),
          dialogs: [...now.dialogs.map(dialog => dialog.name), ...(now.sidebar === null ? [] : [`侧栏：${now.sidebar}`])],
          ...(where.sheet === SAMPLE_SHEETS.data.name && where.cell === HOME ? {} : { movedTo: `${where.sheet}!${where.cell}` }),
        })
      })
    }
    // 最后一个组合弹出的也关掉，全程没有改动
    await closeAllowedSurfaces(page, `${previous} 之后（结束时）`, baseParts)
    await expectNothingChanged(page, '（结束）', opened, 0, watched)

    // 覆盖：按过的组合里派发到命令的、没有派发的（前提条件不满足），与按不出来的组合，都写进附件
    const coverage = {
      platform,
      shortcuts: shortcuts.length,
      combos: combos.length + unpressable.length,
      pressed: combos.length,
      dispatched: results.filter(result => result.attempted.length > 0).length,
      notDispatched: results.filter(result => result.attempted.length === 0).map(result => `${result.keys}：${result.ids.join('、')}`),
      unpressable,
      results,
    }
    test.info().annotations.push({ type: '快捷键的覆盖', description: `${coverage.shortcuts} 项、${coverage.combos} 种组合：按了 ${coverage.pressed} 种，派发到命令的 ${coverage.dispatched} 种，按不出来的 ${unpressable.length} 种` })
    await test.info().attach('快捷键的覆盖', { body: JSON.stringify(coverage, null, 2), contentType: 'application/json' })
  })
})
