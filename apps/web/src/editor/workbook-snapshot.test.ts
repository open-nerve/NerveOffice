import { describe, expect, it } from 'vitest'
import { SheetEditorLoadError } from './sheet-editor-error.ts'
import { parseWorkbookSnapshot } from './workbook-snapshot.ts'

const VALID = { id: 'unit-1', sheetOrder: ['sheet-1'], sheets: { 'sheet-1': { id: 'sheet-1' } }, resources: [] }

function failureOf(text: string): unknown {
  try {
    parseWorkbookSnapshot(text)
    return null
  }
  catch (error) {
    return error
  }
}

describe('载入前核对快照的基本结构', () => {
  it('取出 unitId，交给 SDK 的对象每次都是新解析的', () => {
    const text = JSON.stringify(VALID)
    const first = parseWorkbookSnapshot(text)
    const second = parseWorkbookSnapshot(text)
    expect(first.unitId).toBe('unit-1')
    expect(first.data).toEqual(VALID)
    expect(first.data).not.toBe(second.data)
  })

  it.each([
    ['不是 JSON', '{'],
    ['顶层是数组', '[]'],
    ['顶层是 null', 'null'],
    ['顶层是字符串', '"x"'],
    ['没有 id', JSON.stringify({ ...VALID, id: undefined })],
    ['id 是空字符串', JSON.stringify({ ...VALID, id: '' })],
    ['id 不是字符串', JSON.stringify({ ...VALID, id: 1 })],
    ['sheetOrder 不是数组', JSON.stringify({ ...VALID, sheetOrder: 'sheet-1' })],
    ['sheets 不是对象', JSON.stringify({ ...VALID, sheets: [] })],
    ['没有 sheets', JSON.stringify({ ...VALID, sheets: undefined })],
  ])('%s：按 snapshot-invalid 失败', (_, text) => {
    const error = failureOf(text)
    expect(error).toBeInstanceOf(SheetEditorLoadError)
    expect((error as SheetEditorLoadError).reason).toBe('snapshot-invalid')
  })

  it('解析失败时保留原来的错误', () => {
    expect((failureOf('{') as Error).cause).toBeInstanceOf(SyntaxError)
  })
})
