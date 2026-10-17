import { describe, expect, it } from 'vitest'
import { SELFTEST_REPORT_FORMAT } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import { createNaturalObservation } from './natural-observation.ts'

const runId = '1f1f40c3-1579-4657-9902-9f1f804fdde1'
const documentId = '2f1f40c3-1579-4657-9902-9f1f804fdde1'
const userId = '3f1f40c3-1579-4657-9902-9f1f804fdde1'
const bootId = '4f1f40c3-1579-4657-9902-9f1f804fdde1'
const hash = 'a'.repeat(64)
const now = 1_800_000_000_000
const boot = { kind: 'boot', runId, documentId, bootId }
const local = { ...boot, kind: 'local-ready', userId, clientInstanceId: userId, writerId: bootId, writeEpoch: 1, draftSeq: 3, baseRevision: 3, contentHash: hash, snapshotHash: hash, writtenAt: now + 10, workerConfirmed: true, inFlight: false, formulasPending: false, visible: false, pageErrors: 0 }
function completed() {
  return {
    ...boot,
    kind: 'complete',
    report: {
      format: SELFTEST_REPORT_FORMAT,
      scenario: 'paused-local-holder',
      documentId,
      userAgent: 'test Safari',
      startedAt: new Date(now).toISOString(),
      finishedAt: new Date(now + 160_000).toISOString(),
      page: { state: 'ready' },
      checks: ['first-save', 'hidden-upload', 'after-hidden-edit', 'local-ready', 'outcome', 'server'].map(id => ({ id: `request.holder.${id}`, pass: true, detail: '', ms: 1 })),
      visibility: [],
      pageErrors: [],
      consoleErrors: [],
      ignoredNotices: [],
      path: 'handed-over',
      facts: { localSnapshotHash: hash, localDraftSeq: 3 },
    },
  }
}
function setup(waitForWindow = false) {
  const session = createNaturalObservation({ runId, documentId, userId, contentHash: hash, cloudHash: 'b'.repeat(64), deadline: now + 300_000, waitForWindow })
  expect(session.receive(boot, now + 1)).toEqual({ kind: waitForWindow ? 'prepare-window' : 'prepare' })
  return session
}

describe('自然隐藏观察的持久证据', () => {
  it('Space 过渡结束须由宿主确认，页面轮询不能自行放行第三格', () => {
    const session = setup(true)
    const query = { ...boot, kind: 'window-state' }
    expect(session.receive(query, now + 2)).toEqual({ kind: 'wait' })
    expect(session.confirmWindowReady(now + 3)).toBe(true)
    expect(session.receive(query, now + 4)).toEqual({ kind: 'window-ready' })
    expect(session.receive(local, now + 11)).toEqual({ kind: 'wait' })
    expect(session.snapshot().windowReadyAt).toBe(now + 3)
    expect(session.receive(completed(), now + 160_001)).toEqual({ kind: 'wait' })
  })

  it('拒绝窗口确认前的本机草稿、错身份查询及重复窗口确认', () => {
    expect(setup(true).receive(local, now + 11)).toEqual({ kind: 'stop' })
    expect(setup(true).receive({ ...boot, kind: 'window-state', bootId: userId }, now + 2)).toEqual({ kind: 'stop' })
    const early = setup(true)
    expect(early.confirmWindowReady(now + 20)).toBe(true)
    expect(early.receive(local, now + 21)).toEqual({ kind: 'stop' })
    const repeated = setup(true)
    expect(repeated.confirmWindowReady(now + 3)).toBe(true)
    expect(repeated.confirmWindowReady(now + 4)).toBe(false)
    expect(repeated.snapshot().phase).toBe('failed')
    expect(setup().confirmWindowReady(now + 2)).toBe(false)
  })

  it('准备失败时仍保留本页白名单诊断，但不把它接受为完成', () => {
    const session = setup()
    const value = completed()
    const failed = { ...value.report, checks: [{ id: 'request.holder.local-ready', pass: false, detail: '第三格未形成草稿', ms: 30_000, secret: 'must-not-be-retained' }], visibility: ['hidden', 'visible', 'hidden'], facts: { secret: 'must-not-be-retained' } }
    expect(session.receive({ ...value, report: failed }, now + 160_001)).toEqual({ kind: 'stop' })
    expect(session.snapshot()).toMatchObject({ phase: 'failed', diagnostic: { visibility: failed.visibility, checks: [{ id: 'request.holder.local-ready', pass: false, detail: '第三格未形成草稿', ms: 30_000 }] } })
    expect(session.snapshot().report).toBeUndefined()
    expect(JSON.stringify(session.snapshot())).not.toContain('must-not-be-retained')
    failed.visibility.push('changed')
    expect(session.snapshot().diagnostic?.visibility).toEqual(['hidden', 'visible', 'hidden'])
  })

  it('错运行、错页面、错启动与未来报告不形成诊断证据', () => {
    for (const value of [
      { ...completed(), runId: userId },
      { ...completed(), bootId: userId },
      { ...completed(), report: { ...completed().report, documentId: userId } },
      { ...completed(), report: { ...completed().report, finishedAt: new Date(now + 170_000).toISOString() } },
    ]) {
      const session = setup()
      expect(session.receive(value, now + 160_001)).toEqual({ kind: 'stop' })
      expect(session.snapshot().diagnostic).toBeUndefined()
    }
  })

  it('只观察真实准备及交出结果，不生成任何暂停或恢复回执', () => {
    const session = setup()
    expect(session.receive(local, now + 11)).toEqual({ kind: 'wait' })
    expect(session.receive(completed(), now + 160_001)).toEqual({ kind: 'wait' })
    expect(session.snapshot()).toMatchObject({ mode: 'natural-observation', phase: 'reported', local, report: { path: 'handed-over' }, problems: [] })
    expect(session).not.toHaveProperty('paused')
    expect(session).not.toHaveProperty('resumed')
  })

  it('自然停顿后失权也须保留旧保存拒绝、副本和清理事实', () => {
    const session = setup()
    session.receive(local, now + 11)
    const value = completed()
    const extra = ['stale-save', 'copy', 'local-cleaned'].map(id => ({ id: `request.holder.${id}`, pass: true, detail: '', ms: 1 }))
    const report = { ...value.report, path: 'lost-after-pause', checks: [...value.report.checks, ...extra], facts: { ...value.report.facts, localDraftRemaining: false, copyDocumentId: bootId, staleSaveRequestId: userId, staleSaveStatus: 409, staleSaveCode: 'EDIT_LEASE_LOST', staleSaveReason: 'replaced', staleSaveSentAt: now + 150_000, staleSaveAnsweredAt: now + 151_000 } }
    expect(session.receive({ ...value, report }, now + 160_001)).toEqual({ kind: 'wait' })
    expect(session.snapshot().mode).toBe('natural-observation')
    expect(session.snapshot().report?.path).toBe('lost-after-pause')
  })

  it.each([
    { workerConfirmed: false },
    { visible: true },
    { userId: bootId },
    { bootId: userId },
    { secret: 'must-not-be-retained' },
  ])('准备事实继续由原严格协议拒绝：%j', (change) => {
    const session = setup()
    expect(session.receive({ ...local, ...change }, now + 11)).toEqual({ kind: 'stop' })
    expect(JSON.stringify(session.snapshot())).not.toContain('must-not-be-retained')
    expect(session.receive(completed(), now + 160_001)).toEqual({ kind: 'stop' })
  })

  it.each([
    { documentId: userId },
    { path: 'not-hidden' },
    { scenario: 'paused-holder' },
    { checks: [] },
    { pageErrors: ['error'] },
    { facts: { localSnapshotHash: 'b'.repeat(64), localDraftSeq: 3 } },
    { finishedAt: new Date(now + 170_000).toISOString() },
    { path: 'lost-after-pause' },
  ])('缺证据或错误报告不能算完成：%j', (change) => {
    const session = setup()
    session.receive(local, now + 11)
    const message = completed()
    expect(session.receive({ ...message, report: { ...message.report, ...change } }, now + 160_001)).toEqual({ kind: 'stop' })
    expect(session.snapshot().report).toBeUndefined()
  })

  it('拒绝提前完成、重复消息、错身份、倒退或超时；快照不能改证据', () => {
    expect(setup().receive(completed(), now + 160_001)).toEqual({ kind: 'stop' })
    for (const bad of [boot, { ...completed(), bootId: userId }, { ...completed(), runId: userId }, { ...completed(), secret: 'secret' }]) {
      const session = setup()
      session.receive(local, now + 11)
      expect(session.receive(bad, now + 160_001)).toEqual({ kind: 'stop' })
    }
    for (const at of [now, now + 300_000]) {
      const session = setup()
      session.receive(local, now + 11)
      expect(session.receive(completed(), at)).toEqual({ kind: 'stop' })
    }
    const session = setup()
    session.receive(local, now + 11)
    session.receive(completed(), now + 160_001)
    session.snapshot().problems.push('fake')
    expect(session.snapshot().problems).toEqual([])
    expect(session.receive(completed(), now + 160_002)).toEqual({ kind: 'stop' })
  })
})
