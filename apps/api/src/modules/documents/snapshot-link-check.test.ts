import type { SnapshotRule } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { inspectSnapshot } from './snapshot-inspection.ts'

function linkedCell(url = 'https://example.invalid', rangeId = 'link1') {
  return { p: { body: { dataStream: 'private text\r\n', customRanges: [{ rangeType: 0, rangeId, properties: { url } }] } } }
}

function inspect(sheets: Record<string, unknown>, sheetOrder = Object.keys(sheets)) {
  return inspectSnapshot(new TextEncoder().encode(JSON.stringify({ id: 'wb', sheetOrder, sheets, resources: [] })), 'sheet@1')
}

describe('真实工作簿路径中的链接拒绝位置', () => {
  const cases: readonly [SnapshotRule, unknown][] = [
    ['link-address', linkedCell()],
    ['link-range-id', linkedCell('https://example.invalid/', 'bad id')],
    ['link-structure', { p: { body: { customRanges: 'private text' } } }],
  ]
  it.each(cases)('%s 说明 B3，且不回显正文或地址', (rule, cell) => {
    const result = inspect({ budget: { cellData: { 2: { 1: cell } } } })
    expect(result).toEqual({ ok: false, rule, linkLocations: [{ kind: 'cell', sheetId: 'budget', row: 2, column: 1 }] })
    expect(JSON.stringify(result)).not.toMatch(/private|example|url|dataStream/)
  })

  it('隐藏表、未在 sheetOrder 中的表和数组行列都按原语义检查', () => {
    const result = inspect({
      visible: { cellData: {} },
      hidden: { hidden: 1, cellData: [[null, linkedCell()]] },
    }, ['visible'])
    expect(result).toEqual({ ok: false, rule: 'link-address', linkLocations: [{ kind: 'cell', sheetId: 'hidden', row: 0, column: 1 }] })
  })

  it('首个失败保持不变，只收同规则的位置，同格多个链接不重复', () => {
    const first = linkedCell()
    first.p.body.customRanges.push({ ...first.p.body.customRanges[0]!, rangeId: 'link2' })
    expect(inspect({ s: { cellData: { 0: { 0: first, 1: cases[2]![1], 2: linkedCell() } } } })).toEqual({
      ok: false,
      rule: 'link-address',
      linkLocations: [{ kind: 'cell', sheetId: 's', row: 0, column: 0 }, { kind: 'cell', sheetId: 's', row: 0, column: 2 }],
    })
  })

  it('最多五个不同位置，不扩大原快照接受范围', () => {
    expect(inspect({ s: { cellData: [Array.from({ length: 8 }, () => linkedCell())] } })).toEqual({
      ok: false,
      rule: 'link-address',
      linkLocations: Array.from({ length: 5 }, (_, column) => ({ kind: 'cell', sheetId: 's', row: 0, column })),
    })
  })

  it.each(['-1', '02', '2147483648', 'private/path'])('行或列键 %s 不能直接作为坐标，降为工作表且去重', (key) => {
    expect(inspect({ s: { cellData: { [key]: { 0: linkedCell() }, 0: { [key]: linkedCell() } } } })).toEqual({
      ok: false,
      rule: 'link-address',
      linkLocations: [{ kind: 'sheet', sheetId: 's' }],
    })
  })

  it.each(['__proto__', 'constructor', 'prototype', 'private/path', 's'.repeat(129)])('不合法的表身份降为工作簿：%s', (sheetId) => {
    expect(inspect(Object.fromEntries([[sheetId, { cellData: [[linkedCell()]] }]]))).toEqual({
      ok: false,
      rule: 'link-address',
      linkLocations: [{ kind: 'workbook' }],
    })
  })

  it('合法链接保持接受；嵌套伪造的 sheets/cellData 不是链接扫描入口', () => {
    expect(inspect({ s: { cellData: [[linkedCell('https://example.invalid/')]], extra: { cellData: [[linkedCell()]] } } })).toMatchObject({ ok: true, unitId: 'wb' })
  })

  it('其他错误优先级保持：图片先于链接', () => {
    const cell = { ...linkedCell(), extra: { source: 'https://example.invalid/private.png' } }
    expect(inspect({ s: { cellData: [[cell]] } })).toEqual({
      ok: false,
      rule: 'image-source',
      imageLocations: [{ kind: 'cell', sheetId: 's', row: 0, column: 0 }],
    })
  })
})
