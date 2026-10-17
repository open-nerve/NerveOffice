import { describe, expect, it, vi } from 'vitest'
import { createVmKillGuard } from './owned-vm.ts'
import { createVmDurabilityRound } from './vm-durability.ts'

const RUN = '7f1f40c3-1579-4657-9902-9f1f804fdde1'
const PAGE = '8f1f40c3-1579-4657-9902-9f1f804fdde1'
const HASH = 'a'.repeat(64)
const identity = { pid: 1234, ppid: 4321, uid: 501, startedAtUs: '1780000000000000', executable: '/owned/tart' }
const disk = { path: '/owned/disk.img', device: 1, inode: 9 }
const boot = { resourceId: RUN, pid: identity.pid, uid: identity.uid, startedAt: identity.startedAtUs, guestBootId: 'guest-boot', disk }
const owned = { identity, boot, command: '/owned/tart run test-vm', ownerSha256: HASH }

async function frozen(before = boot) {
  const round = createVmDurabilityRound({ runId: RUN, mode: 'vm-power-cut', durability: 'strict', cutAtSeq: 1, before, digestFor: () => HASH, append: async () => {}, now: () => 2000 })
  await round.receive({ kind: 'boot', runId: RUN, bootId: PAGE })
  await round.receive({ kind: 'completed', runId: RUN, bootId: PAGE, requested: 'strict', actual: 'strict', seq: 1, digest: HASH, completedAt: 1000 })
  return round.freeze()
}

function setup() {
  const snapshot = { running: true, identity: { ...identity }, disk: { ...disk }, command: owned.command, ownerSha256: HASH }
  const send = vi.fn(() => ({ kind: 'signaled' as const, signal: 'SIGKILL' as const, pid: identity.pid, startedAtUs: identity.startedAtUs, sentAt: 2100, signalsSent: 1 as const }))
  const capture = vi.fn(() => snapshot)
  let now = 2100
  const guard = createVmKillGuard(owned, { capture, send, now: () => now })
  return { guard, capture, send, snapshot, setNow: (value: number) => {
    now = value
  } }
}

describe('VM 信号资格只属于本次已登记、已冻结且仍相同的子进程', () => {
  it('临发复核后只发一次 SIGKILL，不先尝试 SIGINT 或正常关机', async () => {
    const h = setup()
    const receipt = await frozen()
    expect(h.guard(receipt)).toMatchObject({ signal: 'SIGKILL', pid: identity.pid, signalsSent: 1 })
    expect(h.capture).toHaveBeenCalledOnce()
    expect(h.send).toHaveBeenCalledExactlyOnceWith(identity)
    expect(() => h.guard(receipt)).toThrow()
    expect(h.send).toHaveBeenCalledOnce()
  })

  it.each([undefined, {}, { runId: RUN }])('没有模块实际签发的 journal 凭证不能发信号：%j', (receipt) => {
    const h = setup()
    expect(() => h.guard(receipt)).toThrow()
    expect(h.send).not.toHaveBeenCalled()
  })

  it('序列化复制的凭证、另一 VM 的真实凭证都不能借用', async () => {
    const h = setup()
    const awaitedReceipt = await frozen()
    expect(() => h.guard(structuredClone(awaitedReceipt))).toThrow()
    const other = setup()
    const receipt = await frozen({ ...boot, resourceId: PAGE })
    expect(() => other.guard(receipt)).toThrow()
    expect(other.send).not.toHaveBeenCalled()
  })

  it.each([
    { running: false },
    { identity: { ...identity, pid: 9999 } },
    { identity: { ...identity, ppid: 9999 } },
    { identity: { ...identity, uid: 502 } },
    { identity: { ...identity, startedAtUs: '1780000000000001' } },
    { identity: { ...identity, executable: '/other/tart' } },
    { command: '/owned/tart run other-vm' },
    { ownerSha256: 'b'.repeat(64) },
    { disk: { ...disk, path: '/other/disk.img' } },
    { disk: { ...disk, inode: 10 } },
    { disk: { ...disk, device: 2 } },
  ])('进程、资源登记或磁盘身份变化时不发信号：%j', async (change) => {
    const h = setup()
    Object.assign(h.snapshot, change)
    const receipt = await frozen()
    expect(() => h.guard(receipt)).toThrow()
    expect(h.send).not.toHaveBeenCalled()
  })

  it.each([1000, 8001])('冻结凭证来自未来或超过五秒时拒绝：%s', async (now) => {
    const h = setup()
    h.setNow(now)
    const receipt = await frozen()
    expect(() => h.guard(receipt)).toThrow()
    expect(h.send).not.toHaveBeenCalled()
  })

  it('原生复核异常时无后备按 PID 结束，也不重复尝试', async () => {
    const h = setup()
    h.capture.mockImplementation(() => {
      throw new Error('内核接口不可用')
    })
    const receipt = await frozen()
    expect(() => h.guard(receipt)).toThrow()
    expect(() => h.guard(receipt)).toThrow()
    expect(h.capture).toHaveBeenCalledOnce()
    expect(h.send).not.toHaveBeenCalled()
  })

  it('登记的启动证明和内核进程不一致时立即拒绝', () => {
    const h = setup()
    expect(() => createVmKillGuard({ ...owned, boot: { ...boot, pid: 4567 } }, {
      capture: h.capture,
      send: h.send,
      now: () => 2100,
    })).toThrow()
    expect(h.send).not.toHaveBeenCalled()
  })

  it('临发复核耗时导致冻结凭证过期时不发信号', async () => {
    const h = setup()
    h.capture.mockImplementation(() => {
      h.setNow(8001)
      return h.snapshot
    })
    const receipt = await frozen()
    expect(() => h.guard(receipt)).toThrow()
    expect(h.send).not.toHaveBeenCalled()
  })

  it('原生回执错报 PID 时不能宣布成功，也不会补发信号', async () => {
    const h = setup()
    h.send.mockReturnValue({ kind: 'signaled', signal: 'SIGKILL', pid: 9999, startedAtUs: identity.startedAtUs, sentAt: 2100, signalsSent: 1 })
    const receipt = await frozen()
    expect(() => h.guard(receipt)).toThrow()
    expect(() => h.guard(receipt)).toThrow()
    expect(h.send).toHaveBeenCalledOnce()
  })
})
