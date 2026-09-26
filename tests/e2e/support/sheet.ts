// 编辑器页的操作与核对（P4 设计 §3.10）。
// Univer 把表格画在画布上，单元格没有可访问的元素：选中单元格只能按位置点击画布，位置按模板的默认行高、列宽与表头的大小算；
// 内容按接口取回的快照核对（服务器上保存的才算数）。页头、按钮与提示照常按角色与名称定位。
import type { Locator, Page } from '@playwright/test'
import { revisionFromEtag, SHEET_TEMPLATE } from '@nerve-office/contracts'
import { e2eOrigin } from './environment.ts'
import { expect } from './fixtures.ts'

const SHEET = SHEET_TEMPLATE.sheets['sheet-1']
const GEOMETRY = {
  rowHeader: SHEET.rowHeader.width,
  columnHeader: SHEET.columnHeader.height,
  columnWidth: SHEET.defaultColumnWidth,
  rowHeight: SHEET.defaultRowHeight,
}

/** Univer 挂载的容器：页面的状态写在它的 data-editor-state 上 */
export function editorSurface(page: Page): Locator {
  return page.locator('#sheet-editor')
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

/** 点击单元格（按模板的默认行高列宽算出画布上的位置） */
export async function selectCell(page: Page, a1: string, options: { button?: 'left' | 'right' } = {}): Promise<void> {
  const { row, column } = cellPosition(a1)
  await page.locator('canvas[id^="univer-sheet-main-canvas_"]').click({
    button: options.button,
    position: {
      x: GEOMETRY.rowHeader + column * GEOMETRY.columnWidth + GEOMETRY.columnWidth / 2,
      y: GEOMETRY.columnHeader + row * GEOMETRY.rowHeight + GEOMETRY.rowHeight / 2,
    },
  })
}

/** 选中单元格，键入内容；commit 为真时按回车提交（选区随之下移） */
export async function typeInCell(page: Page, a1: string, text: string, commit = true): Promise<void> {
  await selectCell(page, a1)
  await page.keyboard.type(text)
  if (commit)
    await page.keyboard.press('Enter')
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

interface Cell {
  readonly v?: unknown
  readonly f?: string
  readonly s?: unknown
  readonly t?: number
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
