import type { ProfilePageTarget } from './profile-process.ts'
import { describe, expect, it } from 'vitest'
import { createPauseRecord } from './profile-pause.ts'

const NOW = 1_800_000_000_000
const target: ProfilePageTarget = { pid: 5010, uid: 501, startedAtUs: '1799999999000000', executable: '/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent', bundleId: 'com.apple.WebKit.WebContent', asn: 'ASN:0x0-0x123:', appleSigned: true, windowId: 1, profileName: '测试', url: 'http://127.0.0.1:5000/document', observedAt: NOW }
const kernel = { pid: target.pid, uid: target.uid, ppid: 1, startedAtUs: target.startedAtUs, executable: target.executable }
const ready = { kind: 'ready', guardian: { pid: 6010, uid: 501, startedAtUs: '1799999999999000' }, at: NOW, monoMs: 100 }
const stopped = { kind: 'stopped', target: kernel, signalAt: NOW + 10, signalMonoMs: 110, at: NOW + 11, monoMs: 111, stopSignals: 1, maxPauseMs: 180_000 }
const finished = { kind: 'finished', target: kernel, reason: 'requested', at: NOW + 90_020, monoMs: 90_120, continueAt: NOW + 90_019, continueMonoMs: 90_119, stopSignals: 1, continueSignals: 1, stoppedConfirmed: true, resumedConfirmed: true }
function record() {
  return createPauseRecord({ guardianPid: 6010, target, deadline: NOW + 200_000 })
}
function afterStop() {
  const r = record()
  expect(r.receive(ready)).toBe(true)
  expect(r.receive(stopped)).toBe(true)
  return r
}

describe('独立暂停守护的回执', () => {
  it('只有同一守护者、同一出生身份且实际停止再恢复，才构成正常完成', () => {
    const r = afterStop()
    expect(r.snapshot().normalCompletion).toBe(false)
    expect(r.receive(finished)).toBe(true)
    expect(r.snapshot()).toMatchObject({ phase: 'finished', restored: true, normalCompletion: true, problems: [] })
  })

  it.each(['deadline', 'controller-eof', 'controller-signal', 'user-activity', 'screen-locked', 'desktop-unavailable', 'invalid-command', 'output-unavailable'])('异常 %s 得到安全恢复，仍不能当作正常实验', (reason) => {
    const r = afterStop()
    expect(r.receive({ ...finished, reason })).toBe(true)
    expect(r.snapshot()).toMatchObject({ phase: 'finished', restored: true, normalCompletion: false })
  })

  it('墙钟倒退可以记录恢复事实，不能构成正常完成', () => {
    const r = afterStop()
    expect(r.receive({ ...finished, reason: 'clock-changed', at: NOW - 10, continueAt: NOW - 11 })).toBe(true)
    expect(r.snapshot()).toMatchObject({ restored: true, normalCompletion: false })
  })

  it.each([
    ['其他守护者', { ...ready, guardian: { ...ready.guardian, pid: 6011 } }],
    ['其他用户', { ...ready, guardian: { ...ready.guardian, uid: 502 } }],
    ['未知字段', { ...ready, ignored: true }],
    ['非有限时刻', { ...ready, monoMs: Number.POSITIVE_INFINITY }],
  ])('%s 不能进入就绪', (_name, event) => {
    const r = record()
    expect(r.receive(event)).toBe(false)
    expect(r.receive(ready)).toBe(false)
    expect(r.snapshot()).toMatchObject({ phase: 'failed', normalCompletion: false })
  })

  it.each([
    ['没有 ready', undefined, stopped],
    ['重复 ready', ready, ready],
    ['没有 stop 就声称继续', ready, finished],
    ['不同出生身份', ready, { ...stopped, target: { ...kernel, startedAtUs: '1800000000000001' } }],
    ['改变可执行文件', ready, { ...stopped, target: { ...kernel, executable: '/bin/sleep' } }],
    ['伪造两个 STOP', ready, { ...stopped, stopSignals: 2 }],
    ['映射超过两秒', ready, { ...stopped, signalAt: NOW + 2001, at: NOW + 2002 }],
    ['到达绝对期限', ready, { ...stopped, signalAt: NOW + 200_000, at: NOW + 200_001 }],
    ['先确认后信号', ready, { ...stopped, at: NOW + 9 }],
    ['暂停超过三分钟', ready, { ...stopped, maxPauseMs: 180_001 }],
    ['停止的单调时钟倒退', ready, { ...stopped, signalMonoMs: 99 }],
  ])('%s 的序列被拒绝', (_name, first, event) => {
    const r = record()
    if (first !== undefined)
      expect(r.receive(first)).toBe(true)
    expect(r.receive(event)).toBe(false)
    expect(r.snapshot().normalCompletion).toBe(false)
  })

  it.each([
    ['重复 stop', stopped],
    ['不同父进程', { ...finished, target: { ...kernel, ppid: 99 } }],
    ['重复 CONT', { ...finished, continueSignals: 2 }],
    ['无 CONT 却声称恢复', { ...finished, continueSignals: 0 }],
    ['CONT 早于 STOP', { ...finished, continueAt: NOW + 1 }],
    ['单调时钟倒退', { ...finished, monoMs: 105 }],
    ['漏掉停止确认', { ...finished, stoppedConfirmed: false }],
    ['正常恢复缺少内核确认', { ...finished, resumedConfirmed: false }],
  ])('%s 不能掩盖成通过', (_name, event) => {
    const r = afterStop()
    expect(r.receive(event)).toBe(false)
    expect(r.snapshot().normalCompletion).toBe(false)
  })

  it.each(['target-exited', 'target-changed', 'externally-resumed', 'resume-unconfirmed'])('%s 保留终态但不冒称本次完成恢复', (reason) => {
    const r = afterStop()
    expect(r.receive({ ...finished, reason, continueSignals: 0, continueAt: null, continueMonoMs: null, resumedConfirmed: false })).toBe(true)
    expect(r.snapshot()).toMatchObject({ phase: 'finished', restored: false, normalCompletion: false })
  })

  it('就绪后拒绝初始资格，未发信号的目标不会有 CONT', () => {
    const r = record()
    r.receive(ready)
    expect(r.receive({ ...finished, target: null, reason: 'initial-refused', stopSignals: 0, continueSignals: 0, continueAt: null, continueMonoMs: null, stoppedConfirmed: false, resumedConfirmed: false })).toBe(true)
    expect(r.snapshot()).toMatchObject({ restored: false, normalCompletion: false })
  })

  it('STOP 发送后未确认，也必须记录恢复尝试，不能算有效暂停', () => {
    const r = record()
    r.receive(ready)
    expect(r.receive({ ...finished, reason: 'stop-unconfirmed', stoppedConfirmed: false })).toBe(true)
    expect(r.snapshot()).toMatchObject({ restored: true, normalCompletion: false })
  })

  it('完成之后不允许重放结果，调用者也不能改写已经记录的输入', () => {
    const r = afterStop()
    const event = structuredClone(finished)
    expect(r.receive(event)).toBe(true)
    event.target.pid = 9999
    const snapshot = r.snapshot()
    expect(snapshot.events[2]).toEqual(finished)
    expect(r.receive(finished)).toBe(false)
    expect(r.snapshot().normalCompletion).toBe(false)
  })
})
