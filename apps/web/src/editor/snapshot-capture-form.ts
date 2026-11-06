import type { ICellData, IObjectMatrixPrimitiveType, IWorkbookData, Univer } from '@univerjs/core'
import { arrayFormulaAnchors } from './internal-api/index.ts'

/**
 * 正文的捕获形态（M5R-I-07，D-04）：去掉当前确有多格溢出的数组公式锚点的缓存值 v/t，其余字段（f、si、样式、p、custom）原样保留。
 * “有公式、没有缓存值”本来就是合法的正文（新输入还没算完的公式、“公式待更新”的文档），格式与档案版本不变；重开时阅读、编辑、
 * Worker 与主线程都走 SDK 默认的 WHEN_EMPTY 初次计算，只重算这些锚点、溢出结果随之恢复。
 * 不改模型：只在需要时复制，每张表的 cellData 与每一行最多复制一次（S14 审查 E4：逐个锚点复制整张表在整列都是数组公式时是平方级，
 * 十万个锚点约 6 秒，每次自动保存的捕获都在主线程上）
 */
export function withoutArrayAnchorValues(data: IWorkbookData, anchors: Iterable<{ readonly sheetId: string, readonly row: number, readonly column: number }>): IWorkbookData {
  const copied = new Map<string, { readonly cellData: IObjectMatrixPrimitiveType<ICellData>, readonly rows: Map<number, Record<number, ICellData>> }>()
  for (const { sheetId, row, column } of anchors) {
    const sheet = data.sheets[sheetId]
    const cell = sheet?.cellData?.[row]?.[column]
    if (!sheet || !cell || (cell.v === undefined && cell.t === undefined))
      continue
    let table = copied.get(sheetId)
    if (table === undefined) {
      table = { cellData: { ...sheet.cellData }, rows: new Map() }
      copied.set(sheetId, table)
    }
    let copy = table.rows.get(row)
    if (copy === undefined) {
      copy = { ...table.cellData[row] }
      table.cellData[row] = copy
      table.rows.set(row, copy)
    }
    const { v: _value, t: _type, ...rest } = cell
    copy[column] = rest
  }
  if (copied.size === 0)
    return data
  const sheets = { ...data.sheets }
  for (const [sheetId, { cellData }] of copied)
    sheets[sheetId] = { ...data.sheets[sheetId], cellData }
  return { ...data, sheets }
}

/** 编辑器与测试构建探针共用的捕获：JSON.stringify(save()) 的数组锚点形态 */
export function captureWorkbookData(univer: Univer, data: IWorkbookData): string {
  return JSON.stringify(withoutArrayAnchorValues(data, arrayFormulaAnchors(univer, data.id)))
}
