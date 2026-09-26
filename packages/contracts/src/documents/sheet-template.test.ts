import { describe, expect, it } from 'vitest'
import { UNIVER_SDK_VERSION } from './content.ts'
import { SHEET_TEMPLATE, SHEET_TEMPLATE_UNIT_ID, sheetSnapshotFor } from './sheet-template.ts'

const TEMPLATE_JSON = JSON.stringify(SHEET_TEMPLATE)

describe('表格的模板快照', () => {
  it('JSON 往返逐字节不变：服务端解析、换 id、再序列化，不会改动别的字节', () => {
    expect(JSON.stringify(JSON.parse(TEMPLATE_JSON))).toBe(TEMPLATE_JSON)
  })

  it('实例化只换顶层的 id，键的顺序不变', () => {
    const unitId = '0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0d'
    const snapshot = sheetSnapshotFor(unitId)
    expect(snapshot).toBe(TEMPLATE_JSON.replace(`{"id":"${SHEET_TEMPLATE_UNIT_ID}",`, `{"id":"${unitId}",`))
    expect(snapshot.startsWith(`{"id":"${unitId}","sheetOrder":`)).toBe(true)
    expect(Object.keys(JSON.parse(snapshot) as object)).toEqual(Object.keys(SHEET_TEMPLATE))
  })

  it('是基本校验能接受的工作簿：sheetOrder 与 sheets 一一对应', () => {
    expect(SHEET_TEMPLATE.sheetOrder).toEqual(Object.keys(SHEET_TEMPLATE.sheets))
    for (const [id, sheet] of Object.entries(SHEET_TEMPLATE.sheets))
      expect(sheet.id).toBe(id)
  })

  it('由平台内置的 SDK 版本保存得到（appVersion 由 SDK 写出）', () => {
    expect(SHEET_TEMPLATE.appVersion).toBe(UNIVER_SDK_VERSION)
  })
})
