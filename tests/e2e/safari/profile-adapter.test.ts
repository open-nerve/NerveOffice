import { describe, expect, it, vi } from 'vitest'
import { createProfileExecutor, parseProfileProof } from './profile-adapter.ts'
import { identifyProfilePage } from './profile-process.ts'

const NOW = 1_790_000_000_000
const proof = () => ({ name: 'NerveOffice M4-P3 验证', windowId: 123, axWindowUuid: '9dd78b07-671f-443e-b107-a0b54f40c3e4', exclusiveFromCreation: true, extensionsDisabled: true, createdAt: NOW - 9000, baseline: { capturedAt: NOW - 10_000, pids: [1, 10, 11] } })

function fixture(deadline = NOW + 10_000) {
  const context = { url: 'http://127.0.0.1:40001/documents/test?selftest=crash-recovery', uid: 501, mainPid: 10, profile: proof(), deadline }
  const process = { pid: 42, uid: 501, executable: '/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent', startedAtUs: String(BigInt(NOW - 8000) * 1000n), bundleId: 'com.apple.WebKit.WebContent', asn: 'ASN:0x0-0xa:', appleSigned: true }
  const snapshot = { capturedAt: NOW, finishedAt: NOW + 10, desktop: { idleSeconds: 150, locked: false, returned: false }, processes: [process], windows: [{ windowId: 123, profileMatches: true, tabs: [{ index: 1, pid: 42, urlMatches: true }] }] }
  const first = identifyProfilePage(context, snapshot, NOW + 20)
  if (first.kind !== 'identified')
    throw new Error('测试准备目标失败')
  const capture = vi.fn(() => ({ ...snapshot, capturedAt: NOW + 30, finishedAt: NOW + 40 }))
  const send = vi.fn(() => ({ kind: 'signaled' as const, pid: 42, startedAtUs: process.startedAtUs, sentAt: NOW + 50, signal: 'SIGKILL' as const, signalsSent: 1 as const }))
  return { first: first.target, snapshot, capture, send, execute: createProfileExecutor(context, { capture, now: () => NOW + 50, send }) }
}

describe('专用场景证明与单次执行边界', () => {
  it('第二次完整采集仍新鲜但本轮截止时刻已经到达时不得发送', () => {
    const h = fixture(NOW + 45)
    expect(() => h.execute(h.first)).toThrow()
    expect(h.send).not.toHaveBeenCalled()
  })
  it('完整创建证明可读，未知字段、缺少基线或窗口 UUID 一律拒绝', () => {
    expect(parseProfileProof(proof())).toEqual(proof())
    for (const value of [null, {}, { ...proof(), additional: 'unexpected' }, { ...proof(), baseline: undefined }, { ...proof(), axWindowUuid: 'not-uuid' }])
      expect(() => parseProfileProof(value)).toThrow()
  })

  it('必须先二次采集后才发送，而且整个运行只有一次发送机会', () => {
    const h = fixture()
    expect(h.execute(h.first).receipt.signalsSent).toBe(1)
    expect(h.capture.mock.invocationCallOrder[0]).toBeLessThan(h.send.mock.invocationCallOrder[0]!)
    expect(h.send).toHaveBeenCalledExactlyOnceWith({ ...h.first, observedAt: NOW + 30 })
    expect(() => h.execute(h.first)).toThrow('已经尝试')
    expect(h.send).toHaveBeenCalledTimes(1)
  })

  it.each(['locked', 'returned', 'old', 'reused', 'other-tab'] as const)('二次采集出现 %s 时完全不调用发送器', (problem) => {
    const h = fixture()
    const next = h.capture()
    if (problem === 'locked')
      next.desktop = { ...next.desktop, locked: true }
    if (problem === 'returned')
      next.desktop = { ...next.desktop, returned: true }
    if (problem === 'old')
      next.capturedAt = NOW
    if (problem === 'reused')
      next.processes = next.processes.map(process => ({ ...process, startedAtUs: String(BigInt(NOW - 7000) * 1000n) }))
    if (problem === 'other-tab')
      next.windows = [...next.windows, { windowId: 456, profileMatches: false, tabs: [{ index: 1, pid: 42, urlMatches: false }] }]
    h.capture.mockReturnValue(next)
    expect(() => h.execute(h.first)).toThrow()
    expect(h.send).not.toHaveBeenCalled()
  })

  it('采集或发送器异常之后没有重试和仅按 PID 发送的退路', () => {
    const h = fixture()
    h.send.mockImplementationOnce(() => {
      throw new Error('原生身份已变化')
    })
    expect(() => h.execute(h.first)).toThrow('原生身份已变化')
    expect(() => h.execute(h.first)).toThrow('已经尝试')
    expect(h.send).toHaveBeenCalledTimes(1)
    const another = fixture()
    another.capture.mockImplementationOnce(() => {
      throw new Error('AppleEvent 超时')
    })
    expect(() => another.execute(another.first)).toThrow('AppleEvent 超时')
    expect(another.send).not.toHaveBeenCalled()
  })
})
