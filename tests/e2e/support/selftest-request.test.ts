// 请求编辑的两条路的编排（selftest-request.ts）里的判定（纯函数）：路 1 请求方在后台停在交给了我、回到前台才进入（waiterJudgement），路 2 持有者
// 被暂停时编辑权按时间到期、另一方接手（pausedHolderJudgement）。证据是库里的时间线、后端日志里这份文档的请求（按认证出的用户分开两个人）与协作者
// 自己的调用。时刻都写成相对 0 的毫秒数。有别的条件兜着的条件也各有一条只违反它的用例（审查 B13：每个条件单独有人看着）
import type { SelftestReport } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import type { DocumentState, ServerRequest } from './selftest-handover.ts'
import type { PausedHolderEvidence, PeerCall, WaiterEvidence } from './selftest-request.ts'
import { describe, expect, it } from 'vitest'
import { SELFTEST_REPORT_FORMAT } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import { GRANTED_HOLD_MIN_MS, HEARTBEAT_QUIET_MS, heartbeatQuiet, LEASE_TTL_MS, pausedHolderJudgement, SUSPENDED_GAP_MIN_MS, waiterJudgement } from './selftest-request.ts'

const AUTHOR = 'author-id'
const PEER = 'peer-id'

function report(scenario: string, path: string, longestGap: number | null = null): SelftestReport {
  return {
    format: SELFTEST_REPORT_FORMAT,
    scenario,
    documentId: 'doc',
    userAgent: 'Safari',
    startedAt: '2026-10-08T01:00:00.000Z',
    finishedAt: '2026-10-08T01:03:00.000Z',
    page: { state: 'ready', readOnly: scenario === 'request-waiter' },
    visibility: [],
    checks: [{ id: 'x', pass: true, detail: '', ms: 1 }],
    pageErrors: [],
    consoleErrors: [],
    ignoredNotices: [],
    path,
    timings: [{ id: 'request.holder', ms: { longestGap } }],
  }
}

function state(at: number, fields: Partial<DocumentState> = {}): DocumentState {
  return { at, revision: 1, epoch: null, endReason: null, takeover: null, clientInstanceId: null, holderId: null, requestedBy: null, reservedFor: null, acquiredAt: null, renewedAt: null, ...fields }
}

function logged(time: number, method: string, route: string, statusCode: number | undefined, userId: string): ServerRequest {
  return { time, method, route: `/api/documents/:id${route}`, statusCode, aborted: statusCode === undefined, durationMs: 5, userId }
}

describe('路 1：请求方在后台停在交给了我，回到前台才进入（waiterJudgement）', () => {
  /** 协作者第 1 代（心跳）；请求方在 4 秒请求，5 秒隐藏，7 秒交出（handed_over、留给请求方）；8 秒请求方续期；21 秒回到前台，21.1 秒申请 201、第 2 代 */
  const STATES: readonly DocumentState[] = [
    state(0),
    state(100, { epoch: 1, holderId: PEER }),
    state(4_000, { epoch: 1, holderId: PEER, requestedBy: AUTHOR }),
    state(7_050, { epoch: 1, holderId: PEER, endReason: 'handed_over', reservedFor: AUTHOR }),
    state(21_200, { epoch: 2, holderId: AUTHOR }),
  ]
  const REQUESTS: readonly ServerRequest[] = [
    logged(2_000, 'PUT', '/edit-lease', 200, PEER),
    logged(4_000, 'POST', '/edit-lease/request', 200, AUTHOR),
    logged(4_990, 'PUT', '/edit-lease', 200, PEER),
    logged(6_000, 'PUT', '/edit-lease/request', 200, AUTHOR),
    logged(7_000, 'POST', '/edit-lease/handover', 200, PEER),
    logged(8_000, 'PUT', '/edit-lease/request', 200, AUTHOR),
    logged(21_100, 'POST', '/edit-lease', 201, AUTHOR),
  ]
  const MARKS = { requestSeenAt: 4_990, hiddenAt: 5_000, handedOverAt: 7_000, renewedAt: 8_000, shownAt: 21_000 }
  const evidence = (overrides: Partial<WaiterEvidence> = {}): WaiterEvidence => ({ report: report('request-waiter', 'entered-on-return'), states: STATES, requests: REQUESTS, holderId: PEER, waiterId: AUTHOR, marks: MARKS, ...overrides })

  it('按设计走完：交出写进库里、留给请求方；交出之后请求方续期一次、之后 13 秒没有申请；回到前台之后申请 201，新一代是请求方的普通申请', () => {
    const judgement = waiterJudgement(evidence())
    expect(judgement.problems).toEqual([])
    expect(judgement.evidence).toBe('（相对请求方隐藏）协作者第 1 代，心跳 2 次；心跳带来请求 -10 ms；交出 +2000 ms（库里 handed_over +2050 ms，留给请求方）；交出之后、回到前台之前请求方续期 1 次（第一次 +3000 ms）、申请 0 次；停在交给了我 13.0 秒；回到前台 +16000 ms，之后请求方申请 201 +16100 ms；第 2 代 +16200 ms，接管方式 空（普通申请）；页面交回的路 entered-on-return')
  })

  it('回到前台之前请求方就申请了（在后台抢编辑权）：说出申请的结果与时刻；新一代早于回到前台也算问题', () => {
    const requests = [...REQUESTS.slice(0, 6), logged(9_000, 'POST', '/edit-lease', 201, AUTHOR)]
    const states = [...STATES.slice(0, 4), state(9_100, { epoch: 2, holderId: AUTHOR })]
    expect(waiterJudgement(evidence({ requests, states })).problems).toEqual([
      '回到前台之前请求方申请了编辑权 1 次（201，+4000 ms）：应当停在交给了我',
      '回到前台之后请求方没有取得编辑权（没有申请）',
      `库里的新一代：持有者是请求方、接管方式 空、+4100 ms（应当是请求方的普通申请，在回到前台之后）`,
    ])
  })

  it('交出之后请求方没有续期、停的时间不够、新一代带着接管方式：各自说明', () => {
    expect(waiterJudgement(evidence({ requests: REQUESTS.filter(request => request.time !== 8_000) })).problems).toEqual(['交出之后、回到前台之前请求方没有续期（它没能得知交给了它）'])
    const short = { ...MARKS, shownAt: 8_000 + GRANTED_HOLD_MIN_MS - 1_000 }
    const requests = [...REQUESTS.slice(0, 6), logged(short.shownAt + 100, 'POST', '/edit-lease', 201, AUTHOR)]
    const states = [...STATES.slice(0, 4), state(short.shownAt + 200, { epoch: 2, holderId: AUTHOR })]
    expect(waiterJudgement(evidence({ marks: short, requests, states })).problems).toEqual([`请求方停在交给了我的时间只有 9.0 秒（不短于 ${GRANTED_HOLD_MIN_MS / 1000} 秒才说明得了它不申请）`])
    expect(waiterJudgement(evidence({ states: [...STATES.slice(0, 4), state(21_200, { epoch: 2, holderId: AUTHOR, takeover: 'self' })] })).problems).toEqual(['库里的新一代：持有者是请求方、接管方式 self、+16200 ms（应当是请求方的普通申请，在回到前台之后）'])
  })

  it('协作者没有交出、库里没有看到交出、请求方没有交回：各自说明', () => {
    expect(waiterJudgement(evidence({ marks: { ...MARKS, handedOverAt: undefined } })).problems).toEqual(['协作者没有交出（心跳没有带来请求，或者交出没有成功）'])
    expect(waiterJudgement(evidence({ states: STATES.filter(item => item.endReason === null) })).problems).toEqual(['库里没有看到交出：协作者那一代没有明确结束为 handed_over，没有留给请求方的保留'])
    expect(waiterJudgement(evidence({ report: undefined })).problems).toEqual(['请求方没有交回结果'])
  })

  it('只违反"回到前台之后的申请得到 201"：那一次被中断（后端日志里没有状态码）或 409 之后再申请才成，库里照样有请求方的新一代', () => {
    const aborted = REQUESTS.map(request => request.time === 21_100 ? logged(21_100, 'POST', '/edit-lease', undefined, AUTHOR) : request)
    expect(waiterJudgement(evidence({ requests: aborted })).problems).toEqual(['回到前台之后请求方没有取得编辑权（中断）'])
    const retried = [...REQUESTS.slice(0, 6), logged(21_100, 'POST', '/edit-lease', 409, AUTHOR), logged(21_150, 'POST', '/edit-lease', 201, AUTHOR)]
    expect(waiterJudgement(evidence({ requests: retried })).problems).toEqual(['回到前台之后请求方没有取得编辑权（409）'])
  })
})

describe('路 2：持有者的心跳停下没有（heartbeatQuiet：盖屏之后等它停下再请求）', () => {
  const TIMELINE: readonly DocumentState[] = [
    state(0),
    state(100, { epoch: 1, holderId: AUTHOR, renewedAt: 90 }),
    state(10_100, { epoch: 1, holderId: AUTHOR, renewedAt: 10_080 }),
    state(10_500, { revision: 2, epoch: 1, holderId: AUTHOR, renewedAt: 10_080 }),
    state(20_150, { revision: 2, epoch: 1, holderId: AUTHOR, renewedAt: 20_120 }),
  ]

  it('最后一次续租是看到它变化的那一刻算起：停了 HEARTBEAT_QUIET_MS 才算停下（修订号变了不算续租）', () => {
    expect(heartbeatQuiet(TIMELINE, 30_000, HEARTBEAT_QUIET_MS)).toEqual({ lastRenewedAt: 20_120, lastChangeSeenAt: 20_150, quiet: false })
    expect(heartbeatQuiet(TIMELINE, 20_150 + HEARTBEAT_QUIET_MS, HEARTBEAT_QUIET_MS)).toEqual({ lastRenewedAt: 20_120, lastChangeSeenAt: 20_150, quiet: true })
    expect(heartbeatQuiet(TIMELINE.slice(0, 4), 40_000, HEARTBEAT_QUIET_MS).lastChangeSeenAt).toBe(10_100)
  })

  it('那一代已经结束（交出、释放）或者换了一代：不算被暂停；还没有租约时也不算', () => {
    expect(heartbeatQuiet([...TIMELINE, state(21_000, { revision: 2, epoch: 1, holderId: AUTHOR, renewedAt: 20_120, endReason: 'handed_over' })], 80_000, HEARTBEAT_QUIET_MS).quiet).toBe(false)
    expect(heartbeatQuiet([...TIMELINE, state(21_000, { revision: 2, epoch: 2, holderId: PEER, renewedAt: 21_000 })], 80_000, HEARTBEAT_QUIET_MS).quiet).toBe(false)
    expect(heartbeatQuiet([state(0)], 80_000, HEARTBEAT_QUIET_MS)).toEqual({ lastRenewedAt: undefined, lastChangeSeenAt: undefined, quiet: false })
  })
})

describe('路 2：持有者被暂停时编辑权按时间到期（pausedHolderJudgement）', () => {
  /**
   * 0 盖屏；持有者第 1 代（-10 秒取得），盖屏之后心跳到 50 秒（Safari 约 50 秒后暂停）；协作者 1 秒请求、续期，145 秒得到 free、145.02 秒申请 201
   * （带持有者那一代异常中断的提醒）；147 秒移走盖屏，之后持有者续租 409、续上 409
   */
  const STATES: readonly DocumentState[] = [
    state(0, { epoch: 1, holderId: AUTHOR, acquiredAt: -10_000, renewedAt: 0 }),
    state(1_000, { epoch: 1, holderId: AUTHOR, acquiredAt: -10_000, renewedAt: 0, requestedBy: PEER }),
    state(20_000, { epoch: 1, holderId: AUTHOR, acquiredAt: -10_000, renewedAt: 20_000, requestedBy: PEER }),
    state(50_000, { epoch: 1, holderId: AUTHOR, acquiredAt: -10_000, renewedAt: 50_000, requestedBy: PEER }),
    state(145_100, { revision: 3, epoch: 2, holderId: PEER, acquiredAt: 145_020, renewedAt: 145_020 }),
  ]
  const REQUESTS: readonly ServerRequest[] = [
    logged(20_000, 'PUT', '/edit-lease', 200, AUTHOR),
    logged(50_000, 'PUT', '/edit-lease', 200, AUTHOR),
    logged(145_030, 'POST', '/edit-lease', 201, PEER),
    logged(147_500, 'PUT', '/edit-lease', 409, AUTHOR),
    logged(147_600, 'POST', '/edit-lease', 409, AUTHOR),
  ]
  const call = (at: number, method: string, path: string, status: number, body: unknown): PeerCall => ({ sentAt: at - 20, at, method, path: `/api/documents/:id/edit-lease${path}`, status, body })
  const CALLS: readonly PeerCall[] = [
    call(1_000, 'POST', '/request', 200, { kind: 'pending' }),
    call(6_000, 'PUT', '/request', 200, { kind: 'pending' }),
    call(145_000, 'PUT', '/request', 200, { kind: 'free' }),
    call(145_040, 'POST', '', 201, { token: 't', interruption: { holder: { id: AUTHOR }, sameUser: false, samePage: false } }),
  ]
  const MARKS = { coveredAt: 0, hiddenSavedAt: 150, requestedAt: 1_000, grantedAt: 145_000, acquiredAt: 145_040, uncoveredAt: 147_000 }
  const evidence = (overrides: Partial<PausedHolderEvidence> = {}): PausedHolderEvidence => ({ report: report('paused-holder', 'lost-after-pause', 95_000), states: STATES, requests: REQUESTS, calls: CALLS, holderId: AUTHOR, requesterId: PEER, marks: MARKS, expectSuspended: true, ...overrides })

  it('按设计走完：协作者续期得到 free 之后申请成功（带异常中断的提醒）；持有者那一代没有明确结束，最后一次续租到协作者取得 95 秒；盖屏期间没有交出、释放；页面停过', () => {
    const judgement = pausedHolderJudgement(evidence())
    expect(judgement.problems).toEqual([])
    expect(judgement.evidence).toBe('（相对盖屏）第二格（隐藏的那一刻）+150 ms；协作者请求 +1000 ms，续期 2 次，+145000 ms 得到 free、+145040 ms 申请 201（异常中断的提醒：持有者那一代）；盖屏之后持有者心跳 2 次、最后一次 +50000 ms，库里最后一次续租 +50000 ms；最后一次续租到协作者取得 95.0 秒；持有者那一代没有明确结束；第 2 代 +145100 ms，接管方式 空（普通申请）；移走盖屏 +147000 ms，之后持有者的请求：PUT /edit-lease 409、POST /edit-lease 409；隐藏期间计时器最长停了 95.0 秒；页面交回的路 lost-after-pause')
  })

  it('持有者交出了（续期得到 reserved，那一代结束为 handed_over）、释放了：各自说明', () => {
    const reserved = CALLS.map(item => item.at === 145_000 ? { ...item, body: { kind: 'reserved' } } : item)
    const handedStates = STATES.map(item => item.at === 50_000 ? { ...item, endReason: 'handed_over' } : item)
    const requests = [...REQUESTS.slice(0, 2), logged(60_000, 'POST', '/edit-lease/handover', 200, AUTHOR), ...REQUESTS.slice(2)]
    expect(pausedHolderJudgement(evidence({ calls: reserved, states: handedStates, requests })).problems).toEqual([
      '协作者接手之前那次续期的结果是 reserved（应当是 free：持有者那一代按时间到期；reserved 说明持有者交出了，没有被暂停）',
      '持有者那一代明确结束了（handed_over，+50000 ms）：应当没有交出、没有释放，按时间到期',
      '盖屏到协作者申请之间后端收到持有者的交出 1 个、释放 0 个（应当一个也没有）',
    ])
  })

  it('最后一次续租到协作者取得不到一个有效期、申请的回答里没有异常中断的提醒：各自说明', () => {
    const late = STATES.map(item => item.at === 50_000 ? { ...item, renewedAt: 100_000 } : item)
    expect(pausedHolderJudgement(evidence({ states: late })).problems).toEqual([`持有者那一代最后一次续租到协作者那一代取得只隔了 45.0 秒（应当不短于 ${LEASE_TTL_MS / 1000} 秒：按时间到期）`])
    const plain = CALLS.map(item => item.method === 'POST' && item.status === 201 ? { ...item, body: { token: 't', interruption: null } } : item)
    expect(pausedHolderJudgement(evidence({ calls: plain })).problems).toEqual(['协作者申请的回答里没有异常中断提醒（持有者那一代按时间到期时应当有）'])
  })

  it('真实 Safari 要求页面真的停过（计时器最长的停顿不短于 30 秒）；Playwright（不要求）不看它', () => {
    const throttled = report('paused-holder', 'lost-after-pause', 4_000)
    expect(pausedHolderJudgement(evidence({ report: throttled })).problems).toEqual([`持有者的页面隐藏期间计时器最长只停了 4.0 秒（真实 Safari 里被暂停时应当不短于 ${SUSPENDED_GAP_MIN_MS / 1000} 秒）`])
    expect(pausedHolderJudgement(evidence({ report: throttled, expectSuspended: false })).problems).toEqual([])
    expect(pausedHolderJudgement(evidence({ report: report('paused-holder', 'lost-after-pause', null), expectSuspended: false })).problems).toEqual([])
  })

  it('只违反"新一代是协作者的"：持有者那一代之后的新一代是第三个人的普通申请', () => {
    const stranger = STATES.map(item => item.epoch === 2 ? { ...item, holderId: 'stranger-id' } : item)
    expect(pausedHolderJudgement(evidence({ states: stranger })).problems).toEqual(['库里的新一代：持有者 stranger-id、接管方式 空（应当是协作者的普通申请）'])
  })

  it('只违反"异常中断的提醒说的是持有者那一代、sameUser 为 false"：提醒里的持有者对、sameUser 不是 false', () => {
    const same = CALLS.map(item => item.method === 'POST' && item.status === 201 ? { ...item, body: { token: 't', interruption: { holder: { id: AUTHOR }, sameUser: true, samePage: false } } } : item)
    expect(pausedHolderJudgement(evidence({ calls: same })).problems).toEqual([`协作者申请的回答里的异常中断提醒对不上（中断的那一代的持有者 ${AUTHOR}、sameUser true；持有者那一代按时间到期时应当是持有者、sameUser 为 false）`])
  })

  it('只违反"盖屏期间持有者没有释放"：后端收到持有者的释放（没成：409），库里那一代照样没有明确结束', () => {
    const released = [...REQUESTS.slice(0, 2), logged(60_000, 'DELETE', '/edit-lease', 409, AUTHOR), ...REQUESTS.slice(2)]
    expect(pausedHolderJudgement(evidence({ requests: released })).problems).toEqual(['盖屏到协作者申请之间后端收到持有者的交出 0 个、释放 1 个（应当一个也没有）'])
  })

  describe('页面交回 handed-over（没被暂停：空闲满 2 分钟自动交出，2026-10-08 第一次真实 Safari 运行的样子）', () => {
    /** 盖屏之后持有者照常心跳到 124 秒，124.1 秒交出（handed_over、留给协作者）；协作者 135.74 秒续期得到 reserved、135.78 秒申请 201（没有提醒） */
    const HANDED_STATES: readonly DocumentState[] = [
      ...STATES.slice(0, 3),
      state(120_000, { epoch: 1, holderId: AUTHOR, acquiredAt: -10_000, renewedAt: 120_000, requestedBy: PEER }),
      state(124_150, { revision: 4, epoch: 1, holderId: AUTHOR, acquiredAt: -10_000, renewedAt: 120_000, endReason: 'handed_over', reservedFor: PEER }),
      state(135_850, { revision: 4, epoch: 2, holderId: PEER, acquiredAt: 135_800, renewedAt: 135_800 }),
    ]
    const HANDED_REQUESTS: readonly ServerRequest[] = [
      ...[10_000, 20_000, 30_000, 60_000, 90_000, 120_000].map(time => logged(time, 'PUT', '/edit-lease', 200, AUTHOR)),
      logged(124_050, 'PUT', '/content', 200, AUTHOR),
      logged(124_100, 'POST', '/edit-lease/handover', 200, AUTHOR),
      logged(135_810, 'POST', '/edit-lease', 201, PEER),
    ]
    const HANDED_CALLS: readonly PeerCall[] = [
      call(1_000, 'POST', '/request', 200, { kind: 'pending' }),
      call(130_700, 'PUT', '/request', 200, { kind: 'pending' }),
      call(135_740, 'PUT', '/request', 200, { kind: 'reserved', reservedUntil: '2026-10-08T01:05:00.000Z' }),
      call(135_820, 'POST', '', 201, { token: 't', interruption: null }),
    ]
    const handed = (overrides: Partial<PausedHolderEvidence> = {}): PausedHolderEvidence => evidence({ report: report('paused-holder', 'handed-over', 7_700), states: HANDED_STATES, requests: HANDED_REQUESTS, calls: HANDED_CALLS, marks: { ...MARKS, grantedAt: 135_740, acquiredAt: 135_820, uncoveredAt: 137_800 }, ...overrides })

    it('按这条路的要求都对：交出 200、那一代结束为 handed_over 留给协作者、续期得到 reserved、申请没有提醒；不要求停过、不要求隔一个有效期', () => {
      const judgement = pausedHolderJudgement(handed())
      expect(judgement.problems).toEqual([])
      expect(judgement.evidence).toContain('盖屏之后持有者心跳 6 次、最后一次 +120000 ms')
      expect(judgement.evidence).toContain('持有者交出 200 +124100 ms')
      expect(judgement.evidence).toContain('持有者那一代明确结束（handed_over，+124150 ms）')
    })

    it('交出不在后端日志里、续期得到 free、申请带着提醒、那一代不是 handed_over：各自说明', () => {
      const free = HANDED_CALLS.map(item => item.at === 135_740 ? { ...item, body: { kind: 'free' } } : item.status === 201 ? { ...item, body: { token: 't', interruption: { holder: { id: AUTHOR }, sameUser: false } } } : item)
      const states = HANDED_STATES.map(item => item.endReason === 'handed_over' ? { ...item, endReason: null, reservedFor: null } : item)
      expect(pausedHolderJudgement(handed({ calls: free, states, requests: HANDED_REQUESTS.filter(request => !(request.route ?? '').endsWith('/handover')) })).problems).toEqual([
        '协作者接手之前那次续期的结果是 free（持有者交出了，应当是 reserved）',
        '协作者申请的回答里有异常中断的提醒（持有者交出是明确结束，不该有）',
        '持有者那一代没有明确结束、没有留给协作者（自动交出时应当是 handed_over、留给协作者）',
        '盖屏到协作者申请之间后端收到持有者的交出 0 个（—）、释放 0 个（自动交出时应当恰好一个 200 的交出、没有释放）',
      ])
    })

    it('只违反"恰好一个交出"：第一个交出 200 之后又来了一个（409）', () => {
      const twice = [...HANDED_REQUESTS.slice(0, 8), logged(124_300, 'POST', '/edit-lease/handover', 409, AUTHOR), ...HANDED_REQUESTS.slice(8)]
      expect(pausedHolderJudgement(handed({ requests: twice })).problems).toEqual(['盖屏到协作者申请之间后端收到持有者的交出 2 个（200、409）、释放 0 个（自动交出时应当恰好一个 200 的交出、没有释放）'])
    })

    it('只违反"交出的那一代留给协作者"：那一代结束为 handed_over，保留的却是第三个人', () => {
      const elsewhere = HANDED_STATES.map(item => item.endReason === 'handed_over' ? { ...item, reservedFor: 'stranger-id' } : item)
      expect(pausedHolderJudgement(handed({ states: elsewhere })).problems).toEqual(['持有者那一代结束为 handed_over、没有留给协作者（自动交出时应当是 handed_over、留给协作者）'])
    })
  })

  it('协作者没有接手、库里没有新一代、持有者没有交回：各自说明', () => {
    const judgement = pausedHolderJudgement(evidence({ calls: CALLS.slice(0, 2), states: STATES.slice(0, 4), marks: { ...MARKS, acquiredAt: undefined, grantedAt: undefined }, report: undefined }))
    expect(judgement.problems).toEqual(['持有者没有交回结果', '协作者没有接手（持有者那一代没有按时间到期？）', '库里没有看到持有者那一代之后的新一代', '持有者的页面隐藏期间计时器最长只停了 —（真实 Safari 里被暂停时应当不短于 30 秒）'])
  })
})
