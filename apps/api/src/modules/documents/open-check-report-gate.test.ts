import type { OpenCheckFailure } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { normalizedFailures, OPEN_CHECK_REPORT_WINDOW_MS, OPEN_CHECK_REPORTS_PER_ACCOUNT, OpenCheckReportGate, openCheckReportKey } from './open-check-report-gate.ts'

/** 假的单调时钟：用例拨动它 */
function clock(): { readonly now: () => number, readonly advance: (ms: number) => void } {
  let current = 1_000
  return {
    now: () => current,
    advance: (ms) => {
      current += ms
    },
  }
}

const PARSE: OpenCheckFailure = { kind: 'parse-threw', resource: 'SHEET_FILTER_PLUGIN', error: 'SyntaxError' }
const EMPTIED: OpenCheckFailure = { kind: 'resource-emptied', resource: 'SHEET_FILTER_PLUGIN' }

describe('失败清单的规范形式与去重键', () => {
  it('去掉完全相同的、排好序；构造器名不同的不算相同', () => {
    expect(normalizedFailures([EMPTIED, PARSE, { ...EMPTIED }, { kind: 'parse-threw', resource: 'SHEET_FILTER_PLUGIN' }])).toEqual([
      { kind: 'parse-threw', resource: 'SHEET_FILTER_PLUGIN' },
      PARSE,
      EMPTIED,
    ])
  })

  it('同一组失败（先后、重复都不算）的键相同；文档、修订号、构建、失败任何一项不同，键就不同', () => {
    const key = openCheckReportKey('d1', 3, '0.1.0', [PARSE, EMPTIED])
    expect(openCheckReportKey('d1', 3, '0.1.0', [EMPTIED, PARSE, PARSE])).toBe(key)
    for (const other of [
      openCheckReportKey('d2', 3, '0.1.0', [PARSE, EMPTIED]),
      openCheckReportKey('d1', 4, '0.1.0', [PARSE, EMPTIED]),
      openCheckReportKey('d1', 3, '0.1.1', [PARSE, EMPTIED]),
      openCheckReportKey('d1', 3, '0.1.0', [PARSE]),
      openCheckReportKey('d1', 3, '0.1.0', [{ ...PARSE, error: 'TypeError' }, EMPTIED]),
    ])
      expect(other).not.toBe(key)
  })

  it('各段里的字符串不会串到别的段（JSON 数组）', () => {
    expect(openCheckReportKey('a|1', 2, 'b', [PARSE])).not.toBe(openCheckReportKey('a', 12, 'b', [PARSE]))
  })
})

describe('进程内的去重与按账户限量（M3-P4 设计 §3.13）', () => {
  it('同一个键在窗口之内只采纳第一次（谁报的都一样）；过了窗口再采纳', () => {
    const time = clock()
    const gate = new OpenCheckReportGate({ now: time.now })
    expect(gate.decide('amy', 'k')).toBe('accept')
    expect(gate.decide('amy', 'k')).toBe('duplicate')
    expect(gate.decide('bob', 'k')).toBe('duplicate')
    time.advance(OPEN_CHECK_REPORT_WINDOW_MS - 1)
    expect(gate.decide('amy', 'k')).toBe('duplicate')
    time.advance(1)
    expect(gate.decide('amy', 'k')).toBe('accept')
  })

  it(`每个账户每个窗口至多采纳 ${OPEN_CHECK_REPORTS_PER_ACCOUNT} 条：第一次超出记一条（throttled-first），之后不记；别的账户不受影响；下一个窗口重来`, () => {
    const time = clock()
    const gate = new OpenCheckReportGate({ now: time.now })
    for (let index = 0; index < OPEN_CHECK_REPORTS_PER_ACCOUNT; index += 1)
      expect(gate.decide('amy', `k${index}`)).toBe('accept')
    expect(gate.decide('amy', 'over-1')).toBe('throttled-first')
    expect(gate.decide('amy', 'over-2')).toBe('throttled')
    expect(gate.decide('bob', 'over-1')).toBe('accept')
    // 超出时没有记下键：窗口过了之后同样的上报照常采纳
    time.advance(OPEN_CHECK_REPORT_WINDOW_MS)
    expect(gate.decide('amy', 'over-1')).toBe('accept')
    for (let index = 1; index < OPEN_CHECK_REPORTS_PER_ACCOUNT; index += 1)
      expect(gate.decide('amy', `next${index}`)).toBe('accept')
    expect(gate.decide('amy', 'over-3')).toBe('throttled-first')
  })

  it('去重挡下的不计入限量', () => {
    const gate = new OpenCheckReportGate({ now: clock().now, perAccount: 2 })
    expect(gate.decide('amy', 'a')).toBe('accept')
    for (let index = 0; index < 10; index += 1)
      expect(gate.decide('amy', 'a')).toBe('duplicate')
    expect(gate.decide('amy', 'b')).toBe('accept')
    expect(gate.decide('amy', 'c')).toBe('throttled-first')
  })

  it('账户的窗口从它第一次被采纳算起（固定窗口），不随之后的上报顺延', () => {
    const time = clock()
    const gate = new OpenCheckReportGate({ now: time.now, perAccount: 1 })
    expect(gate.decide('amy', 'a')).toBe('accept')
    time.advance(OPEN_CHECK_REPORT_WINDOW_MS / 2)
    expect(gate.decide('amy', 'b')).toBe('throttled-first')
    time.advance(OPEN_CHECK_REPORT_WINDOW_MS / 2)
    expect(gate.decide('amy', 'b')).toBe('accept')
  })

  it('内存有界：过期的键与账户随之清掉；超出上限时丢最旧的', () => {
    const time = clock()
    const gate = new OpenCheckReportGate({ now: time.now, maxKeys: 3, perAccount: 100 })
    for (const key of ['a', 'b', 'c', 'd'])
      gate.decide(`user-${key}`, key)
    expect(gate.sizes()).toEqual({ keys: 3, accounts: 3 })
    // 最旧的 a 被丢掉：同样的上报再来就是新的
    expect(gate.decide('user-a', 'a')).toBe('accept')
    expect(gate.decide('user-d', 'd')).toBe('duplicate')
    time.advance(OPEN_CHECK_REPORT_WINDOW_MS)
    gate.decide('user-e', 'e')
    expect(gate.sizes()).toEqual({ keys: 1, accounts: 1 })
  })

  it('默认用进程的单调时钟：不传时钟也能用', () => {
    const gate = new OpenCheckReportGate()
    expect(gate.decide('amy', 'k')).toBe('accept')
    expect(gate.decide('amy', 'k')).toBe('duplicate')
  })
})
