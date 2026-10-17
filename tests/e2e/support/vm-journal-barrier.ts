import type { VmBoot } from './vm-durability.ts'
import { isVmBoot } from './vm-reboot.ts'

interface Data {
  readonly runId: string
  readonly mode: 'vm-power-cut' | 'control' | 'reload-calibration'
  readonly before?: VmBoot
}
export interface VmJournalReceipt {
  readonly runId: string
  readonly mode: 'vm-power-cut'
  readonly before: VmBoot
  readonly journaledAt: number
}
const issued = new WeakSet<object>()

function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null)
    return
  for (const item of Object.values(value))
    deepFreeze(item)
  Object.freeze(value)
}

/** append 的契约是宿主 fsync 完成；等待期间不发资格，也不接受后来改写的输入。 */
export async function freezeVmJournal<T extends Data>(input: T, append: (value: T) => Promise<void>, now: () => number) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.runId)
    || !['vm-power-cut', 'control', 'reload-calibration'].includes(input.mode)
    || (input.mode === 'vm-power-cut' && !isVmBoot(input.before))) {
    throw new Error('VM 落档屏障缺少有效身份')
  }
  const data = structuredClone(input)
  deepFreeze(data)
  await append(data)
  const receipt = Object.freeze({ ...data, journaledAt: now() })
  if (receipt.mode === 'vm-power-cut')
    issued.add(receipt)
  return receipt
}

export function isVmJournalReceipt(value: unknown): value is VmJournalReceipt {
  return typeof value === 'object' && value !== null && issued.has(value)
}
