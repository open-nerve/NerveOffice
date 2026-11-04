export interface ImageInputFormula {
  readonly sheetId: string
  readonly row: number
  readonly column: number
  readonly formula: string
}

/** 仅为断言扣除逐字保持的输入公式；实际快照、其他字段及默认检查范围不变。 */
export function imageSnapshotForUrlCheck(snapshot: string, input?: ImageInputFormula): string {
  if (!input)
    return snapshot
  const parsed = JSON.parse(snapshot) as {
    sheets?: Record<string, { cellData?: Record<number, Record<number, { f?: string }>> }>
  }
  const cell = parsed.sheets?.[input.sheetId]?.cellData?.[input.row]?.[input.column]
  if (!cell || cell.f !== input.formula)
    throw new Error('图片来源检查的原始输入公式改变或丢失')
  delete cell.f
  return JSON.stringify(parsed)
}
