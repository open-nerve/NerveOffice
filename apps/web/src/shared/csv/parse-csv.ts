import type { CsvTable } from './csv-format.ts'
import { assertCsvShape, CSV_LIMITS, CsvError, isDocumentStructureCharacter } from './csv-format.ts'

type FieldState = 'start' | 'bare' | 'quoted' | 'closed'
/** 每处理这么多字符看一次时钟 */
const CHECK_CHARACTERS = 16_384
/**
 * 连续计算满这么久才让出一轮事件循环：按计算时长而不是按字符数让出（M5-P8）。原先每 16K 字符让出一次，3 MB 的文件约 200 次，
 * 每次至少等浏览器嵌套计时器的 4 毫秒下限、负载高时更久，计算本身只要几十毫秒；托管 Mac 的 Chromium 上新建流程 5 秒内没读完。
 * 一段约为 8 毫秒再加上到下一处检查的计算（16K 字符），页面仍能及时处理取消与输入；循环之前的 UTF-8 解码不在分段之内。
 */
const SLICE_MILLISECONDS = 8

function assertActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true)
    throw new CsvError('cancelled')
}

/** 不做编码探测或修复；必须有完整结果才向调用方交付。 */
export async function parseCsv(bytes: Uint8Array, options?: { readonly signal?: AbortSignal }): Promise<CsvTable> {
  const signal = options?.signal
  assertActive(signal)
  if (bytes.byteLength > CSV_LIMITS.bytes)
    throw new CsvError('bytes')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  catch {
    throw new CsvError('encoding')
  }
  if (text.length === 0)
    throw new CsvError('empty')

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let state: FieldState = 'start'
  let width = 0
  let recordStart = 0
  let nextCheck = CHECK_CHARACTERS
  let sliceStart = performance.now()

  function append(value: string): void {
    if (field.length + value.length > CSV_LIMITS.field)
      throw new CsvError('field')
    field += value
  }

  function finishField(): void {
    width = Math.max(width, row.length + 1)
    assertCsvShape(rows.length + 1, width)
    row.push(field)
    field = ''
    state = 'start'
  }

  function finishRow(): void {
    finishField()
    rows.push(row)
    row = []
  }

  for (let index = 0; index < text.length; index++) {
    if (index >= nextCheck) {
      nextCheck = index + CHECK_CHARACTERS
      if (performance.now() - sliceStart >= SLICE_MILLISECONDS) {
        // Promise.resolve 只让出微任务，页面无法处理取消；这里必须让出一轮事件循环。
        await new Promise<void>(resolve => setTimeout(resolve, 0))
        assertActive(signal)
        sliceStart = performance.now()
      }
    }
    const char = text.charAt(index)
    if (char === '\0')
      throw new CsvError('syntax')
    if (isDocumentStructureCharacter(char))
      throw new CsvError('control')
    if (state === 'quoted') {
      if (char === '"')
        state = 'closed'
      else
        append(char)
      continue
    }
    if (char === '"') {
      if (state === 'closed') {
        append('"')
        state = 'quoted'
      }
      else if (state === 'start') {
        state = 'quoted'
      }
      else {
        throw new CsvError('syntax')
      }
    }
    else if (char === ',') {
      finishField()
    }
    else if (char === '\r' || char === '\n') {
      finishRow()
      if (char === '\r' && text.charAt(index + 1) === '\n')
        index++
      recordStart = index + 1
    }
    else if (state === 'closed') {
      throw new CsvError('syntax')
    }
    else {
      append(char)
      state = 'bare'
    }
  }
  assertActive(signal)
  if (state === 'quoted')
    throw new CsvError('syntax')
  if (recordStart < text.length)
    finishRow()
  for (const values of rows) {
    while (values.length < width)
      values.push('')
  }
  return { rows, rowCount: rows.length, columnCount: width }
}
