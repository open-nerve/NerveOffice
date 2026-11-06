/** CSV 是客户端交换格式；最终工作簿还要经过快照容量和服务端校验。 */
export const CSV_LIMITS = {
  bytes: 5 * 1024 * 1024,
  field: 32_767,
  rows: 50_000,
  columns: 1_024,
  cells: 100_000,
} as const

export type CsvErrorReason = 'encoding' | 'syntax' | 'control' | 'empty' | 'bytes' | 'field' | 'rows' | 'columns' | 'cells' | 'cancelled'

/**
 * 表格单元格的文字在 SDK 里会按文档流编辑：这些字符是文档流的结构标记（core 的 DataStreamTreeTokenType：CUSTOM_BLOCK 0x08、分栏 0x0B、
 * 分页 0x0C、表格/列/块 0x0E–0x15 与 0x1A–0x1D、自定义范围 0x1E–0x1F）。CSV 导入照原样放进文字格，进入编辑时 SDK 的文档结构校验会抛出
 * 未接住的异常（审查疑点 Q-12 的实测），所以导入时拒绝，与空字符同样处理；制表符与换行是正常文字，其他控制字符没有结构含义，照常保留
 */
export function isDocumentStructureCharacter(char: string): boolean {
  const code = char.charCodeAt(0)
  return code === 0x08 || code === 0x0B || code === 0x0C || (code >= 0x0E && code <= 0x15) || (code >= 0x1A && code <= 0x1F)
}

export class CsvError extends Error {
  override readonly name = 'CsvError'
  readonly reason: CsvErrorReason

  constructor(reason: CsvErrorReason) {
    // 原字段可能含个人资料；错误只携带固定原因，界面另映射中文说明。
    super(`CSV ${reason}`)
    this.reason = reason
  }
}

export interface CsvTable {
  readonly rows: readonly (readonly string[])[]
  readonly rowCount: number
  readonly columnCount: number
}

/** 先检查矩形预算再分配/补齐；后出现的宽行也影响之前的短行。 */
export function assertCsvShape(rows: number, columns: number): void {
  if (rows > CSV_LIMITS.rows)
    throw new CsvError('rows')
  if (columns > CSV_LIMITS.columns)
    throw new CsvError('columns')
  if (rows * columns > CSV_LIMITS.cells)
    throw new CsvError('cells')
}

/** 用于已读入的字段；解析扫描仍须逐字符限制内存。 */
export function assertCsvField(text: string): void {
  if (text.length > CSV_LIMITS.field)
    throw new CsvError('field')
  if (text.includes('\0'))
    throw new CsvError('syntax')
  // Unicode 模式将合法代理对视为一个码点，只拒绝孤立代理字符。
  if (/[\uD800-\uDFFF]/u.test(text))
    throw new CsvError('encoding')
}
