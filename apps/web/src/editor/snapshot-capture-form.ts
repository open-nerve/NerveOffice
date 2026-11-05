import type { IWorkbookData, Univer } from '@univerjs/core'
import { arrayFormulaAnchors } from './internal-api/index.ts'

/**
 * 正文的捕获形态（M5R-I-07，D-04）：去掉当前确有多格溢出的数组公式锚点的缓存值 v/t，其余字段（f、si、样式、p、custom）原样保留。
 * “有公式、没有缓存值”本来就是合法的正文（新输入还没算完的公式、“公式待更新”的文档），格式与档案版本不变；重开时阅读、编辑、
 * Worker 与主线程都走 SDK 默认的 WHEN_EMPTY 初次计算，只重算这些锚点、溢出结果随之恢复。不改模型：只在需要时逐层复制
 */
export function withoutArrayAnchorValues(data: IWorkbookData, anchors: Iterable<{ readonly sheetId: string, readonly row: number, readonly column: number }>): IWorkbookData {
  let sheets = data.sheets
  for (const { sheetId, row, column } of anchors) {
    const sheet = sheets[sheetId]
    const cell = sheet?.cellData?.[row]?.[column]
    if (!sheet || !cell || (cell.v === undefined && cell.t === undefined))
      continue
    if (sheets === data.sheets)
      sheets = { ...data.sheets }
    const { v: _value, t: _type, ...rest } = cell
    const cellData = sheet.cellData ?? {}
    sheets[sheetId] = { ...sheet, cellData: { ...cellData, [row]: { ...cellData[row], [column]: rest } } }
  }
  return sheets === data.sheets ? data : { ...data, sheets }
}

/** 编辑器与测试构建探针共用的捕获：JSON.stringify(save()) 的数组锚点形态 */
export function captureWorkbookData(univer: Univer, data: IWorkbookData): string {
  return JSON.stringify(withoutArrayAnchorValues(data, arrayFormulaAnchors(univer, data.id)))
}
