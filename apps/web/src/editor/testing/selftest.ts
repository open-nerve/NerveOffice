// 测试构建的页面自检（M3-P2 设计 §3.5，DEF-003 的阅读模式部分）：在 Playwright 驱动不了的真实 Safari 里复核只读。
// 编辑器页在测试构建、地址带 selftest=<场景> 时，到 steady 之后经挂接（features/sheet-editor/selftest-hook.ts）动态引入这里：
// 用 E2E 的探针（./e2e-probe.ts 装在 window.__nerveEditorProbe 上）执行编译进测试构建的检查，每项比较执行前后的内存快照与命令日志，
// 跑完把结果（./selftest-report.ts）带到地址里的 next（整页跳转：页面的 CSP 只许同源连接，顶层跳转不受它限制）。
// 检查与 E2E 共用一份入口清单与预期（./read-only-entries.ts）、一份比较口径（./content-compare.ts）：
// - read-only：打开不产生改动、M0 的 Facade 入口逐项、经 Facade 写公式的 mutation、撤销与重做（Facade 与快捷键）、快捷键入口、
//   界面（工具栏、底栏、单元格与工作表标签的右键菜单）；
// - read-only-formulas：缓存值缺失的公式在 Worker 里算出结果，没有被防火墙取消；
// - edit-chrome：能编辑时同样的界面检查都看得到（工具栏、底栏、右键菜单），合成的右键与按键确实有效——只读时"没有"的对照；
// - enter-exit（M3-P2 S5）：作者阅读 → 点页头真实的"编辑"（合成的点击）→ 经 Facade 改一格 → 点"退出编辑"（先保存）→ 回到阅读之后
//   再试 Facade 的只读入口（样本去掉了图片，操作图片的几项不试，M3-P3）、撤销与重做与界面；两次切换的耗时按 ./switch-timing.ts 记下，随结果交回；
// - 捕获时机的复核（M3-P4 S1：环境、变更检测、公式时序 × 两种模式、自动行高、大表复制、组合输入、隐藏时保存；S7 起观察真实的自动保存）
//   在 ./selftest-capture.ts；
// - 交接的复核（M3-P5 设计 §3.14：同一个浏览器里两个标签页的本人接管、刷新时在途的保存）在 ./selftest-handover.ts。
// 一次运行的共用部分（编辑器页交给自检的、一项检查怎么记、命令日志的查询）在 ./selftest-session.ts。
// 只读的入口里能用 Facade 与合成事件执行的部分才在这里；可信的键盘输入、输入法与鼠标的拖动由 Playwright 的 WebKit 覆盖
// （read-only.spec.ts、read-only-shortcuts.spec.ts），Worker 作用域里的错误这里看不到（设计 §3.5 第 4 条）。
// 等待都等确定的信号（命令被取消、被拦下、执行完，提示出现），不用固定时长；每项有时限，超时记为不通过、接着做下一项；
// 一个场景另有总时限，页面中途被隐藏（Safari 几秒之后就暂停隐藏的页面）时余下的检查不做——都照样把结果交回，看得到卡在哪里。
import type { EditorProbe } from './e2e-probe.ts'
import type { EntryOutcome, EntryScope, FacadeEntry } from './read-only-entries.ts'
import type { KeyCombo } from './selftest-dom.ts'
import type { SelftestCheck, SelftestReport, SelftestScenario, SelftestTimelineEntry, SelftestTiming } from './selftest-report.ts'
import type { SelftestApi, SelftestHost, Session } from './selftest-session.ts'
import type { SwitchDirection, SwitchTimingRecorder } from './switch-timing.ts'
import { canonicalJson, documentChangeAttemptsIn, documentChangesIn, sameContent } from './content-compare.ts'
import { FACADE_ENTRIES, FORMULA_MUTATION_CELL, FORMULA_MUTATION_ID, PERMISSION_ALERT_TITLE, PROTECTION_WORDING, SHORTCUT_OUTCOMES, writeFormulaMutation } from './read-only-entries.ts'
import { holdTimedAutosave } from './selftest-autosave.ts'
import { EXPECTS_HIDDEN as CAPTURE_EXPECTS_HIDDEN, CAPTURE_SCENARIO_RUNNERS } from './selftest-capture.ts'
import { accessibleName, byExactText, byRole, centerOf, clickAt, dialogTitled, isShown, isVisible, keyboardTarget, nextFrames, pressKeys, rightClickAt, sheetCanvas, sheetTab, univerIsMac, waitFor } from './selftest-dom.ts'
import { HANDOVER_EXPECTS_HIDDEN, HANDOVER_SCENARIO_RUNNERS } from './selftest-handover.ts'
import { encodeSelftestReport, ENTER_EXIT_EDIT, isSelftestScenario, NEXT_PARAM, nextProblem, reportUrl, SELFTEST_PARAM, SELFTEST_REPORT_FORMAT } from './selftest-report.ts'
import { adoptEditor, check, CHECK_TIMEOUT_MS, chromeButton, describe, describeCommand, describeView, differences, fail, fetchServerContent, has, lastSeq, SCENARIO_BUDGET_MS, seenSince, SIGNAL_TIMEOUT_MS, SWITCH_TIMEOUT_MS, truncate, untilSwitched } from './selftest-session.ts'
import { installSwitchTiming, summarizeSwitch, SWITCH_TIMING_OPTIONS, switchDurations } from './switch-timing.ts'

export type { SelftestHost, SelftestPageView } from './selftest-session.ts'

/** 公式在 Worker 里算出结果最多等多久（Worker 的启动与第一次计算） */
const FORMULA_TIMEOUT_MS = 30_000

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

/** 快照里一项资源的数据（JSON 解析之后；空串是 undefined） */
function resourceOf(snapshot: { readonly resources?: readonly { readonly name: string, readonly data: string }[] }, name: string): unknown {
  const data = snapshot.resources?.find(resource => resource.name === name)?.data
  return data === undefined || data === '' ? undefined : JSON.parse(data) as unknown
}

// ---- 场景 ----

/**
 * 只读入口里能用 Facade 执行的：M0 的 Facade 入口逐项、经 Facade 写公式的 mutation、Facade 的撤销与重做。
 * 用当前的编辑器（enter-exit 退出编辑之后是新换上的只读编辑器），与 session.opened 比较
 */
async function checkFacadeEntries(session: Session, entries: readonly FacadeEntry[] = FACADE_ENTRIES): Promise<void> {
  const { probe, api, unitId } = session
  for (const entry of entries) {
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
}

async function readOnlyScenario(session: Session): Promise<void> {
  const { probe, unitId } = session
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

  await checkFacadeEntries(session)
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

// ---- 进入、退出编辑（M3-P2 S5） ----

/** 点页头里的按钮（真实的按钮，合成的点击），等切换完；记下这次切换的耗时，返回说明 */
async function switchBy(session: Session, timing: SwitchTimingRecorder, button: string, direction: Extract<SwitchDirection, 'enter' | 'exit'>): Promise<string> {
  const target = chromeButton(session, button)
  if (target === undefined)
    fail(`页头没有"${button}"（${describeView(session)}）`)
  const previous = session.probe
  timing.clear()
  target.click()
  await untilSwitched(session, direction === 'enter' ? 'editing' : 'reading', direction === 'enter' ? 'entering' : 'exiting')
  adoptEditor(session, previous)
  const ms = switchDurations(summarizeSwitch(direction, timing.marks(), timing.resources()))
  session.timings.push({ id: `switch.${direction}`, ms })
  const network = direction === 'enter' ? `申请编辑权 ${ms.acquire ?? '—'} ms` : `保存 ${ms.save ?? '—'} ms、释放 ${ms.release ?? '—'} ms`
  return `点击到可以操作 ${ms.ready ?? '—'} ms（页头 ${ms.header ?? '—'} ms；${network}；重建 ${ms.rebuild ?? '—'} ms），到 steady ${ms.steady ?? '—'} ms`
}

/** 快照里一格的值 */
function cellValue(snapshotText: string, sheetId: string, row: number, column: number): unknown {
  const workbook = JSON.parse(snapshotText) as { readonly sheets: Readonly<Record<string, { readonly cellData?: Readonly<Record<string, Readonly<Record<string, { readonly v?: unknown }>>>> }>> }
  return workbook.sheets[sheetId]?.cellData?.[row]?.[column]?.v
}

/**
 * 作者打开自己的一份样本（阅读）：点"编辑"→ 经 Facade 改一格 → 点"退出编辑"（先保存）→ 回到阅读之后，只读入口里能用 Facade 执行的
 * 那些（与 read-only 同一份清单）、撤销与重做、界面都核对一遍。前一步没做成时后面的不做（记为不通过，看得到卡在哪里）
 */
async function enterExitScenario(session: Session): Promise<void> {
  const timing = installSwitchTiming(SWITCH_TIMING_OPTIONS)
  const { sheetId, row, column, value } = ENTER_EXIT_EDIT
  const reading = await check(session, 'page.reading', async () => {
    if (session.host.page.readOnly !== true)
      fail('页面没有按阅读打开')
    if (chromeButton(session, '编辑') === undefined || chromeButton(session, '保存') !== undefined)
      fail(`页头不是能编辑的人阅读时的样子（${describeView(session)}）`)
    return '阅读：页头有"编辑"，没有保存按钮'
  })
  const entered = reading && await check(session, 'switch.enter', async () => {
    const seen = await switchBy(session, timing, '编辑', 'enter')
    if (chromeButton(session, '保存') === undefined || chromeButton(session, '退出编辑') === undefined)
      fail('进入了编辑，页头没有"保存""退出编辑"')
    return `进入编辑：${seen}`
  }, SWITCH_TIMEOUT_MS + CHECK_TIMEOUT_MS)
  const edited = entered && await check(session, 'edit.set-cell', async () => {
    const mark = lastSeq(session.probe)
    session.api.getActiveWorkbook().getSheetByName(ENTER_EXIT_EDIT.sheetName).getRange(ENTER_EXIT_EDIT.cell).setValue(value)
    if (!await waitFor(() => has(session.probe, mark, 'executed', 'sheet.command.set-range-values'), SIGNAL_TIMEOUT_MS))
      fail(`写入 ${ENTER_EXIT_EDIT.cell} 没有执行；${seenSince(session.probe, mark)}`)
    if (cellValue(session.probe.snapshot(), sheetId, row, column) !== value)
      fail(`内存里 ${ENTER_EXIT_EDIT.cell} 不是写进去的值`)
    return `能编辑：经 Facade 在"${ENTER_EXIT_EDIT.sheetName}"表 ${ENTER_EXIT_EDIT.cell} 写入"${value}"`
  })
  const exited = edited && await check(session, 'switch.exit', async () => {
    const seen = await switchBy(session, timing, '退出编辑', 'exit')
    if (chromeButton(session, '编辑') === undefined || chromeButton(session, '保存') !== undefined)
      fail(`退出之后页头不是阅读的样子（${describeView(session)}）`)
    return `退出编辑（先保存）：${seen}`
  }, SWITCH_TIMEOUT_MS + CHECK_TIMEOUT_MS)
  if (!exited)
    return
  session.opened = session.probe.snapshot()
  await check(session, 'exit.content', async () => {
    // 退出时先保存、再以捕获的内容重建为只读：阅读的编辑器里与服务器上都是改过的内容
    if (cellValue(session.opened, sheetId, row, column) !== value)
      fail(`退出之后阅读的编辑器里 ${ENTER_EXIT_EDIT.cell} 不是写进去的值`)
    const stored = await fetchServerContent(session.host.documentId)
    if (!sameContent(stored, session.opened))
      fail(`阅读的编辑器里的内容与服务器上的不同：${differences(stored, session.opened)}`)
    return `阅读的编辑器里与服务器上都是保存的内容（${ENTER_EXIT_EDIT.cell} 是"${value}"）`
  })
  // 这个场景的样本去掉了图片（M3-P3 设计 §3.11：样本的图片是 data: 地址，服务端拒绝保存，而这里要保存一次）：操作图片的几项没有对象可操作，
  // 跳过——它们在 read-only 场景（完整的样本）里照样逐项核对，"进入再退出"之后的这几项由 E2E 的 edit-mode.spec.ts 在三个浏览器里核对
  await checkFacadeEntries(session, FACADE_ENTRIES.filter(entry => entry.needsImage !== true))
  await checkChrome(session, false)
  await check(session, 'content.final', async () => {
    expectUnchanged(session, 0)
    return '内存里的内容与退出编辑时相同，回到阅读之后没有改动文档的 mutation 执行'
  })
}

const SCENARIOS: Readonly<Record<SelftestScenario, (session: Session) => Promise<void>>> = {
  'read-only': readOnlyScenario,
  'read-only-formulas': formulasScenario,
  'edit-chrome': editChromeScenario,
  'enter-exit': enterExitScenario,
  ...CAPTURE_SCENARIO_RUNNERS,
  ...HANDOVER_SCENARIO_RUNNERS,
}

/** 这些场景要求页面在中途变成隐藏（不按"页面被隐藏，余下的检查不做"处理）：hidden-save，交接里被另开的标签页遮住的 A */
const EXPECTS_HIDDEN: ReadonlySet<string> = new Set([...CAPTURE_EXPECTS_HIDDEN, ...HANDOVER_EXPECTS_HIDDEN])

/** 跑一次自检，返回结果（不跳转） */
export async function runEditorSelftest(host: SelftestHost, scenario: string): Promise<SelftestReport> {
  const checks: SelftestCheck[] = []
  const timings: SelftestTiming[] = []
  let failure: string | undefined
  let formulaValues: Record<string, unknown> | undefined
  let path: string | undefined
  let timeline: SelftestTimelineEntry[] | undefined
  const probe = window.__nerveEditorProbe
  if (!isSelftestScenario(scenario))
    failure = `不认识的场景 ${scenario}`
  else if (host.page.state !== 'ready')
    failure = `编辑器页没有就绪（${host.page.state}${host.page.detail === undefined ? '' : `：${host.page.detail}`}）`
  else if (probe === undefined)
    failure = '页面里没有编辑器的探针（不是测试构建？）'
  if (failure === undefined && probe !== undefined && isSelftestScenario(scenario)) {
    const api = probe.univerAPI as unknown as SelftestApi
    const session: Session = { host, probe, api, unitId: api.getActiveWorkbook().getId(), opened: probe.snapshot(), checks, timings, deadline: performance.now() + SCENARIO_BUDGET_MS }
    // 页面中途被隐藏（浏览器窗口被挡住、切到别的标签页）：Safari 几秒之后就暂停它，余下的检查不再做，趁计时器还在走把结果交回去。
    // 自检开始时已经隐藏了（到 steady 之前就被挡住：挂接只在页面一开始就隐藏时不等 steady）同样算：不然每项都在没有动画帧的页面上超时
    // hidden-save 本来就要页面在中途变成隐藏（EXPECTS_HIDDEN），不按这一条处理
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden' && !EXPECTS_HIDDEN.has(scenario))
        session.hiddenAt ??= new Date().toISOString()
    }
    onVisibility()
    document.addEventListener('visibilitychange', onVisibility)
    // 定时的自动保存先一律暂停（不依赖打开时的状态，审查 B1）；捕获时机的场景按需要放开（./selftest-autosave.ts）
    holdTimedAutosave()
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
    path = session.path
    timeline = session.timeline
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
    timings: timings.length === 0 ? undefined : timings,
    path,
    timeline,
    failure,
  }
}

/** 自检没有运行的原因：写在页面的最上面（手工打开时看得到），页面的其余部分照常 */
function showProblem(text: string): void {
  const notice = document.createElement('p')
  notice.setAttribute('role', 'alert')
  notice.textContent = text
  document.body.prepend(notice)
}

/**
 * 跑地址里要求的场景（selftest），把结果带到地址里的 next（整页跳转，替换当前的历史记录）。
 * 没有 next 时只跑、不跳转（手工调试时在开发者工具里看页面）。next 不是本机的地址时（nextProblem，M3-P2 复核 B7）不跑、不跳转，
 * 原因写在页面上，返回 undefined：带着任意 next 打开测试构建的编辑器页，既不会动这份文档（enter-exit 要保存），也不会把结果带出本机
 */
export async function runSelftestAndReport(host: SelftestHost): Promise<SelftestReport | undefined> {
  const params = new URL(window.location.href).searchParams
  const next = params.get(NEXT_PARAM)
  const problem = next === null ? undefined : nextProblem(next)
  if (problem !== undefined) {
    showProblem(`页面自检没有运行：${problem}`)
    return undefined
  }
  const report = await runEditorSelftest(host, params.get(SELFTEST_PARAM) ?? '')
  if (next !== null) {
    const url = reportUrl(next, await encodeSelftestReport(report))
    host.allowLeave()
    window.location.replace(url)
  }
  return report
}
