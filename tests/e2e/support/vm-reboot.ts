import type { VmBoot } from './vm-durability.ts'

export interface VmRebootProof {
  readonly before: VmBoot
  readonly after: VmBoot
  readonly signal: 'SIGKILL'
  readonly exited: true
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
function bounded(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}
export function isVmBoot(value: unknown): value is VmBoot {
  return object(value) && exact(value, ['resourceId', 'pid', 'uid', 'startedAt', 'guestBootId', 'disk'])
    && typeof value.resourceId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.resourceId)
    && positive(value.pid) && typeof value.uid === 'number' && Number.isSafeInteger(value.uid) && value.uid >= 0
    && bounded(value.startedAt) && bounded(value.guestBootId)
    && object(value.disk) && exact(value.disk, ['path', 'device', 'inode'])
    && typeof value.disk.path === 'string' && value.disk.path.startsWith('/') && positive(value.disk.device) && positive(value.disk.inode)
}
function sameDisk(a: VmBoot, b: VmBoot): boolean {
  return a.disk.path === b.disk.path && a.disk.device === b.disk.device && a.disk.inode === b.disk.inode
}
function sameBoot(a: VmBoot, b: VmBoot): boolean {
  return a.resourceId === b.resourceId && a.pid === b.pid && a.uid === b.uid && a.startedAt === b.startedAt
    && a.guestBootId === b.guestBootId && sameDisk(a, b)
}
export function isVmRebootProof(value: unknown, before: VmBoot): value is VmRebootProof {
  return object(value) && exact(value, ['before', 'after', 'signal', 'exited']) && value.signal === 'SIGKILL' && value.exited === true
    && isVmBoot(value.before) && isVmBoot(value.after) && sameBoot(before, value.before)
    && value.after.resourceId === value.before.resourceId && value.after.uid === value.before.uid
    && value.after.pid !== value.before.pid && value.after.startedAt !== value.before.startedAt
    && value.after.guestBootId !== value.before.guestBootId && sameDisk(value.before, value.after)
}
