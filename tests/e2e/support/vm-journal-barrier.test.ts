import { describe, expect, it, vi } from 'vitest'
import { freezeVmJournal, isVmJournalReceipt } from './vm-journal-barrier.ts'

const before = { resourceId: '1f1f40c3-1579-4657-9902-9f1f804fdde1', pid: 1234, uid: 501, startedAt: '1000000', guestBootId: 'guest-boot', disk: { path: '/owned/disk.img', device: 1, inode: 2 } }
const data = () => ({ kind: 'product-frozen', runId: before.resourceId, mode: 'vm-power-cut' as const, before: structuredClone(before), ready: { draftSeq: 1, snapshotHash: 'a'.repeat(64) } })

describe('共享 VM 落档屏障只能在实际写入完成后签发一次不可复制的资格', () => {
  it('挂起写入期间没有资格，成功后冻结原始证据并拒绝复制件', async () => {
    let complete!: () => void
    const blocked = new Promise<void>(resolve => complete = resolve)
    const input = data()
    let settled = false
    const append = vi.fn(async () => blocked)
    const promise = freezeVmJournal(input, append, () => 2000).then((receipt) => {
      settled = true
      return receipt
    })
    input.ready.draftSeq = 99
    await vi.waitFor(() => expect(append).toHaveBeenCalledOnce())
    expect(settled).toBe(false)
    complete()
    const receipt = await promise
    expect(receipt.ready.draftSeq).toBe(1)
    expect(Object.isFrozen(receipt.ready)).toBe(true)
    expect(receipt.journaledAt).toBe(2000)
    expect(isVmJournalReceipt(receipt)).toBe(true)
    expect(isVmJournalReceipt(structuredClone(receipt))).toBe(false)
  })

  it('写入失败时不会返回信号资格', async () => {
    await expect(freezeVmJournal(data(), async () => {
      throw new Error('fsync failed')
    }, () => 2000)).rejects.toThrow('fsync failed')
  })

  it('普通控制轮可以留档，但不能取得 VM 信号资格', async () => {
    const receipt = await freezeVmJournal({ ...data(), mode: 'control' as const }, async () => {}, () => 2000)
    expect(isVmJournalReceipt(receipt)).toBe(false)
  })

  it('没有有效磁盘身份的 VM 记录不调用落档端口', async () => {
    const append = vi.fn(async () => {})
    await expect(freezeVmJournal({ ...data(), before: undefined }, append, () => 2000)).rejects.toThrow()
    expect(append).not.toHaveBeenCalled()
  })
})
