// M5-P3-S4：真实 UI 操作与服务器事实。公开流程不调用测试探针或 Facade 写入。
import type { Page } from '@playwright/test'
import type { Scene } from './read-only.ts'
import type { Workbook } from './sheet.ts'
import { sheetSnapshotFor } from '@nerve-office/contracts'
import { contentOf, nameBox } from './editor-probe.ts'
import { expect, test } from './fixtures.ts'
import { pressUniverShortcut } from './keyboard.ts'
import { ALERT, closePermissionAlert, nextFrames, openReadOnly, scene, watch } from './read-only.ts'
import { loginThroughApi } from './session.ts'
import { enterEditButton, enterEditing, exitEditing, expectFoundOnce, openAndEnterEditing, saveAndWait, savedContent } from './sheet.ts'

export async function openCapabilitySheet(page: Page, prefix: string): Promise<Scene> {
  const actors = await scene(prefix, sheetSnapshotFor)
  await loginThroughApi(page, actors.author)
  await openAndEnterEditing(page, actors.documentId, 'steady')
  return actors
}

/** 名称框是正式 UI；行高、列宽或隐藏发生变化后也不用模板几何猜单元格位置。 */
export async function selectAddress(page: Page, address: string): Promise<void> {
  await nameBox(page).fill(address)
  await nameBox(page).press('Enter')
  await expect(nameBox(page)).toHaveValue(address)
  await expect(nameBox(page)).not.toBeFocused()
  await nextFrames(page)
}

export async function committedWorkbook(page: Page, documentId: string): Promise<Workbook> {
  await saveAndWait(page)
  return (await savedContent(page, documentId)).snapshot
}

export interface CapabilitySheet {
  readonly rowCount: number
  readonly columnCount: number
  readonly defaultRowHeight: number
  readonly defaultColumnWidth: number
  readonly rowHeader: { readonly width: number }
  readonly columnHeader: { readonly height: number }
  readonly rowData?: Readonly<Record<string, { readonly h?: number, readonly ah?: number, readonly hd?: number }>>
  readonly columnData?: Readonly<Record<string, { readonly w?: number, readonly hd?: number }>>
}

export function dimensions(workbook: Workbook): CapabilitySheet {
  return workbook.sheets[workbook.sheetOrder[0]!] as unknown as CapabilitySheet
}

/** 本组未滚动、未冻结的左上区域：用刚保存的行列尺寸，不能沿用模板几何。 */
export function cellBounds(workbook: Workbook, address: string): { startX: number, endX: number, startY: number, endY: number } {
  const match = /^([A-Z])([1-9]\d*)$/.exec(address)
  if (match === null)
    throw new Error(`不支持的地址：${address}`)
  const column = match[1]!.charCodeAt(0) - 65
  const row = Number(match[2]) - 1
  const sheet = dimensions(workbook)
  const width = (index: number) => sheet.columnData?.[index]?.hd === 1 ? 0 : sheet.columnData?.[index]?.w ?? sheet.defaultColumnWidth
  const height = (index: number) => sheet.rowData?.[index]?.hd === 1 ? 0 : sheet.rowData?.[index]?.h ?? sheet.rowData?.[index]?.ah ?? sheet.defaultRowHeight
  const startX = sheet.rowHeader.width + Array.from({ length: column }, (_, index) => width(index)).reduce((sum, value) => sum + value, 0)
  const startY = sheet.columnHeader.height + Array.from({ length: row }, (_, index) => height(index)).reduce((sum, value) => sum + value, 0)
  expect(width(column), '目标列必须可见').toBeGreaterThan(0)
  expect(height(row), '目标行必须可见').toBeGreaterThan(0)
  return { startX, endX: startX + width(column), startY, endY: startY + height(row) }
}

/** 每个可写能力都实际保存前值、后值、撤销值和重做值，不只检查菜单存在或命令被调用。 */
export async function historyStep(
  page: Page,
  documentId: string,
  label: string,
  read: (workbook: Workbook) => unknown,
  act: () => Promise<void>,
  expected: unknown,
): Promise<Workbook> {
  return test.step(label, async () => {
    const before = read(await committedWorkbook(page, documentId))
    expect(before, '阳性对照：本次操作应改变待核对的事实').not.toEqual(expected)
    await act()
    const after = await committedWorkbook(page, documentId)
    expect(read(after), '实际操作后的服务器事实').toEqual(expected)
    await selectAddress(page, 'A1')
    await pressUniverShortcut(page, 'Z')
    expect(read(await committedWorkbook(page, documentId)), '撤销回到操作前').toEqual(before)
    await selectAddress(page, 'A1')
    await pressUniverShortcut(page, 'Y')
    const redone = await committedWorkbook(page, documentId)
    expect(read(redone), '重做恢复操作后').toEqual(expected)
    return redone
  })
}

/** 重建后再保存须收敛；查看者得到同一正文，真实键入被只读权限拒绝，也不产生保存。 */
export async function finishCapabilitySheet(page: Page, actors: Scene, visibleText?: string): Promise<void> {
  await saveAndWait(page)
  const before = await savedContent(page, actors.documentId)
  await exitEditing(page, 'steady')
  await enterEditing(page, 'steady')
  await saveAndWait(page)
  expect(contentOf((await savedContent(page, actors.documentId)).text)).toEqual(contentOf(before.text))
  await exitEditing(page, 'steady')
  const observed = watch(page, actors.documentId)
  await openReadOnly(page, actors.viewer, actors.documentId)
  await expect(enterEditButton(page)).toHaveCount(0)
  if (visibleText !== undefined)
    await expectFoundOnce(page, visibleText)
  await selectAddress(page, 'A1')
  await page.keyboard.type('123')
  await closePermissionAlert(page, ALERT.edit)
  const viewed = await savedContent(page, actors.documentId)
  expect(contentOf(viewed.text)).toEqual(contentOf(before.text))
  expect(viewed.revision).toBe(before.revision)
  expect(observed.saves).toEqual([])
}
