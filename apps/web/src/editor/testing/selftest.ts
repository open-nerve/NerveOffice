// 测试构建的页面自检（M3-P2 设计 §3.5，DEF-003 的阅读模式部分）：在 Playwright 驱动不了的真实 Safari 里复核只读。
// 编辑器页在测试构建、地址带 selftest=<场景> 时，到 steady 之后经挂接（features/sheet-editor/selftest-hook.ts）动态引入这里：
// 用 E2E 的探针（./e2e-probe.ts 装在 window.__nerveEditorProbe 上）执行编译进测试构建的检查，每项比较执行前后的内存快照与命令日志，
// 跑完把结果（./selftest-report.ts）带到地址里的 next（整页跳转：页面的 CSP 只许同源连接，顶层跳转不受它限制）。
// 检查与 E2E 共用一份入口清单与预期（./read-only-entries.ts）、一份比较口径（./content-compare.ts）：
// - read-only：打开不产生改动、M0 的 Facade 入口逐项、经 Facade 写公式的 mutation、撤销与重做（Facade 与快捷键）、快捷键入口、
//   界面（工具栏、底栏、单元格与工作表标签的右键菜单）；
// - read-only-formulas：缓存值缺失的公式在 Worker 里算出结果，没有被防火墙取消；
// - edit-chrome：能编辑时同样的界面检查都看得到（工具栏、底栏、右键菜单），合成的右键与按键确实有效——只读时"没有"的对照。
// 只读的入口里能用 Facade 与合成事件执行的部分才在这里；可信的键盘输入、输入法与鼠标的拖动由 Playwright 的 WebKit 覆盖
// （read-only.spec.ts、read-only-shortcuts.spec.ts），Worker 作用域里的错误这里看不到（设计 §3.5 第 4 条）。
// 等待都等确定的信号（命令被取消、被拦下、执行完，提示出现），不用固定时长；每项有时限，超时记为不通过、接着做下一项；
// 一个场景另有总时限，页面中途被隐藏（Safari 几秒之后就暂停隐藏的页面）时余下的检查不做——都照样把结果交回，看得到卡在哪里。
import type { EditorProbe, ProbeCommand } from './e2e-probe.ts'
import type { EntryApi, EntryOutcome, EntryRange, EntryScope, EntrySheet, EntryWorkbook } from './read-only-entries.ts'
import type { KeyCombo } from './selftest-dom.ts'
import type { SelftestCheck, SelftestPage, SelftestReport, SelftestScenario } from './selftest-report.ts'
import { canonicalJson, contentOf, documentChangeAttemptsIn, documentChangesIn, sameContent } from './content-compare.ts'
import { FACADE_ENTRIES, FORMULA_MUTATION_CELL, FORMULA_MUTATION_ID, PERMISSION_ALERT_TITLE, PROTECTION_WORDING, SHORTCUT_OUTCOMES, writeFormulaMutation } from './read-only-entries.ts'
import { accessibleName, byExactText, byRole, centerOf, clickAt, dialogTitled, isShown, isVisible, keyboardTarget, nextFrames, pressKeys, rightClickAt, sheetCanvas, sheetTab, univerIsMac, waitFor } from './selftest-dom.ts'
import { encodeSelftestReport, isSelftestScenario, NEXT_PARAM, reportUrl, SELFTEST_PARAM, SELFTEST_REPORT_FORMAT } from './selftest-report.ts'

/** 编辑器页交给自检的（挂接在页面开始载入时就收集页面错误与可见性，到 steady 之后才引入这里） */
export interface SelftestHost {
  readonly documentId: string
  readonly surface: HTMLElement
  readonly chrome: HTMLElement
  /** 编辑器页开始载入的时刻（ISO 8601） */
  readonly startedAt: string
  readonly page: SelftestPage
  readonly visibility: () => readonly string[]
  readonly pageErrors: () => readonly string[]
  readonly consoleErrors: () => readonly string[]
  readonly ignoredNotices: () => readonly string[]
}

/**
 * 等一个信号（命令被取消、被拦下、执行完，提示出现或关掉）最多等多久：Playwright 的三个浏览器里这些信号都在 250 毫秒以内到达，
 * 留出二十倍的余量（与 E2E 的 expect.poll 同一个量级）
 */
const SIGNAL_TIMEOUT_MS = 5_000

/** 一项检查最多用多久：超时记为不通过（它的后续可能还在进行，下一项照常开始）。一项里最多等两三个信号 */
const CHECK_TIMEOUT_MS = 15_000

/**
 * 一个场景的检查一共最多用多久：超过之后余下的检查不再做、记为不通过，结果照样交回（真实 Safari 里一项接一项地超时，
 * 也要在驱动脚本的时限之内交回结果，看得到卡在哪里）。Playwright 的三个浏览器里一个场景十几秒
 */
const SCENARIO_BUDGET_MS = 180_000

/** 公式在 Worker 里算出结果最多等多久（Worker 的启动与第一次计算） */
const FORMULA_TIMEOUT_MS = 30_000

/** 每项的说明最多留多长：结果放在地址里 */
const DETAIL_LIMIT = 600

// ---- Facade：入口清单的声明之外，自检另外用到的几样（sheets 与 sheets-ui 的 Facade 都有） ----

interface CellRect {
  readonly startX: number
  readonly startY: number
  readonly endX: number
  readonly endY: number
}

interface SelftestRange extends EntryRange {
  /** 单元格在画布上的范围（相对画布的左上角，含行列表头；sheets-ui 的 Facade） */
  readonly getCell: () => CellRect
  readonly getA1Notation: () => string
}

interface SelftestSheet extends EntrySheet {
  readonly getRange: (a1: string) => SelftestRange
}

interface SelftestWorkbook extends EntryWorkbook {
  readonly getActiveSheet: () => SelftestSheet
  /** 选区的主单元格；没有选区时是 null */
  readonly getActiveCell: () => SelftestRange | null
}

interface SelftestApi extends EntryApi {
  readonly getActiveWorkbook: () => SelftestWorkbook
  readonly undo: () => Promise<boolean>
  readonly redo: () => Promise<boolean>
}

/** 检查不通过：detail 说明看到了什么 */
class CheckFailure extends Error {
  override readonly name = 'CheckFailure'
}

function fail(detail: string): never {
  throw new CheckFailure(detail)
}

function describe(error: unknown): string {
  if (error instanceof CheckFailure)
    return error.message
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function truncate(text: string, limit = DETAIL_LIMIT): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new CheckFailure(`${timeoutMs / 1000} 秒内没有做完`)), timeoutMs)
  })
  try {
    return await Promise.race([work, timeout])
  }
  finally {
    clearTimeout(timer)
  }
}

/** 一次自检：探针、Facade、打开时的快照与记下的检查结果 */
interface Session {
  readonly host: SelftestHost
  readonly probe: EditorProbe
  readonly api: SelftestApi
  readonly unitId: string
  /** 打开时（自检开始时）的内存快照 */
  readonly opened: string
  readonly checks: SelftestCheck[]
  /** 场景的检查最晚做到什么时候（performance.now()）：之后的检查不再做 */
  readonly deadline: number
  /** 页面被隐藏的时刻（自检开始之后第一次）：之后的检查不再做 */
  hiddenAt?: string
  formulaValues?: Record<string, unknown>
}

async function check(session: Session, id: string, run: () => Promise<string>, timeoutMs = CHECK_TIMEOUT_MS): Promise<boolean> {
  const started = performance.now()
  if (started > session.deadline) {
    session.checks.push({ id, pass: false, detail: `没有做：这个场景的检查超过了总时限（${SCENARIO_BUDGET_MS / 1000} 秒）`, ms: 0 })
    return false
  }
  if (session.hiddenAt !== undefined) {
    session.checks.push({ id, pass: false, detail: `没有做：页面在 ${session.hiddenAt} 被隐藏（浏览器暂停隐藏页面的动画帧与计时器），之后的结果不可信，让浏览器的窗口露出来再跑`, ms: 0 })
    return false
  }
  let pass = true
  let detail: string
  try {
    detail = await withTimeout(run(), timeoutMs)
  }
  catch (error) {
    pass = false
    detail = describe(error)
  }
  session.checks.push({ id, pass, detail: truncate(detail), ms: Math.round(performance.now() - started) })
  return pass
}

// ---- 命令日志 ----

function lastSeq(probe: EditorProbe): number {
  return probe.commands().at(-1)?.seq ?? 0
}

function describeCommand(command: ProbeCommand): string {
  const phase = command.phase === 'executed' ? '执行' : command.canceled ? '取消' : '尝试'
  return `${phase} ${command.id}`
}

/** mark 之后的命令（给不通过时的说明：最多 12 条） */
function seenSince(probe: EditorProbe, mark: number): string {
  const commands = probe.commands(mark)
  return commands.length === 0 ? '之后没有命令' : `之后的命令：${commands.slice(0, 12).map(describeCommand).join('、')}${commands.length > 12 ? '…' : ''}`
}

function has(probe: EditorProbe, mark: number, phase: ProbeCommand['phase'], id: string, canceled?: boolean): boolean {
  return probe.commands(mark).some(command => command.phase === phase && command.id === id && (canceled === undefined || command.canceled === canceled))
}

// ---- 界面 ----

/** 权限检查的提示（标题是"提示"的对话框，看得见的） */
function permissionAlert(): HTMLElement | undefined {
  return byRole('dialog').find(dialog => isVisible(dialog) && byRole('heading', { root: dialog }).some(heading => accessibleName(heading) === PERMISSION_ALERT_TITLE))
}

/** 等提示出现，核对说法（不再提保护、不让人联系创建者），点"确定"关掉；返回提示的正文 */
async function closePermissionAlert(expected: string): Promise<string> {
  await waitFor(() => permissionAlert() !== undefined, SIGNAL_TIMEOUT_MS)
  const alert = permissionAlert()
  if (alert === undefined)
    fail('没有弹出权限检查的提示')
  const text = (alert.textContent ?? '').replace(/\s+/g, ' ').trim()
  if (!text.includes(expected))
    fail(`提示的说法不对："${text}"（应当是"${expected}"）`)
  if (PROTECTION_WORDING.test(text))
    fail(`提示还在说保护或创建者："${text}"`)
  const confirm = byRole('button', { name: '确定', root: alert })[0]
  if (confirm === undefined)
    fail('提示里没有"确定"按钮')
  confirm.click()
  if (!await waitFor(() => permissionAlert() === undefined, SIGNAL_TIMEOUT_MS))
    fail('点了"确定"，提示没有关掉')
  return expected
}

/** 等到 outcome 的信号；被权限检查拦下的，核对并关掉提示。返回看到了什么 */
async function settle(probe: EditorProbe, mark: number, outcome: EntryOutcome): Promise<string> {
  if ('executed' in outcome) {
    if (!await waitFor(() => has(probe, mark, 'executed', outcome.executed), SIGNAL_TIMEOUT_MS))
      fail(`没有等到 ${outcome.executed} 执行完；${seenSince(probe, mark)}`)
    return `执行完 ${outcome.executed}`
  }
  if ('canceled' in outcome) {
    if (!await waitFor(() => has(probe, mark, 'before', outcome.canceled, true), SIGNAL_TIMEOUT_MS))
      fail(`没有等到 ${outcome.canceled} 被取消；${seenSince(probe, mark)}`)
    return `取消了 ${outcome.canceled}`
  }
  if (!await waitFor(() => has(probe, mark, 'before', outcome.blocked, false), SIGNAL_TIMEOUT_MS))
    fail(`没有等到 ${outcome.blocked} 被尝试；${seenSince(probe, mark)}`)
  const alert = await closePermissionAlert(outcome.alert)
  if (has(probe, mark, 'executed', outcome.blocked))
    fail(`${outcome.blocked} 执行了`)
  return `权限检查拦下 ${outcome.blocked}，提示"${alert}"`
}

/** 内容与 baseline 不同的部分（给不通过时的说明）：顶层的键，工作表按 id */
function differences(baseline: string, current: string): string {
  const before = contentOf(baseline) as Record<string, unknown>
  const after = contentOf(current) as Record<string, unknown>
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
  const changed = keys.filter(key => canonicalJson(before[key]) !== canonicalJson(after[key]))
  const sheetsBefore = (before.sheets ?? {}) as Record<string, unknown>
  const sheetsAfter = (after.sheets ?? {}) as Record<string, unknown>
  const sheets = [...new Set([...Object.keys(sheetsBefore), ...Object.keys(sheetsAfter)])]
    .filter(id => canonicalJson(sheetsBefore[id]) !== canonicalJson(sheetsAfter[id]))
  return `${changed.join('、')}${sheets.length > 0 ? `（工作表 ${sheets.join('、')}）` : ''}`
}

/** mark 之后内存里的内容与打开时相同，也没有改动文档的 mutation 执行 */
function expectUnchanged(session: Session, mark: number): void {
  const current = session.probe.snapshot()
  if (!sameContent(current, session.opened))
    fail(`内存里的内容与打开时不同：${differences(session.opened, current)}`)
  const changes = documentChangesIn(session.probe.commands(mark), session.unitId)
  if (changes.length > 0)
    fail(`有改动文档的 mutation 执行：${changes.map(command => command.id).join('、')}`)
}

function scopeOf(api: SelftestApi): EntryScope {
  const workbook = api.getActiveWorkbook()
  return { api, workbook, sheet: workbook.getActiveSheet() }
}

/** 当前单元格（选区的主单元格）的 A1 写法 */
function activeCell(api: SelftestApi): string | undefined {
  return api.getActiveWorkbook().getActiveCell()?.getA1Notation()
}

/** 当前工作表里这一格的中心（视口坐标） */
function cellPoint(session: Session, a1: string): { readonly x: number, readonly y: number } {
  const canvas = sheetCanvas(session.host.surface)
  if (canvas === null)
    fail('找不到表格的画布')
  const box = canvas.getBoundingClientRect()
  const rect = session.api.getActiveWorkbook().getActiveSheet().getRange(a1).getCell()
  return { x: box.left + (rect.startX + rect.endX) / 2, y: box.top + (rect.startY + rect.endY) / 2 }
}

/** 元素的简短写法（给不通过时的说明） */
function describeElement(element: Element | null): string {
  if (element === null)
    return '页面外'
  const role = element.getAttribute('role')
  const label = element.getAttribute('aria-label')
  return `${element.tagName.toLowerCase()}${role === null ? '' : `[role=${role}]`}${label === null ? '' : `[aria-label=${label}]`}`
}

/**
 * 页面上这一点的元素，真实的点击也落在它上面：等到它在 within 里（关掉的对话框淡出时，它的遮罩还会挡一会儿，
 * 与 Playwright 点击之前等元素能接收事件同样的看法）
 */
async function hitTarget(point: { readonly x: number, readonly y: number }, within: Element): Promise<Element> {
  const found = (): Element | undefined => {
    const target = document.elementFromPoint(point.x, point.y)
    return target !== null && within.contains(target) ? target : undefined
  }
  await waitFor(() => found() !== undefined, SIGNAL_TIMEOUT_MS)
  const target = found()
  if (target === undefined)
    fail(`(${Math.round(point.x)}, ${Math.round(point.y)}) 被 ${describeElement(document.elementFromPoint(point.x, point.y))} 挡着`)
  return target
}

/**
 * 让一个单元格成为当前单元格：点它，等选区移过去。已经是当前单元格时不再点：同一处连点两下会被当成双击、打开单元格编辑器
 * （只读时随之弹出提示，与 E2E 的 read-only-shortcuts.spec.ts 同样的看法）
 */
async function selectCell(session: Session, a1: string): Promise<void> {
  if (activeCell(session.api) === a1)
    return
  const point = cellPoint(session, a1)
  clickAt(await hitTarget(point, session.host.surface), point.x, point.y)
  if (!await waitFor(() => activeCell(session.api) === a1, SIGNAL_TIMEOUT_MS))
    fail(`点了 ${a1}，当前单元格是 ${activeCell(session.api) ?? '没有'}`)
}

/**
 * 用到的组合键（与 E2E 的 support/keyboard.ts 同样的按法：主修饰键按 Univer 对平台的判断取；快速求和在苹果的平台上是 Cmd+Option+=，
 * 别的平台 Alt+=；替换在两种平台上都是 Control+H，苹果的平台上 SDK 绑定的是 MAC_CTRL）
 */
const KEYS = {
  find: { key: 'f', code: 'KeyF', keyCode: 70, primary: true },
  bold: { key: 'b', code: 'KeyB', keyCode: 66, primary: true },
  italic: { key: 'i', code: 'KeyI', keyCode: 73, primary: true },
  underline: { key: 'u', code: 'KeyU', keyCode: 85, primary: true },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  undo: { key: 'z', code: 'KeyZ', keyCode: 90, primary: true },
  redo: { key: 'y', code: 'KeyY', keyCode: 89, primary: true },
  featureSearch: { key: 'P', code: 'KeyP', keyCode: 80, primary: true, shift: true },
  quickSumMac: { key: '=', code: 'Equal', keyCode: 187, primary: true, alt: true },
  quickSum: { key: '=', code: 'Equal', keyCode: 187, alt: true },
  replace: { key: 'h', code: 'KeyH', keyCode: 72, ctrl: true },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
} as const satisfies Readonly<Record<string, KeyCombo>>

/** 按 Univer 的快捷键（合成事件，目标见 keyboardTarget） */
function press(session: Session, combo: KeyCombo): void {
  pressKeys(keyboardTarget(session.host.surface), combo)
}

/**
 * 关掉右键菜单：在文档上按 Escape（合成事件）。SDK 的右键菜单（ui 的 AnchoredContextMenu）在 document 上听 Escape；
 * 发在菜单里获得焦点的按钮上时，菜单面板自己的按键处理先接住、停止传播，到不了 document
 */
async function escapeUntil(gone: () => boolean): Promise<boolean> {
  pressKeys(document.documentElement, KEYS.escape)
  return waitFor(gone, SIGNAL_TIMEOUT_MS)
}

// ---- 场景里共用的几项 ----

/** 页头：只读时"只能查看"、没有保存按钮；能编辑时反过来 */
async function checkHeader(session: Session, readOnly: boolean): Promise<void> {
  await check(session, readOnly ? 'page.read-only' : 'page.editable', async () => {
    if (session.host.page.readOnly !== readOnly)
      fail(`页面按${session.host.page.readOnly === true ? '只读' : '可编辑'}打开`)
    const notice = byExactText('只能查看', session.host.chrome).some(isVisible)
    const save = byRole('button', { name: '保存', root: session.host.chrome }).some(isVisible)
    if (notice !== readOnly || save === readOnly)
      fail(`页头：${notice ? '有' : '没有'}"只能查看"，${save ? '有' : '没有'}保存按钮`)
    return readOnly ? '页头只能查看，没有保存按钮' : '页头有保存按钮'
  })
}

/** 查找的快捷键打开查找面板（查找是阅读）：合成的按键到得了 SDK 的校准；之后关掉面板 */
async function checkFind(session: Session, readOnly: boolean): Promise<void> {
  await check(session, 'shortcut.find', async () => {
    await selectCell(session, 'C8')
    const mark = lastSeq(session.probe)
    press(session, KEYS.find)
    const seen = await settle(session.probe, mark, readOnly ? SHORTCUT_OUTCOMES.find.read : SHORTCUT_OUTCOMES.find.edit)
    const findDialog = (): HTMLElement | undefined => {
      const dialog = dialogTitled('查找')
      return dialog !== undefined && isVisible(dialog) ? dialog : undefined
    }
    if (!await waitFor(() => findDialog() !== undefined, SIGNAL_TIMEOUT_MS))
      fail(`${seen}，查找面板没有出现`)
    const close = byRole('button', { name: 'Close', root: findDialog() ?? document })[0]
    if (close === undefined)
      fail('查找面板里没有关闭按钮')
    close.click()
    if (!await waitFor(() => findDialog() === undefined, SIGNAL_TIMEOUT_MS))
      fail('查找面板关不掉')
    return `${seen}，查找面板出现并关掉`
  })
}

/** 编辑类的界面在不在（工具栏、底栏菜单）：只读时都没有，能编辑时都在 */
async function checkChrome(session: Session, present: boolean): Promise<void> {
  const verdict = (name: string, count: number): string | undefined => (count > 0) === present ? undefined : `${name}${count > 0 ? `有 ${count} 个` : '没有'}`
  await check(session, present ? 'chrome.toolbar.present' : 'chrome.toolbar.absent', async () => {
    const problems = [
      verdict('功能区的"开始"标签页', byRole('tab', { name: '开始' }).filter(isVisible).length),
      verdict('工具栏', byRole('toolbar').filter(isVisible).length),
      verdict('工具栏的命令（data-u-command）', [...document.querySelectorAll('[data-u-command]')].filter(isVisible).length),
    ].filter(problem => problem !== undefined)
    if (problems.length > 0)
      fail(problems.join('；'))
    return present ? '功能区、工具栏与命令都在' : '没有功能区、工具栏与命令'
  })
  await check(session, present ? 'chrome.footer.present' : 'chrome.footer.absent', async () => {
    // 底栏菜单（网格线开关等）；新增工作表与"全部工作表"的按钮没有可访问的名称，只能按 SDK 的 DOM 标记找，留给 E2E（read-only.spec.ts）
    const gridLines = byRole('button').filter(button => isVisible(button) && accessibleName(button).includes('切换网格线')).length
    const problem = verdict('底栏的网格线开关', gridLines)
    if (problem !== undefined)
      fail(problem)
    return present ? '底栏有网格线开关' : '底栏没有网格线开关'
  })
}

/**
 * 右键单元格与工作表标签：只读时页面上没有菜单（SDK 不渲染右键菜单），能编辑时弹出（之后在文档上按 Escape 关掉）。
 * 右键之后先等选区移过去、标签选中（右键已经处理），再等两帧（菜单在动画帧里弹出），然后只看一次页面上有没有菜单——
 * 能编辑时这样看得到它，这是只读时"没有菜单"的校准（与 E2E 的 expectEditingChrome 相同：只读时 toHaveCount(0)）。
 * 能编辑时再等它淡入到显示出来（isShown：关上的菜单留在页面上、透明度为 0，Playwright 的"可见"认不出），按 Escape 之后等它淡出
 */
async function checkContextMenus(session: Session, present: boolean): Promise<void> {
  const cellMenu = (): HTMLElement[] => byExactText('选择性复制')
  const tabMenu = (): HTMLElement[] => byRole('button', { name: '重命名' })
  const expectMenu = async (found: () => readonly HTMLElement[], what: string): Promise<string> => {
    if (!await nextFrames())
      fail('等不到动画帧（页面隐藏？）')
    const rendered = found().length > 0
    if (rendered !== present)
      fail(present ? `两帧之后页面上还没有${what}` : `页面上有${what}`)
    if (!present)
      return `两帧之后页面上没有${what}`
    if (!await waitFor(() => found().some(isShown), SIGNAL_TIMEOUT_MS))
      fail(`${what}没有显示出来`)
    if (!await escapeUntil(() => !found().some(isShown)))
      fail(`${what}按 Escape 关不掉`)
    return `两帧之后页面上有${what}，显示出来，按 Escape 关掉`
  }
  await check(session, present ? 'context-menu.cell.present' : 'context-menu.cell.absent', async () => {
    // 先选另一格：右键落在当前选区之外，选区随之移过去，这就是"右键已经处理"的信号
    await selectCell(session, 'A12')
    const point = cellPoint(session, 'C3')
    rightClickAt(await hitTarget(point, session.host.surface), point.x, point.y)
    if (!await waitFor(() => activeCell(session.api) === 'C3', SIGNAL_TIMEOUT_MS))
      fail(`右键 C3 之后当前单元格是 ${activeCell(session.api) ?? '没有'}`)
    return expectMenu(cellMenu, '单元格的右键菜单（"选择性复制"）')
  })
  await check(session, present ? 'context-menu.sheet-tab.present' : 'context-menu.sheet-tab.absent', async () => {
    const tab = sheetTab('汇总')
    if (tab === undefined)
      fail('找不到工作表标签"汇总"')
    const point = centerOf(tab)
    rightClickAt(await hitTarget(point, tab), point.x, point.y)
    if (!await waitFor(() => sheetTab('汇总')?.getAttribute('aria-selected') === 'true', SIGNAL_TIMEOUT_MS))
      fail('右键"汇总"之后它没有被选中')
    const seen = await expectMenu(tabMenu, '工作表标签的右键菜单（"重命名"）')
    // 回到"数据"表（切换工作表是阅读，只读时照常）
    const back = sheetTab('数据')
    if (back === undefined)
      fail('找不到工作表标签"数据"')
    const home = centerOf(back)
    clickAt(await hitTarget(home, back), home.x, home.y)
    if (!await waitFor(() => sheetTab('数据')?.getAttribute('aria-selected') === 'true', SIGNAL_TIMEOUT_MS))
      fail('点"数据"之后它没有被选中')
    return seen
  })
}

/** 自检开始时（steady 之后）的内容与命令日志：之后的每一项都与它比较 */
async function fetchServerContent(documentId: string): Promise<string> {
  const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/content`, { cache: 'no-store', credentials: 'same-origin' })
  if (!response.ok)
    fail(`读服务器上的内容：${response.status}`)
  return response.text()
}

/** 快照里一项资源的数据（JSON 解析之后；空串是 undefined） */
function resourceOf(snapshot: { readonly resources?: readonly { readonly name: string, readonly data: string }[] }, name: string): unknown {
  const data = snapshot.resources?.find(resource => resource.name === name)?.data
  return data === undefined || data === '' ? undefined : JSON.parse(data) as unknown
}

// ---- 场景 ----

async function readOnlyScenario(session: Session): Promise<void> {
  const { probe, api, unitId } = session
  await checkHeader(session, true)
  await check(session, 'open.server-content', async () => {
    // 样本已经收敛（打开之后保存的字节就是它自己），所以逐字节比较（与 E2E"打开不产生改动"相同）
    const stored = await fetchServerContent(session.host.documentId)
    if (session.opened !== stored)
      fail(`内存快照与服务器上的内容不同：${differences(stored, session.opened) || '只差写法'}`)
    return `内存快照与服务器上的内容逐字节相同（${stored.length} 字符）`
  })
  await check(session, 'open.no-change-attempts', async () => {
    // 探针在就绪时装上：从就绪到 steady，没有改动文档的 mutation 的尝试（被防火墙取消的也没有，M2-P3 审查 B9）
    const attempts = documentChangeAttemptsIn(probe.commands(), unitId)
    if (attempts.length > 0)
      fail(`就绪之后有改动文档的 mutation 的尝试：${attempts.map(describeCommand).join('、')}`)
    return `就绪之后 ${probe.commands().length} 条命令，没有改动文档的 mutation 的尝试`
  })
  await check(session, 'open.resources', async () => {
    const snapshot = JSON.parse(session.opened) as { readonly resources?: readonly { readonly name: string, readonly data: string }[] }
    for (const name of ['SHEET_RANGE_PROTECTION_PLUGIN', 'SHEET_WORKSHEET_PROTECTION_PLUGIN', 'SHEET_WORKSHEET_PROTECTION_POINT_PLUGIN']) {
      const data = resourceOf(snapshot, name)
      if (canonicalJson(data ?? {}) !== '{}')
        fail(`${name} 不是空的：${truncate(canonicalJson(data), 120)}`)
    }
    if (snapshot.resources?.some(resource => resource.name === 'SHEET_AuthzIoMockService_PLUGIN') === true)
      fail('快照里有本地授权服务的资源 SHEET_AuthzIoMockService_PLUGIN')
    return '保护类资源为空，没有本地授权服务的资源'
  })

  for (const entry of FACADE_ENTRIES) {
    await check(session, `facade.${entry.name}`, async () => {
      const mark = lastSeq(probe)
      let callError: string | undefined
      try {
        await entry.call(scopeOf(api))
      }
      catch (error) {
        // 取消之后仍去取结果的 Facade 方法会抛错（例如 insertSheet 的 TypeError，M2-P3 设计 §3.3），不是页面错误
        callError = describe(error)
      }
      const seen = await settle(probe, mark, entry.read)
      expectUnchanged(session, mark)
      return `${seen}${callError === undefined ? '' : `；调用抛出 ${callError}`}`
    })
  }

  await check(session, 'facade.写公式的 mutation', async () => {
    // 防火墙要排在 SDK 自己的执行前监听之前（M2-P6 复核 F3）：被取消，SDK 的公式控制器也没有先把公式写进单元格
    const mark = lastSeq(probe)
    const scope = scopeOf(api)
    const sheetId = scope.sheet.getSheetId()
    let callError: string | undefined
    try {
      await writeFormulaMutation(scope)
    }
    catch (error) {
      callError = describe(error)
    }
    const seen = await settle(probe, mark, { canceled: FORMULA_MUTATION_ID })
    const workbook = JSON.parse(probe.snapshot()) as { readonly sheets: Readonly<Record<string, { readonly cellData?: Readonly<Record<string, Readonly<Record<string, { readonly f?: string }>>>> }>> }
    const formula = workbook.sheets[sheetId]?.cellData?.[FORMULA_MUTATION_CELL.row]?.[FORMULA_MUTATION_CELL.column]?.f
    if (formula !== undefined)
      fail(`K40 被写进了公式 ${formula}`)
    const mutations = probe.commands(mark).filter(command => command.phase === 'executed' && command.kind === 'mutation' && command.unitId === unitId)
    if (mutations.length > 0)
      fail(`本文档上有 mutation 执行：${mutations.map(command => `${command.id}（${command.flags.join('、')}）`).join('、')}`)
    expectUnchanged(session, mark)
    return `${seen}，K40 没有公式，本文档上没有 mutation 执行${callError === undefined ? '' : `；调用抛出 ${callError}`}`
  })

  await check(session, 'facade.undo-redo', async () => {
    const mark = lastSeq(probe)
    await api.undo()
    const undo = await settle(probe, mark, SHORTCUT_OUTCOMES.undo.read)
    await api.redo()
    const redo = await settle(probe, mark, SHORTCUT_OUTCOMES.redo.read)
    expectUnchanged(session, mark)
    return `${undo}；${redo}`
  })

  await checkFind(session, true)

  await check(session, 'shortcut.undo-redo', async () => {
    await selectCell(session, 'A5')
    const mark = lastSeq(probe)
    press(session, KEYS.undo)
    const undo = await settle(probe, mark, SHORTCUT_OUTCOMES.undo.read)
    press(session, KEYS.redo)
    const redo = await settle(probe, mark, SHORTCUT_OUTCOMES.redo.read)
    expectUnchanged(session, mark)
    return `${undo}；${redo}`
  })

  for (const [name, combo] of [['bold', KEYS.bold], ['italic', KEYS.italic], ['underline', KEYS.underline]] as const) {
    await check(session, `shortcut.${name}`, async () => {
      await selectCell(session, 'A2')
      const mark = lastSeq(probe)
      press(session, combo)
      const seen = await settle(probe, mark, SHORTCUT_OUTCOMES.style.read)
      expectUnchanged(session, mark)
      return seen
    })
  }

  await check(session, 'shortcut.delete', async () => {
    await selectCell(session, 'A3')
    const mark = lastSeq(probe)
    press(session, KEYS.delete)
    const seen = await settle(probe, mark, SHORTCUT_OUTCOMES.clear.read)
    expectUnchanged(session, mark)
    return seen
  })

  await check(session, 'shortcut.feature-search', async () => {
    // "搜索功能"面板（M2-P6 复核 F1）：打开它的操作被只读守卫取消，面板不出现
    await selectCell(session, 'A4')
    const mark = lastSeq(probe)
    press(session, KEYS.featureSearch)
    if (!await nextFrames())
      fail('等不到动画帧（页面隐藏？）')
    if (dialogTitled('搜索功能') !== undefined)
      fail('"搜索功能"面板弹出来了')
    const seen = await settle(probe, mark, SHORTCUT_OUTCOMES.featureSearch.read)
    expectUnchanged(session, mark)
    return `${seen}，面板没有出现`
  })

  await check(session, 'shortcut.quick-sum', async () => {
    // 快速求和（M2-P6 复核 F2）：被只读守卫取消，编辑栏显示的仍是 B10 真实的内容（空），也没有弹出提示
    await selectCell(session, 'B10')
    if (!await waitFor(() => probe.formulaBarText() === '', SIGNAL_TIMEOUT_MS))
      fail(`选中 B10 之后编辑栏显示"${probe.formulaBarText()}"`)
    const mark = lastSeq(probe)
    press(session, univerIsMac() ? KEYS.quickSumMac : KEYS.quickSum)
    if (!await nextFrames())
      fail('等不到动画帧（页面隐藏？）')
    const bar = probe.formulaBarText()
    if (bar !== '')
      fail(`编辑栏显示"${bar}"（B10 是空的）`)
    if (permissionAlert() !== undefined)
      fail('弹出了提示')
    const seen = await settle(probe, mark, SHORTCUT_OUTCOMES.quickSum.read)
    expectUnchanged(session, mark)
    return `${seen}，编辑栏仍是空的`
  })

  await check(session, 'shortcut.replace', async () => {
    // 替换（Control+H）：打开替换的操作被只读守卫取消，查找替换的面板不出现
    await selectCell(session, 'C8')
    const mark = lastSeq(probe)
    press(session, KEYS.replace)
    const seen = await settle(probe, mark, SHORTCUT_OUTCOMES.replace.read)
    if (!await nextFrames())
      fail('等不到动画帧（页面隐藏？）')
    if (dialogTitled('查找') !== undefined)
      fail('查找替换的面板弹出来了')
    expectUnchanged(session, mark)
    return `${seen}，面板没有出现`
  })

  await checkChrome(session, false)
  await checkContextMenus(session, false)

  await check(session, 'content.final', async () => {
    expectUnchanged(session, 0)
    return '内存里的内容与打开时相同，就绪之后没有改动文档的 mutation 执行'
  })
}

/** 快照里有公式的格：工作表 id、A1 写法、有没有值 */
function formulaCells(snapshotText: string): { readonly key: string, readonly value: unknown }[] {
  const workbook = JSON.parse(snapshotText) as { readonly sheets: Readonly<Record<string, { readonly cellData?: Readonly<Record<string, Readonly<Record<string, { readonly f?: string, readonly v?: unknown }>>>> }>> }
  const cells: { key: string, value: unknown }[] = []
  for (const [sheetId, sheet] of Object.entries(workbook.sheets)) {
    for (const [row, columns] of Object.entries(sheet.cellData ?? {})) {
      for (const [column, cell] of Object.entries(columns)) {
        if (cell.f !== undefined)
          cells.push({ key: `${sheetId}!${columnName(Number(column))}${Number(row) + 1}`, value: cell.v })
      }
    }
  }
  return cells
}

/** 从 0 开始的列号的字母写法（0 → A，26 → AA） */
function columnName(index: number): string {
  let name = ''
  for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26))
    name = String.fromCharCode(65 + ((rest - 1) % 26)) + name
  return name
}

async function formulasScenario(session: Session): Promise<void> {
  const { probe, unitId } = session
  await checkHeader(session, true)
  let stored = ''
  await check(session, 'formulas.computed', async () => {
    // 服务器上的文档里公式都没有结果；打开时 SDK 只算没有结果的公式，所以出现的结果一定是 Worker 算出来的
    stored = await fetchServerContent(session.host.documentId)
    const cells = formulaCells(stored)
    if (cells.length === 0)
      fail('样本里没有公式')
    const cached = cells.filter(cell => cell.value !== undefined)
    if (cached.length > 0)
      fail(`服务器上的样本已经有结果：${cached.map(cell => cell.key).join('、')}`)
    const pending = (): string[] => formulaCells(probe.snapshot()).filter(cell => cell.value === undefined).map(cell => cell.key)
    if (!await waitFor(() => pending().length === 0, FORMULA_TIMEOUT_MS, 100))
      fail(`${FORMULA_TIMEOUT_MS / 1000} 秒内这些公式没有算出结果：${pending().join('、')}`)
    session.formulaValues = Object.fromEntries(formulaCells(probe.snapshot()).map(cell => [cell.key, cell.value]))
    return `${cells.length} 个公式都算出了结果`
  }, FORMULA_TIMEOUT_MS + CHECK_TIMEOUT_MS)
  await check(session, 'formulas.no-change-attempts', async () => {
    const attempts = documentChangeAttemptsIn(probe.commands(), unitId)
    if (attempts.length > 0)
      fail(`有改动文档的 mutation 的尝试：${attempts.map(describeCommand).join('、')}`)
    return '结果的写回都不算修改，没有被防火墙取消'
  })
  await check(session, 'formulas.server-unchanged', async () => {
    if (stored === '')
      fail('没有读到打开时服务器上的内容（formulas.computed 没有做完）')
    if (await fetchServerContent(session.host.documentId) !== stored)
      fail('服务器上的内容变了')
    return '服务器上的内容不变'
  })
}

async function editChromeScenario(session: Session): Promise<void> {
  await checkHeader(session, false)
  await checkChrome(session, true)
  await checkContextMenus(session, true)
  await checkFind(session, false)
  await check(session, 'content.unchanged', async () => {
    expectUnchanged(session, 0)
    return '内存里的内容与打开时相同（界面检查没有改动文档）'
  })
}

const SCENARIOS: Readonly<Record<SelftestScenario, (session: Session) => Promise<void>>> = {
  'read-only': readOnlyScenario,
  'read-only-formulas': formulasScenario,
  'edit-chrome': editChromeScenario,
}

/** 跑一次自检，返回结果（不跳转） */
export async function runEditorSelftest(host: SelftestHost, scenario: string): Promise<SelftestReport> {
  const checks: SelftestCheck[] = []
  let failure: string | undefined
  let formulaValues: Record<string, unknown> | undefined
  const probe = window.__nerveEditorProbe
  if (!isSelftestScenario(scenario))
    failure = `不认识的场景 ${scenario}`
  else if (host.page.state !== 'ready')
    failure = `编辑器页没有就绪（${host.page.state}${host.page.detail === undefined ? '' : `：${host.page.detail}`}）`
  else if (probe === undefined)
    failure = '页面里没有编辑器的探针（不是测试构建？）'
  if (failure === undefined && probe !== undefined && isSelftestScenario(scenario)) {
    const api = probe.univerAPI as unknown as SelftestApi
    const session: Session = { host, probe, api, unitId: api.getActiveWorkbook().getId(), opened: probe.snapshot(), checks, deadline: performance.now() + SCENARIO_BUDGET_MS }
    // 页面中途被隐藏（浏览器窗口被挡住、切到别的标签页）：Safari 几秒之后就暂停它，余下的检查不再做，趁计时器还在走把结果交回去
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden')
        session.hiddenAt ??= new Date().toISOString()
    }
    document.addEventListener('visibilitychange', onVisibility)
    try {
      await SCENARIOS[scenario](session)
    }
    catch (error) {
      failure = `自检中途出错：${describe(error)}`
    }
    finally {
      document.removeEventListener('visibilitychange', onVisibility)
    }
    if (failure === undefined && session.hiddenAt !== undefined)
      failure = `页面在 ${session.hiddenAt} 被隐藏，余下的检查没有做`
    formulaValues = session.formulaValues
  }
  return {
    format: SELFTEST_REPORT_FORMAT,
    scenario,
    documentId: host.documentId,
    userAgent: navigator.userAgent,
    startedAt: host.startedAt,
    finishedAt: new Date().toISOString(),
    page: host.page,
    visibility: host.visibility(),
    checks,
    pageErrors: host.pageErrors().map(text => truncate(text)),
    consoleErrors: host.consoleErrors().map(text => truncate(text)),
    ignoredNotices: host.ignoredNotices().map(text => truncate(text)),
    formulaValues,
    failure,
  }
}

/**
 * 跑地址里要求的场景（selftest），把结果带到地址里的 next（整页跳转，替换当前的历史记录）。
 * 没有 next 时只跑、不跳转（手工调试时在开发者工具里看页面）
 */
export async function runSelftestAndReport(host: SelftestHost): Promise<SelftestReport> {
  const params = new URL(window.location.href).searchParams
  const report = await runEditorSelftest(host, params.get(SELFTEST_PARAM) ?? '')
  const next = params.get(NEXT_PARAM)
  if (next !== null)
    window.location.replace(reportUrl(next, await encodeSelftestReport(report)))
  return report
}
