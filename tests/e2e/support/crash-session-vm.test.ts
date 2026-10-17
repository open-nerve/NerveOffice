import { describe, expect, it } from 'vitest'
import { createCrashSession } from './crash-session.ts'

const RUN = '1f1f40c3-1579-4657-9902-9f1f804fdde1'
const DOCUMENT = '2f1f40c3-1579-4657-9902-9f1f804fdde1'
const USER = '3f1f40c3-1579-4657-9902-9f1f804fdde1'
const BEFORE = '4f1f40c3-1579-4657-9902-9f1f804fdde1'
const AFTER = '5f1f40c3-1579-4657-9902-9f1f804fdde1'
const CLIENT = '6f1f40c3-1579-4657-9902-9f1f804fdde1'
const HASH = 'a'.repeat(64)
const SNAPSHOT = 'b'.repeat(64)
const beforeVm = { resourceId: RUN, pid: 1234, uid: 501, startedAt: '1000000', guestBootId: 'linux-boot-1', disk: { path: '/owned/disk.img', device: 1, inode: 2 } }
const afterVm = { ...beforeVm, pid: 1235, startedAt: '2000000', guestBootId: 'linux-boot-2' }
const proof = () => ({ before: structuredClone(beforeVm), after: structuredClone(afterVm), signal: 'SIGKILL', exited: true })
const boot = (bootId = BEFORE) => ({ kind: 'boot', runId: RUN, documentId: DOCUMENT, bootId })
const original = () => ({ userId: USER, clientInstanceId: CLIENT, writerId: BEFORE, draftSeq: 1, baseRevision: 1, contentHash: HASH, snapshotHash: SNAPSHOT, inFlight: false, visible: true, pageErrors: 0 })
const ready = () => ({ ...boot(), ...original(), kind: 'ready', workerWrites: 1, mirror: { draftSeq: 1, snapshotHash: SNAPSHOT } })
function setup() {
  return createCrashSession({ mode: 'vm-power-cut', runId: RUN, documentId: DOCUMENT, userId: USER, contentHash: HASH, deadline: 1000, beforeVm })
}
function prepared() {
  const session = setup()
  expect(session.receive(boot(), 10)).toEqual({ kind: 'prepare', mirrorRequired: true })
  expect(session.receive(ready(), 20)).toEqual({ kind: 'wait' })
  return session
}

describe('产品 VM 突停证据独立于页面崩溃与刷新', () => {
  it('缺少 VM 初始启动事实不能创建实验', () => {
    expect(() => createCrashSession({ mode: 'vm-power-cut', runId: RUN, documentId: DOCUMENT, userId: USER, contentHash: HASH, deadline: 1000 })).toThrow()
  })

  it.each([
    undefined,
    { draftSeq: 2, snapshotHash: SNAPSHOT },
    { draftSeq: 1, snapshotHash: HASH },
    { draftSeq: 1, snapshotHash: SNAPSHOT, secret: 'not-for-report' },
  ])('实际 OPFS 证据缺失、不一致或有额外字段时不能就绪：%j', (mirror) => {
    const session = setup()
    session.receive(boot(), 10)
    const message = ready()
    const { mirror: _removed, ...withoutMirror } = message
    expect(session.receive(mirror === undefined ? withoutMirror : { ...withoutMirror, mirror }, 20)).toEqual({ kind: 'stop' })
    expect(session.snapshot().phase).toBe('failed')
    expect(JSON.stringify(session.snapshot())).not.toContain('not-for-report')
  })

  it('不能用浏览器进程信号或普通刷新推进 VM 恢复', () => {
    expect(prepared().signaled(30)).toBe(false)
    expect(prepared().reloadedForCalibration(30)).toBe(false)
    const session = prepared()
    expect(session.receive(boot(AFTER), 30)).toEqual({ kind: 'stop' })
  })

  it.each([
    {},
    { ...proof(), signal: 'SIGINT' },
    { ...proof(), exited: false },
    { ...proof(), after: { ...afterVm, pid: beforeVm.pid } },
    { ...proof(), after: { ...afterVm, guestBootId: beforeVm.guestBootId } },
    { ...proof(), after: { ...afterVm, resourceId: AFTER } },
    { ...proof(), after: { ...afterVm, disk: { ...beforeVm.disk, inode: 3 } } },
    { ...proof(), before: { ...beforeVm, pid: 9999 } },
    { ...proof(), secret: 'not-for-report' },
  ])('不完整、不同 VM 或换盘证明不进入恢复：%j', (changed) => {
    const session = prepared()
    expect(session.vmRestarted(changed, 30)).toBe(false)
    expect(session.snapshot().phase).toBe('failed')
    expect(JSON.stringify(session.snapshot())).not.toContain('not-for-report')
  })

  it('同磁盘和新客体证明之后仍须阅读、明确确认与唯一云端修订', () => {
    const session = prepared()
    const evidence = proof()
    expect(session.vmRestarted(evidence, 30)).toBe(true)
    evidence.after.disk.inode = 999
    expect(session.receive(boot(AFTER), 40)).toEqual({ kind: 'observe' })
    expect(session.receive({ ...boot(AFTER), ...original(), kind: 'awaiting-confirmation', mode: 'reading', entry: 'restore' }, 50)).toEqual({ kind: 'wait' })
    expect(session.authorizeConfirmation({ revision: 1, contentHash: 'c'.repeat(64), acquires: [], saves: [] }, 60)).toBe(true)
    expect(session.receive({ ...boot(AFTER), kind: 'confirm' }, 70, { acquires: 0, saves: 0 })).toEqual({ kind: 'confirm' })
    expect(session.receive({ ...boot(AFTER), kind: 'restored', contentHash: HASH, mode: 'editing', recoveredNotice: true, draftRemaining: false, visible: true, pageErrors: 0 }, 80)).toEqual({ kind: 'wait' })
    expect(session.finish({ revision: 2, contentHash: HASH, acquires: [{ clientInstanceId: AFTER, takeover: null, status: 201 }], saves: [{ status: 200 }] }, 90)).toEqual([])
    expect(session.snapshot()).toMatchObject({ mode: 'vm-power-cut', phase: 'passed', vmReboot: { after: { disk: { inode: 2 } } } })
  })

  it('既有浏览器进程模式不能借用 VM 证明', () => {
    const session = createCrashSession({ mode: 'process-kill', runId: RUN, documentId: DOCUMENT, userId: USER, contentHash: HASH, deadline: 1000 })
    const { mirror: _removed, ...message } = ready()
    session.receive(boot(), 10)
    session.receive(message, 20)
    expect(session.vmRestarted(proof(), 30)).toBe(false)
    expect(session.snapshot().phase).toBe('failed')
  })
})
