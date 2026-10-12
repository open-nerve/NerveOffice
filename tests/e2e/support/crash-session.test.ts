import { describe, expect, it } from 'vitest'
import { createCrashSession } from './crash-session.ts'

const RUN = '1f1f40c3-1579-4657-9902-9f1f804fdde1'
const DOCUMENT = '2f1f40c3-1579-4657-9902-9f1f804fdde1'
const USER = '3f1f40c3-1579-4657-9902-9f1f804fdde1'
const BEFORE = '4f1f40c3-1579-4657-9902-9f1f804fdde1'
const AFTER = '5f1f40c3-1579-4657-9902-9f1f804fdde1'
const CLIENT = '6f1f40c3-1579-4657-9902-9f1f804fdde1'
const HASH = 'a'.repeat(64)

const boot = (bootId = BEFORE) => ({ kind: 'boot', runId: RUN, documentId: DOCUMENT, bootId })
const ready = () => ({ ...boot(), kind: 'ready', userId: USER, clientInstanceId: CLIENT, writerId: BEFORE, draftSeq: 1, baseRevision: 1, contentHash: HASH, snapshotHash: 'b'.repeat(64), workerWrites: 1, inFlight: false, visible: true, pageErrors: 0 })
const restored = () => ({ ...boot(AFTER), kind: 'restored', contentHash: HASH, mode: 'editing', recoveredNotice: true, draftRemaining: false, visible: true, pageErrors: 0 })
const server = () => ({ revision: 2, contentHash: HASH, acquires: [{ clientInstanceId: AFTER, takeover: null, status: 201 }], saves: [{ status: 200 }] })

function setup() {
  return createCrashSession({ mode: 'process-kill', runId: RUN, documentId: DOCUMENT, userId: USER, contentHash: HASH, deadline: 1000 })
}

function prepared() {
  const session = setup()
  expect(session.receive(boot(), 10)).toEqual({ kind: 'prepare' })
  expect(session.receive(ready(), 20)).toEqual({ kind: 'wait' })
  return session
}

function observing() {
  const session = prepared()
  expect(session.signaled(30)).toBe(true)
  expect(session.receive(boot(AFTER), 40)).toEqual({ kind: 'observe' })
  return session
}

function diagnostic(bootId = BEFORE, stage = 'boot') {
  const point = () => ({ navigation: { timeOrigin: 100, type: 'navigate', discarded: 'unsupported', key: BEFORE, id: CLIENT, activation: 'replace', fromKey: null, fromId: null }, storage: { status: 'available', markers: [], invalid: 0, truncated: false } })
  return { ...boot(bootId), kind: 'diagnostic', stage, facts: { initial: point(), current: point(), events: [], truncated: false } }
}

describe('崩溃只读诊断不授予产品恢复或测试信号资格', () => {
  it('独立留档清理前后事实，不能把准备推进为就绪或触发信号', () => {
    const session = setup()
    session.receive(boot(), 10)
    const message = diagnostic()
    expect(session.receive(message, 11)).toEqual({ kind: 'wait' })
    message.facts.initial.navigation.key = AFTER
    expect(session.snapshot()).toMatchObject({ phase: 'preparing', diagnostics: [{ stage: 'boot', facts: { initial: { navigation: { key: BEFORE } } } }] })
    expect(session.signaled(12)).toBe(false)
    expect(session.receive(ready(), 20)).toEqual({ kind: 'wait' })
  })

  it('恢复页诊断只追加证据，不能替代恢复报告或服务端核对', () => {
    const session = observing()
    expect(session.receive(diagnostic(AFTER), 41)).toEqual({ kind: 'wait' })
    expect(session.receive(diagnostic(AFTER, 'failed'), 42)).toEqual({ kind: 'wait' })
    expect(session.snapshot()).toMatchObject({ phase: 'observing', diagnostics: [{ bootId: AFTER }, { stage: 'failed' }] })
    expect(session.finish(server(), 50).length).toBeGreaterThan(0)
  })

  it.each([
    { bootId: AFTER },
    { stage: 'unknown' },
    { secret: 'not-for-report' },
    { facts: { ...diagnostic().facts, secret: 'not-for-report' } },
    { facts: { ...diagnostic().facts, current: { ...diagnostic().facts.current, storage: { status: 'available', markers: [{ token: 'not-for-report' }], invalid: 0, truncated: false } } } },
  ])('不接受无关页面、未知阶段或额外敏感字段：%j', (change) => {
    const session = setup()
    session.receive(boot(), 10)
    expect(session.receive({ ...diagnostic(), ...change }, 11)).toEqual({ kind: 'stop' })
    expect(JSON.stringify(session.snapshot())).not.toContain('not-for-report')
  })

  it('快照不能反向改写证据，重复阶段和信号后的旧页诊断均拒绝', () => {
    const session = setup()
    session.receive(boot(), 10)
    session.receive(diagnostic(), 11)
    const snapshot = session.snapshot()
    snapshot.diagnostics.splice(0)
    expect(session.snapshot().diagnostics).toHaveLength(1)
    expect(session.receive(diagnostic(), 12)).toEqual({ kind: 'stop' })
    const signaled = prepared()
    signaled.signaled(30)
    expect(signaled.receive(diagnostic(BEFORE, 'failed'), 31)).toEqual({ kind: 'stop' })
  })

  it.each([
    { ...diagnostic().facts, events: Array.from({ length: 9 }, () => ({ kind: 'lock', clientInstanceId: CLIENT, result: 'held' })) },
    { ...diagnostic().facts, events: [{ kind: 'match', clientInstanceId: CLIENT, result: 'match', token: 'not-for-report' }] },
    { ...diagnostic().facts, current: { ...diagnostic().facts.current, navigation: { ...diagnostic().facts.current.navigation, url: 'not-for-report' } } },
    { ...diagnostic().facts, current: { ...diagnostic().facts.current, navigation: { ...diagnostic().facts.current.navigation, type: 'not-for-report' } } },
  ])('嵌套元数据超限或带额外内容时不留档', (facts) => {
    const session = setup()
    session.receive(boot(), 10)
    expect(session.receive({ ...diagnostic(), facts }, 11)).toEqual({ kind: 'stop' })
    expect(session.snapshot().diagnostics).toEqual([])
  })
})

describe('真实 Safari 崩溃会话：只在真实就绪、结束与新页面之间推进', () => {
  it('普通刷新校准不能被标记成真实进程崩溃', () => {
    const options = { runId: RUN, documentId: DOCUMENT, userId: USER, contentHash: HASH, deadline: 1000 }
    const session = createCrashSession({ ...options, mode: 'reload-calibration' })
    session.receive(boot(), 10)
    session.receive(ready(), 20)
    expect(session.signaled(30)).toBe(false)
    expect(session.snapshot().phase).toBe('failed')
    const calibration = createCrashSession({ ...options, mode: 'reload-calibration' })
    calibration.receive(boot(), 10)
    calibration.receive(ready(), 20)
    expect(calibration.reloadedForCalibration(30)).toBe(true)
    expect(calibration.snapshot().mode).toBe('reload-calibration')
  })
  it('实际持久正文、明确确认、新实例普通申请、一次修订与清理全部成立才通过', () => {
    const session = confirmed()
    expect(session.receive(restored(), 50)).toEqual({ kind: 'wait' })
    expect(session.finish(server(), 60)).toEqual([])
    expect(session.snapshot().phase).toBe('passed')
  })

  it('通过后迟到取消、报告与重复核对不再改写终态', () => {
    const session = confirmed()
    session.receive(restored(), 50)
    expect(session.finish(server(), 60)).toEqual([])
    session.cancel('迟到的用户活动回调')
    expect(session.receive(boot(), 70)).toEqual({ kind: 'stop' })
    expect(session.finish({ ...server(), revision: 3 }, 80)).toEqual([])
    expect(session.snapshot().phase).toBe('passed')
  })

  it('启动请求可以同一 boot 重传，但第二个页面提前出现使整次作废', () => {
    const session = setup()
    expect(session.receive(boot(), 10)).toEqual({ kind: 'prepare' })
    expect(session.receive(boot(), 11)).toEqual({ kind: 'prepare' })
    expect(session.receive(boot(AFTER), 12)).toEqual({ kind: 'stop' })
    expect(session.snapshot().phase).toBe('failed')
    expect(session.signaled(13)).toBe(false)
  })

  it.each(['runId', 'documentId', 'bootId'] as const)('就绪的 %s 不匹配时拒绝操作', (field) => {
    const session = setup()
    session.receive(boot(), 10)
    expect(session.receive({ ...ready(), [field]: AFTER }, 20)).toEqual({ kind: 'stop' })
    expect(session.signaled(30)).toBe(false)
  })

  it.each([
    ['userId', AFTER],
    ['clientInstanceId', 'not-a-uuid'],
    ['writerId', ''],
    ['draftSeq', 0],
    ['draftSeq', 1.5],
    ['baseRevision', 2],
    ['workerWrites', 0],
    ['pageErrors', 1],
    ['pageErrors', -1],
    ['pageErrors', undefined],
    ['contentHash', 'c'.repeat(64)],
    ['snapshotHash', ''],
    ['inFlight', true],
    ['visible', false],
  ])('就绪证据 %s=%s 不能支持崩溃前提', (field, value) => {
    const session = setup()
    session.receive(boot(), 10)
    expect(session.receive({ ...ready(), [field]: value }, 20)).toEqual({ kind: 'stop' })
    expect(session.signaled(30)).toBe(false)
  })

  it.each([null, [], {}, { ...boot(), kind: 'unknown' }, { ...ready(), secret: 'unexpected' }])('无效或额外字段不进入证据：%j', (message) => {
    const session = setup()
    session.receive(boot(), 10)
    expect(session.receive(message, 20)).toEqual({ kind: 'stop' })
    expect(JSON.stringify(session.snapshot())).not.toContain('unexpected')
  })

  it('就绪重复上报不能反复触发信号，旧页面也不能冒充重载', () => {
    const session = prepared()
    expect(session.receive(ready(), 21)).toEqual({ kind: 'wait' })
    expect(session.signaled(30)).toBe(true)
    expect(session.signaled(31)).toBe(false)
    expect(session.receive(boot(), 40)).toEqual({ kind: 'stop' })
  })

  it('没有持久就绪时不允许结束；没有结束时不接收恢复报告', () => {
    const session = setup()
    expect(session.signaled(10)).toBe(false)
    expect(session.receive(restored(), 20)).toEqual({ kind: 'stop' })
  })

  it.each(['contentHash', 'mode', 'recoveredNotice', 'draftRemaining', 'visible', 'pageErrors'] as const)('恢复的 %s 反例不会通过', (field) => {
    const values = { contentHash: 'c'.repeat(64), mode: 'reading', recoveredNotice: false, draftRemaining: true, visible: false, pageErrors: 1 }
    const session = confirmed()
    expect(session.receive({ ...restored(), [field]: values[field] }, 50)).toEqual({ kind: 'stop' })
    expect(session.finish(server(), 60).length).toBeGreaterThan(0)
  })

  it.each([
    { revision: 3 },
    { contentHash: 'c'.repeat(64) },
    { acquires: [] },
    { acquires: [{ clientInstanceId: CLIENT, takeover: null, status: 200 }] },
    { acquires: [{ clientInstanceId: CLIENT, takeover: null, status: 201 }] },
    { acquires: [{ clientInstanceId: CLIENT, takeover: 'self', status: 201 }] },
    { acquires: [{ clientInstanceId: CLIENT, takeover: null, status: 409 }] },
    { acquires: [...server().acquires, ...server().acquires] },
    { saves: [] },
    { saves: [{ status: 500 }] },
    { saves: [{ status: 200 }, { status: 200 }] },
  ])('独立服务端证据的反例会失败：%j', (change) => {
    const session = confirmed()
    session.receive(restored(), 50)
    expect(session.finish({ ...server(), ...change }, 60).length).toBeGreaterThan(0)
    expect(session.snapshot().phase).toBe('failed')
  })

  it('取消和超时是终态，迟到的就绪、恢复或服务端结果不能翻绿', () => {
    for (const reason of ['用户返回', '归属不明']) {
      const session = prepared()
      session.cancel(reason)
      expect(session.signaled(30)).toBe(false)
      expect(session.receive(boot(AFTER), 40)).toEqual({ kind: 'stop' })
      expect(session.finish(server(), 50)).toContain(reason)
    }
    const session = prepared()
    expect(session.signaled(1000)).toBe(false)
    expect(session.snapshot().problems).toContain('超过本次崩溃复核的总时限')
  })

  it('恢复报告之后仍需服务端核对；页面报告与只读快照不能改写内部证据', () => {
    const session = setup()
    session.receive(boot(), 10)
    const message = ready()
    session.receive(message, 20)
    message.clientInstanceId = AFTER
    expect(session.snapshot().ready?.clientInstanceId).toBe(CLIENT)
    expect(session.finish(server(), 30).length).toBeGreaterThan(0)
  })
})

function awaitingConfirmation(entry: 'restore' | 'takeover-self' = 'restore') {
  const { workerWrites: _writes, ...draft } = ready()
  return { ...draft, ...boot(AFTER), kind: 'awaiting-confirmation', mode: 'reading', entry }
}
const beforeConfirmation = () => ({ revision: 1, contentHash: 'c'.repeat(64), acquires: [], saves: [] })
const emptyTraffic = { acquires: 0, saves: 0 }

function confirmed() {
  const session = observing()
  expect(session.receive(awaitingConfirmation(), 45)).toEqual({ kind: 'wait' })
  expect(session.authorizeConfirmation(beforeConfirmation(), 46)).toBe(true)
  expect(session.receive({ ...boot(AFTER), kind: 'confirm' }, 47, emptyTraffic)).toEqual({ kind: 'confirm' })
  return session
}

describe('明确恢复许可只能来自驱动的独立核对', () => {
  it.each(['restore', 'takeover-self'] as const)('%s：先阅读等待，独立核对后只许可一次真实点击，新身份才可提交', (entry) => {
    const session = observing()
    expect(session.receive(awaitingConfirmation(entry), 45)).toEqual({ kind: 'wait' })
    expect(session.receive({ ...boot(AFTER), kind: 'confirm' }, 46, emptyTraffic)).toEqual({ kind: 'wait' })
    expect(session.snapshot().phase).toBe('awaiting-confirmation')
    expect(session.authorizeConfirmation(beforeConfirmation(), 47)).toBe(true)
    expect(session.receive({ ...boot(AFTER), kind: 'confirm' }, 48, emptyTraffic)).toEqual({ kind: 'confirm' })
    expect(session.receive(restored(), 50)).toEqual({ kind: 'wait' })
    expect(session.finish({ ...server(), acquires: [{ clientInstanceId: AFTER, takeover: entry === 'restore' ? null : 'self', status: 201 }] }, 60)).toEqual([])
    expect(session.snapshot()).toMatchObject({ phase: 'passed', recovery: 'explicit-confirmation', confirmation: { authorizedAt: 47, consumedAt: 48 } })
  })

  it('没有等待证据不能提前许可，页面也不能通过 HTTP 自行授权', () => {
    const session = observing()
    expect(session.authorizeConfirmation(beforeConfirmation(), 45)).toBe(false)
    const forged = observing()
    expect(forged.receive({ ...boot(AFTER), kind: 'authorize-confirmation' }, 45)).toEqual({ kind: 'stop' })
    const automatic = observing()
    expect(automatic.receive(restored(), 45)).toEqual({ kind: 'stop' })
  })

  it.each([
    { bootId: BEFORE },
    { mode: 'editing' },
    { entry: 'force' },
    { pageErrors: 1 },
    { contentHash: 'c'.repeat(64) },
    { snapshotHash: 'd'.repeat(64) },
    { clientInstanceId: AFTER },
    { draftSeq: 2 },
    { writerId: AFTER },
    { inFlight: true },
    { visible: false },
    { secret: 'never-export' },
  ])('确认前原件或页面事实变化不能继续：%j', (change) => {
    const session = observing()
    expect(session.receive({ ...awaitingConfirmation(), ...change }, 45)).toEqual({ kind: 'stop' })
    expect(JSON.stringify(session.snapshot())).not.toContain('never-export')
  })

  it.each([
    { acquires: [{ clientInstanceId: AFTER, takeover: null, status: 0 }] },
    { acquires: [{ clientInstanceId: AFTER, takeover: null, status: 201 }] },
    { saves: [{ status: 0 }] },
    { saves: [{ status: 200 }] },
    { revision: 2 },
  ])('独立核对发现确认前已发请求（包括在途）或云端已变，拒绝许可：%j', (change) => {
    const session = observing()
    session.receive(awaitingConfirmation(), 45)
    expect(session.authorizeConfirmation({ ...beforeConfirmation(), ...change }, 46)).toBe(false)
    expect(session.receive({ ...boot(AFTER), kind: 'confirm' }, 47, emptyTraffic)).toEqual({ kind: 'stop' })
  })

  it.each([undefined, { acquires: 1, saves: 0 }, { acquires: 0, saves: 1 }])('发放许可瞬间再次核对请求；缺失或已发请求不能钻核对后的空隙', (traffic) => {
    const session = observing()
    session.receive(awaitingConfirmation(), 45)
    session.authorizeConfirmation(beforeConfirmation(), 46)
    expect(session.receive({ ...boot(AFTER), kind: 'confirm' }, 47, traffic)).toEqual({ kind: 'stop' })
  })

  it.each(['repeat', 'wrong-boot', 'cancel', 'timeout'] as const)('许可 %s 时不能再次交付或继续恢复', (ending) => {
    const session = observing()
    session.receive(awaitingConfirmation(), 45)
    session.authorizeConfirmation(beforeConfirmation(), 46)
    if (ending === 'repeat')
      expect(session.receive({ ...boot(AFTER), kind: 'confirm' }, 47, emptyTraffic)).toEqual({ kind: 'confirm' })
    if (ending === 'cancel')
      session.cancel('用户返回')
    expect(session.receive({ ...boot(ending === 'wrong-boot' ? BEFORE : AFTER), kind: 'confirm' }, ending === 'timeout' ? 1000 : 48, emptyTraffic)).toEqual({ kind: 'stop' })
  })
})
