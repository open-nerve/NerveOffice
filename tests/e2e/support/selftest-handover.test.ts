// 交接的页面自检的编排（selftest-handover.ts）里的纯函数：后端日志里这份文档的请求、两个标签页的本人接管与刷新时在途的保存的判定。
import type { SelftestReport } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import type { DocumentState, ServerRequest } from './selftest-handover.ts'
import { describe, expect, it } from 'vitest'
import { SELFTEST_REPORT_FORMAT } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import { parseServerRequests, refreshJudgement, takeoverJudgement } from './selftest-handover.ts'

const DOC = '01a11504-fe69-7a50-9711-eddc1c100604'

function report(scenario: string, path: string | undefined): SelftestReport {
  return {
    format: SELFTEST_REPORT_FORMAT,
    scenario,
    documentId: DOC,
    userAgent: 'Safari',
    startedAt: '2026-10-07T01:00:00.000Z',
    finishedAt: '2026-10-07T01:00:30.000Z',
    page: { state: 'ready', readOnly: true },
    visibility: [],
    checks: [{ id: 'x', pass: true, detail: '', ms: 1 }],
    pageErrors: [],
    consoleErrors: [],
    ignoredNotices: [],
    path,
  }
}

/** 库里的一个样子：at 是毫秒数（相对 0） */
function state(at: number, fields: Partial<DocumentState> = {}): DocumentState {
  return { at, revision: 1, epoch: null, endReason: null, takeover: null, clientInstanceId: null, ...fields }
}

function line(fields: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ level: 'info', time: '2026-10-07T01:00:10.000Z', pid: 1, ...fields })
}

describe('后端日志里这份文档的请求（parseServerRequests）', () => {
  it('只要路径里有这份文档、在时间范围里的请求；完成的带状态码，中断的记 aborted；按记下的时刻排好；不是 JSON 的行跳过', () => {
    const since = Date.parse('2026-10-07T01:00:00.000Z')
    const text = [
      line({ time: '2026-10-07T01:00:12.000Z', method: 'POST', route: '/api/documents/:id/edit-lease', path: `/api/documents/${DOC}/edit-lease`, statusCode: 201, durationMs: 19, msg: '请求完成' }),
      line({ time: '2026-10-07T01:00:11.500Z', method: 'PUT', route: '/api/documents/:id/content', path: `/api/documents/${DOC}/content`, aborted: true, durationMs: 1700, msg: '请求中断' }),
      line({ time: '2026-10-07T01:00:11.000Z', method: 'GET', route: '/api/documents/:id', path: '/api/documents/other/content', statusCode: 200, msg: '请求完成' }),
      line({ time: '2026-10-06T23:00:00.000Z', method: 'GET', route: '/api/documents/:id', path: `/api/documents/${DOC}`, statusCode: 200, msg: '请求完成' }),
      `不是 JSON ${DOC}`,
      line({ msg: `别的日志 ${DOC}` }),
    ].join('\n')
    expect(parseServerRequests(text, DOC, since)).toEqual([
      { time: Date.parse('2026-10-07T01:00:11.500Z'), method: 'PUT', route: '/api/documents/:id/content', statusCode: undefined, aborted: true, durationMs: 1700 },
      { time: Date.parse('2026-10-07T01:00:12.000Z'), method: 'POST', route: '/api/documents/:id/edit-lease', statusCode: 201, aborted: false, durationMs: 19 },
    ])
    expect(parseServerRequests(text, DOC, since, Date.parse('2026-10-07T01:00:11.900Z'))).toHaveLength(1)
  })
})

describe('两个标签页的本人接管（takeoverJudgement）', () => {
  /** A 第 1 代（另开 B 之前取得）、修订号 1 → 2 → 3 */
  const BEFORE: readonly DocumentState[] = [state(0), state(100, { epoch: 1 }), state(300, { revision: 2, epoch: 1 }), state(1_200, { revision: 3, epoch: 1 })]
  const acquire = (time: number): ServerRequest => ({ time, method: 'POST', route: '/api/documents/:id/edit-lease', statusCode: 201, aborted: false, durationMs: 20 })
  const release = (time: number): ServerRequest => ({ time, method: 'DELETE', route: '/api/documents/:id/edit-lease', statusCode: 204, aborted: false, durationMs: 5 })

  it('silent：A 那一代没有明确结束、期间没有释放，B 的新一代记着本人接管；A 交回 lost（或者没交回）都没有问题；B 交回结果时的释放不算', () => {
    const states = [...BEFORE, state(12_000, { revision: 3, epoch: 2, takeover: 'self' }), state(20_000, { revision: 3, epoch: 2, takeover: 'self', endReason: 'released' })]
    const requests = [acquire(50), acquire(12_000), release(20_000)]
    const judgement = takeoverJudgement({ taker: report('takeover-taker', 'silent'), holder: report('takeover-holder', 'lost'), states, requests, openedTakerAt: 1_000 })
    expect(judgement.problems).toEqual([])
    expect(judgement.evidence).toBe('B 走的路 silent、A 交回的路 lost；库里（相对另开 B）：A 第 1 代；+11000 ms 第 2 代，接管方式 self；后端：这期间没有释放，B 取得 +11000 ms；修订号 1（开始时） → 2（-700 ms） → 3（+200 ms）')
    expect(takeoverJudgement({ taker: report('takeover-taker', 'silent'), holder: undefined, states, requests, openedTakerAt: 1_000 }).problems).toEqual([])
  })

  it('answered：B 的新一代是普通申请，后端日志里 B 取得之前有 A 的释放（库里不一定看得到"已释放"的那一刻）', () => {
    const states = [...BEFORE, state(9_100, { revision: 4, epoch: 2 })]
    expect(takeoverJudgement({ taker: report('takeover-taker', 'answered'), holder: report('takeover-holder', 'handed-over'), states, requests: [acquire(50), release(9_080), acquire(9_090)], openedTakerAt: 1_000 }).problems).toEqual([])
  })

  it('不一致的都说出来：A 的路与 B 的对不上、接管方式与路对不上、释放与路对不上、没有新一代、B 没交回', () => {
    const silentButReleased = [...BEFORE, state(9_000, { revision: 3, epoch: 1, endReason: 'released' }), state(9_100, { revision: 3, epoch: 2, takeover: 'self' })]
    expect(takeoverJudgement({ taker: report('takeover-taker', 'silent'), holder: report('takeover-holder', 'handed-over'), states: silentButReleased, requests: [release(9_000), acquire(9_100)], openedTakerAt: 1_000 }).problems).toEqual([
      'A 交回的路是 handed-over（B 走的是 silent，A 应当是 lost）',
      'B 没有回应就接手：新一代应当记着本人接管、A 那一代不释放；库里新一代的接管方式是 self，A 那一代明确结束了（released），另开 B 之后、B 取得之前的释放 1 个',
    ])
    const answeredButSelf = [...BEFORE, state(9_100, { revision: 4, epoch: 2, takeover: 'self' })]
    expect(takeoverJudgement({ taker: report('takeover-taker', 'answered'), holder: undefined, states: answeredButSelf, requests: [acquire(9_100)], openedTakerAt: 1_000 }).problems).toEqual([
      'A 交出之后 B 普通申请：A 那一代应当先释放、新一代不记接管；库里新一代的接管方式是 self，另开 B 之后、B 取得之前的释放 0 个',
    ])
    expect(takeoverJudgement({ taker: undefined, holder: undefined, states: BEFORE, requests: [], openedTakerAt: 1_000 }).problems).toEqual(['另开的 B 没有交回结果', '库里没有看到 A 那一代（第 1 代）之后的新一代'])
    expect(takeoverJudgement({ taker: undefined, holder: undefined, states: [state(0)], requests: [], openedTakerAt: undefined }).problems).toEqual(['另开的 B 没有交回结果', '库里没有看到 A 那一代的编辑租约'])
  })
})

describe('刷新时在途的保存（refreshJudgement）', () => {
  /** 刷新之前第 1 代；保存在 1000 停在服务端，13000 停完、13050 修订号前进，15000 本人接管第 2 代 */
  const STATES: readonly DocumentState[] = [state(0), state(200, { epoch: 1 }), state(13_050, { revision: 2, epoch: 1 }), state(15_000, { revision: 2, epoch: 2, takeover: 'self' }), state(20_000, { revision: 2, epoch: 2, takeover: 'self', endReason: 'released' })]
  const SAVE: ServerRequest = { time: 2_600, method: 'PUT', route: '/api/documents/:id/content', statusCode: undefined, aborted: true, durationMs: 1_600 }
  const TAKE: ServerRequest = { time: 15_000, method: 'POST', route: '/api/documents/:id/edit-lease', statusCode: 201, aborted: false, durationMs: 20 }
  const LATER_RELEASE: ServerRequest = { time: 20_000, method: 'DELETE', route: '/api/documents/:id/edit-lease', statusCode: 204, aborted: false, durationMs: 5 }

  it('committed、刷新之前那一代没有明确结束、新一代本人接管、接手之前没有释放（接手之后交回结果时的释放不算）：没有问题；证据说那次保存的请求在服务端中断', () => {
    const judgement = refreshJudgement({ report: report('refresh-save', 'committed'), states: STATES, requests: [SAVE, TAKE, LATER_RELEASE], blockedAt: 1_000, finishedAt: 13_000 })
    expect(judgement.problems).toEqual([])
    expect(judgement.evidence).toBe('（相对保存停在服务端）保存停在服务端，+12000 ms 停完；保存的请求在服务端：PUT /api/documents/:id/content 中断（结束于 +1600 ms，用时 1600 ms）；修订号 1（开始时） → 2（+12050 ms）；第 1 代没有明确结束；+14000 ms 第 2 代，接管方式 self；接手之前的释放 0 个；页面交回的路 committed')
  })

  it('保存没停住、没交回、等满了 30 秒、刷新之前那一代被释放、接手之前收到释放、新一代不是本人接管、修订号没在接手之前前进、没有新一代：都算问题', () => {
    expect(refreshJudgement({ report: undefined, states: STATES, requests: [], blockedAt: undefined, finishedAt: 0 }).problems).toEqual(['保存没有停在服务端（没有看到它在改写内容行时停着）', '刷新之后的那一次没有交回结果'])
    expect(refreshJudgement({ report: report('refresh-save', 'expired'), states: STATES, requests: [], blockedAt: 1_000, finishedAt: 13_000 }).problems).toEqual(['页面等满了 30 秒才接手：停在服务端的那次保存没有提交？'])
    const released = [state(0), state(200, { epoch: 1 }), state(2_700, { epoch: 1, endReason: 'released' }), state(15_000, { revision: 2, epoch: 2 })]
    const early: ServerRequest = { ...LATER_RELEASE, time: 2_650 }
    expect(refreshJudgement({ report: report('refresh-save', 'committed'), states: released, requests: [SAVE, early], blockedAt: 1_000, finishedAt: 13_000 }).problems).toEqual([
      '刷新之前那一代（第 1 代）明确结束了（released，+1700 ms）：页面关闭时不应释放',
      '接手之前服务端收到了释放：DELETE /api/documents/:id/edit-lease 204（结束于 +1650 ms，用时 5 ms）',
    ])
    expect(refreshJudgement({ report: report('refresh-save', 'committed'), states: [state(0), state(200, { epoch: 1 }), state(15_000, { epoch: 2 })], requests: [], blockedAt: 1_000, finishedAt: 13_000 }).problems).toEqual([
      '新一代的接管方式是 空（应当是本人接管：接手时刷新之前那一代还有效）',
      '页面说那次保存提交了才接手，库里修订号却没有前进',
    ])
    expect(refreshJudgement({ report: report('refresh-save', 'committed'), states: [state(0), state(200, { epoch: 1 }), state(15_000, { epoch: 2, takeover: 'self' }), state(16_000, { revision: 2, epoch: 2, takeover: 'self' })], requests: [], blockedAt: 1_000, finishedAt: 13_000 }).problems).toEqual(['页面说那次保存提交了才接手，库里修订号却在接手之后（+15000 ms）才前进'])
    expect(refreshJudgement({ report: report('refresh-save', 'committed'), states: [state(0), state(200, { epoch: 1 })], requests: [], blockedAt: 1_000, finishedAt: 13_000 }).problems).toEqual(['库里没有看到第 1 代之后的新一代（没有接手）'])
    expect(refreshJudgement({ report: report('refresh-save', 'committed'), states: [state(0)], requests: [], blockedAt: 1_000, finishedAt: 13_000 }).problems).toEqual(['库里没有看到刷新之前那一代的编辑租约'])
  })
})
