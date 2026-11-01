import type { Univer } from '@univerjs/core'
import { CellValueType } from '@univerjs/core'
import { FormulaDataModel } from '@univerjs/engine-formula'
import { injectorOf } from './injector.ts'

/**
 * 固定 SDK 的数组公式显示来自独立缓存；原始 cellData 只有锚点。
 * 只枚举当前文档/表实际存在的结果格，不采用可能含 #SPILL! 意图的 range。
 * 每次只交出坐标和数值类型，不泄露模型、缓存引用、公式或内容；调用方可在预算超限时立即停止。
 */
export function* csvArrayCells(univer: Univer, unitId: string, sheetId: string): Generator<{ readonly row: number, readonly column: number, readonly numeric: boolean }> {
  const cells = injectorOf(univer).get(FormulaDataModel).getArrayFormulaCellData()[unitId]?.[sheetId] ?? {}
  for (const rowKey of Object.keys(cells)) {
    const row = Number(rowKey)
    const values = cells[row]
    for (const columnKey of Object.keys(values ?? {})) {
      const column = Number(columnKey)
      const value = values?.[column]
      if (value === null || value === undefined)
        continue
      // ArrayFormulaCellInterceptorController 用缓存覆盖 raw.v/raw.t；两者均 nullish 时显示 NUMBER/0。
      const untyped = value.t === null || value.t === undefined
      const numeric = value.t === CellValueType.NUMBER || (untyped && (value.v === null || value.v === undefined || typeof value.v === 'number'))
      yield { row, column, numeric }
    }
  }
}
