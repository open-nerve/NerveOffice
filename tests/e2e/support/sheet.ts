// 编辑器页的操作与核对（P4 设计 §3.10）。
// Univer 把表格画在画布上，单元格没有可访问的元素：选中单元格只能按位置点击画布，位置按模板的默认行高、列宽与表头的大小算；
// 内容按接口取回的快照核对（服务器上保存的才算数）。页头、按钮与提示照常按角色与名称定位。
import type { Locator, Page, Request, Route } from '@playwright/test'
import { revisionFromEtag, SHEET_TEMPLATE } from '@nerve-office/contracts'
import { editLeaseEndReason } from './database.ts'
import { e2eOrigin } from './environment.ts'
import { expect } from './fixtures.ts'
import { pressUniverShortcut } from './keyboard.ts'
import { shownName } from './people.ts'

/**
 * 要打开编辑器的用例，整份 spec 用这个时限（M2-P4 复验 G3）：
 * 在 spec 的开头写 test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })。
 *
 * Playwright 默认的 30 秒对这些用例不够用：一份用例要开一到两次编辑器（下载 SDK、起公式 Worker、画完表格），
 * 再键入、保存、逐项核对，而里面单独一步的时限就已经是 30 秒（下面的 waitForEditor）——用例的总时限反倒成了最紧的那一道。
 * 本机实测（2026-09-30 两次全跑；2026-10-01 editor/ 在 chromium、chrome、webkit 上又全跑两次，取每份 spec 最慢的那一个用例）：
 * editor/read-only 13.3 秒、editor/features 10.6 秒、editor/conflict 8.8 秒、editor/reopen 7.5 秒，
 * 其余（csp、documents/copy、template、save、create、session、access）都在 6.2 秒以内；
 * 满载的本机上 conflict 出现过一次"点保存 30 秒超时"（重跑通过）。CI 的机器比本机慢好几倍，30 秒的余量不到 4 倍。
 * 时限只用来发现卡住的用例，所以按本机最慢的那一份留二十倍上下的余量，取 4 分钟。不用重试掩盖：出现重试即记为不稳定，
 * CI 上让这次运行失败（规范 §8.4，playwright.config.ts 的 failOnFlakyTests）。
 * 只读的快捷键回归（editor/read-only-shortcuts）更长，另用 SHORTCUT_SWEEP_TIMEOUT。
 */
export const EDITOR_TEST_TIMEOUT = 240_000

/**
 * 只读的快捷键回归（editor/read-only-shortcuts.spec.ts）的时限：一条用例要按遍 SDK 注册的全部快捷键（1.0.1 在苹果的平台上 78 种组合，
 * 每种都要复位、按下、核对），比别的用例长得多。本机实测（2026-10-01，三种选区各一条）：单个工作进程时每条 16.7–19.2 秒，
 * 与 editor/ 的其他用例一起跑时 17.5–22.6 秒（两次），9 条同时跑（三个浏览器的三种选区）时 25.1–30.3 秒；拆成三条之前的一条
 * （只按单元格的选区）本机 21–25 秒、加压时 42 秒（M2-P6 复验 N7）。按最慢的一条留二十倍上下的余量，取 8 分钟：用 4 分钟时
 * 余量只剩十倍，加压时八倍，CI 慢几倍之后就贴着时限了。别的用例仍是 4 分钟，卡住时不必等更久
 */
export const SHORTCUT_SWEEP_TIMEOUT = 480_000

const SHEET = SHEET_TEMPLATE.sheets['sheet-1']
const GEOMETRY = {
  rowHeader: SHEET.rowHeader.width,
  columnHeader: SHEET.columnHeader.height,
  columnWidth: SHEET.defaultColumnWidth,
  rowHeight: SHEET.defaultRowHeight,
}

/**
 * Univer 挂载的容器（编辑器页的 #sheet-editor，作为 UniverUIPlugin 的 container 传入，SDK 把它登记为根容器）：
 * 页面的状态写在它的 data-editor-state 上；SDK 只派发目标在它（或别的登记过的容器）里的按键
 */
export const EDITOR_SURFACE = '#sheet-editor'

export function editorSurface(page: Page): Locator {
  return page.locator(EDITOR_SURFACE)
}

/** 编辑器页自己的页头（Univer 的功能区也是一个 header） */
function chrome(page: Page): Locator {
  return page.locator('#editor-chrome')
}

/** 页头里的保存状态（role="status"） */
export function saveStatus(page: Page): Locator {
  return chrome(page).getByRole('banner').getByRole('status')
}

export function saveButton(page: Page): Locator {
  return chrome(page).getByRole('button', { name: '保存', exact: true })
}

/** 等编辑器就绪（渲染完成，可以输入），或者到 steady（渲染完成后 3 秒，之后才判断"打开是否被判定为有修改"） */
export async function waitForEditor(page: Page, stage: 'ready' | 'steady' = 'ready'): Promise<void> {
  await expect(editorSurface(page)).toHaveAttribute('data-editor-state', stage === 'steady' ? 'steady' : /^(?:ready|steady)$/, { timeout: 30_000 })
}

/**
 * 编辑器的容器上适配层写的 access（M3-P2 S3）：模式切换一律重建，每个编辑器以 read 或 edit 创建，开始挂载时写上。
 * 页面的状态（data-editor-state）在切换期间是 loading，所以 access 是 edit 而状态是 ready、steady 时，就是可编辑的编辑器就绪了
 */
const EDITOR_ACCESS = 'data-editor-access'

/** 页头里的"编辑"（阅读、能编辑时，M3-P2） */
export function enterEditButton(page: Page): Locator {
  return chrome(page).getByRole('banner').getByRole('button', { name: '编辑', exact: true })
}

/** 页头里的"退出编辑"（编辑时，M3-P2） */
export function exitEditButton(page: Page): Locator {
  return chrome(page).getByRole('banner').getByRole('button', { name: '退出编辑', exact: true })
}

/** 等以 access 创建的编辑器就绪（或 steady） */
export async function waitForEditorAccess(page: Page, access: 'read' | 'edit', stage: 'ready' | 'steady' = 'ready'): Promise<void> {
  await expect(editorSurface(page)).toHaveAttribute(EDITOR_ACCESS, access, { timeout: 30_000 })
  await waitForEditor(page, stage)
}

/**
 * 点"编辑"，等可编辑的编辑器就绪（M3-P2：申请编辑权、以可编辑重建）。点下去的那个事件里页面就挂上交互屏障
 * （data-editor-state 变成 loading），所以之后等到的就绪是新建的那一个；进不去（被占用、不能编辑了）时等不到 edit，用例失败
 */
export async function enterEditing(page: Page, stage: 'ready' | 'steady' = 'ready'): Promise<void> {
  await enterEditButton(page).click()
  await waitForEditorAccess(page, 'edit', stage)
}

/** 点"退出编辑"，等只读的编辑器就绪（M3-P2：先保存、释放编辑权、以只读重建） */
export async function exitEditing(page: Page, stage: 'ready' | 'steady' = 'ready'): Promise<void> {
  await exitEditButton(page).click()
  await waitForEditorAccess(page, 'read', stage)
}

/**
 * 只打开、阅读（M3-P2：打开即阅读）：以只读创建的编辑器就绪，页头有了阅读时的样子（能编辑时有"编辑"，不能时"只能查看"）。
 * 查看者、别人正在编辑时打开的用例用它
 */
export async function openReader(page: Page, documentId: string, stage: 'ready' | 'steady' = 'ready'): Promise<void> {
  await page.goto(`/documents/${documentId}`)
  await whenReading(page, stage)
}

/** 打开或刷新之后：以只读创建的编辑器就绪，页头有了阅读时的样子（载入的结果在编辑器就绪之后一刻才交给页头） */
async function whenReading(page: Page, stage: 'ready' | 'steady'): Promise<void> {
  await waitForEditorAccess(page, 'read', stage)
  await expect(enterEditButton(page).or(saveStatus(page).filter({ hasText: /^只能查看$/ }))).toBeVisible()
}

/** 打开并进入编辑（M3-P2：打开即阅读，点"编辑"才进入编辑）：要在编辑器里改内容、保存的用例用它 */
export async function openAndEnterEditing(page: Page, documentId: string, stage: 'ready' | 'steady' = 'ready'): Promise<void> {
  await page.goto(`/documents/${documentId}`)
  await whenReading(page, 'ready')
  await enterEditing(page, stage)
}

/** 刷新之后进入编辑（刷新出来的页面同样先阅读） */
export async function reloadAndEnterEditing(page: Page, stage: 'ready' | 'steady' = 'ready'): Promise<void> {
  await page.reload()
  await whenReading(page, 'ready')
  await enterEditing(page, stage)
}

/** 在列表页点"新建表格"，整页打开编辑器页（?edit=new：刚建好的直接进入编辑，进入之后地址里去掉它）；返回新文档的 id */
export async function createSheetThroughUi(page: Page): Promise<string> {
  await page.goto('/')
  await page.getByRole('button', { name: '新建表格' }).click()
  await waitForEditorAccess(page, 'edit')
  await expect(page).toHaveURL(/\/documents\/[\da-f-]{36}$/)
  return new URL(page.url()).pathname.split('/').at(-1) ?? ''
}

/** A1 写法 → 从 0 开始的行号与列号（只用到单个字母的列） */
function cellPosition(a1: string): { row: number, column: number } {
  const match = /^([A-Z])(\d+)$/.exec(a1)
  if (match === null)
    throw new Error(`不支持的单元格写法：${a1}`)
  return { row: Number(match[2]) - 1, column: (match[1] ?? 'A').charCodeAt(0) - 'A'.charCodeAt(0) }
}

/** 表格的主画布 */
export function sheetCanvas(page: Page): Locator {
  return page.locator('canvas[id^="univer-sheet-main-canvas_"]')
}

/** 单元格的中心在画布上的位置（按模板的默认行高列宽算） */
function cellPoint(a1: string): { x: number, y: number } {
  const { row, column } = cellPosition(a1)
  return {
    x: GEOMETRY.rowHeader + column * GEOMETRY.columnWidth + GEOMETRY.columnWidth / 2,
    y: GEOMETRY.columnHeader + row * GEOMETRY.rowHeight + GEOMETRY.rowHeight / 2,
  }
}

/** 点击单元格 */
export async function selectCell(page: Page, a1: string, options: { button?: 'left' | 'right' } = {}): Promise<void> {
  await sheetCanvas(page).click({ button: options.button, position: cellPoint(a1) })
}

/** 鼠标移到单元格上（例如让批注的浮层弹出来）。force 的含义同 openCellEditor */
export async function hoverCell(page: Page, a1: string, options: { force?: boolean } = {}): Promise<void> {
  await sheetCanvas(page).hover({ position: cellPoint(a1), force: options.force })
}

/**
 * 双击单元格，打开单元格编辑器（不键入）。force 为真时不做可操作性的检查，直接发出鼠标事件
 * （就绪之前的用例：编辑器页的交互屏障会把它们拦下）
 */
export async function openCellEditor(page: Page, a1: string, options: { force?: boolean } = {}): Promise<void> {
  await sheetCanvas(page).dblclick({ position: cellPoint(a1), force: options.force })
}

/** 选中一个区域：点击起点，按住 Shift 点击终点 */
export async function selectRange(page: Page, from: string, to: string): Promise<void> {
  await selectCell(page, from)
  await page.keyboard.down('Shift')
  await selectCell(page, to)
  await page.keyboard.up('Shift')
}

/** 切到功能区的一个标签页，返回它的工具栏 */
export async function ribbon(page: Page, tab: '开始' | '插入' | '公式' | '数据' | '视图'): Promise<Locator> {
  await page.getByRole('tab', { name: tab, exact: true }).click()
  const toolbar = page.getByRole('toolbar', { name: tab })
  await expect(toolbar).toBeVisible()
  return toolbar
}

/** 选中单元格，键入内容；commit 为真时按回车提交（选区随之下移） */
export async function typeInCell(page: Page, a1: string, text: string, commit = true): Promise<void> {
  await selectCell(page, a1)
  await page.keyboard.type(text)
  if (commit)
    await page.keyboard.press('Enter')
}

/** 工作表标签栏里的一个标签（功能区的标签页也是 role="tab"，例如"数据"，按标签栏限定） */
export function sheetTab(page: Page, name: string): Locator {
  return page.getByRole('tablist', { name: '工作表标签页' }).getByRole('tab', { name, exact: true })
}

/** 在工作表标签栏新加一张表（成为当前的表）。这个按钮没有可访问的名称，按 Univer 的组件标记定位 */
export async function appendSheet(page: Page): Promise<void> {
  await page.locator('button[data-u-comp="sheet-bar-append-button"]').first().click()
}

/** 页面此刻会不会拦下离开（派发一次可以取消的 beforeunload，看页面有没有阻止它）：本页还有没保存、没另存为副本的内容时拦下 */
export async function wouldPromptOnLeave(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  })
}

/**
 * 用查找核对表格里有这段文字，找到 1 处（画布上的字读不出来）：只读时照常能查找，没有工具栏时点一下表格、按查找的快捷键。
 * 用来核对以只读重建之后显示的是哪一份内容（失去编辑权之后是本页的，放弃或另存为副本之后是服务器上的）。
 * 先等编辑器到 steady：查找的快捷键要等查找的提供方注册之后才可用，SDK 在它的 Steady 阶段才注册（support/read-only.ts 的 OPENED）
 */
export async function expectFoundOnce(page: Page, text: string): Promise<void> {
  await waitForEditor(page, 'steady')
  await selectCell(page, 'C3')
  await pressUniverShortcut(page, 'F')
  const find = page.getByRole('dialog', { name: '查找' })
  await find.getByRole('textbox', { name: '输入查找内容' }).fill(text)
  await find.getByRole('textbox', { name: '输入查找内容' }).press('Enter')
  await expect(find).toContainText('1/1')
  await find.getByRole('button', { name: 'Close' }).click()
  await expect(find).toBeHidden()
}

/** 点保存并等到"已保存到云端" */
export async function saveAndWait(page: Page): Promise<void> {
  await saveButton(page).click()
  await expect(saveStatus(page)).toHaveText('已保存到云端')
}

/** 页头之外说明谁在编辑的读屏状态区（M3-P1；M3-P2 起阅读时随编辑状态更新）：别处正在编辑这份文档时有内容 */
export function editingNotice(page: Page): Locator {
  return chrome(page).getByRole('status').filter({ hasText: '正在编辑这份文档' })
}

/** 写进正则的一段原文 */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * editingNotice 里"别人正在编辑"的说明（M3-P2：阅读时能不能编辑都显示）：人名（登录名在前，support/people.ts）、最后活动几分钟之前
 * （刚刚操作过时是"不到 1 分钟"，用例慢的时候可能过了一分钟）；能编辑的人另说现在只能阅读，查看者不说（页头已经说只能查看）
 */
export function editingBy(person: Parameters<typeof shownName>[0], canEdit: boolean): RegExp {
  return new RegExp(`^${literal(shownName(person))} 正在编辑这份文档（最后活动(?:不到 1| \\d+) 分钟前）${canEdit ? '，你现在只能阅读' : ''}$`)
}

/** 失去编辑权之后的说明（M3-P2：原因、本页的修改有没有保存，"另存为副本""放弃本页的修改""重新加载"） */
export function lostNotice(page: Page): Locator {
  return chrome(page).getByRole('alert').filter({ hasText: /^编辑权已失效/ })
}

/** 保存的请求（PUT …/content?…）：心跳续租也是 PUT（…/edit-lease），核对"发没发保存"时要分开 */
export function isSaveRequest(request: Request): boolean {
  return request.method() === 'PUT' && new URL(request.url()).pathname.endsWith('/content')
}

/**
 * 离开编辑器页（到空白页），等本页的编辑权释放到了服务端（M3-P1）：之后重开的页面能立即取得编辑权。
 * 释放在页面隐藏时经 keepalive 发出、结果不管；平时它早于重开的页面申请到达（晚到时重开的页面先再试几次，P1 设计 §7 第一条）。
 * 要在重开之前拦截请求（page.route）的用例先用它离开：WebKit 装了 page.route 之后，导航离开、刷新时的 keepalive 请求送不到
 * （本机实测：服务端收不到释放，重开的页面只能阅读，要等 90 秒到期；关闭页面时照常送到，Chromium 与 Chrome 都照常，审查者 B 的 R1），
 * 所以先放掉编辑权、再装拦截
 */
export async function leaveEditor(page: Page, documentId: string): Promise<void> {
  await page.goto('about:blank')
  await expect.poll(async () => editLeaseEndReason(documentId)).toBe('released')
}

/**
 * 拦下这个页面的心跳续租（M3-P1）：续租一律按断网处理——页面照常隔 10 秒重试，编辑权的状态不变；unblock 之后照常。
 * 核对保存那一步的用例用它：心跳也会得知失去访问、登录失效，赶在保存之前说明编辑权已失效（页面这样做是对的，
 * 但那就不是这条用例要核对的那一步了，结果还取决于心跳恰好落在哪里）。申请与释放照常
 */
export async function blockLeaseRenewals(page: Page): Promise<{ readonly unblock: () => Promise<void> }> {
  const pattern = '**/api/documents/*/edit-lease'
  const handler = async (route: Route): Promise<void> => route.request().method() === 'PUT' ? route.abort('internetdisconnected') : route.continue()
  await page.route(pattern, handler)
  return { unblock: async () => page.unroute(pattern, handler) }
}

export interface SavedContent {
  /** 快照的 JSON 原文（接口原样下发的 gzip 解压之后） */
  readonly text: string
  readonly revision: number
  readonly snapshot: Workbook
}

interface CustomRange {
  readonly rangeType: number
  readonly rangeId?: string
  readonly properties?: { readonly url?: string }
}

interface Paragraph {
  readonly startIndex: number
  readonly paragraphId?: string
}

interface Cell {
  readonly v?: unknown
  readonly f?: string
  readonly s?: unknown
  readonly t?: number
  /** 富文本（例如自动识别出的链接） */
  readonly p?: { readonly body?: { readonly dataStream?: string, readonly customRanges?: readonly CustomRange[], readonly paragraphs?: readonly Paragraph[] } }
}

export interface Workbook {
  readonly id: string
  readonly sheetOrder: readonly string[]
  readonly styles: Readonly<Record<string, Record<string, unknown>>>
  readonly sheets: Readonly<Record<string, { name: string, cellData: Readonly<Record<string, Readonly<Record<string, Cell>>>> }>>
  readonly resources: readonly { name: string, data: string }[]
}

/** 服务器上的当前内容（用这个页面的会话 Cookie 请求） */
export async function savedContent(page: Page, documentId: string): Promise<SavedContent> {
  const response = await page.request.get(`/api/documents/${documentId}/content`)
  expect(response.status(), await response.text()).toBe(200)
  const text = await response.text()
  return { text, revision: revisionFromEtag(response.headers().etag) ?? 0, snapshot: JSON.parse(text) as Workbook }
}

/** 快照里一项资源的数据（JSON 解析之后；空串是 undefined） */
export function resourceOf(snapshot: Workbook, name: string): unknown {
  const data = snapshot.resources.find(resource => resource.name === name)?.data
  return data === undefined || data === '' ? undefined : JSON.parse(data) as unknown
}

/** 快照里某张工作表（默认第一张）的一个单元格 */
export function cellOf(snapshot: Workbook, a1: string, sheetId = snapshot.sheetOrder[0] ?? ''): Cell | undefined {
  const { row, column } = cellPosition(a1)
  return snapshot.sheets[sheetId]?.cellData[row]?.[column]
}

/** 经接口新建一份表格（不经界面） */
export async function createSheetThroughApi(page: Page, title?: string): Promise<string> {
  const session = await page.request.get('/api/auth/session')
  const { csrfToken } = await session.json() as { csrfToken: string }
  const response = await page.request.post('/api/documents', {
    data: { type: 'sheet', requestId: crypto.randomUUID(), ...(title === undefined ? {} : { title }) },
    headers: { 'origin': e2eOrigin(), 'x-csrf-token': csrfToken },
  })
  expect(response.status(), await response.text()).toBe(201)
  return (await response.json() as { id: string }).id
}
