import type { PauseEvent, PauseFinished } from './profile-pause.ts'
import type { ProfilePageContext, ProfilePageSnapshot } from './profile-process.ts'
import { describe, expect, it, vi } from 'vitest'
import { createProfilePauseRun } from './profile-pause-run.ts'

const NOW = 1_800_000_000_000
const executable = '/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent'
const context: ProfilePageContext = { url: 'http://127.0.0.1:5000/document', uid: 501, mainPid: 4000, deadline: NOW + 200_000, profile: { name: '测试', windowId: 1, axWindowUuid: 'ac408a8c-18e2-4efa-860c-735a001175ec', exclusiveFromCreation: true, extensionsDisabled: true, createdAt: NOW - 5000, baseline: { capturedAt: NOW - 6000, pids: [4000] } } }
const kernel = { pid: 5010, uid: 501, ppid: 1, startedAtUs: '1799999999000000', executable }
const ready: Extract<PauseEvent, { kind: 'ready' }> = { kind: 'ready', guardian: { pid: 6010, uid: 501, startedAtUs: '1799999999999000' }, at: NOW, monoMs: 100 }
const stopped: Extract<PauseEvent, { kind: 'stopped' }> = { kind: 'stopped', target: kernel, signalAt: NOW + 10, signalMonoMs: 110, at: NOW + 11, monoMs: 111, stopSignals: 1, maxPauseMs: 180_000 }
const finished: PauseFinished = { kind: 'finished', target: kernel, reason: 'requested', at: NOW + 1000, monoMs: 1100, continueAt: NOW + 999, continueMonoMs: 1099, stopSignals: 1, continueSignals: 1, stoppedConfirmed: true, resumedConfirmed: true }
const idleFinish: PauseFinished = { ...finished, target: null, reason: 'controller-eof', stopSignals: 0, continueSignals: 0, stoppedConfirmed: false, resumedConfirmed: false, continueAt: null, continueMonoMs: null }

function fixture() {
  const order: string[] = []
  let readAt = NOW
  const capture = vi.fn((): ProfilePageSnapshot => {
    order.push('capture')
    readAt += 1
    return { capturedAt: readAt, finishedAt: readAt, desktop: { idleSeconds: 150, locked: false, returned: false }, processes: [{ ...kernel, bundleId: 'com.apple.WebKit.WebContent', asn: 'ASN:0x0-0x123:', appleSigned: true }], windows: [{ windowId: 1, profileMatches: true, tabs: [{ index: 1, pid: 5010, urlMatches: true }] }] }
  })
  let resolve!: (value: PauseFinished) => void
  const final = new Promise<PauseFinished>((done) => {
    resolve = done
  })
  const guardian = {
    ready: Promise.resolve(ready),
    finished: final,
    stop: vi.fn(async () => {
      order.push('stop')
      return stopped
    }),
    resume: vi.fn(() => {
      order.push('resume')
      resolve(finished)
    }),
    close: vi.fn(() => {
      order.push('close')
      resolve(guardian.stop.mock.calls.length === 0 ? idleFinish : { ...finished, reason: 'controller-eof' })
    }),
  }
  const start = vi.fn(() => {
    order.push('start')
    return guardian
  })
  const run = createProfilePauseRun(context, { capture, now: () => NOW + 5, start })
  return { order, capture, guardian, start, run }
}

describe('原生暂停的宿主阶段', () => {
  it('完整归属、独立守护 ready、第二次映射之后才发 STOP；持有停止期间禁止 Apple Events 查询，确认 CONT 后才放开', async () => {
    const f = fixture()
    expect(await f.run.stop()).toEqual(stopped)
    expect(f.order).toEqual(['capture', 'start', 'capture', 'stop'])
    expect(() => f.run.capture()).toThrow('暂停期间')
    expect(f.capture).toHaveBeenCalledTimes(2)
    expect(await f.run.resume()).toEqual(finished)
    expect(f.run.capture()).toBeDefined()
    await f.run.settle()
    expect(f.run.snapshot()).toMatchObject({ inProgress: false, attempted: true, finished })
  })

  it('归属缺失不启动守护者；第二次映射变化不发 STOP，关闭输入并等零信号终态', async () => {
    const f = fixture()
    f.capture.mockReturnValueOnce({ ...f.capture(), windows: [] })
    await expect(f.run.stop()).rejects.toThrow()
    expect(f.start).not.toHaveBeenCalled()
    const g = fixture()
    const bad = g.capture()
    g.capture.mockReturnValueOnce({ ...bad, capturedAt: NOW + 1 }).mockReturnValueOnce({ ...bad, capturedAt: NOW + 2, windows: [] })
    await expect(g.run.stop()).rejects.toThrow()
    expect(g.guardian.stop).not.toHaveBeenCalled()
    expect(g.guardian.close).toHaveBeenCalledTimes(1)
    expect(g.run.snapshot().finished?.stopSignals).toBe(0)
  })

  it('重复停止不能重试；中途错误的清理依靠关闭输入、等待独立恢复，不结束守护者', async () => {
    const f = fixture()
    await f.run.stop()
    await expect(f.run.stop()).rejects.toThrow('一次')
    expect(f.guardian.stop).toHaveBeenCalledTimes(1)
    const end = await f.run.settle()
    expect(end).toMatchObject({ reason: 'controller-eof', resumedConfirmed: true })
    expect(f.guardian.close).toHaveBeenCalledTimes(1)
    expect(f.guardian.resume).not.toHaveBeenCalled()
    await expect(f.run.resume()).rejects.toThrow()
  })
})
