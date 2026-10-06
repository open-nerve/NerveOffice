// 编辑租约的规则（M3-P1 设计 §3.4.1、§3.4.5；M3-P5 设计 §3.5–§3.8）：有效条件的每个原因、判断的顺序、时间的边界，
// 以及"前五条不满足时不查第 6、7 条的事实"；M3-P5：异常结束按事实判断、从调用者看谁占着这份文档（R2）、申请怎样对待占着的那一代
// （本人接管、强制接管、重试、被占用）、被接管的那一代（心跳、保存得到 taken_over）、交出之后的保留，每个边界（恰好到期、恰好 12 分钟、
// 恰好 30 分钟、恰好保留到期）。
import type { EditLeaseLostReason } from '@nerve-office/contracts'
import type { Claimant, HolderFacts, LeaseOccupancy, LeaseRequest } from './edit-lease-rules.ts'
import type { ObservedEditLease } from './edit-leases.repository.ts'
import { Buffer } from 'node:buffer'
import { EDIT_HANDOVER_RESERVE_SECONDS, EDIT_INTERRUPTION_NOTICE_SECONDS, EDIT_LEASE_IDLE_RECLAIM_SECONDS, EDIT_LEASE_TTL_SECONDS } from '@nerve-office/contracts'
import { describe, expect, it, vi } from 'vitest'
import { NO_HANDOVER } from './documents.test-support.ts'
import { claimOf, currentLeaseLoss, endedAbnormally, isSamePage, occupancyOf, releasableBy, requestLeaseLoss, reservedFor, supersededLoss } from './edit-lease-rules.ts'
import { editLeaseTokenDigest } from './edit-lease-token.ts'

const DOCUMENT = '0199a2c4-0000-7000-8000-0000000000d1'
const AMY = '0199a2c4-0000-7000-8000-00000000000a'
const BEN = '0199a2c4-0000-7000-8000-00000000000b'
const SESSION = '0199a2c4-0000-7000-8000-0000000000e1'
const OTHER_SESSION = '0199a2c4-0000-7000-8000-0000000000e2'
const TAB = '0199a2c4-0000-7000-8000-0000000000f1'
const OTHER_TAB = '0199a2c4-0000-7000-8000-0000000000f2'
const TOKEN = `${'a'.repeat(41)}-_`
const OTHER_TOKEN = `${'b'.repeat(41)}-_`
/** 被接管的那一代的令牌（接管标记记着它的摘要） */
const TAKEN_TOKEN = `${'c'.repeat(41)}-_`
/** 文档当前的代次：租约默认就是这一代 */
const EPOCH = 3
/** 读租约那条语句里数据库的 now() */
const NOW = new Date('2026-10-04T08:00:00.000Z')

/** 相对 NOW 的时刻（毫秒） */
function at(milliseconds: number): Date {
  return new Date(NOW.getTime() + milliseconds)
}

const SECOND = 1000
const IDLE = EDIT_LEASE_IDLE_RECLAIM_SECONDS * SECOND
const NOTICE = EDIT_INTERRUPTION_NOTICE_SECONDS * SECOND

/** 一条有效的租约：10 分钟前申请，5 秒前续租（还有 85 秒到期），30 秒前有过操作；没有请求、保留与接管标记 */
function lease(overrides: Partial<ObservedEditLease> = {}): ObservedEditLease {
  return {
    documentId: DOCUMENT,
    holderId: AMY,
    sessionId: SESSION,
    clientInstanceId: TAB,
    tokenDigest: editLeaseTokenDigest(TOKEN),
    writeEpoch: EPOCH,
    acquiredAt: at(-600 * SECOND),
    renewedAt: at(-5 * SECOND),
    expiresAt: at((EDIT_LEASE_TTL_SECONDS - 5) * SECOND),
    lastActiveAt: at(-30 * SECOND),
    endedAt: null,
    endReason: null,
    ...NO_HANDOVER,
    now: NOW,
    ...overrides,
  }
}

/** 第 6、7 条的事实：记下有没有被问到 */
function facts(sessionActive = true, holderCanEdit = true) {
  return {
    sessionActive: vi.fn(async () => sessionActive),
    holderCanEdit: vi.fn(async () => holderCanEdit),
  } satisfies HolderFacts
}

/** 持有者自己的心跳：令牌与登录都对得上 */
function own(overrides: Partial<LeaseRequest> = {}): LeaseRequest {
  return { token: TOKEN, sessionId: SESSION, ...overrides }
}

/** 第 2–5 条各自不满足的租约（其余条件都满足） */
const ROW_FAILURES: readonly (readonly [EditLeaseLostReason, Partial<ObservedEditLease>])[] = [
  ['released', { endedAt: at(-SECOND), endReason: 'released' }],
  ['revoked', { endedAt: at(-SECOND), endReason: 'revoked' }],
  ['handed_over', { endedAt: at(-SECOND), endReason: 'handed_over' }],
  ['stale', { writeEpoch: EPOCH - 1 }],
  ['expired', { expiresAt: NOW }],
  ['idle', { lastActiveAt: at(-IDLE) }],
]

/** 上一位持有者（艾米）异常结束的提醒：结束的时间是她最近一次续租的时间 */
function noticeOf(row: ObservedEditLease, sameUser = false) {
  return { holderId: AMY, endedAt: row.renewedAt, sameUser }
}

/** 按时间已死、而续租在 30 分钟以内：3 分钟前最后一次续租，之后再没有心跳（90 秒前到期） */
const EXPIRED = { renewedAt: at(-180 * SECOND), expiresAt: at(-90 * SECOND), lastActiveAt: at(-180 * SECOND) }

describe('当前的租约（有效条件本身）', () => {
  it('七条都满足：有效；登录与编辑权各问一次，先问登录', async () => {
    const holder = facts()
    expect(await currentLeaseLoss(lease(), EPOCH, holder)).toBeUndefined()
    expect(holder.sessionActive).toHaveBeenCalledOnce()
    expect(holder.holderCanEdit).toHaveBeenCalledOnce()
    expect(holder.sessionActive.mock.invocationCallOrder[0]).toBeLessThan(holder.holderCanEdit.mock.invocationCallOrder[0] ?? 0)
  })

  it('没有这一行：none', async () => {
    expect(await currentLeaseLoss(undefined, EPOCH, facts())).toBe('none')
  })

  it.each(ROW_FAILURES)('第 2–5 条不满足：%s', async (reason, overrides) => {
    expect(await currentLeaseLoss(lease(overrides), EPOCH, facts())).toBe(reason)
  })

  it('第 6 条：绑定的登录已经失效（退出、被撤销、换了令牌）：session', async () => {
    expect(await currentLeaseLoss(lease(), EPOCH, facts(false))).toBe('session')
  })

  it('第 7 条：持有者已经不能编辑（权限变了、收回写入权没找到这一行）：revoked', async () => {
    expect(await currentLeaseLoss(lease(), EPOCH, facts(true, false))).toBe('revoked')
  })

  it('前五条有一条不满足：第 6、7 条的事实一个也不问（不查数据库）', async () => {
    for (const [reason, overrides] of [['none', undefined], ...ROW_FAILURES] as const) {
      const holder = facts(false, false)
      expect(await currentLeaseLoss(overrides === undefined ? undefined : lease(overrides), EPOCH, holder), reason).toBe(reason)
      expect(holder.sessionActive, reason).not.toHaveBeenCalled()
      expect(holder.holderCanEdit, reason).not.toHaveBeenCalled()
    }
  })

  it('登录已经失效：不再问编辑权', async () => {
    const holder = facts(false, false)
    expect(await currentLeaseLoss(lease(), EPOCH, holder)).toBe('session')
    expect(holder.holderCanEdit).not.toHaveBeenCalled()
  })

  it('按顺序判断，第一条不满足的就是原因', async () => {
    const ended = { endedAt: at(-SECOND), endReason: 'released' } as const
    const stale = { writeEpoch: EPOCH - 1 }
    const expired = { expiresAt: at(-SECOND) }
    const idle = { lastActiveAt: at(-2 * IDLE) }
    expect(await currentLeaseLoss(lease({ ...ended, ...stale, ...expired, ...idle }), EPOCH, facts(false, false))).toBe('released')
    expect(await currentLeaseLoss(lease({ ...stale, ...expired, ...idle }), EPOCH, facts(false, false))).toBe('stale')
    expect(await currentLeaseLoss(lease({ ...expired, ...idle }), EPOCH, facts(false, false))).toBe('expired')
    expect(await currentLeaseLoss(lease(idle), EPOCH, facts(false, false))).toBe('idle')
    expect(await currentLeaseLoss(lease(), EPOCH, facts(false, false))).toBe('session')
  })

  it('代次：租约的那一代不是文档现在的代次就过时，文档的代次往哪边变都一样', async () => {
    expect(await currentLeaseLoss(lease(), EPOCH + 1, facts())).toBe('stale')
    expect(await currentLeaseLoss(lease(), EPOCH - 1, facts())).toBe('stale')
  })

  it('到期的边界：到期的时刻恰好是 now 算到期，晚 1 毫秒仍然有效', async () => {
    expect(await currentLeaseLoss(lease({ expiresAt: NOW }), EPOCH, facts())).toBe('expired')
    expect(await currentLeaseLoss(lease({ expiresAt: at(-1) }), EPOCH, facts())).toBe('expired')
    expect(await currentLeaseLoss(lease({ expiresAt: at(1) }), EPOCH, facts())).toBeUndefined()
  })

  it('空闲的边界：最后活动恰好在 12 分钟前算超时，差 1 毫秒仍然有效；最后活动晚于 now（并发的续租）不算空闲', async () => {
    expect(await currentLeaseLoss(lease({ lastActiveAt: at(-IDLE) }), EPOCH, facts())).toBe('idle')
    expect(await currentLeaseLoss(lease({ lastActiveAt: at(-IDLE - 1) }), EPOCH, facts())).toBe('idle')
    expect(await currentLeaseLoss(lease({ lastActiveAt: at(-IDLE + 1) }), EPOCH, facts())).toBeUndefined()
    expect(await currentLeaseLoss(lease({ lastActiveAt: at(SECOND) }), EPOCH, facts())).toBeUndefined()
  })

  it('时间只看读出时数据库的 now：同一行换一个 now，结论跟着变', async () => {
    const row = lease({ expiresAt: at(10 * SECOND) })
    expect(await currentLeaseLoss(row, EPOCH, facts())).toBeUndefined()
    expect(await currentLeaseLoss({ ...row, now: at(10 * SECOND) }, EPOCH, facts())).toBe('expired')
  })
})

describe('请求带的租约（心跳、保存：持有者自己的请求）', () => {
  it('令牌、代次、登录都对得上：有效；保存另带的标签页与代次也对得上', () => {
    expect(requestLeaseLoss(lease(), EPOCH, own())).toBeUndefined()
    expect(requestLeaseLoss(lease(), EPOCH, own({ clientInstanceId: TAB, writeEpoch: EPOCH }))).toBeUndefined()
  })

  it('没有这一行、没带令牌：none（没带令牌时这一行再有效也一样）', () => {
    expect(requestLeaseLoss(undefined, EPOCH, own())).toEqual({ reason: 'none' })
    expect(requestLeaseLoss(lease(), EPOCH, own({ token: undefined }))).toEqual({ reason: 'none' })
  })

  it('令牌对不上：replaced——这一行是新的一代，不论它现在有没有效；不带 forced（只有被接管时带）', () => {
    expect(requestLeaseLoss(lease(), EPOCH, own({ token: OTHER_TOKEN }))).toEqual({ reason: 'replaced' })
    for (const [reason, overrides] of ROW_FAILURES)
      expect(requestLeaseLoss(lease(overrides), EPOCH, own({ token: OTHER_TOKEN })), reason).toEqual({ reason: 'replaced' })
  })

  it.each(ROW_FAILURES)('令牌对得上，第 2–5 条不满足：%s', (reason, overrides) => {
    expect(requestLeaseLoss(lease(overrides), EPOCH, own())).toEqual({ reason })
  })

  it('保存带的代次不是租约的这一代：stale（与租约的代次过时同一条，排在到期之前）', () => {
    expect(requestLeaseLoss(lease(), EPOCH, own({ writeEpoch: EPOCH - 1 }))).toEqual({ reason: 'stale' })
    expect(requestLeaseLoss(lease(), EPOCH, own({ writeEpoch: EPOCH + 1 }))).toEqual({ reason: 'stale' })
    expect(requestLeaseLoss(lease({ expiresAt: at(-SECOND) }), EPOCH, own({ writeEpoch: EPOCH - 1 }))).toEqual({ reason: 'stale' })
    expect(requestLeaseLoss(lease({ endedAt: at(-SECOND), endReason: 'revoked' }), EPOCH, own({ writeEpoch: EPOCH - 1 }))).toEqual({ reason: 'revoked' })
  })

  it('第 6 条换成"请求的登录、标签页就是租约绑定的那一个"：登录换了（换过令牌）、保存的标签页不是这一个，都是 session', () => {
    expect(requestLeaseLoss(lease(), EPOCH, own({ sessionId: OTHER_SESSION }))).toEqual({ reason: 'session' })
    expect(requestLeaseLoss(lease(), EPOCH, own({ clientInstanceId: OTHER_TAB }))).toEqual({ reason: 'session' })
  })

  it('心跳不带标签页：只凭令牌（令牌只发给了申请的那一个标签页）', () => {
    expect(requestLeaseLoss(lease(), EPOCH, { token: TOKEN, sessionId: SESSION })).toBeUndefined()
  })

  it('按顺序判断：令牌在第 2 条之前；登录与标签页在到期、空闲之后', () => {
    expect(requestLeaseLoss(lease({ endedAt: at(-SECOND), endReason: 'released' }), EPOCH, own({ token: OTHER_TOKEN }))).toEqual({ reason: 'replaced' })
    expect(requestLeaseLoss(lease({ expiresAt: at(-SECOND) }), EPOCH, own({ sessionId: OTHER_SESSION }))).toEqual({ reason: 'expired' })
    expect(requestLeaseLoss(lease({ lastActiveAt: at(-IDLE) }), EPOCH, own({ clientInstanceId: OTHER_TAB }))).toEqual({ reason: 'idle' })
  })

  it('边界与当前的租约相同：恰好到期、恰好 12 分钟都算失效', () => {
    expect(requestLeaseLoss(lease({ expiresAt: NOW }), EPOCH, own())).toEqual({ reason: 'expired' })
    expect(requestLeaseLoss(lease({ lastActiveAt: at(-IDLE) }), EPOCH, own())).toEqual({ reason: 'idle' })
    expect(requestLeaseLoss(lease({ expiresAt: at(1), lastActiveAt: at(-IDLE + 1) }), EPOCH, own())).toBeUndefined()
  })
})

describe('M3-P5 被接管的那一代：令牌对不上时，对得上接管标记就是 taken_over（带方式），否则照旧 replaced（设计 §3.7、§3.8）', () => {
  /** 这一代接管了 TAKEN_TOKEN 的那一代 */
  const takenOver = (takeover: 'self' | 'forced') => lease({ takenOverTokenDigest: editLeaseTokenDigest(TAKEN_TOKEN), takeover })

  it('本人接管（self）：taken_over，forced 为假；强制接管（forced）：forced 为真', () => {
    expect(supersededLoss(takenOver('self'), TAKEN_TOKEN)).toEqual({ reason: 'taken_over', forced: false })
    expect(supersededLoss(takenOver('forced'), TAKEN_TOKEN)).toEqual({ reason: 'taken_over', forced: true })
  })

  it('有接管标记、令牌不是被接管的那一代的（更早的一代，或者接管之后又换过一代——标记只记一层）：replaced，不带方式', () => {
    for (const takeover of ['self', 'forced'] as const)
      expect(supersededLoss(takenOver(takeover), OTHER_TOKEN), takeover).toEqual({ reason: 'replaced' })
  })

  it('没有接管标记（普通的申请改写了这一行）：replaced', () => {
    expect(supersededLoss(lease(), TAKEN_TOKEN)).toEqual({ reason: 'replaced' })
    expect(supersededLoss(lease(), OTHER_TOKEN)).toEqual({ reason: 'replaced' })
  })

  it('比的是摘要：标记里存的是令牌的 SHA-256 摘要，把令牌原文的字节当摘要存进去对不上', () => {
    expect(supersededLoss(lease({ takenOverTokenDigest: Buffer.from(TAKEN_TOKEN.slice(0, 32), 'utf8'), takeover: 'self' }), TAKEN_TOKEN)).toEqual({ reason: 'replaced' })
  })

  it('心跳、保存（requestLeaseLoss）：令牌是被接管的那一代的——taken_over 带方式，排在别的原因之前（这一行之后到期、过时、结束了也一样）；别的旧令牌照旧 replaced；这一行自己的令牌照常', () => {
    for (const takeover of ['self', 'forced'] as const) {
      const forced = takeover === 'forced'
      expect(requestLeaseLoss(takenOver(takeover), EPOCH, own({ token: TAKEN_TOKEN })), takeover).toEqual({ reason: 'taken_over', forced })
      for (const [reason, overrides] of ROW_FAILURES)
        expect(requestLeaseLoss(lease({ ...overrides, takenOverTokenDigest: editLeaseTokenDigest(TAKEN_TOKEN), takeover }), EPOCH, own({ token: TAKEN_TOKEN })), `${takeover} ${reason}`).toEqual({ reason: 'taken_over', forced })
      expect(requestLeaseLoss(takenOver(takeover), EPOCH, own({ token: OTHER_TOKEN })), takeover).toEqual({ reason: 'replaced' })
      expect(requestLeaseLoss(takenOver(takeover), EPOCH, own()), takeover).toBeUndefined()
    }
  })
})

describe('M3-P5 申请怎样对待占着的那一代：普通的申请、页面自己的重试、本人接管、强制接管、被占用（设计 §3.4、§3.7、§3.8）', () => {
  /** 申请的人：本（别人）；艾米在同一次登录的别的标签页、在别的设备；艾米就是持有这一代的那个页面 */
  const BEN_PAGE: Claimant = { userId: BEN, sessionId: OTHER_SESSION, clientInstanceId: OTHER_TAB }
  const AMY_OTHER_TAB: Claimant = { userId: AMY, sessionId: SESSION, clientInstanceId: OTHER_TAB }
  const AMY_OTHER_DEVICE: Claimant = { userId: AMY, sessionId: OTHER_SESSION, clientInstanceId: TAB }
  const AMY_SAME_PAGE: Claimant = { userId: AMY, sessionId: SESSION, clientInstanceId: TAB }
  /** 申请带的接管方式：普通的申请、本人接管、强制接管 */
  const MODES = [undefined, 'self', 'force'] as const
  type Occupied = Extract<LeaseOccupancy, { kind: 'occupied' }>
  const valid: Occupied = { kind: 'occupied', lease: lease(), stale: false }
  /** R2：代次过时、而持有者按时间、登录、编辑权都还活着（只对别人是占着的） */
  const stale: Occupied = { kind: 'occupied', lease: lease({ writeEpoch: EPOCH - 1 }), stale: true }

  it('没人占着（没有这一行、上一代失效了）：一律是普通的申请，带不带接管方式都一样——没有可接管的，不写接管标记，强制接管也不写审计', () => {
    const vacancies: readonly Extract<LeaseOccupancy, { kind: 'vacant' }>[] = [
      { kind: 'vacant', lease: undefined, loss: 'none', interruption: undefined },
      { kind: 'vacant', lease: lease(EXPIRED), loss: 'expired', interruption: noticeOf(lease(EXPIRED)) },
      { kind: 'vacant', lease: lease({ endedAt: at(-SECOND), endReason: 'released' }), loss: 'released', interruption: undefined },
    ]
    for (const vacancy of vacancies) {
      for (const claimant of [BEN_PAGE, AMY_OTHER_TAB, AMY_SAME_PAGE]) {
        for (const mode of MODES)
          expect(claimOf(vacancy, claimant, mode), `${vacancy.loss} ${claimant.userId} ${String(mode)}`).toEqual({ kind: 'fresh' })
      }
    }
  })

  it('占着的就是这个页面自己的那一代（同一个登录、同一个标签页，例如上次的回包丢了）：重试——带不带接管方式都一样，不当成一次接管（标记由仓储沿用，不另写审计）', () => {
    for (const mode of MODES)
      expect(claimOf(valid, AMY_SAME_PAGE, mode), String(mode)).toEqual({ kind: 'retry' })
  })

  it('本人接管：占着的是自己在别的标签页、别的设备上的有效租约——接管它（self）；强制接管遇到自己的同样是本人接管（不写审计）；没带接管方式是被占用', () => {
    for (const claimant of [AMY_OTHER_TAB, AMY_OTHER_DEVICE]) {
      expect(claimOf(valid, claimant, 'self'), claimant.sessionId).toEqual({ kind: 'takeOver', takeover: 'self', lease: valid.lease })
      expect(claimOf(valid, claimant, 'force'), claimant.sessionId).toEqual({ kind: 'takeOver', takeover: 'self', lease: valid.lease })
      expect(claimOf(valid, claimant, undefined), claimant.sessionId).toEqual({ kind: 'held', lease: valid.lease })
    }
  })

  it('占着的是别人（有效的租约，或 R2 的）：强制接管接管它（forced）；本人接管不起作用、普通的申请——都是被占用', () => {
    for (const occupancy of [valid, stale]) {
      const name = occupancy.stale ? 'R2' : '有效'
      expect(claimOf(occupancy, BEN_PAGE, 'force'), name).toEqual({ kind: 'takeOver', takeover: 'forced', lease: occupancy.lease })
      expect(claimOf(occupancy, BEN_PAGE, 'self'), name).toEqual({ kind: 'held', lease: occupancy.lease })
      expect(claimOf(occupancy, BEN_PAGE, undefined), name).toEqual({ kind: 'held', lease: occupancy.lease })
    }
  })

  it('重试按登录与标签页一起认：别人报了与持有者相同的标签页标识（标签页标识是页面自报的）也不是重试——强制接管照样是接管别人', () => {
    expect(claimOf(valid, { userId: BEN, sessionId: OTHER_SESSION, clientInstanceId: TAB }, 'force')).toEqual({ kind: 'takeOver', takeover: 'forced', lease: valid.lease })
    expect(claimOf(valid, { userId: BEN, sessionId: OTHER_SESSION, clientInstanceId: TAB }, undefined)).toEqual({ kind: 'held', lease: valid.lease })
  })
})

describe('M3-P5 异常结束按事实判断（设计 §3.5，US-M3-10）：没有明确结束，并且已到期、空闲满 12 分钟或登录失效', () => {
  it('到期、空闲满 12 分钟、登录失效：都是异常结束；按时间已死时不问登录', async () => {
    for (const row of [lease(EXPIRED), lease({ lastActiveAt: at(-IDLE) })]) {
      const sessionActive = vi.fn(async () => true)
      expect(await endedAbnormally(row, sessionActive)).toBe(true)
      expect(sessionActive).not.toHaveBeenCalled()
    }
    expect(await endedAbnormally(lease(), async () => false)).toBe(true)
  })

  it('代次过时不遮住它（P1 审查 A6 第 1 处）：先到期、后被跨空间移动或转移——仍是异常结束', async () => {
    expect(await endedAbnormally(lease({ ...EXPIRED, writeEpoch: EPOCH - 1 }), async () => true)).toBe(true)
  })

  it('不算：明确结束（释放、收回、交出——到期了也一样）、按时间与登录都还活着（代次过时、持有者没了编辑权的也一样）；明确结束时不问登录', async () => {
    for (const reason of ['released', 'revoked', 'handed_over'] as const) {
      const sessionActive = vi.fn(async () => false)
      expect(await endedAbnormally(lease({ ...EXPIRED, endedAt: at(-SECOND), endReason: reason }), sessionActive), reason).toBe(false)
      expect(sessionActive, reason).not.toHaveBeenCalled()
    }
    expect(await endedAbnormally(lease(), async () => true)).toBe(false)
    expect(await endedAbnormally(lease({ writeEpoch: EPOCH - 1 }), async () => true)).toBe(false)
  })

  it('时间的边界与有效条件相同：恰好到期、恰好 12 分钟算死（异常结束），差 1 毫秒仍活着', async () => {
    const alive = async () => true
    expect(await endedAbnormally(lease({ expiresAt: NOW }), alive)).toBe(true)
    expect(await endedAbnormally(lease({ expiresAt: at(1) }), alive)).toBe(false)
    expect(await endedAbnormally(lease({ lastActiveAt: at(-IDLE) }), alive)).toBe(true)
    expect(await endedAbnormally(lease({ lastActiveAt: at(-IDLE + 1) }), alive)).toBe(false)
  })
})

describe('M3-P5 从调用者看谁占着这份文档（申请、编辑状态；设计 §3.5）', () => {
  it('没有这一行：空着（none），没有提醒，什么也不问', async () => {
    const holder = facts()
    expect(await occupancyOf(undefined, EPOCH, BEN, holder)).toEqual({ kind: 'vacant', lease: undefined, loss: 'none', interruption: undefined })
    expect(holder.sessionActive).not.toHaveBeenCalled()
  })

  it('有效的租约：对谁都是占着的（包括持有者自己在别的标签页、设备上），登录与编辑权各问一次', async () => {
    const row = lease()
    for (const caller of [BEN, AMY]) {
      const holder = facts()
      expect(await occupancyOf(row, EPOCH, caller, holder), caller).toEqual({ kind: 'occupied', lease: row, stale: false })
      expect([holder.sessionActive.mock.calls.length, holder.holderCanEdit.mock.calls.length], caller).toEqual([1, 1])
    }
  })

  it('R2：代次过时、而按时间、登录、编辑权都还活着——别人看是占着的（stale），只让持有者本人续上：他看是空着的，没有提醒', async () => {
    const row = lease({ writeEpoch: EPOCH - 1 })
    const others = facts()
    expect(await occupancyOf(row, EPOCH, BEN, others)).toEqual({ kind: 'occupied', lease: row, stale: true })
    expect([others.sessionActive.mock.calls.length, others.holderCanEdit.mock.calls.length]).toEqual([1, 1])
    // 持有者本人：普通的申请；按时间还活着，问一次登录（异常结束的判断），不问编辑权
    const self = facts()
    expect(await occupancyOf(row, EPOCH, AMY, self)).toEqual({ kind: 'vacant', lease: row, loss: 'stale', interruption: undefined })
    expect([self.sessionActive.mock.calls.length, self.holderCanEdit.mock.calls.length]).toEqual([1, 0])
  })

  it('R2 要"都还活着"：代次过时而按时间已死、登录失效——空着，异常结束有提醒；持有者没了编辑权——空着，没有提醒', async () => {
    for (const overrides of [EXPIRED, { lastActiveAt: at(-IDLE) }]) {
      const row = lease({ ...overrides, writeEpoch: EPOCH - 1 })
      const holder = facts()
      expect(await occupancyOf(row, EPOCH, BEN, holder)).toEqual({ kind: 'vacant', lease: row, loss: 'stale', interruption: noticeOf(row) })
      // 按时间已死：登录与编辑权一个也不问
      expect([holder.sessionActive.mock.calls.length, holder.holderCanEdit.mock.calls.length]).toEqual([0, 0])
    }
    const stale = lease({ writeEpoch: EPOCH - 1 })
    const loggedOut = facts(false)
    expect(await occupancyOf(stale, EPOCH, BEN, loggedOut)).toEqual({ kind: 'vacant', lease: stale, loss: 'stale', interruption: noticeOf(stale) })
    // 登录只问一次（R2 与异常结束共用），登录失效就不再问编辑权
    expect([loggedOut.sessionActive.mock.calls.length, loggedOut.holderCanEdit.mock.calls.length]).toEqual([1, 0])
    const demoted = facts(true, false)
    expect(await occupancyOf(stale, EPOCH, BEN, demoted)).toEqual({ kind: 'vacant', lease: stale, loss: 'stale', interruption: undefined })
    expect([demoted.sessionActive.mock.calls.length, demoted.holderCanEdit.mock.calls.length]).toEqual([1, 1])
  })

  it('R2 的时间边界与有效条件相同：恰好到期、恰好空闲 12 分钟就不再占着；差 1 毫秒仍占着', async () => {
    const stale = { writeEpoch: EPOCH - 1 }
    expect((await occupancyOf(lease({ ...stale, expiresAt: NOW }), EPOCH, BEN, facts())).kind).toBe('vacant')
    expect((await occupancyOf(lease({ ...stale, expiresAt: at(1) }), EPOCH, BEN, facts())).kind).toBe('occupied')
    expect((await occupancyOf(lease({ ...stale, lastActiveAt: at(-IDLE) }), EPOCH, BEN, facts())).kind).toBe('vacant')
    expect((await occupancyOf(lease({ ...stale, lastActiveAt: at(-IDLE + 1) }), EPOCH, BEN, facts())).kind).toBe('occupied')
  })

  it('明确结束的（释放、收回、交出，代次也过时了的同样）：空着，没有提醒，什么也不问', async () => {
    for (const reason of ['released', 'revoked', 'handed_over'] as const) {
      for (const writeEpoch of [EPOCH, EPOCH - 1]) {
        const row = lease({ endedAt: at(-SECOND), endReason: reason, writeEpoch })
        const holder = facts()
        expect(await occupancyOf(row, EPOCH, BEN, holder), `${reason} ${writeEpoch}`).toEqual({ kind: 'vacant', lease: row, loss: reason, interruption: undefined })
        expect(holder.sessionActive).not.toHaveBeenCalled()
      }
    }
  })

  it('US-M3-10 异常结束（到期、空闲、登录失效）：空着，提醒是上一位持有者与他最近一次续租的时间；登录只问一次', async () => {
    for (const [expected, row, holder] of [
      ['expired', lease(EXPIRED), facts()],
      ['idle', lease({ lastActiveAt: at(-IDLE) }), facts()],
      ['session', lease(), facts(false)],
    ] as const) {
      expect(await occupancyOf(row, EPOCH, BEN, holder), expected).toEqual({ kind: 'vacant', lease: row, loss: expected, interruption: noticeOf(row) })
      expect(holder.sessionActive.mock.calls.length, expected).toBeLessThanOrEqual(1)
      expect(holder.holderCanEdit, expected).not.toHaveBeenCalled()
    }
  })

  it('US-M3-10 有意改掉 P1 的预期（设计 §3.5，P1 审查 A6 第 1 处）：先到期、后代次过时（跨空间移动、转移），原来取第一条失效原因 stale、不提醒——现在按事实算异常结束，照样提醒', async () => {
    const row = lease({ ...EXPIRED, writeEpoch: EPOCH - 1 })
    expect(await occupancyOf(row, EPOCH, BEN, facts())).toEqual({ kind: 'vacant', lease: row, loss: 'stale', interruption: noticeOf(row) })
  })

  it('US-M3-10 有效时没了编辑权（不经收回写入权的入口，第 7 条）：空着，不是异常结束，没有提醒', async () => {
    const row = lease()
    expect(await occupancyOf(row, EPOCH, BEN, facts(true, false))).toEqual({ kind: 'vacant', lease: row, loss: 'revoked', interruption: undefined })
  })

  it('US-M3-10 提醒带上上一位持有者是不是调用者自己（sameUser，只按人比较，与登录、标签页无关）', async () => {
    const row = lease({ lastActiveAt: at(-IDLE) })
    expect(await occupancyOf(row, EPOCH, AMY, facts())).toMatchObject({ kind: 'vacant', interruption: noticeOf(row, true) })
    expect(await occupancyOf(row, EPOCH, BEN, facts())).toMatchObject({ kind: 'vacant', interruption: noticeOf(row, false) })
  })

  it('US-M3-10 结束在 30 分钟以内才给：恰好 30 分钟仍然给，再晚 1 毫秒就不给', async () => {
    const ended = (milliseconds: number) => lease({ renewedAt: at(-milliseconds), expiresAt: at(-milliseconds + EDIT_LEASE_TTL_SECONDS * SECOND), lastActiveAt: at(-milliseconds) })
    expect(await occupancyOf(ended(NOTICE), EPOCH, BEN, facts())).toMatchObject({ kind: 'vacant', loss: 'expired', interruption: { holderId: AMY, endedAt: at(-NOTICE), sameUser: false } })
    expect(await occupancyOf(ended(NOTICE + 1), EPOCH, BEN, facts())).toMatchObject({ kind: 'vacant', loss: 'expired', interruption: undefined })
    // 代次过时的同样只看续租的时间
    expect(await occupancyOf({ ...ended(NOTICE + 1), writeEpoch: EPOCH - 1 }, EPOCH, BEN, facts())).toMatchObject({ kind: 'vacant', interruption: undefined })
  })
})

describe('M3-P5 交出之后的保留（设计 §3.6）：有保留、没过期、被保留的人仍能编辑，才算数', () => {
  /** 交出之后的一行：明确结束（handed_over），保留给本 */
  const handedOver = (reservedUntil: Date) => lease({ endedAt: at(-SECOND), endReason: 'handed_over', reservedFor: BEN, reservedUntil })

  it('算数：留给的人；问的是被保留的人能不能编辑', async () => {
    const canEdit = vi.fn(async () => true)
    expect(await reservedFor(handedOver(at(EDIT_HANDOVER_RESERVE_SECONDS * SECOND)), canEdit)).toBe(BEN)
    expect(canEdit.mock.calls).toEqual([[BEN]])
  })

  it('恰好保留到期算过期（与租约的到期同一个边界），不问编辑权；差 1 毫秒仍算数', async () => {
    const canEdit = vi.fn(async () => true)
    expect(await reservedFor(handedOver(NOW), canEdit)).toBeUndefined()
    expect(await reservedFor(handedOver(at(-1)), canEdit)).toBeUndefined()
    expect(canEdit).not.toHaveBeenCalled()
    expect(await reservedFor(handedOver(at(1)), canEdit)).toBe(BEN)
  })

  it('被保留的人已经不能编辑（被降级、移出、取消授权）：不算数', async () => {
    expect(await reservedFor(handedOver(at(SECOND)), async () => false)).toBeUndefined()
  })

  it('没有保留、没有这一行：不算数，不问', async () => {
    const canEdit = vi.fn(async () => true)
    expect(await reservedFor(lease(), canEdit)).toBeUndefined()
    expect(await reservedFor(undefined, canEdit)).toBeUndefined()
    expect(canEdit).not.toHaveBeenCalled()
  })
})

describe('申请时这一行是不是页面自己的（同一个登录、同一个标签页：重试）', () => {
  it('登录与标签页都对得上才是；同一个人换了标签页或换了登录（别的设备）都不是', () => {
    expect(isSamePage(lease(), SESSION, TAB)).toBe(true)
    expect(isSamePage(lease(), SESSION, OTHER_TAB)).toBe(false)
    expect(isSamePage(lease(), OTHER_SESSION, TAB)).toBe(false)
  })
})

describe('释放：令牌是当前这一行的、没有明确结束、释放的人是持有者', () => {
  it('对得上、没有结束、是持有者：可以释放；到期、空闲的照样可以；不要求同一个登录（换令牌之后续上，要先释放自己那一代）', () => {
    expect(releasableBy(lease(), TOKEN, AMY)).toBe(true)
    expect(releasableBy(lease({ expiresAt: at(-SECOND), lastActiveAt: at(-IDLE) }), TOKEN, AMY)).toBe(true)
    expect(releasableBy(lease({ sessionId: OTHER_SESSION }), TOKEN, AMY)).toBe(true)
  })

  it('没有这一行、没带令牌、令牌不是这一行的、已经释放、收回或交出：不动它', () => {
    expect(releasableBy(undefined, TOKEN, AMY)).toBe(false)
    expect(releasableBy(lease(), undefined, AMY)).toBe(false)
    expect(releasableBy(lease(), OTHER_TOKEN, AMY)).toBe(false)
    for (const reason of ['released', 'revoked', 'handed_over'] as const)
      expect(releasableBy(lease({ endedAt: at(-SECOND), endReason: reason }), TOKEN, AMY), reason).toBe(false)
  })

  it('别人拿到了令牌（例如经代理的访问日志外泄）：不是持有者，不动它（M3-P1 审查 A4）', () => {
    expect(releasableBy(lease(), TOKEN, BEN)).toBe(false)
  })
})
