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

  it('登录了的请求另带认证出的用户（userId，M3-P6：请求编辑的两条路按它分开两个人）；不是字符串时没有', () => {
    const since = Date.parse('2026-10-07T01:00:00.000Z')
    const text = [
      line({ time: '2026-10-07T01:00:12.000Z', method: 'PUT', route: '/api/documents/:id/edit-lease/request', path: `/api/documents/${DOC}/edit-lease/request`, statusCode: 200, durationMs: 4, userId: 'user-1', msg: '请求完成' }),
      line({ time: '2026-10-07T01:00:13.000Z', method: 'PUT', route: '/api/documents/:id/edit-lease', path: `/api/documents/${DOC}/edit-lease`, statusCode: 200, durationMs: 4, userId: 42, msg: '请求完成' }),
    ].join('\n')
    expect(parseServerRequests(text, DOC, since).map(request => request.userId)).toEqual(['user-1', undefined])
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

  it('answered：A 存上之后不释放（审查 B4），B 的新一代记着本人接管，那期间后端没有释放', () => {
    const states = [...BEFORE, state(9_100, { revision: 4, epoch: 2, takeover: 'self' })]
    expect(takeoverJudgement({ taker: report('takeover-taker', 'answered'), holder: report('takeover-holder', 'handed-over'), states, requests: [acquire(50), acquire(9_090)], openedTakerAt: 1_000 }).problems).toEqual([])
  })

  it('不一致的都说出来：A 的路与 B 的对不上、接管方式与路对不上、释放与路对不上、没有新一代、B 没交回', () => {
    const silentButReleased = [...BEFORE, state(9_000, { revision: 3, epoch: 1, endReason: 'released' }), state(9_100, { revision: 3, epoch: 2, takeover: 'self' })]
    expect(takeoverJudgement({ taker: report('takeover-taker', 'silent'), holder: report('takeover-holder', 'handed-over'), states: silentButReleased, requests: [release(9_000), acquire(9_100)], openedTakerAt: 1_000 }).problems).toEqual([
      'A 交回的路是 handed-over（B 走的是 silent，A 应当是 lost）',
      'B 没有回应就接手：新一代应当记着本人接管、A 那一代不释放；库里新一代的接管方式是 self，A 那一代明确结束了（released），另开 B 之后、B 取得之前的释放 1 个',
    ])
    // 审查 B4 之前的做法：A 先释放、B 再普通申请
    const answeredButReleased = [...BEFORE, state(9_100, { revision: 4, epoch: 2 })]
    expect(takeoverJudgement({ taker: report('takeover-taker', 'answered'), holder: undefined, states: answeredButReleased, requests: [release(9_080), acquire(9_100)], openedTakerAt: 1_000 }).problems).toEqual([
      'A 先保存再交出、B 等它做完再接手（审查 B4）：新一代应当记着本人接管、A 那一代不释放；库里新一代的接管方式是 空，A 那一代没有明确结束，另开 B 之后、B 取得之前的释放 1 个',
    ])
    expect(takeoverJudgement({ taker: undefined, holder: undefined, states: BEFORE, requests: [], openedTakerAt: 1_000 }).problems).toEqual(['另开的 B 没有交回结果', '库里没有看到 A 那一代（第 1 代）之后的新一代'])
    expect(takeoverJudgement({ taker: undefined, holder: undefined, states: [state(0)], requests: [], openedTakerAt: undefined }).problems).toEqual(['另开的 B 没有交回结果', '库里没有看到 A 那一代的编辑租约'])
  })
})

describe('刷新在途保存：原实例自动核对后回阅读（refreshJudgement）', () => {
  const instance = 'original-instance'
  // 100ms 采样可能一次看到新代次及其释放；顺序必须依据真实请求，不能把采样时刻当申请时刻。
  const STATES: readonly DocumentState[] = [state(0), state(200, { epoch: 1, clientInstanceId: instance }), state(15_100, { revision: 2, epoch: 2, clientInstanceId: instance, endReason: 'released' })]
  const SAVE: ServerRequest = { time: 2_600, method: 'PUT', route: '/api/documents/:id/content', statusCode: undefined, aborted: true, durationMs: 1_600 }
  const ACQUIRE: ServerRequest = { time: 15_000, method: 'POST', route: '/api/documents/:id/edit-lease', statusCode: 201, aborted: false, durationMs: 20 }
  const REPLAY: ServerRequest = { time: 15_040, method: 'PUT', route: '/api/documents/:id/content', statusCode: 200, aborted: false, durationMs: 20 }
  const RELEASE: ServerRequest = { time: 15_080, method: 'DELETE', route: '/api/documents/:id/edit-lease', statusCode: 204, aborted: false, durationMs: 10 }
  const baseline = { report: report('refresh-save', 'confirmed-reading'), states: STATES, requests: [SAVE, ACQUIRE, REPLAY, RELEASE], blockedAt: 1_000, finishedAt: 13_000 }

  it('原实例普通申请，精确回执确认后释放并阅读；采样没看到新代次活跃时刻也通过', () => {
    const judgement = refreshJudgement(baseline)
    expect(judgement.problems).toEqual([])
    expect(judgement.evidence).toContain('confirmed-reading')
    expect(judgement.evidence).toContain('中断')
  })

  it.each(['committed', 'expired', undefined])('旧手动路径 %s 不再充当自动恢复证据', (path) => {
    expect(refreshJudgement({ ...baseline, report: report('refresh-save', path) }).problems).toContain('页面没有证明原实例自动核对后回到阅读')
  })

  it('另一个实例或 self 接管都不能充当原实例普通申请', () => {
    for (const changes of [{ clientInstanceId: 'someone-else' }, { takeover: 'self' as const }]) {
      const states = STATES.map(row => row.epoch === 2 ? { ...row, ...changes } : row)
      expect(refreshJudgement({ ...baseline, states }).problems).toContain('新一代没有以原 clientInstanceId 普通申请')
    }
  })

  it('离开时释放旧代次、确认前提前释放都不通过；采用请求开始时刻而非结束或数据库采样时刻', () => {
    const states = [STATES[0]!, STATES[1]!, state(2_700, { epoch: 1, endReason: 'released', clientInstanceId: instance }), STATES[2]!]
    expect(refreshJudgement({ ...baseline, states }).problems).toContain('刷新之前那一代明确结束：页面关闭时不应释放')
    const early = { ...RELEASE, time: 15_090, durationMs: 100 }
    expect(refreshJudgement({ ...baseline, requests: [SAVE, ACQUIRE, REPLAY, early] }).problems).toContain('服务端收到过早释放：原实例申请与旧回执确认尚未完成')
  })

  it('没有真实申请、确认回执，或者租约/修订号证据缺失都不通过', () => {
    expect(refreshJudgement({ ...baseline, requests: [SAVE, REPLAY, RELEASE] }).problems).toContain('服务端没有确认刷新后的普通申请')
    expect(refreshJudgement({ ...baseline, requests: [SAVE, ACQUIRE, RELEASE] }).problems).toContain('普通申请之后没有成功核对旧保存回执')
    expect(refreshJudgement({ ...baseline, states: STATES.slice(0, 2) }).problems).toContain('库里没有看到刷新后的新一代')
    expect(refreshJudgement({ ...baseline, states: STATES.map(row => ({ ...row, revision: 1 })) }).problems).toContain('云端修订号没有恰好前进一次')
    expect(refreshJudgement({ ...baseline, states: STATES.map(row => row.epoch === 2 ? { ...row, revision: 3 } : row) }).problems).toContain('云端修订号没有恰好前进一次')
  })

  it('保存没停住、没交回结果都会说明缺失', () => {
    const problems = refreshJudgement({ ...baseline, report: undefined, blockedAt: undefined }).problems
    expect(problems).toContain('保存没有停在服务端（没有看到它在改写内容行时停着）')
    expect(problems).toContain('刷新之后的那一次没有交回结果')
  })
})
