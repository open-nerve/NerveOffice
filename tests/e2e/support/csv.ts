import type { DocumentListResponse } from '@nerve-office/contracts'
import type { Page } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { sheetSnapshotFor } from '@nerve-office/contracts'
import { expect } from './fixtures.ts'

/** 正式文件输入，不向产品控制器注入解析结果。 */
export async function chooseCsv(page: Page, data: string | Uint8Array): Promise<void> {
  const picking = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: /^(?:选择文件|更换文件)$/ }).click()
  await (await picking).setFiles({ name: 'sample.csv', mimeType: 'text/csv', buffer: typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data) })
}

/** 文件保留在浏览器本轮受管临时目录，由运行器收尾；这里只读取实际下载字节。 */
export async function downloadCsv(page: Page, sheetName: string): Promise<{ name: string, bytes: Buffer }> {
  await page.getByRole('button', { name: '导出 CSV', exact: true }).click()
  await page.getByLabel('工作表', { exact: true }).selectOption({ label: sheetName })
  const finished = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载 CSV', exact: true }).click()
  const download = await finished
  expect(await download.failure()).toBeNull()
  return { name: download.suggestedFilename(), bytes: await readFile(await download.path()) }
}

export async function documentsAt(page: Page, spaceId: string, folderId?: string): Promise<DocumentListResponse> {
  const query = new URLSearchParams({ spaceId, ...(folderId === undefined ? {} : { folderId }) })
  const response = await page.request.get(`/api/documents?${query.toString()}`)
  expect(response.status()).toBe(200)
  return await response.json() as DocumentListResponse
}

interface CsvFormulaSample {
  sheetOrder: string[]
  sheets: Record<string, {
    name: string
    cellData: Record<string, Record<string, { v: string | number, t: number, f?: string, s?: { n: { pattern: string } } }>>
  }>
}

export const CSV_FORMULA_SHEET = 'CSV计算样本'

/** 只有数组锚点带故意过时的缓存；溢出格须由实际引擎计算，样本不填写结果。 */
export function csvFormulaSampleFor(unitId: string): string {
  const book = JSON.parse(sheetSnapshotFor(unitId)) as CsvFormulaSample
  const first = book.sheets[book.sheetOrder[0] ?? '']
  if (first === undefined)
    throw new Error('CSV 公式样本缺少模板工作表')
  first.name = CSV_FORMULA_SHEET
  first.cellData = { 0: {
    0: { f: '=SEQUENCE(2,3)', v: 999, t: 2 },
    3: { v: 1234.5, t: 2, s: { n: { pattern: '#,##0.00' } } },
    4: { v: 45292, t: 2, s: { n: { pattern: 'yyyy-mm-dd' } } },
    5: { v: ' =1+2', t: 1 },
    6: { v: '行一\n"行二"', t: 1 },
    7: { v: -12.5, t: 2 },
  } }
  return JSON.stringify(book)
}
