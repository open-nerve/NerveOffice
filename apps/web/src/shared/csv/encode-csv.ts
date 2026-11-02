import { assertCsvField, assertCsvShape, CSV_LIMITS, CsvError } from './csv-format.ts'

export interface CsvExportCell {
  readonly text: string
  readonly kind: 'text' | 'number'
}

// 自定义数字格式也能生成公式形态。只有完整的普通数值显示可以豁免负号保护。
const NUMERIC_DISPLAY = /^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?(?:e[+-]?\d+)?%?$/i

function formulaLike(text: string): boolean {
  for (const char of text) {
    if ('=+-@＝＋－＠\t\r\n'.includes(char))
      return true
    if (char.charCodeAt(0) > 0x20 && !/\s/u.test(char))
      return false
  }
  return false
}

function quotedCell(cell: CsvExportCell | undefined): string {
  const text = cell?.text ?? ''
  assertCsvField(text)
  const numeric = cell?.kind === 'number' && NUMERIC_DISPLAY.test(text)
  const protectedText = !numeric && formulaLike(text) ? `\t${text}` : text
  if (protectedText.length > CSV_LIMITS.field)
    throw new CsvError('field')
  return `"${protectedText.replaceAll('"', '""')}"`
}

/** 显式显示类型只控制公式保护，不做数值/日期重算；每一格都完整引用。 */
export function encodeCsv(rows: readonly (readonly CsvExportCell[])[]): Uint8Array {
  let width = 0
  for (const row of rows) {
    width = Math.max(width, row.length)
    assertCsvShape(rows.length, width)
  }
  if (width === 0)
    throw new CsvError('empty')
  const encoder = new TextEncoder()
  const parts = [new Uint8Array([0xEF, 0xBB, 0xBF])]
  let bytes = 3
  for (const row of rows) {
    for (let column = 0; column < width; column++) {
      const suffix = column === width - 1 ? '\r\n' : ','
      // 每块最多一个字段；超限时不会先拼出无界的整行/整份文本。
      const part = encoder.encode(`${quotedCell(row[column])}${suffix}`)
      bytes += part.byteLength
      if (bytes > CSV_LIMITS.bytes)
        throw new CsvError('bytes')
      parts.push(part)
    }
  }
  const output = new Uint8Array(bytes)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}
