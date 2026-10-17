import type { ProfilePageContext, ProfilePageTarget } from './profile-process.ts'
import { describe, expect, it, vi } from 'vitest'
import { createPauseChannel } from './profile-pause-adapter.ts'

const NOW = 1_800_000_000_000
const target: ProfilePageTarget = { pid: 5010, uid: 501, startedAtUs: '1799999999000000', executable: '/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent', bundleId: 'com.apple.WebKit.WebContent', asn: 'ASN:0x0-0x123:', appleSigned: true, windowId: 1, profileName: '测试', url: 'http://127.0.0.1:5000/document', observedAt: NOW }
const context: ProfilePageContext = { url: target.url, uid: 501, mainPid: 4000, deadline: NOW + 200_000, profile: { name: '测试', windowId: 1, axWindowUuid: 'ac408a8c-18e2-4efa-860c-735a001175ec', exclusiveFromCreation: true, extensionsDisabled: true, createdAt: NOW - 5000, baseline: { capturedAt: NOW - 6000, pids: [4000] } } }
const kernel = { pid: target.pid, uid: 501, ppid: 1, startedAtUs: target.startedAtUs, executable: target.executable }
const ready = { kind: 'ready', guardian: { pid: 6010, uid: 501, startedAtUs: '1799999999999000' }, at: NOW, monoMs: 100 }
const stopped = { kind: 'stopped', target: kernel, signalAt: NOW + 10, signalMonoMs: 110, at: NOW + 11, monoMs: 111, stopSignals: 1, maxPauseMs: 180_000 }
const finished = { kind: 'finished', target: kernel, reason: 'requested', at: NOW + 1000, monoMs: 1100, continueAt: NOW + 999, continueMonoMs: 1099, stopSignals: 1, continueSignals: 1, stoppedConfirmed: true, resumedConfirmed: true }
function fixture() {
  const send = vi.fn()
  const close = vi.fn()
  const channel = createPauseChannel({ guardianPid: 6010, now: () => NOW + 5, send, close })
  return { send, close, channel }
}

describe('原生暂停控制通道', () => {
  it('ready 之前不发 stop，失败会关闭输入让守护者自行收尾', async () => {
    const f = fixture()
    await expect(f.channel.stop(context, target)).rejects.toThrow()
    expect(f.send).not.toHaveBeenCalled()
    expect(f.close).toHaveBeenCalledTimes(1)
  })

  it.each([
    { ...target, observedAt: NOW - 2000 },
    { ...target, uid: 502 },
    { ...target, pid: context.mainPid },
    { ...target, url: 'http://127.0.0.1:5000/other' },
    { ...target, profileName: '其他场景' },
    { ...target, windowId: 2 },
  ])('过期或归属变化的目标不能发往原生程序：%j', async (changed) => {
    const f = fixture()
    f.channel.receive(ready)
    await expect(f.channel.stop(context, changed)).rejects.toThrow()
    expect(f.send).not.toHaveBeenCalled()
    expect(f.close).toHaveBeenCalledTimes(1)
  })

  it('依次握手、一次暂停、一次恢复，退出后才交回完成回执', async () => {
    const f = fixture()
    f.channel.receive(ready)
    await expect(f.channel.ready).resolves.toEqual(ready)
    const stop = f.channel.stop(context, target)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.send.mock.calls[0]?.[0]).toMatchObject({ kind: 'stop', mainPid: context.mainPid, observedAt: target.observedAt, deadline: context.deadline, maxPauseMs: 180_000 })
    f.channel.receive(stopped)
    await expect(stop).resolves.toEqual(stopped)
    f.channel.resume()
    expect(f.send).toHaveBeenLastCalledWith({ kind: 'resume' })
    f.channel.receive(finished)
    const settled = vi.fn()
    void f.channel.finished.then(settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    f.channel.exited(0, null)
    await expect(f.channel.finished).resolves.toEqual(finished)
  })

  it('重复 stop 不能变成第二次操作，即使第一次已经发出', async () => {
    const f = fixture()
    f.channel.receive(ready)
    const pending = f.channel.stop(context, target)
    await expect(f.channel.stop(context, target)).rejects.toThrow()
    await expect(pending).rejects.toThrow()
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.close).toHaveBeenCalledTimes(1)
  })

  it('未暂停或重复 resume 不会向原生程序发 CONT 命令', () => {
    const f = fixture()
    expect(() => f.channel.resume()).toThrow()
    expect(f.send).not.toHaveBeenCalled()
    const g = fixture()
    g.channel.receive(ready)
    void g.channel.stop(context, target)
    g.channel.receive(stopped)
    g.channel.resume()
    expect(() => g.channel.resume()).toThrow()
    expect(g.send).toHaveBeenCalledTimes(2)
    expect(g.close).toHaveBeenCalledTimes(1)
  })

  it.each([null, {}, { ...ready, unexpected: true }, { ...ready, guardian: { ...ready.guardian, pid: 6011 } }])('坏回执关闭控制输入，不伪造恢复：%j', async (event) => {
    const f = fixture()
    f.channel.receive(event)
    await expect(f.channel.ready).rejects.toThrow()
    await expect(f.channel.finished).rejects.toThrow()
    expect(f.close).toHaveBeenCalledTimes(1)
    expect(f.send).not.toHaveBeenCalled()
  })

  it('写入失败及没有终态就退出都明确失败，并关闭控制输入', async () => {
    const f = fixture()
    f.channel.receive(ready)
    f.send.mockImplementation(() => {
      throw new Error('broken pipe')
    })
    await expect(f.channel.stop(context, target)).rejects.toThrow('broken pipe')
    expect(f.close).toHaveBeenCalledTimes(1)
    const g = fixture()
    g.channel.receive(ready)
    g.channel.exited(0, null)
    await expect(g.channel.finished).rejects.toThrow()
    expect(g.close).toHaveBeenCalledTimes(1)
  })

  it('正常回执后原生异常退出仍不算通过', async () => {
    const f = fixture()
    f.channel.receive(ready)
    void f.channel.stop(context, target)
    f.channel.receive(stopped)
    f.channel.resume()
    f.channel.receive(finished)
    f.channel.exited(null, 'SIGKILL')
    await expect(f.channel.finished).rejects.toThrow()
  })

  it('没有由控制端请求恢复，不接受 requested 终态', async () => {
    const f = fixture()
    f.channel.receive(ready)
    void f.channel.stop(context, target)
    f.channel.receive(stopped)
    f.channel.receive(finished)
    f.channel.exited(0, null)
    await expect(f.channel.finished).rejects.toThrow()
    expect(f.close).toHaveBeenCalledTimes(1)
  })
})
