import type { Univer } from '@univerjs/core'
import { FormulaDataModel } from '@univerjs/engine-formula'
import { injectorOf } from './injector.ts'

/**
 * 当前文档确有多格结果的数组公式锚点（M5R-I-07，D-04）：固定 1.0.1 引擎只把锚点写入原 cellData，溢出结果只在 FormulaDataModel 里，
 * 加载时也只从单元格 ref 恢复（SDK 从不写回 ref）。捕获正文时据此去掉这些锚点的缓存值，重开时 SDK 默认的 WHEN_EMPTY 初次计算恰好
 * 只重算它们。1×1 的结果没有溢出，不在其中；被挡住的溢出（#SPILL!）仍按其意图范围列出，重算后照样是 #SPILL!。只交出坐标
 */
export function* arrayFormulaAnchors(univer: Univer, unitId: string): Generator<{ readonly sheetId: string, readonly row: number, readonly column: number }> {
  const sheets = injectorOf(univer).get(FormulaDataModel).getArrayFormulaRange()[unitId] ?? {}
  for (const sheetId of Object.keys(sheets)) {
    const rows = sheets[sheetId] ?? {}
    for (const rowKey of Object.keys(rows)) {
      const row = Number(rowKey)
      const columns = rows[row] ?? {}
      for (const columnKey of Object.keys(columns)) {
        const column = Number(columnKey)
        const range = columns[column]
        if (!range || (range.startRow === range.endRow && range.startColumn === range.endColumn))
          continue
        yield { sheetId, row, column }
      }
    }
  }
}
