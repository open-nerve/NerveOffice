// 查看者的只读（M2-P3 设计 §3.3–§3.7、§4 的 E2E 一行，US-M2-11）：查看者与归档空间里的文档只能看不能改。
// 只读样本（support/read-only-sample.ts：5 张表、浮动图片、批注、超链接、数据验证、条件格式、筛选）写进团队空间，查看者打开后
// 逐项试 M0 的 28 个表格编辑入口（M0-P3 报告 §5）与界面上还能碰到的入口：
// - 画布上的内容读不出来：比较测试构建的探针给出的内存快照（support/editor-probe.ts，比较的口径见 contentOf）；
// - 每项都等到确定的信号再比较，不用固定时长的等待：命令被只读守卫取消、被 SDK 的权限检查拦下（它弹出提示，关掉），或者执行完；
//   只读时没有控制点的手势（填充柄、非冻结区域的行高分隔线、冻结线、浮动图片）不产生命令：先确认没有意外弹出的提示，再点一个单元格，
//   等名称框显示它（界面的输入按顺序处理）。冻结区域的行高分隔线不同：SDK 在那里仍显示调整的光标，拖动之后被权限检查拦下、
//   弹出只读的提示（与非冻结区域不一致，已写入上游报告），同样核对数据不变；
// - 对照：作者（能编辑）逐项做同样的事，每项确实改动了内存快照（每项用新写的文档，并行执行），只读时的"没变"才不是空断言；
// - 另有界面的隐藏（同样以作者的界面作对照）、还能读、打开不产生改动、服务端拒绝保存、公式在 Worker 里算出结果、归档空间。
// S3 的 E2E 发现的 5 个问题与 P3 审查之后的修复（只读守卫 editor/read-only/、语言包 editor/profile/locale.ts）：编辑栏点不进去
// （点编辑框、从别处按下在编辑框上松开之后，查找、复制、方向键照常）；拦下操作的提示是只读的说法（含筛选按钮）；浮动图片点不中、
// 拖不动；冻结线拖不动；只读时打不开替换；批注浮层的文本框只读。
// Univer 自己的快捷键按页面的平台判断取修饰键（support/keyboard.ts：Linux 上的 WebKit 也报 Mac 的 UA）。
// 用到探针（只在测试构建里）：标签 @test-build，外部模式测生产镜像时按标签排除（playwright.config.ts）；
// 文件末尾的冒烟用例不用探针，生产镜像上也跑（容器 E2E）。
import type { BrowserContext, Locator, Page } from '@playwright/test'
import type { TestUser } from '../../support/database.ts'
import type { FacadeScope, ProbeCommand } from '../../support/editor-probe.ts'
import type { Workbook } from '../../support/sheet.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { SNAPSHOT_UPLOAD_CONTENT_TYPE } from '@nerve-office/contracts'
import { archiveSpace, createDocumentIn, createTeamSpace, createUser } from '../../support/database.ts'
import { activeImageCount, cellCenter, cellRect, clickCell, commandMark, contentOf, nameBox, probeCommands, probeSnapshot, runFacade, waitForCommand } from '../../support/editor-probe.ts'
import { e2eOrigin } from '../../support/environment.ts'
import { expect, test } from '../../support/fixtures.ts'
import { deleteDrawingKey, pressUniverShortcut } from '../../support/keyboard.ts'
import { readOnlySampleFor, SAMPLE_CELLS, SAMPLE_FORMULAS, SAMPLE_SHEETS, sampleWithoutFormulaValuesFor } from '../../support/read-only-sample.ts'
import { loginThroughApi } from '../../support/session.ts'
import { openEditor, resourceOf, saveButton, savedContent, selectCell, sheetCanvas, sheetTab, waitForEditor } from '../../support/sheet.ts'

interface Scene {
  readonly author: TestUser
  readonly viewer: TestUser
  readonly spaceId: string
  /** 写好样本的一份文档 */
  readonly documentId: string
}

/** 系统管理员建团队空间，作者是空间管理员，查看者是查看者；作者在空间里有一份写好样本（默认是只读样本）的文档 */
async function scene(prefix: string, snapshotFor: (unitId: string) => string = readOnlySampleFor): Promise<Scene> {
  const admin = await createUser(`${prefix}-admin`, '系统管理员', { systemRole: 'admin' })
  const author = await createUser(`${prefix}-author`, '作者')
  const viewer = await createUser(`${prefix}-viewer`, '查看者')
  const space = await createTeamSpace('只读样本', admin, [[author, 'admin'], [viewer, 'viewer']])
  return { author, viewer, spaceId: space.id, documentId: await createDocumentIn(space.id, author, '只读样本', snapshotFor) }
}

/** 只读的全过程都应该没有的：页面错误（被取消的命令不产生页面错误，M2-P3 设计 §3.8）与保存请求 */
function watch(page: Page, documentId: string): { readonly pageErrors: string[], readonly saves: string[] } {
  const watched = { pageErrors: [] as string[], saves: [] as string[] }
  page.on('pageerror', error => watched.pageErrors.push(`${error.name}: ${error.message}`))
  page.on('request', (request) => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname === `/api/documents/${documentId}/content`)
      watched.saves.push(request.url())
  })
  return watched
}

/**
 * 打开到 steady：SDK 的一部分控制器在它的 Steady 阶段才装上（例如查找替换：它的快捷键要等查找的提供方注册之后才可用，
 * find-replace 的 find-replace.service.ts 的 _syncActiveProvider），入口要在这之后试
 */
const OPENED = 'steady'

/** 查看者（或归档空间里的成员）打开：页头显示"只能查看" */
async function openReadOnly(page: Page, user: TestUser, documentId: string): Promise<void> {
  await loginThroughApi(page, user)
  await openEditor(page, documentId, OPENED)
  await expect(page.locator('#editor-chrome').getByText('只能查看', { exact: true })).toBeVisible()
}

/** 快照的 unitId（本文档的 mutation 按它认） */
function unitIdOf(snapshotText: string): string {
  return (JSON.parse(snapshotText) as Workbook).id
}

/** 快照里 sheetId 这张工作表 A1 写法的一格的值（v）；没有时为 undefined */
function cellValueIn(snapshotText: string, sheetId: string, a1: string): unknown {
  const match = /^([A-Z])(\d+)$/.exec(a1)
  if (match === null)
    throw new Error(`不支持的单元格写法：${a1}`)
  const row = Number(match[2]) - 1
  const column = (match[1] ?? 'A').charCodeAt(0) - 'A'.charCodeAt(0)
  return (JSON.parse(snapshotText) as Workbook).sheets[sheetId]?.cellData[row]?.[column]?.v
}

/** 执行选项里带这些标记的 mutation 不是用户的修改（apps/web 的 change-classifier.ts） */
const NOT_USER_CHANGE_FLAGS = ['onlyLocal', 'fromCollab', 'fromChangeset', 'fromFormula']
/** 类型是 MUTATION、实际只清除界面上的图片变换框（插件档案 v1 §5.3 的排除名单） */
const NOT_CHANGE_MUTATIONS = ['sheet.operation.clear-drawing-transformer']

/** mark 之后执行了的、变更检测会认作修改的 mutation：只读时一条都不应该有（防火墙的不变量，M2-P3 设计 §3.3） */
async function documentChanges(page: Page, mark: number, unitId: string): Promise<ProbeCommand[]> {
  return (await probeCommands(page, mark)).filter(command => command.phase === 'executed' && command.kind === 'mutation'
    && (command.unitId === undefined || command.unitId === unitId)
    && !command.flags.some(flag => NOT_USER_CHANGE_FLAGS.includes(flag))
    && !NOT_CHANGE_MUTATIONS.includes(command.id))
}

/**
 * mark 之后尝试过的、变更检测会认作修改的 mutation（执行前的记录，被取消的也算）：打开的过程中一条都不应该有，
 * 否则就是进入只读时 SDK 试图改文档、被防火墙取消了（P3 审查 B9）
 */
async function documentChangeAttempts(page: Page, mark: number, unitId: string): Promise<ProbeCommand[]> {
  return (await probeCommands(page, mark)).filter(command => command.phase === 'before' && command.kind === 'mutation'
    && (command.unitId === undefined || command.unitId === unitId)
    && !command.flags.some(flag => NOT_USER_CHANGE_FLAGS.includes(flag))
    && !NOT_CHANGE_MUTATIONS.includes(command.id))
}

/** mark 之后内存里的内容与 baseline 相同，也没有改动文档的 mutation 执行 */
async function expectUnchanged(page: Page, baseline: string, mark: number): Promise<void> {
  expect(contentOf(await probeSnapshot(page)), '内存里的内容与打开时相同').toEqual(contentOf(baseline))
  expect(await documentChanges(page, mark, unitIdOf(baseline)), '没有改动文档的 mutation 执行').toEqual([])
}

/**
 * SDK 的权限检查拦下命令时弹出的提示（sheets-ui 的 sheet-permission-check-ui.controller.ts）。标题是"提示"，
 * 正文由平台的语言包改成只读的说法（editor/profile/locale.ts；SDK 的原文是给保护区域写的）
 */
function permissionAlert(page: Page): Locator {
  return page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '提示', exact: true }) })
}

/** 关掉权限检查的提示：先核对它的说法（text），不再提保护、不让人联系创建者 */
async function closePermissionAlert(page: Page, text: string): Promise<void> {
  const alert = permissionAlert(page)
  await expect(alert).toContainText(text)
  await expect(alert).not.toContainText(/保护|创建者/)
  await alert.getByRole('button', { name: '确定', exact: true }).click()
  await expect(alert).toBeHidden()
}

/** 各种操作被拦下时的提示（与 editor/profile/locale.ts 的 READ_ONLY_PERMISSION_TEXTS 相同；E2E 引用不到 web 的代码） */
const ALERT = {
  edit: '这份文档只能查看，不能修改。',
  paste: '这份文档只能查看，不能粘贴。',
  cut: '这份文档只能查看，不能剪切。',
  style: '这份文档只能查看，不能修改格式。',
  sheet: '这份文档只能查看，不能调整工作表。',
  rowCol: '这份文档只能查看，不能调整行列。',
  insertRowCol: '这份文档只能查看，不能插入行列。',
  removeRowCol: '这份文档只能查看，不能删除行列。',
  image: '这份文档只能查看，不能修改图片。',
  conditionalFormat: '这份文档只能查看，不能修改条件格式。',
  dataValidation: '这份文档只能查看，不能修改数据验证。',
  filter: '这份文档只能查看，不能使用筛选。',
} as const

/**
 * 只看一次、不重试：web 优先的断言给最短的时限，第一次检查不满足就失败（Playwright 的 timeout: 0 是不限时，不能用）。
 * 用在"等到确定的时刻之后，这时应该已经如此"的地方：能编辑时的对照同样只看一次，只读时的否定才有校准
 */
const LOOK_ONCE = { timeout: 1 } as const

/** 一步操作之后等到的信号 */
type Outcome
  /** 这条命令执行完 */
  = | { readonly executed: string }
  /** 被只读守卫（超链接是入口守卫）取消：执行前的记录里 canceled 为真 */
    | { readonly canceled: string }
  /** 被 SDK 的权限检查拦下：只有执行前的记录。拦下时 SDK 弹出提示（alert 是提示的说法），关掉它 */
    | { readonly blocked: string, readonly alert: string }
  /**
   * 不产生这条命令（只读时这个手势没有控制点）：之后点 thenClick 这一格，等名称框显示它，确认手势已经处理完。
   * 点之前先确认没有意外弹出的提示：弹出时点击被它挡住，会一直等到超时
   */
    | { readonly absent: string, readonly thenClick: string }

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

type Mode = 'read' | 'edit'

/** 做一步操作，按打开的方式等到对应的信号 */
async function step(page: Page, mode: Mode, act: () => Promise<unknown>, outcomes: { readonly read?: Outcome, readonly edit?: Outcome }): Promise<void> {
  const mark = await commandMark(page)
  await act()
  const outcome = outcomes[mode]
  if (outcome !== undefined)
    await settle(page, mark, outcome)
}

interface Entry {
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
async function showSheet(page: Page, name: string): Promise<void> {
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

/** 等两个动画帧：SDK 在动画帧里结算的状态（标签的拖动位置、右键菜单的弹出）这时已经处理完 */
async function nextFrames(page: Page): Promise<void> {
  await page.evaluate(async () => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
}

/** 键入（M0 的第一个界面入口）：归档空间的用例也用它 */
const TYPING: Entry = {
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
function formulaBarEditor(page: Page): Locator {
  return page.locator('[data-u-comp="formula-bar"] [data-u-comp="formula-editor"]')
}

function formulaBarInput(page: Page): Locator {
  return page.locator('[id="__editor___INTERNAL_EDITOR__DOCS_FORMULA_BAR"]')
}

/** 编辑栏内部文档的单元：只读时这个单元上不应该有插入文字等命令（编辑栏没有收到输入） */
const FORMULA_BAR_UNIT = '__INTERNAL_EDITOR__DOCS_FORMULA_BAR'

/**
 * 在名称框上按下、拖到编辑栏的编辑框上松开（P3 审查 A1 的复现）：按下不在编辑框上，只读守卫拦不到；
 * 松开时编辑框自己的 mouseup 会聚焦编辑栏的编辑器
 */
async function slipOntoFormulaBar(page: Page): Promise<void> {
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
async function findApple(page: Page): Promise<void> {
  await step(page, 'read', async () => pressUniverShortcut(page, 'F'), { read: { executed: 'ui.operation.open-find-dialog' } })
  const find = page.getByRole('dialog', { name: '查找' })
  await find.getByRole('textbox', { name: '输入查找内容' }).fill('苹果')
  await find.getByRole('textbox', { name: '输入查找内容' }).press('Enter')
  await expect(find).toContainText(/[12]\/2/)
  await find.getByRole('button', { name: 'Close' }).click()
  await expect(find).toBeHidden()
}

// M0 的界面入口（U 类 7 项，spikes/m0/e2e/v09-read-mode.spec.ts 的 37–102、115–132 行）
const UI_ENTRIES: readonly Entry[] = [
  TYPING,
  {
    name: '删除：A2 按 Delete',
    run: async (page, mode) => {
      await clickCell(page, 'A2')
      await step(page, mode, async () => page.keyboard.press('Delete'), {
        read: { blocked: 'sheet.command.clear-selection-content', alert: ALERT.edit },
        edit: { executed: 'sheet.command.clear-selection-content' },
      })
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
 * 查找替换：把"苹果"全部替换为"苹果X"。只读时打不开替换（只读守卫在执行前取消打开替换的操作）：查找面板里的"替换 / 高级查找"
 * 与替换的快捷键都进不了替换，查找照常。
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
  await step(page, mode, async () => find.getByText('替换 / 高级查找').click(), {
    read: { canceled: 'ui.operation.open-replace-dialog' },
    edit: { executed: 'ui.operation.open-replace-dialog' },
  })
  const replaceText = find.getByRole('textbox', { name: '输入替换内容' })
  if (mode === 'read') {
    await expect(replaceText).toHaveCount(0)
    await expect(find).toContainText(/[12]\/2/)
    await find.getByRole('button', { name: 'Close' }).click()
    await expect(find).toBeHidden()
    // 替换的快捷键：苹果的平台上也是 Control+H（find-replace 的 find-replace.shortcut.ts:78-88，mac 绑定的是 MAC_CTRL）
    await step(page, mode, async () => page.keyboard.press('Control+H'), { read: { canceled: 'ui.operation.open-replace-dialog' } })
    await expect(find).toHaveCount(0)
    return
  }
  await replaceText.fill('苹果X')
  await find.getByRole('button', { name: '替换全部', exact: true }).click()
  await step(page, mode, async () => page.getByRole('dialog', { name: '确定要替换所有的匹配项吗？' }).getByRole('button', { name: '确定', exact: true }).click(), {
    edit: { executed: 'ui.command.replace-all-matches' },
  })
  await find.getByRole('button', { name: 'Close' }).click()
  await expect(find).toBeHidden()
}

// 界面上还能碰到的其他入口（只读时的界面没有工具栏与右键菜单，但快捷键、工作表标签、全部工作表的菜单、图片、批注的浮层与查找替换还在）
const OTHER_UI_ENTRIES: readonly Entry[] = [
  { name: '查找替换：把"苹果"全部替换为"苹果X"（只读时打不开替换）', run: findAndReplaceAll },
  {
    name: '格式的快捷键：A2 按 Ctrl/Cmd+B、I、U',
    run: async (page, mode) => {
      await clickCell(page, 'A2')
      for (const key of ['B', 'I', 'U']) {
        await step(page, mode, async () => pressUniverShortcut(page, key), {
          read: { blocked: 'sheet.command.set-style', alert: ALERT.style },
          edit: { executed: 'sheet.command.set-style' },
        })
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
        read: { blocked: 'sheet.command.clear-selection-content', alert: ALERT.edit },
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
  { name: '筛选按钮："筛选"表 A1 的筛选按钮', run: openFilterPanel },
]

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
 * 拖动冻结区域（第 1 行冻结）的行高：SDK 在冻结区域仍显示调整行高的光标，只读时拖动之后被权限检查拦下、弹出只读的提示
 * （非冻结区域只读时没有这个控制点，见"拖动行高"；不一致已写入上游报告）。数据不变由 expectUnchanged 核对（P3 审查 B7）
 */
async function dragFrozenRowHeight(page: Page, mode: Mode): Promise<void> {
  await showSheet(page, SAMPLE_SHEETS.data.name)
  const origin = await canvasOrigin(page)
  const a1 = await cellRect(page, 'A1')
  // 行标题的中间（A1 的左边就是行标题的宽度），第 1 行的下边
  const x = origin.x + a1.startX / 2
  const y = origin.y + a1.endY - 1
  await step(page, mode, async () => {
    await page.mouse.move(x, y - 8)
    await page.mouse.move(x, y, { steps: 4 })
    await page.mouse.down()
    await page.mouse.move(x, y + 30, { steps: 6 })
    await page.mouse.up()
  }, {
    read: { blocked: 'sheet.command.delta-row-height', alert: ALERT.rowCol },
    edit: { executed: 'sheet.command.delta-row-height' },
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
  await step(page, mode, async () => pressUniverShortcut(page, 'Z'), { read: { canceled: 'univer.command.undo' }, edit: { executed: 'univer.command.undo' } })
  // 重做的快捷键：各平台都是 Ctrl/Cmd+Y（苹果的平台另有 Cmd+Shift+Z，ui 的 shared-shortcut.controller.ts）
  await step(page, mode, async () => pressUniverShortcut(page, 'Y'), { read: { canceled: 'univer.command.redo' }, edit: { executed: 'univer.command.redo' } })
}

/** 工作表标签栏左边"全部工作表"的菜单按钮（图标按钮，没有可访问的名称：按下拉菜单的触发器与 SDK 的组件标记定位） */
function allSheetsMenuButton(page: Page): Locator {
  return page.locator('[data-slot="dropdown-menu-trigger"]').filter({ has: page.locator('[data-u-comp="sheet-bar-append-button"]') })
}

/** 新增工作表的按钮：标签栏里同样标记的图标按钮中，不在"全部工作表"下拉菜单触发器里的那个（sheets-ui 的 SheetBar.tsx:100-111） */
function addSheetButton(page: Page): Locator {
  return page.locator('[data-u-comp="sheet-bar-append-button"]:not([data-slot="dropdown-menu-trigger"] > *)')
}

/** Facade 入口：M0 的 F 类 21 项（v09-read-mode.spec.ts 的 103–142 行），另加"取消已有的超链接" */
interface FacadeEntry {
  readonly name: string
  /** 在页面里执行（序列化过去，不能引用外面的变量） */
  readonly call: (scope: FacadeScope) => unknown
  readonly read: Outcome
  readonly edit: Outcome
  readonly unchangedWhenEditable?: true
}

const FACADE_ENTRIES: readonly FacadeEntry[] = [
  { name: '筛选', call: ({ sheet }) => sheet.getRange('A1:F6').createFilter(), read: { canceled: 'sheet.mutation.set-filter-range' }, edit: { executed: 'sheet.command.set-filter-range' } },
  { name: '排序', call: ({ sheet }) => sheet.getRange('A2:F6').sort({ column: 1, ascending: false }), read: { canceled: 'sheet.mutation.reorder-range' }, edit: { executed: 'sheet.command.sort-range' } },
  { name: '新增工作表', call: ({ workbook }) => workbook.insertSheet('新表'), read: { canceled: 'sheet.mutation.insert-sheet' }, edit: { executed: 'sheet.command.insert-sheet' } },
  { name: '删除工作表', call: ({ workbook }) => workbook.deleteSheet(workbook.getSheetByName('汇总')), read: { canceled: 'sheet.mutation.remove-sheet' }, edit: { executed: 'sheet.command.remove-sheet' } },
  { name: '工作表改名', call: ({ workbook }) => workbook.getSheetByName('汇总').setName('汇总二'), read: { blocked: 'sheet.command.set-worksheet-name', alert: ALERT.sheet }, edit: { executed: 'sheet.command.set-worksheet-name' } },
  { name: '复制工作表', call: ({ workbook }) => workbook.duplicateSheet(workbook.getSheetByName('汇总')), read: { canceled: 'sheet.mutation.insert-sheet' }, edit: { executed: 'sheet.command.copy-sheet' } },
  { name: '隐藏工作表', call: ({ workbook }) => workbook.getSheetByName('汇总').hideSheet(), read: { canceled: 'sheet.mutation.set-worksheet-hidden' }, edit: { executed: 'sheet.command.set-worksheet-hidden' } },
  { name: '移动工作表', call: ({ workbook }) => workbook.moveSheet(workbook.getSheetByName('汇总'), 0), read: { blocked: 'sheet.command.set-worksheet-order', alert: ALERT.sheet }, edit: { executed: 'sheet.command.set-worksheet-order' } },
  { name: '移动图片', call: async ({ workbook }) => workbook.getSheetByName('功能').getImages()[0]?.setPositionAsync(12, 12), read: { blocked: 'sheet.command.set-sheet-image', alert: ALERT.image }, edit: { executed: 'sheet.command.set-sheet-image' } },
  { name: '删除图片', call: ({ workbook }) => workbook.getSheetByName('功能').getImages()[0]?.remove(), read: { blocked: 'sheet.command.remove-sheet-image', alert: ALERT.image }, edit: { executed: 'sheet.command.remove-sheet-image' } },
  { name: '缩放图片', call: async ({ workbook }) => workbook.getSheetByName('功能').getImages()[0]?.setSizeAsync(200, 150), read: { blocked: 'sheet.command.set-sheet-image', alert: ALERT.image }, edit: { executed: 'sheet.command.set-sheet-image' } },
  { name: '设行高', call: ({ sheet }) => sheet.setRowHeight(5, 40), read: { blocked: 'sheet.command.set-row-height', alert: ALERT.rowCol }, edit: { executed: 'sheet.command.set-row-height' } },
  { name: '插入行', call: ({ sheet }) => sheet.insertRowAfter(3), read: { blocked: 'sheet.command.insert-row-by-range', alert: ALERT.insertRowCol }, edit: { executed: 'sheet.command.insert-row-by-range' } },
  { name: '删除行', call: ({ sheet }) => sheet.deleteRows(16, 1), read: { blocked: 'sheet.command.remove-row-by-range', alert: ALERT.removeRowCol }, edit: { executed: 'sheet.command.remove-row-by-range' } },
  { name: '合并单元格', call: ({ sheet }) => sheet.getRange('K10:L11').merge(), read: { canceled: 'sheet.mutation.add-worksheet-merge' }, edit: { executed: 'sheet.command.add-worksheet-merge' } },
  { name: '加粗', call: ({ sheet }) => sheet.getRange('A2:B3').setFontWeight('bold'), read: { blocked: 'sheet.command.set-style', alert: ALERT.style }, edit: { executed: 'sheet.command.set-style' } },
  {
    name: '条件格式',
    call: ({ sheet }) => sheet.addConditionalFormattingRule(sheet.newConditionalFormattingRule().whenCellNotEmpty().setRanges([sheet.getRange('K1:K20').getRange()]).setBackground('#fecaca').build()),
    read: { blocked: 'sheet.command.add-conditional-rule', alert: ALERT.conditionalFormat },
    edit: { executed: 'sheet.command.add-conditional-rule' },
  },
  { name: '数据验证', call: ({ api, sheet }) => sheet.getRange('K20:K25').setDataValidation(api.newDataValidation().requireNumberBetween(1, 10).build()), read: { blocked: 'sheet.command.addDataValidation', alert: ALERT.dataValidation }, edit: { executed: 'sheet.command.addDataValidation' } },
  // M5 之前两种方式都被入口守卫取消（P4 设计 §3.6.8）：能编辑时同样不改动，对照组另有"取消已有的超链接"
  { name: '超链接', call: async ({ sheet }) => sheet.getRange('K31').setHyperLink('https://example.com/new', '新链接'), read: { canceled: 'sheets.command.add-hyper-link' }, edit: { canceled: 'sheets.command.add-hyper-link' }, unchangedWhenEditable: true },
  { name: '批注', call: ({ sheet }) => sheet.getRange('K30').createOrUpdateNote({ note: '新备注', width: 160, height: 60 }), read: { canceled: 'sheet.mutation.update-note' }, edit: { executed: 'sheet.mutation.update-note' } },
  { name: '全部替换', call: async ({ api }) => (await api.createTextFinderAsync('苹果')).replaceAllWithAsync('苹果X'), read: { blocked: 'sheet.command.set-range-values', alert: ALERT.edit }, edit: { executed: 'sheet.command.replace' } },
  { name: '取消已有的超链接（"功能"表 H3）', call: ({ workbook }) => workbook.getSheetByName('功能').getRange('H3').cancelHyperLink(), read: { canceled: 'sheet.mutation.set-range-values' }, edit: { executed: 'sheets.command.cancel-hyper-link' } },
]

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

test.describe('US-M2-11 查看者打开有阅读权限的表格，只能看不能改', { tag: '@test-build' }, () => {
  test('打开不产生改动：内存快照与服务器上的内容逐字节相同，保护类资源为空，没有保存请求；服务端拒绝查看者的保存', async ({ page }) => {
    const s = await scene('ro-open')
    const watched = watch(page, s.documentId)
    await openReadOnly(page, s.viewer, s.documentId)
    const stored = await savedContent(page, s.documentId)
    // 样本已经收敛（打开之后保存的字节就是它自己），所以不用规范化，逐字节比较
    const snapshot = await probeSnapshot(page)
    expect(snapshot).toBe(stored.text)
    // 探针在就绪时装上：从就绪到 steady，没有改动文档的 mutation 的尝试（被防火墙取消的也没有，P3 审查 B9）
    expect(await documentChangeAttempts(page, 0, unitIdOf(snapshot))).toEqual([])
    // 不写保护类资源（不用 setReadOnly()，不创建保护规则），也没有本地授权服务的资源（ADR-009）
    const workbook = JSON.parse(snapshot) as Workbook
    for (const name of ['SHEET_RANGE_PROTECTION_PLUGIN', 'SHEET_WORKSHEET_PROTECTION_PLUGIN', 'SHEET_WORKSHEET_PROTECTION_POINT_PLUGIN'])
      expect(resourceOf(workbook, name) ?? {}, name).toEqual({})
    expect(workbook.resources.map(resource => resource.name)).not.toContain('SHEET_AuthzIoMockService_PLUGIN')
    expect(watched.saves).toEqual([])
    expect(watched.pageErrors).toEqual([])

    // 前端的只读只是体验层，写入的边界在服务端（ADR-011）：查看者直接调保存的接口也被拒绝，内容不变
    const { csrfToken } = await (await page.request.get('/api/auth/session')).json() as { csrfToken: string }
    const edited = { ...workbook, name: '查看者改过' }
    const query = new URLSearchParams({ baseRevision: String(stored.revision), requestId: randomUUID(), clientInstanceId: randomUUID(), localSeq: '1' })
    const response = await page.request.put(`/api/documents/${s.documentId}/content?${query.toString()}`, {
      data: zlib.gzipSync(Buffer.from(JSON.stringify(edited), 'utf8')),
      headers: { 'content-type': SNAPSHOT_UPLOAD_CONTENT_TYPE, 'origin': e2eOrigin(), 'x-csrf-token': csrfToken },
    })
    expect(response.status(), await response.text()).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'PERMISSION_DENIED' } })
    const after = await savedContent(page, s.documentId)
    expect([after.revision, after.text]).toEqual([stored.revision, stored.text])
  })

  test('界面没有编辑入口：没有工具栏、右键不弹出菜单、没有底栏菜单与新增工作表按钮，页头只能查看、没有保存按钮（对照：作者打开同一份文档时都有）', async ({ page, anotherDevice }) => {
    // 打开两次编辑器（作者与查看者），各到 steady
    test.slow()
    const s = await scene('ro-chrome')
    // 对照：能编辑时这些入口都在，下面只读时的"没有"才不是空断言
    const authorWatched = watch(anotherDevice, s.documentId)
    await loginThroughApi(anotherDevice, s.author)
    await openEditor(anotherDevice, s.documentId, OPENED)
    await expectEditingChrome(anotherDevice, 'edit')
    expect(authorWatched.pageErrors).toEqual([])

    const watched = watch(page, s.documentId)
    await openReadOnly(page, s.viewer, s.documentId)
    await expectEditingChrome(page, 'read')
    expect(watched.pageErrors).toEqual([])
  })

  test('界面入口（M0 的 7 项）都无效：键入、删除、粘贴、剪切后粘贴、拖动填充柄、编辑栏、拖动行高', async ({ page, context, browserName }) => {
    test.slow()
    // 与对照组的条件一致（P3 审查 B10）
    await grantClipboard(context, browserName)
    const s = await scene('ro-ui')
    const watched = watch(page, s.documentId)
    await openReadOnly(page, s.viewer, s.documentId)
    const opened = await probeSnapshot(page)
    for (const entry of UI_ENTRIES) {
      await test.step(entry.name, async () => {
        const mark = await commandMark(page)
        await entry.run(page, 'read')
        await expectUnchanged(page, opened, mark)
      })
    }
    expect(watched.saves).toEqual([])
    expect(watched.pageErrors).toEqual([])
  })

  test('界面上还能碰到的其他入口都无效：查找替换、格式的快捷键、撤销与重做、双击与拖动工作表标签、全部工作表的菜单、拖动与删除图片、改批注、冻结线、冻结区域的行高、筛选按钮', async ({ page, context, browserName }) => {
    test.slow()
    // 与对照组的条件一致（P3 审查 B10）
    await grantClipboard(context, browserName)
    const s = await scene('ro-other')
    const watched = watch(page, s.documentId)
    await openReadOnly(page, s.viewer, s.documentId)
    const opened = await probeSnapshot(page)
    const entries: readonly Entry[] = [
      ...OTHER_UI_ENTRIES.slice(0, 2),
      {
        name: '撤销与重做的快捷键：被只读守卫取消',
        run: async (target, mode) => {
          await clickCell(target, 'A5')
          await undoAndRedo(target, mode)
        },
      },
      ...OTHER_UI_ENTRIES.slice(2),
    ]
    for (const entry of entries) {
      await test.step(entry.name, async () => {
        const mark = await commandMark(page)
        await entry.run(page, 'read')
        await expectUnchanged(page, opened, mark)
      })
    }
    // 工作表的顺序与可见的标签都没变（"隐藏"表仍然隐藏）
    await expect(page.getByRole('tablist', { name: '工作表标签页' }).getByRole('tab')).toHaveText(['数据', '汇总', '功能', '筛选'])
    expect(watched.saves).toEqual([])
    expect(watched.pageErrors).toEqual([])
  })

  test('Facade 入口（M0 的 21 项，另加取消已有的超链接）经探针逐项都无效：被只读守卫取消，或被权限检查拦下', async ({ page }) => {
    test.slow()
    const s = await scene('ro-facade')
    const watched = watch(page, s.documentId)
    await openReadOnly(page, s.viewer, s.documentId)
    const opened = await probeSnapshot(page)
    for (const entry of FACADE_ENTRIES.map(facadeEntry)) {
      await test.step(entry.name, async () => {
        const mark = await commandMark(page)
        await entry.run(page, 'read')
        await expectUnchanged(page, opened, mark)
      })
    }
    expect(watched.saves).toEqual([])
    expect(watched.pageErrors).toEqual([])
  })

  // 对照：能编辑时，同一批入口确实改动了内存快照。每项一个用例、用新写的文档（互不影响，失败时直接看到是哪一项）；
  // 作者有未保存的修改，用例结束时关页面不会提示
  test.describe('对照：能编辑时，同一批入口确实改动了内存快照', () => {
    // 每项用自己的文档、互不影响：并行执行（P3 审查 B6）
    test.describe.configure({ mode: 'parallel' })
    for (const entry of [...UI_ENTRIES, ...OTHER_UI_ENTRIES, ...FACADE_ENTRIES.map(facadeEntry)]) {
      test(entry.name, async ({ page, context, browserName }) => {
        await grantClipboard(context, browserName)
        const s = await scene('ro-ctl')
        const watched = watch(page, s.documentId)
        await loginThroughApi(page, s.author)
        expect(await changeWhenEditable(page, s, entry)).toBe(expectedWhenEditable(entry))
        // 样本在能编辑时同样正常打开、做这一项：没有页面错误（CSP 违规由夹具核对）
        expect(watched.pageErrors).toEqual([])
      })
    }
  })

  test('对照：能编辑时，撤销与重做的快捷键确实撤销与重做', async ({ page }) => {
    const s = await scene('ro-ctl-undo')
    await loginThroughApi(page, s.author)
    await openEditor(page, s.documentId, OPENED)
    const opened = contentOf(await probeSnapshot(page))
    await clickCell(page, 'A2')
    await step(page, 'edit', async () => pressUniverShortcut(page, 'B'), { edit: { executed: 'sheet.command.set-style' } })
    const bold = contentOf(await probeSnapshot(page))
    expect(bold).not.toEqual(opened)
    const mark = await commandMark(page)
    await pressUniverShortcut(page, 'Z')
    await waitForCommand(page, mark, { phase: 'executed', id: 'univer.command.undo' })
    expect(contentOf(await probeSnapshot(page))).toEqual(opened)
    await pressUniverShortcut(page, 'Y')
    await waitForCommand(page, mark, { phase: 'executed', id: 'univer.command.redo' })
    expect(contentOf(await probeSnapshot(page))).toEqual(bold)
  })

  test('还能读：切换工作表、选中单元格、复制、查找、悬停看批注', async ({ page, context, browserName }) => {
    const s = await scene('ro-read')
    const watched = watch(page, s.documentId)
    await grantClipboard(context, browserName)
    await openReadOnly(page, s.viewer, s.documentId)
    const opened = await probeSnapshot(page)
    const mark = await commandMark(page)

    for (const sheet of [SAMPLE_SHEETS.summary, SAMPLE_SHEETS.features, SAMPLE_SHEETS.filter, SAMPLE_SHEETS.data])
      await showSheet(page, sheet.name)
    await clickCell(page, 'C3')

    await clickCell(page, 'A2')
    await step(page, 'read', async () => pressUniverShortcut(page, 'C'), { read: { executed: 'univer.command.copy' } })
    await expectClipboardText(page, browserName, SAMPLE_CELLS.a2)

    await pressUniverShortcut(page, 'F')
    const find = page.getByRole('dialog', { name: '查找' })
    await find.getByRole('textbox', { name: '输入查找内容' }).fill('苹果')
    await find.getByRole('textbox', { name: '输入查找内容' }).press('Enter')
    await expect(find).toContainText(/[12]\/2/)
    await find.getByRole('button', { name: 'Close' }).click()
    await expect(find).toBeHidden()

    await showSheet(page, SAMPLE_SHEETS.features.name)
    await sheetCanvas(page).hover({ position: await cellCenter(page, 'H1') })
    const note = page.getByRole('textbox', { name: '在此输入' })
    await expect(note).toHaveValue(SAMPLE_CELLS.note)
    // 批注的文本框是只读的：文字照常显示（M2-P3 S3 之后的修复）
    await expect(note).toHaveJSProperty('readOnly', true)

    await expectUnchanged(page, opened, mark)
    expect(watched.saves).toEqual([])
    expect(watched.pageErrors).toEqual([])
  })

  test('编辑栏点不进去：点编辑框、从名称框按下在编辑框上松开之后，查找、复制、方向键与格式的快捷键照常（M2-P3 S3 之后与 P3 审查 A1 之后的修复）', async ({ page, context, browserName }) => {
    const s = await scene('ro-bar')
    const watched = watch(page, s.documentId)
    await grantClipboard(context, browserName)
    await openReadOnly(page, s.viewer, s.documentId)
    const opened = await probeSnapshot(page)
    const mark = await commandMark(page)

    await clickCell(page, 'K5')
    await formulaBarEditor(page).click()
    await expect(formulaBarInput(page)).not.toBeFocused()
    // 键入的字交给单元格：被权限检查拦下；回车照常把选区下移
    await step(page, 'read', async () => page.keyboard.type('abc'), { read: { blocked: 'sheet.operation.set-cell-edit-visible', alert: ALERT.edit } })
    await step(page, 'read', async () => page.keyboard.press('Enter'), { read: { executed: 'sheet.command.move-selection-enter-tab' } })

    // 修复之前，这时查找的快捷键失效（编辑栏的编辑器一直处于激活），格式的快捷键转给了编辑栏的文字编辑器
    await clickCell(page, 'C8')
    await findApple(page)

    await clickCell(page, 'A2')
    await step(page, 'read', async () => pressUniverShortcut(page, 'C'), { read: { executed: 'univer.command.copy' } })
    await expectClipboardText(page, browserName, SAMPLE_CELLS.a2)
    await step(page, 'read', async () => pressUniverShortcut(page, 'B'), { read: { blocked: 'sheet.command.set-style', alert: ALERT.style } })

    // 在名称框上按下、拖到编辑框上松开（P3 审查 A1）：编辑框自己的 mouseup 照样聚焦编辑栏的编辑器（SDK 随之在编辑栏的内部文档里
    // 设光标，这是复现了那条路径的证据），只读守卫马上放开
    const slipped = await commandMark(page)
    await slipOntoFormulaBar(page)
    await waitForCommand(page, slipped, { phase: 'executed', id: 'doc.operation.set-selections', unitId: FORMULA_BAR_UNIT })
    await expect(formulaBarInput(page)).not.toBeFocused()
    // 焦点已经离开编辑栏：键入的字不进编辑栏的内部文档（修复之前会进去）
    await page.keyboard.type('xyz')
    // 点回表格之后，查找与方向键照常（修复之前都失效）
    await clickCell(page, 'C8')
    await findApple(page)
    await clickCell(page, 'A2')
    await step(page, 'read', async () => page.keyboard.press('ArrowDown'), { read: { executed: 'sheet.command.move-selection' } })
    await expect(nameBox(page)).toHaveValue('A3')

    // 编辑栏自始至终没有收到输入：它的内部文档上只有设光标的操作（松开时 SDK 设的与放开时清掉的），没有插入文字，也没有 mutation
    expect((await probeCommands(page, mark)).filter(command => command.unitId === FORMULA_BAR_UNIT && command.id !== 'doc.operation.set-selections')).toEqual([])
    await expectUnchanged(page, opened, mark)
    expect(watched.saves).toEqual([])
    expect(watched.pageErrors).toEqual([])
  })

  test('公式在 Worker 里算出结果：缓存值缺失的文档，查看者打开之后结果照常出现，结果的写回没有被防火墙取消（P3 审查 B5）', async ({ page }) => {
    const s = await scene('ro-formula', sampleWithoutFormulaValuesFor)
    const watched = watch(page, s.documentId)
    await openReadOnly(page, s.viewer, s.documentId)
    const stored = await savedContent(page, s.documentId)
    // 服务器上的文档里这几格没有结果；打开时 SDK 只算没有结果的公式（缓存值在的不重算），所以出现的结果一定是 Worker 算出来的
    for (const formula of SAMPLE_FORMULAS)
      expect(cellValueIn(stored.text, formula.sheetId, formula.cell), `${formula.cell}：服务器上没有结果`).toBeUndefined()
    await expect.poll(async () => {
      const snapshot = await probeSnapshot(page)
      return SAMPLE_FORMULAS.map(formula => cellValueIn(snapshot, formula.sheetId, formula.cell))
    }, { message: '等公式的结果出现在内存里' }).toEqual(SAMPLE_FORMULAS.map(formula => formula.value))
    const snapshot = await probeSnapshot(page)
    expect(await documentChangeAttempts(page, 0, unitIdOf(snapshot)), '没有被取消的修改').toEqual([])
    // 只读不保存：服务器上的内容不变
    const after = await savedContent(page, s.documentId)
    expect([after.revision, after.text]).toEqual([stored.revision, stored.text])
    expect(watched.saves).toEqual([])
    expect(watched.pageErrors).toEqual([])
  })

  test('归档空间里的文档：空间管理员打开同样只读（只能查看、没有工具栏、键入无效）', async ({ page }) => {
    // 打开两次编辑器（归档前后），各到 steady
    test.slow()
    const s = await scene('ro-archive')
    await loginThroughApi(page, s.author)
    await openEditor(page, s.documentId, OPENED)
    // 归档之前：空间管理员能编辑
    await expect(saveButton(page)).toBeVisible()
    await archiveSpace(s.spaceId)

    const watched = watch(page, s.documentId)
    await page.reload()
    await waitForEditor(page, OPENED)
    await expect(page.locator('#editor-chrome').getByText('只能查看', { exact: true })).toBeVisible()
    await expect(saveButton(page)).toHaveCount(0)
    await expect(page.getByRole('toolbar')).toHaveCount(0)
    const opened = await probeSnapshot(page)
    const mark = await commandMark(page)
    await TYPING.run(page, 'read')
    await expectUnchanged(page, opened, mark)
    expect(watched.saves).toEqual([])
    expect(watched.pageErrors).toEqual([])
  })
})

type Change = 'changed' | 'unchanged'

/** 作者（能编辑）打开样本，做这一项：内存里的内容有没有变 */
async function changeWhenEditable(page: Page, s: Scene, entry: Entry): Promise<Change> {
  await openEditor(page, s.documentId, OPENED)
  const opened = contentOf(await probeSnapshot(page))
  await entry.run(page, 'edit')
  return JSON.stringify(contentOf(await probeSnapshot(page))) === JSON.stringify(opened) ? 'unchanged' : 'changed'
}

/** 能编辑时每项都改动了内存里的内容，超链接除外（M5 之前被入口守卫取消） */
function expectedWhenEditable(entry: Entry): Change {
  return entry.unchangedWhenEditable ? 'unchanged' : 'changed'
}

/** 复制之后读剪贴板核对内容：Chromium 内核（Chromium、Chrome）要先授权 */
async function grantClipboard(context: BrowserContext, browserName: string): Promise<void> {
  if (browserName === 'chromium')
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
}

/** 剪贴板里的文字是 expected。无头 WebKit 读不了剪贴板（M0-P3 报告 §5.2），在 WebKit 上只跳过读取这一步 */
async function expectClipboardText(page: Page, browserName: string, expected: string): Promise<void> {
  if (browserName === 'chromium')
    expect(await page.evaluate(async () => navigator.clipboard.readText())).toBe(expected)
}

/**
 * 编辑入口在不在：能编辑时都在，只读时都没有。
 * 右键菜单在动画帧里弹出（ui 的 ContextMenu.tsx 的 handleContextMenu）：右键之后先等选区移过去（右键已经处理），再等两帧，
 * 然后只看一次（不重试）：能编辑时这样看得到菜单，这是只读时"没有菜单"的校准（P3 审查 B14）
 */
async function expectEditingChrome(page: Page, mode: Mode): Promise<void> {
  const present = mode === 'edit'
  const count = async (locator: Locator): Promise<void> => present ? expect(locator.first()).toBeVisible() : expect(locator).toHaveCount(0)
  const countNow = async (locator: Locator): Promise<void> => present
    ? expect(locator.first(), '等两帧之后菜单已经弹出').toBeVisible(LOOK_ONCE)
    : expect(locator).toHaveCount(0, LOOK_ONCE)
  // 页头：能编辑时有保存按钮；只读时显示"只能查看"
  await count(saveButton(page))
  await expect(page.locator('#editor-chrome').getByText('只能查看', { exact: true })).toHaveCount(present ? 0 : 1)
  // 工具栏：功能区的标签页、工具栏与其中的命令按钮
  await count(page.getByRole('tab', { name: '开始', exact: true }))
  await count(page.getByRole('toolbar'))
  await count(page.locator('[data-u-command]'))
  // 底栏：网格线开关（底栏菜单）与新增工作表按钮；"全部工作表"的菜单两种方式都在（切换工作表是阅读）
  await count(page.getByRole('button', { name: '切换网格线' }))
  await count(addSheetButton(page))
  await expect(allSheetsMenuButton(page)).toBeVisible()

  // 右键单元格与工作表标签
  await sheetCanvas(page).click({ button: 'right', position: await cellCenter(page, 'C3') })
  await expect(nameBox(page)).toHaveValue('C3')
  await nextFrames(page)
  await countNow(page.getByText('选择性复制', { exact: true }))
  await page.keyboard.press('Escape')
  await sheetTab(page, SAMPLE_SHEETS.summary.name).click({ button: 'right' })
  await expect(sheetTab(page, SAMPLE_SHEETS.summary.name)).toHaveAttribute('aria-selected', 'true')
  await nextFrames(page)
  await countNow(page.getByRole('button', { name: '重命名', exact: true }))
  await page.keyboard.press('Escape')
}

// 生产镜像上也跑的冒烟（P3 审查 B4）：不用探针、不打 @test-build，外部模式（容器 E2E）照常执行。
// 只核对界面与服务器看得到的结果：只读的页头、没有工具栏、键入被只读的提示拦下、保存的快捷键不发请求、服务器上的内容不变
test.describe('US-M2-11 查看者打开有阅读权限的表格，只能看不能改（冒烟：生产构建）', () => {
  test('查看者打开：页头只能查看、没有工具栏与保存按钮；键入被只读的提示拦下；Ctrl/Cmd+S 不发保存请求；服务器上的内容不变', async ({ page }) => {
    const s = await scene('ro-smoke')
    const watched = watch(page, s.documentId)
    await openReadOnly(page, s.viewer, s.documentId)
    const stored = await savedContent(page, s.documentId)
    await expect(page.getByRole('toolbar')).toHaveCount(0)
    await expect(saveButton(page)).toHaveCount(0)

    // 键入：打开单元格编辑器被权限检查拦下，弹出只读的提示；关掉之后照常
    await selectCell(page, 'K3')
    await page.keyboard.type('1')
    await closePermissionAlert(page, ALERT.edit)
    // 保存的快捷键（编辑器页自己的，按系统的修饰键）：只读时不保存，也不交给浏览器（不弹出另存网页）
    await page.keyboard.press('ControlOrMeta+s')
    // 之后的一次操作处理完，说明快捷键已经处理过：再键入一次，同样被拦下
    await page.keyboard.type('2')
    await closePermissionAlert(page, ALERT.edit)

    const after = await savedContent(page, s.documentId)
    expect([after.revision, after.text]).toEqual([stored.revision, stored.text])
    expect(watched.saves).toEqual([])
    expect(watched.pageErrors).toEqual([])
  })
})
