// 编辑租约的有效条件（M3-P1 设计 §3.4.1）与异常结束（§3.4.5）：每个原因、判断的顺序、时间的边界，
// 以及"前五条不满足时不查第 6、7 条的事实"。
import type { EditLeaseLostReason } from '@nerve-office/contracts'
import type { HolderFacts, LeaseRequest } from './edit-lease-rules.ts'
import type { ObservedEditLease } from './edit-leases.repository.ts'
import { EDIT_INTERRUPTION_NOTICE_SECONDS, EDIT_LEASE_IDLE_RECLAIM_SECONDS, EDIT_LEASE_TTL_SECONDS } from '@nerve-office/contracts'
import { describe, expect, it, vi } from 'vitest'
import { currentLeaseLoss, interruptionOf, isSamePage, releasableBy, requestLeaseLoss } from './edit-lease-rules.ts'
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

/** 一条有效的租约：10 分钟前申请，5 秒前续租（还有 85 秒到期），30 秒前有过操作 */
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
  ['stale', { writeEpoch: EPOCH - 1 }],
  ['expired', { expiresAt: NOW }],
  ['idle', { lastActiveAt: at(-IDLE) }],
]

describe('当前的租约（申请、编辑状态：从旁判断）', () => {
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
    expect(requestLeaseLoss(undefined, EPOCH, own())).toBe('none')
    expect(requestLeaseLoss(lease(), EPOCH, own({ token: undefined }))).toBe('none')
  })

  it('令牌对不上：replaced——这一行是新的一代，不论它现在有没有效', () => {
    expect(requestLeaseLoss(lease(), EPOCH, own({ token: OTHER_TOKEN }))).toBe('replaced')
    for (const [reason, overrides] of ROW_FAILURES)
      expect(requestLeaseLoss(lease(overrides), EPOCH, own({ token: OTHER_TOKEN })), reason).toBe('replaced')
  })

  it.each(ROW_FAILURES)('令牌对得上，第 2–5 条不满足：%s', (reason, overrides) => {
    expect(requestLeaseLoss(lease(overrides), EPOCH, own())).toBe(reason)
  })

  it('保存带的代次不是租约的这一代：stale（与租约的代次过时同一条，排在到期之前）', () => {
    expect(requestLeaseLoss(lease(), EPOCH, own({ writeEpoch: EPOCH - 1 }))).toBe('stale')
    expect(requestLeaseLoss(lease(), EPOCH, own({ writeEpoch: EPOCH + 1 }))).toBe('stale')
    expect(requestLeaseLoss(lease({ expiresAt: at(-SECOND) }), EPOCH, own({ writeEpoch: EPOCH - 1 }))).toBe('stale')
    expect(requestLeaseLoss(lease({ endedAt: at(-SECOND), endReason: 'revoked' }), EPOCH, own({ writeEpoch: EPOCH - 1 }))).toBe('revoked')
  })

  it('第 6 条换成"请求的登录、标签页就是租约绑定的那一个"：登录换了（换过令牌）、保存的标签页不是这一个，都是 session', () => {
    expect(requestLeaseLoss(lease(), EPOCH, own({ sessionId: OTHER_SESSION }))).toBe('session')
    expect(requestLeaseLoss(lease(), EPOCH, own({ clientInstanceId: OTHER_TAB }))).toBe('session')
  })

  it('心跳不带标签页：只凭令牌（令牌只发给了申请的那一个标签页）', () => {
    expect(requestLeaseLoss(lease(), EPOCH, { token: TOKEN, sessionId: SESSION })).toBeUndefined()
  })

  it('按顺序判断：令牌在第 2 条之前；登录与标签页在到期、空闲之后', () => {
    expect(requestLeaseLoss(lease({ endedAt: at(-SECOND), endReason: 'released' }), EPOCH, own({ token: OTHER_TOKEN }))).toBe('replaced')
    expect(requestLeaseLoss(lease({ expiresAt: at(-SECOND) }), EPOCH, own({ sessionId: OTHER_SESSION }))).toBe('expired')
    expect(requestLeaseLoss(lease({ lastActiveAt: at(-IDLE) }), EPOCH, own({ clientInstanceId: OTHER_TAB }))).toBe('idle')
  })

  it('边界与当前的租约相同：恰好到期、恰好 12 分钟都算失效', () => {
    expect(requestLeaseLoss(lease({ expiresAt: NOW }), EPOCH, own())).toBe('expired')
    expect(requestLeaseLoss(lease({ lastActiveAt: at(-IDLE) }), EPOCH, own())).toBe('idle')
    expect(requestLeaseLoss(lease({ expiresAt: at(1), lastActiveAt: at(-IDLE + 1) }), EPOCH, own())).toBeUndefined()
  })
})

describe('异常结束（申请改写这一行之前算，P1 设计 §3.4.5）', () => {
  const NOTICE = EDIT_INTERRUPTION_NOTICE_SECONDS * SECOND

  it('到期、空闲回收、登录失效：给出上一位持有者与结束的时间（他最近一次续租的时间）', async () => {
    // 到期：3 分钟前最后一次续租，之后再没有心跳；空闲：心跳还在，最后一次操作在 12 分钟前；登录失效：其余都满足
    const lastRenewed = at(-180 * SECOND)
    for (const [expected, row, holder] of [
      ['expired', lease({ renewedAt: lastRenewed, expiresAt: at(-90 * SECOND), lastActiveAt: lastRenewed }), facts()],
      ['idle', lease({ lastActiveAt: at(-IDLE) }), facts()],
      ['session', lease(), facts(false)],
    ] as const) {
      const loss = await currentLeaseLoss(row, EPOCH, holder)
      expect(loss).toBe(expected)
      expect(interruptionOf(row, loss), loss).toEqual({ holderId: AMY, endedAt: row.renewedAt })
    }
  })

  it('明确结束（释放、收回）、代次过时、持有者没了编辑权、没有上一个租约、上一个仍然有效：都不算', async () => {
    for (const row of [lease({ endedAt: at(-SECOND), endReason: 'released' }), lease({ endedAt: at(-SECOND), endReason: 'revoked' }), lease({ writeEpoch: EPOCH - 1, expiresAt: at(-SECOND) })])
      expect(interruptionOf(row, await currentLeaseLoss(row, EPOCH, facts()))).toBeUndefined()
    expect(interruptionOf(lease(), await currentLeaseLoss(lease(), EPOCH, facts(true, false)))).toBeUndefined()
    expect(interruptionOf(undefined, 'none')).toBeUndefined()
    expect(interruptionOf(lease(), undefined)).toBeUndefined()
  })

  it('结束在 30 分钟以内才给：恰好 30 分钟仍然给，再晚 1 毫秒就不给', () => {
    const ended = (milliseconds: number) => lease({ renewedAt: at(-milliseconds), expiresAt: at(-milliseconds + EDIT_LEASE_TTL_SECONDS * SECOND), lastActiveAt: at(-milliseconds) })
    expect(interruptionOf(ended(NOTICE), 'expired')).toEqual({ holderId: AMY, endedAt: at(-NOTICE) })
    expect(interruptionOf(ended(NOTICE + 1), 'expired')).toBeUndefined()
    expect(interruptionOf(ended(NOTICE + 1), 'idle')).toBeUndefined()
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

  it('没有这一行、没带令牌、令牌不是这一行的、已经释放或收回：不动它', () => {
    expect(releasableBy(undefined, TOKEN, AMY)).toBe(false)
    expect(releasableBy(lease(), undefined, AMY)).toBe(false)
    expect(releasableBy(lease(), OTHER_TOKEN, AMY)).toBe(false)
    expect(releasableBy(lease({ endedAt: at(-SECOND), endReason: 'released' }), TOKEN, AMY)).toBe(false)
    expect(releasableBy(lease({ endedAt: at(-SECOND), endReason: 'revoked' }), TOKEN, AMY)).toBe(false)
  })

  it('别人拿到了令牌（例如经代理的访问日志外泄）：不是持有者，不动它（M3-P1 审查 A4）', () => {
    expect(releasableBy(lease(), TOKEN, BEN)).toBe(false)
  })
})
