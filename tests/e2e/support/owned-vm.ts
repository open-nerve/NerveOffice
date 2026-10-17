import type { VmBoot } from './vm-durability.ts'
import { isDeepStrictEqual } from 'node:util'
import { isVmJournalReceipt } from './vm-journal-barrier.ts'

export interface VmNativeIdentity {
  readonly pid: number
  readonly ppid: number
  readonly uid: number
  readonly startedAtUs: string
  readonly executable: string
}

export interface VmSignalReceipt {
  readonly kind: 'signaled'
  readonly signal: 'SIGKILL'
  readonly pid: number
  readonly startedAtUs: string
  readonly sentAt: number
  readonly signalsSent: 1
}

interface OwnedVm {
  readonly identity: VmNativeIdentity
  readonly boot: VmBoot
  readonly command: string
  readonly ownerSha256: string
}

interface Ports {
  readonly capture: () => {
    readonly running: boolean
    readonly identity: VmNativeIdentity
    readonly disk: VmBoot['disk']
    readonly command: string
    readonly ownerSha256: string
  }
  readonly send: (identity: VmNativeIdentity) => VmSignalReceipt
  readonly now: () => number
}

/** 只为本次启动的一个 VM 签发一次信号；任何复核错误都会消耗资格。 */
export function createVmKillGuard(owned: OwnedVm, ports: Ports) {
  const expected = structuredClone(owned)
  if (expected.boot.pid !== expected.identity.pid || expected.boot.uid !== expected.identity.uid
    || expected.boot.startedAt !== expected.identity.startedAtUs) {
    throw new Error('VM 启动登记与进程身份不一致')
  }
  let attempted = false
  return (receipt: unknown): VmSignalReceipt => {
    if (attempted)
      throw new Error('本次 VM 信号资格已消耗')
    attempted = true
    if (!isVmJournalReceipt(receipt) || receipt.mode !== 'vm-power-cut'
      || !isDeepStrictEqual(receipt.before, expected.boot)) {
      throw new Error('缺少属于本 VM 的持久冻结凭证')
    }
    function fresh() {
      if (!isVmJournalReceipt(receipt))
        throw new Error('冻结凭证无效')
      const age = ports.now() - receipt.journaledAt
      if (!Number.isFinite(age) || age < 0 || age > 5000)
        throw new Error('冻结凭证已过期或时钟倒退')
    }
    fresh()
    const current = ports.capture()
    if (!current.running || !isDeepStrictEqual(current.identity, expected.identity)
      || !isDeepStrictEqual(current.disk, expected.boot.disk)
      || current.command !== expected.command || current.ownerSha256 !== expected.ownerSha256) {
      throw new Error('VM 进程、命令、磁盘或归属登记已变化')
    }
    fresh()
    const result = ports.send(expected.identity)
    if (result.kind !== 'signaled' || result.signal !== 'SIGKILL' || result.signalsSent !== 1
      || result.pid !== expected.identity.pid || result.startedAtUs !== expected.identity.startedAtUs
      || !Number.isSafeInteger(result.sentAt) || result.sentAt < receipt.journaledAt
      || result.sentAt - receipt.journaledAt > 5000) {
      throw new Error('原生 VM 信号结果不匹配；禁止再次尝试')
    }
    return result
  }
}
