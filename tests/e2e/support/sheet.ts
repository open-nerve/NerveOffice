// 编辑器页的操作与核对（P4 设计 §3.10）。
// Univer 把表格画在画布上，单元格没有可访问的元素：选中单元格只能按位置点击画布，位置按模板的默认行高、列宽与表头的大小算；
// 内容按接口取回的快照核对（服务器上保存的才算数）。页头、按钮与提示照常按角色与名称定位。
import type { Locator, Page } from '@playwright/test'
import { revisionFromEtag, SHEET_TEMPLATE } from '@nerve-office/contracts'
import { e2eOrigin } from './environment.ts'
import { expect } from './fixtures.ts'

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

export async function openEditor(page: Page, documentId: string, stage: 'ready' | 'steady' = 'ready'): Promise<void> {
  await page.goto(`/documents/${documentId}`)
  await waitForEditor(page, stage)
}

/** 在列表页点"新建表格"，整页打开编辑器页；返回新文档的 id */
export async function createSheetThroughUi(page: Page): Promise<string> {
  await page.goto('/')
  await page.getByRole('button', { name: '新建表格' }).click()
  await expect(page).toHaveURL(/\/documents\/[\da-f-]{36}$/)
  await waitForEditor(page)
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

/** 点保存并等到"已保存到云端" */
export async function saveAndWait(page: Page): Promise<void> {
  await saveButton(page).click()
  await expect(saveStatus(page)).toHaveText('已保存到云端')
}

export interface SavedContent {
  /** 快照的 JSON 原文（接口原样下发的 gzip 解压之后） */
  readonly text: string
  readonly revision: number
  readonly snapshot: Workbook
}

interface CustomRange {
  readonly rangeType: number
  readonly properties?: { readonly url?: string }
}

interface Cell {
  readonly v?: unknown
  readonly f?: string
  readonly s?: unknown
  readonly t?: number
  /** 富文本（例如自动识别出的链接） */
  readonly p?: { readonly body?: { readonly dataStream?: string, readonly customRanges?: readonly CustomRange[] } }
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
