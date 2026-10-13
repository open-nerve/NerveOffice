import { describe, expect, it } from 'vitest'
import { crashCellValue, crashControlFrom } from './selftest-crash.ts'

const RUN = '1f1f40c3-1579-4657-9902-9f1f804fdde1'
const ORIGIN = 'http://127.0.0.1:40123'
const endpoint = `${ORIGIN}/__nerve-crash/${RUN}`
const page = (next: string) => `${ORIGIN}/documents/doc?selftest=crash-recovery&next=${encodeURIComponent(next)}`

describe('崩溃自检的同源控制入口', () => {
  it('只接受本页来源、固定路径与运行 UUID，不使用产品恢复身份', () => {
    expect(crashControlFrom(page(endpoint))).toEqual({ endpoint, runId: RUN })
  })

  it.each([
    `http://127.0.0.1:40124/__nerve-crash/${RUN}`,
    `https://example.com/__nerve-crash/${RUN}`,
    `${ORIGIN}/api/auth/session`,
    `${endpoint}?token=unexpected`,
    `${endpoint}#unexpected`,
    `${ORIGIN}/__nerve-crash/not-a-uuid`,
    `http://user:password@127.0.0.1:40123/__nerve-crash/${RUN}`,
  ])('拒绝非专用入口 %s', (next) => {
    expect(crashControlFrom(page(next))).toBeUndefined()
  })
})

describe('真实恢复正文的独立取值', () => {
  it('按 sheetOrder 取首张表的 A1，兼容保存的信封', () => {
    const workbook = { sheetOrder: ['primary', 'other'], sheets: { primary: { cellData: { 0: { 0: { v: '恢复的正文' } } } }, other: { cellData: { 0: { 0: { v: '错误的表' } } } } } }
    expect(crashCellValue(JSON.stringify(workbook))).toBe('恢复的正文')
    expect(crashCellValue(JSON.stringify({ snapshot: workbook }))).toBe('恢复的正文')
  })

  it.each(['{}', 'null', '[]', '{"sheets":{"other":{"cellData":{"0":{"0":{"v":"不应猜表"}}}}}}'])('缺少文档或顺序时不猜正文：%s', (text) => {
    expect(crashCellValue(text)).toBeUndefined()
  })
})
