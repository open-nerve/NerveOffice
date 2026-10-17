import { describe, expect, it } from 'vitest'
import { SELFTEST_REPORT_FORMAT } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import { createLocalPauseSession } from './pause-session.ts'

const RUN = '1f1f40c3-1579-4657-9902-9f1f804fdde1'
const DOC = '2f1f40c3-1579-4657-9902-9f1f804fdde1'
const USER = '3f1f40c3-1579-4657-9902-9f1f804fdde1'
const BOOT = '4f1f40c3-1579-4657-9902-9f1f804fdde1'
const COPY = '5f1f40c3-1579-4657-9902-9f1f804fdde1'
const HASH = 'a'.repeat(64)
const CLOUD = 'b'.repeat(64)
const NOW = 1_800_000_000_000
const boot = { kind: 'boot', runId: RUN, documentId: DOC, bootId: BOOT }
const ready = () => ({ ...boot, kind: 'local-ready', userId: USER, clientInstanceId: USER, writerId: BOOT, writeEpoch: 1, draftSeq: 3, baseRevision: 3, contentHash: HASH, snapshotHash: HASH, writtenAt: NOW + 15, workerConfirmed: true, inFlight: false, formulasPending: false, visible: false, pageErrors: 0 })
const target = { pid: 42, uid: 501, ppid: 1, startedAtUs: '1799999999000000', executable: '/system/test-webcontent' }
const stopped = { kind: 'stopped', target, signalAt: NOW + 31, signalMonoMs: 1031, at: NOW + 32, monoMs: 1032, stopSignals: 1, maxPauseMs: 180_000 }
const resumed = () => ({ kind: 'finished', target, reason: 'requested', at: NOW + 100_000, monoMs: 101_000, continueAt: NOW + 99_999, continueMonoMs: 100_999, stopSignals: 1, continueSignals: 1, stoppedConfirmed: true, resumedConfirmed: true })
const checks = ['first-save', 'hidden-upload', 'after-hidden-edit', 'local-ready', 'outcome', 'stale-save', 'copy', 'local-cleaned'].map(id => ({ id: `request.holder.${id}`, pass: true, detail: '', ms: 1 }))
function completed() {
  return {
    ...boot,
    kind: 'complete',
    report: { format: SELFTEST_REPORT_FORMAT, scenario: 'paused-local-holder', documentId: DOC, userAgent: 'test Safari', startedAt: new Date(NOW).toISOString(), finishedAt: new Date(NOW + 100_500).toISOString(), page: { state: 'ready' }, checks: structuredClone(checks), visibility: [], pageErrors: [], consoleErrors: [], ignoredNotices: [], path: 'lost-after-pause', facts: { localDraftRemaining: false, localSnapshotHash: HASH, copyDocumentId: COPY, staleSaveRequestId: COPY, staleSaveStatus: 409, staleSaveCode: 'EDIT_LEASE_LOST', staleSaveReason: 'replaced', staleSaveSentAt: NOW + 100_050, staleSaveAnsweredAt: NOW + 100_100 } },
  }
}
function setup(mode: 'native' | 'heartbeat-calibration' = 'native') {
  return createLocalPauseSession({ mode, runId: RUN, documentId: DOC, userId: USER, contentHash: HASH, cloudHash: CLOUD, deadline: NOW + 400_000 })
}
function authorized() {
  const session = setup()
  expect(session.receive(boot, NOW + 10)).toEqual({ kind: 'prepare' })
  expect(session.receive(ready(), NOW + 20)).toEqual({ kind: 'wait' })
  expect(session.authorizePause({ revision: 3, contentHash: CLOUD }, NOW + 30)).toBe(true)
  return session
}

describe('本机草稿暂停会话', () => {
  it('实际持久、云端核对、原生恢复、页面副本与服务端证据全部齐全才通过', () => {
    const session = authorized()
    expect(session.paused(stopped, NOW + 33)).toBe(true)
    expect(session.resumed(resumed(), NOW + 100_001)).toBe(true)
    expect(session.receive(completed(), NOW + 100_510)).toEqual({ kind: 'wait' })
    expect(session.snapshot().phase).toBe('reported')
    expect(session.finish([], NOW + 101_000)).toBe(true)
    expect(session.snapshot().phase).toBe('passed')
  })

  it('页面回复可以先于 Node 读完 CONT 回执，但不能先于实际恢复', () => {
    const session = authorized()
    session.paused(stopped, NOW + 33)
    expect(session.receive(completed(), NOW + 100_510)).toEqual({ kind: 'wait' })
    expect(session.snapshot().phase).toBe('paused')
    expect(session.resumed(resumed(), NOW + 100_520)).toBe(true)
    expect(session.finish([], NOW + 101_000)).toBe(true)
    const early = authorized()
    early.paused(stopped, NOW + 33)
    const beforeContinue = completed()
    beforeContinue.report.finishedAt = new Date(NOW + 45).toISOString()
    beforeContinue.report.facts.staleSaveSentAt = NOW + 40
    beforeContinue.report.facts.staleSaveAnsweredAt = NOW + 44
    expect(early.receive(beforeContinue, NOW + 50)).toEqual({ kind: 'wait' })
    expect(early.resumed(resumed(), NOW + 100_520)).toBe(false)
  })

  it.each([
    { userId: COPY },
    { bootId: COPY },
    { documentId: COPY },
    { runId: COPY },
    { workerConfirmed: false },
    { inFlight: true },
    { formulasPending: true },
    { visible: true },
    { pageErrors: 1 },
    { baseRevision: 2 },
    { draftSeq: 0 },
    { contentHash: CLOUD },
    { snapshotHash: 'invalid' },
    { writtenAt: NOW - 1 },
    { writtenAt: NOW + 100 },
    { secret: 'not-for-report' },
  ])('准备事实不符时拒绝暂停：%j', (change) => {
    const session = setup()
    session.receive(boot, NOW + 10)
    expect(session.receive({ ...ready(), ...change }, NOW + 20)).toEqual({ kind: 'stop' })
    expect(session.authorizePause({ revision: 3, contentHash: CLOUD }, NOW + 30)).toBe(false)
    expect(JSON.stringify(session.snapshot())).not.toContain('not-for-report')
  })

  it('重复 boot、重复 ready 或云端第三格已上传会永久作废', () => {
    for (const message of [boot, ready()]) {
      const session = setup()
      session.receive(boot, NOW + 10)
      session.receive(ready(), NOW + 20)
      expect(session.receive(message, NOW + 21)).toEqual({ kind: 'stop' })
      expect(session.authorizePause({ revision: 3, contentHash: CLOUD }, NOW + 30)).toBe(false)
    }
    const session = setup()
    session.receive(boot, NOW + 10)
    session.receive(ready(), NOW + 20)
    expect(session.authorizePause({ revision: 4, contentHash: HASH }, NOW + 30)).toBe(false)
  })

  it.each([
    { reason: 'deadline' },
    { continueSignals: 0, continueAt: null, continueMonoMs: null },
    { resumedConfirmed: false },
    { target: { ...target, ppid: 2 } },
    { continueAt: NOW + 1 },
    { continueMonoMs: 1000 },
  ])('提前、未确认或错目标恢复不能记正常完成：%j', (change) => {
    const session = authorized()
    session.paused(stopped, NOW + 33)
    expect(session.resumed({ ...resumed(), ...change }, NOW + 100_001)).toBe(false)
    expect(session.finish([], NOW + 101_000)).toBe(false)
  })

  it('心跳拦截校准与原生暂停模式不能混记', () => {
    expect(authorized().paused({ kind: 'heartbeat-calibration' }, NOW + 33)).toBe(false)
    const session = setup('heartbeat-calibration')
    session.receive(boot, NOW + 10)
    session.receive(ready(), NOW + 20)
    session.authorizePause({ revision: 3, contentHash: CLOUD }, NOW + 30)
    expect(session.paused(stopped, NOW + 33)).toBe(false)
    const valid = setup('heartbeat-calibration')
    valid.receive(boot, NOW + 10)
    valid.receive(ready(), NOW + 20)
    valid.authorizePause({ revision: 3, contentHash: CLOUD }, NOW + 30)
    expect(valid.paused({ kind: 'heartbeat-calibration' }, NOW + 33)).toBe(true)
    expect(valid.resumed({ kind: 'heartbeat-calibration' }, NOW + 100_001)).toBe(true)
    valid.receive(completed(), NOW + 100_510)
    expect(valid.finish([], NOW + 101_000)).toBe(true)
    expect(valid.snapshot().mode).toBe('heartbeat-calibration')
  })

  it.each([
    { path: 'handed-over' },
    { scenario: 'paused-holder' },
    { documentId: COPY },
    { checks: checks.slice(1) },
    { pageErrors: ['unexpected'] },
    { facts: { localDraftRemaining: true, localSnapshotHash: HASH, copyDocumentId: COPY } },
    { facts: { localDraftRemaining: false, localSnapshotHash: CLOUD, copyDocumentId: COPY } },
    { facts: { localDraftRemaining: false, localSnapshotHash: HASH, copyDocumentId: DOC } },
  ])('页面结果缺少本轮失权、副本或清理证据时拒绝：%j', (change) => {
    const session = authorized()
    session.paused(stopped, NOW + 33)
    session.resumed(resumed(), NOW + 100_001)
    const value = completed()
    expect(session.receive({ ...value, report: { ...value.report, ...change } }, NOW + 100_510)).toEqual({ kind: 'stop' })
  })

  it('不能提前交报告、跳过服务端判定或倒退时钟；快照也不能修改原证据', () => {
    expect(authorized().receive(completed(), NOW + 50)).toEqual({ kind: 'stop' })
    const session = authorized()
    session.paused(stopped, NOW + 33)
    session.resumed(resumed(), NOW + 100_001)
    session.receive(completed(), NOW + 100_510)
    expect(session.finish(['旧写入没有被隔离'], NOW + 101_000)).toBe(false)
    expect(authorized().paused(stopped, NOW + 1)).toBe(false)
    const copy = authorized()
    copy.snapshot().problems.push('fake')
    expect(copy.snapshot().problems).toEqual([])
    expect(copy.finish([], NOW + 101_000)).toBe(false)
  })
})
