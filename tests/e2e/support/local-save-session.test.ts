import type { LocalSaveConfig } from '../../../apps/web/src/editor/testing/local-save-report.ts'
import { describe, expect, it } from 'vitest'
import { SELFTEST_REPORT_FORMAT } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import { createLocalSaveSession } from './local-save-session.ts'

const ids = ['1', '2', '3', '4', '5'].map(prefix => `${prefix}f1f40c3-1579-4657-9902-9f1f804fdde1`)
const [RUN, DOC, USER, BOOT, CLIENT] = ids as [string, string, string, string, string]
const HASH = 'a'.repeat(64)
const NOW = 1_800_000_000_000
const config: LocalSaveConfig = { sample: '1m', network: 'online', rounds: 2 }
const boot = { kind: 'boot', runId: RUN, documentId: DOC, bootId: BOOT }
const ready = { ...boot, kind: 'ready', userId: USER, writerId: BOOT, writeEpoch: 1, lastDraftSeq: 0, baseRevision: 1 }
const proof = { cutAt: null, inFlight: 0, clientInstanceId: CLIENT, revision: 1, contentHash: HASH }
function row(round: number, network: 'online' | 'offline' = 'online') {
  return {
    userId: USER,
    documentId: DOC,
    writerId: BOOT,
    writeEpoch: 1,
    writtenBy: CLIENT,
    round,
    cold: round === 1,
    wallStartedAt: NOW + round * 2000,
    checkedAt: NOW + round * 2000 + 1500,
    startedAt: round * 2000,
    savedAt: round * 2000 + 1000,
    localSavedMs: 1000,
    commandMs: 10,
    formulaSettledMs: 0,
    editorSeq: round,
    draftSeq: round,
    baseRevision: network === 'online' ? round : 1,
    captureMs: 30,
    captureAt: round * 2000 + 900,
    captureSeq: round,
    workerSentAt: round * 2000 + 930,
    workerReceivedAt: round * 2000 + 990,
    workerMs: 60,
    workerConfirmed: true,
    rawBytes: 1024000,
    snapshotHash: HASH,
    contentChecked: true,
    formulasPending: false,
    cloudChecked: network === 'online',
    cloudRevision: network === 'online' ? round + 1 : null,
    visible: true,
  }
}
function setup(network: 'online' | 'offline' = 'online') {
  return createLocalSaveSession({ runId: RUN, documentId: DOC, userId: USER, config: { ...config, network }, baseRevision: 1, baseHash: HASH, deadline: NOW + 20_000 })
}
function prepared(network: 'online' | 'offline' = 'online') {
  const session = setup(network)
  expect(session.receive(boot, NOW + 10)).toEqual({ kind: 'prepare', config: { ...config, network } })
  expect(session.receive(ready, NOW + 20)).toEqual({ kind: 'wait' })
  return session
}
function measuring(network: 'online' | 'offline' = 'online') {
  const session = prepared(network)
  expect(session.confirmNetwork({ ...proof, cutAt: network === 'offline' ? NOW + 25 : null }, NOW + 30)).toBe(true)
  expect(session.receive({ ...boot, kind: 'network-state' }, NOW + 40)).toEqual({ kind: 'measure', clientInstanceId: CLIENT })
  return session
}
function measured(network: 'online' | 'offline' = 'online') {
  const session = measuring(network)
  for (const round of [1, 2]) {
    expect(session.receive({ ...boot, kind: 'sample', sample: row(round, network) }, NOW + round * 2000 + 1510)).toEqual({ kind: 'wait' })
    expect(session.confirmRound(round, [], NOW + round * 2000 + 1520)).toBe(true)
    expect(session.receive({ ...boot, kind: 'round-state', round }, NOW + round * 2000 + 1530)).toEqual({ kind: 'next' })
  }
  return session
}
function completed(network: 'online' | 'offline' = 'online') {
  return {
    ...boot,
    kind: 'complete',
    measurement: { config: { ...config, network }, samples: [row(1, network), row(2, network)] },
    report: {
      format: SELFTEST_REPORT_FORMAT,
      scenario: `local-save-${network}`,
      documentId: DOC,
      userAgent: 'test Safari',
      startedAt: new Date(NOW).toISOString(),
      finishedAt: new Date(NOW + 6000).toISOString(),
      page: { state: 'ready' },
      checks: ['local-save.ready', 'local-save.round.1', 'local-save.round.2', 'local-save.targets'].map(id => ({ id, pass: true, detail: '', ms: 1 })),
      visibility: [],
      pageErrors: [],
      consoleErrors: [],
      ignoredNotices: [],
      facts: { localSaveTransportFailed: network === 'offline' },
    },
  }
}

describe('本机保存逐轮会话', () => {
  it.each(['online', 'offline'] as const)('网络确认、两轮独立确认、完整报告和最终独立判定齐全才通过 %s', (network) => {
    const session = measured(network)
    expect(session.receive(completed(network), NOW + 6010)).toEqual({ kind: 'wait' })
    expect(session.snapshot().phase).toBe('reported')
    expect(session.finish([], NOW + 6020)).toBe(true)
    expect(session.snapshot().phase).toBe('passed')
  })

  it.each([{ bootId: CLIENT }, { userId: CLIENT }, { documentId: CLIENT }, { runId: CLIENT }, { baseRevision: 2 }, { lastDraftSeq: -1 }, { writeEpoch: 0 }, { secret: 'must-not-persist' }])('拒绝准备阶段身份和结构变化 %j', (change) => {
    const session = setup()
    session.receive(boot, NOW + 10)
    expect(session.receive({ ...ready, ...change }, NOW + 20)).toEqual({ kind: 'stop' })
    expect(session.confirmNetwork(proof, NOW + 30)).toBe(false)
    expect(JSON.stringify(session.snapshot())).not.toContain('must-not-persist')
  })

  it.each([{ cutAt: null }, { cutAt: NOW + 19 }, { cutAt: NOW + 31 }, { inFlight: 1 }, { revision: 2 }, { contentHash: 'b'.repeat(64) }, { clientInstanceId: 'invalid' }])('离线网络确认必须来自准备之后的零在途切断和数据库基线 %j', (change) => {
    expect(prepared('offline').confirmNetwork({ ...proof, cutAt: NOW + 25, ...change }, NOW + 30)).toBe(false)
  })

  it('不能提前测量、重复 boot、重复 ready，或用离线证明冒称在线', () => {
    expect(prepared().receive({ ...boot, kind: 'sample', sample: row(1) }, NOW + 3510)).toEqual({ kind: 'stop' })
    expect(prepared().receive(boot, NOW + 30)).toEqual({ kind: 'stop' })
    expect(prepared().receive(ready, NOW + 30)).toEqual({ kind: 'stop' })
    expect(prepared().confirmNetwork({ ...proof, cutAt: NOW + 25 }, NOW + 30)).toBe(false)
  })

  it.each([{ writtenBy: BOOT }, { writerId: CLIENT }, { round: 2 }, { draftSeq: 0 }, { workerConfirmed: false }, { wallStartedAt: NOW + 29 }, { checkedAt: NOW + 4000 }, { localSavedMs: Infinity }])('拒绝轮次错身份、旧时刻或缺持久证据 %j', (change) => {
    expect(measuring().receive({ ...boot, kind: 'sample', sample: { ...row(1), ...change } }, NOW + 3510)).toEqual({ kind: 'stop' })
  })

  it('第一轮独立判定未完成不能提交下一轮，错误或重复确认永久失败', () => {
    const session = measuring()
    session.receive({ ...boot, kind: 'sample', sample: row(1) }, NOW + 3510)
    expect(session.receive({ ...boot, kind: 'round-state', round: 1 }, NOW + 3511)).toEqual({ kind: 'wait' })
    expect(session.receive({ ...boot, kind: 'sample', sample: row(2) }, NOW + 5510)).toEqual({ kind: 'stop' })
    const invalid = measuring()
    invalid.receive({ ...boot, kind: 'sample', sample: row(1) }, NOW + 3510)
    expect(invalid.confirmRound(1, ['数据库正文不符'], NOW + 3520)).toBe(false)
    expect(invalid.confirmRound(1, [], NOW + 3530)).toBe(false)
    expect(measured().confirmRound(2, [], NOW + 5600)).toBe(false)
  })

  it('少轮、报告改写、漏检查和页面错误不能通过', () => {
    expect(measuring().receive(completed(), NOW + 6010)).toEqual({ kind: 'stop' })
    for (const change of ['missing', 'changed', 'check', 'error']) {
      const event = completed()
      if (change === 'missing')
        event.measurement.samples.pop()
      if (change === 'changed')
        event.measurement.samples[0]!.snapshotHash = 'b'.repeat(64)
      if (change === 'check')
        event.report.checks.pop()
      if (change === 'error')
        event.report.pageErrors = ['unexpected'] as never[]
      expect(measured().receive(event, NOW + 6010)).toEqual({ kind: 'stop' })
    }
  })

  it('离线须有页面实际传输失败，可见性中出现隐藏的组不能通过', () => {
    const offline = completed('offline')
    offline.report.facts.localSaveTransportFailed = false
    expect(measured('offline').receive(offline, NOW + 6010)).toEqual({ kind: 'stop' })
    const hidden = completed()
    hidden.report.visibility = [`${new Date(NOW + 500).toISOString()} hidden`] as never[]
    expect(measured().receive(hidden, NOW + 6010)).toEqual({ kind: 'stop' })
  })

  it('保存失败报告的已知诊断，不保存未知字段或任意事实', () => {
    const session = measuring()
    const event = completed()
    const report = { ...event.report, failure: '缺少本轮真实草稿', checks: [], secret: 'must-not-persist', facts: { localSaveAttemptRound: 1, localSaveSavedAt: 3000, secret: 'must-not-persist' } }
    expect(session.receive({ ...event, report }, NOW + 6010)).toEqual({ kind: 'stop' })
    expect(session.snapshot().pageReport?.failure).toBe('缺少本轮真实草稿')
    expect(session.snapshot().pageReport?.facts?.localSaveSavedAt).toBe(3000)
    expect(JSON.stringify(session.snapshot())).not.toContain('must-not-persist')
  })

  it('页面报告本身、时钟倒退、最终网络/数据库失败均不能结案；快照隔离', () => {
    expect(measured().finish([], NOW + 6010)).toBe(false)
    expect(prepared().confirmNetwork(proof, NOW + 19)).toBe(false)
    const session = measured()
    session.receive(completed(), NOW + 6010)
    expect(session.finish(['离线之后后端仍成功保存'], NOW + 6020)).toBe(false)
    const copy = measuring()
    copy.snapshot().problems.push('fake')
    expect(copy.snapshot().problems).toEqual([])
  })
})
