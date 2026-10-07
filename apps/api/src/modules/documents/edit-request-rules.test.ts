// 请求编辑的规则（M3-P5 设计 §3.6）：槽里的请求（五列齐全才算）、它的情形（每一条、顺序、恰好过期的边界、按需问事实）与待回应的请求，
// 发出与续期时的回答（EditRequestOutcome 的每一种 kind，连同回答要用的那一行、槽里的请求与保留）与要不要写——请求接口据此回答与写库。
import type { LeaseOccupancy } from './edit-lease-rules.ts'
import type { ObservedEditLease } from './edit-leases.repository.ts'
import type { PartyFacts } from './edit-request-rules.ts'
import { EDIT_HANDOVER_RESERVE_SECONDS, EDIT_LEASE_TTL_SECONDS, EDIT_REQUEST_TTL_SECONDS } from '@nerve-office/contracts'
import { describe, expect, it, vi } from 'vitest'
import { NO_HANDOVER } from './documents.test-support.ts'
import { editLeaseTokenDigest } from './edit-lease-token.ts'
import { decideRequestRenewal, decideRequestSend, pendingRequestOf, requestStandingOf, slotRequestOf } from './edit-request-rules.ts'

const DOCUMENT = '0199a2c4-0000-7000-8000-0000000000d1'
/** 持有者 */
const AMY = '0199a2c4-0000-7000-8000-00000000000a'
/** 请求方 */
const BEN = '0199a2c4-0000-7000-8000-00000000000b'
/** 第三个人 */
const CAT = '0199a2c4-0000-7000-8000-00000000000c'
const AMY_SESSION = '0199a2c4-0000-7000-8000-0000000000e1'
const BEN_SESSION = '0199a2c4-0000-7000-8000-0000000000e2'
const REQUEST = '0199a2c4-0000-7000-8000-0000000000aa'
const NOW = new Date('2026-10-07T08:00:00.000Z')
const SECOND = 1000

function at(milliseconds: number): Date {
  return new Date(NOW.getTime() + milliseconds)
}

/** 艾米正在编辑的一行（有效与否由 occupancy 决定，这里只摆列） */
function lease(overrides: Partial<ObservedEditLease> = {}): ObservedEditLease {
  return {
    documentId: DOCUMENT,
    holderId: AMY,
    sessionId: AMY_SESSION,
    clientInstanceId: '0199a2c4-0000-7000-8000-0000000000f1',
    tokenDigest: editLeaseTokenDigest(`${'a'.repeat(41)}-_`),
    writeEpoch: 1,
    acquiredAt: at(-60 * SECOND),
    renewedAt: at(-5 * SECOND),
    expiresAt: at((EDIT_LEASE_TTL_SECONDS - 5) * SECOND),
    lastActiveAt: at(-5 * SECOND),
    endedAt: null,
    endReason: null,
    ...NO_HANDOVER,
    now: NOW,
    ...overrides,
  }
}

/** 槽里有 requester 的请求：一分钟前发出，有效期按续期往后推（还有 9 分钟） */
function requested(requester: string = BEN, overrides: Partial<ObservedEditLease> = {}): ObservedEditLease {
  return lease({
    requestId: REQUEST,
    requestedBy: requester,
    requestSessionId: BEN_SESSION,
    requestedAt: at(-60 * SECOND),
    requestExpiresAt: at((EDIT_REQUEST_TTL_SECONDS - 60) * SECOND),
    ...overrides,
  })
}

/** 交出之后的保留到何时 */
const RESERVED_UNTIL = at(EDIT_HANDOVER_RESERVE_SECONDS * SECOND)

/** 交出之后的一行：明确结束（handed_over），保留给 reservedFor，请求已经转成保留 */
function handedOver(reservedFor: string): ObservedEditLease {
  return lease({ endedAt: at(-SECOND), endReason: 'handed_over', reservedFor, reservedUntil: RESERVED_UNTIL })
}

/** requested() 摆的槽里的请求（规则交回的样子） */
function slot(requester: string = BEN, declinedAt: Date | null = null) {
  return { id: REQUEST, requesterId: requester, sessionId: BEN_SESSION, requestedAt: at(-60 * SECOND), expiresAt: at((EDIT_REQUEST_TTL_SECONDS - 60) * SECOND), declinedAt }
}

/** 请求方与被保留的人的事实：记下问了谁 */
function partyFacts(options: { readonly sessionActive?: boolean, readonly canEdit?: boolean } = {}) {
  return {
    sessionActive: vi.fn(async (_sessionId: string) => options.sessionActive ?? true),
    canEdit: vi.fn(async (_userId: string) => options.canEdit ?? true),
  } satisfies PartyFacts
}

const occupied = (row: ObservedEditLease, stale = false): LeaseOccupancy => ({ kind: 'occupied', lease: row, stale })
const vacant = (row: ObservedEditLease | undefined): LeaseOccupancy => ({ kind: 'vacant', lease: row, loss: row === undefined ? 'none' : 'expired', interruption: undefined })

describe('槽里的请求：五列都有值才算（表上的约束让它们同时为空或同时有值），交回带类型的请求', () => {
  it('五列齐全：标识、请求方、请求方的登录、发出的时刻、有效期，与谢绝的时刻（没谢绝时为 null）', () => {
    expect(slotRequestOf(requested())).toEqual(slot())
    expect(slotRequestOf(requested(BEN, { requestDeclinedAt: at(-SECOND) }))).toEqual(slot(BEN, at(-SECOND)))
  })

  it('没有这一行、槽空着，或者五列里缺了任何一列：没有请求', () => {
    expect(slotRequestOf(undefined)).toBeUndefined()
    expect(slotRequestOf(lease())).toBeUndefined()
    for (const column of ['requestId', 'requestedBy', 'requestSessionId', 'requestedAt', 'requestExpiresAt'] as const)
      expect(slotRequestOf(requested(BEN, { [column]: null })), column).toBeUndefined()
  })
})

describe('待回应的请求：情形是 pending 时槽里的那一个（心跳、编辑状态、被占用的详情、交出只认它）', () => {
  it('待回应：交回槽里的请求', async () => {
    expect(await pendingRequestOf(requested(), partyFacts())).toEqual(slot())
  })

  it('已谢绝、已过期、请求方的登录失效、请求方没了编辑权、槽空着、没有这一行：没有', async () => {
    expect(await pendingRequestOf(requested(BEN, { requestDeclinedAt: at(-SECOND) }), partyFacts())).toBeUndefined()
    expect(await pendingRequestOf(requested(BEN, { requestExpiresAt: NOW }), partyFacts())).toBeUndefined()
    expect(await pendingRequestOf(requested(), partyFacts({ sessionActive: false }))).toBeUndefined()
    expect(await pendingRequestOf(requested(), partyFacts({ canEdit: false }))).toBeUndefined()
    expect(await pendingRequestOf(lease(), partyFacts())).toBeUndefined()
    expect(await pendingRequestOf(undefined, partyFacts())).toBeUndefined()
  })
})

describe('槽里的请求的情形：按顺序判断，第一条不满足的就是它', () => {
  it('都满足：待回应；先问请求方绑定的登录，再问请求方能不能编辑', async () => {
    const facts = partyFacts()
    expect(await requestStandingOf(requested(), facts)).toBe('pending')
    expect(facts.sessionActive.mock.calls).toEqual([[BEN_SESSION]])
    expect(facts.canEdit.mock.calls).toEqual([[BEN]])
    expect(facts.sessionActive.mock.invocationCallOrder[0]).toBeLessThan(facts.canEdit.mock.invocationCallOrder[0] ?? 0)
  })

  it('没有请求、没有这一行：none', async () => {
    expect(await requestStandingOf(lease(), partyFacts())).toBe('none')
    expect(await requestStandingOf(undefined, partyFacts())).toBe('none')
  })

  it('持有者谢绝了：declined——排在过期之前（被谢绝之后不再续期的请求，请求方回来时仍然得知被谢绝）', async () => {
    expect(await requestStandingOf(requested(BEN, { requestDeclinedAt: at(-SECOND) }), partyFacts())).toBe('declined')
    expect(await requestStandingOf(requested(BEN, { requestDeclinedAt: at(-SECOND), requestExpiresAt: at(-SECOND) }), partyFacts())).toBe('declined')
  })

  it('过期的边界：恰好到期算过期，晚 1 毫秒仍待回应', async () => {
    expect(await requestStandingOf(requested(BEN, { requestExpiresAt: NOW }), partyFacts())).toBe('expired')
    expect(await requestStandingOf(requested(BEN, { requestExpiresAt: at(-1) }), partyFacts())).toBe('expired')
    expect(await requestStandingOf(requested(BEN, { requestExpiresAt: at(1) }), partyFacts())).toBe('pending')
  })

  it('请求方绑定的登录失效（退出、被撤销、换了令牌）：session；请求方不能编辑了（被降级、移出、取消授权）：revoked', async () => {
    expect(await requestStandingOf(requested(), partyFacts({ sessionActive: false }))).toBe('session')
    expect(await requestStandingOf(requested(), partyFacts({ canEdit: false }))).toBe('revoked')
  })

  it('按需问：没有请求、谢绝了、过期了，登录与编辑权一个也不问；登录失效就不再问编辑权', async () => {
    for (const row of [lease(), requested(BEN, { requestDeclinedAt: at(-SECOND) }), requested(BEN, { requestExpiresAt: NOW })]) {
      const facts = partyFacts({ sessionActive: false, canEdit: false })
      await requestStandingOf(row, facts)
      expect([facts.sessionActive.mock.calls.length, facts.canEdit.mock.calls.length]).toEqual([0, 0])
    }
    const facts = partyFacts({ sessionActive: false })
    await requestStandingOf(requested(), facts)
    expect(facts.canEdit).not.toHaveBeenCalled()
  })
})

describe('发出请求编辑（POST）：怎样回答、要不要写', () => {
  it('self：占着的就是调用者自己（别的标签页或设备），交回那一行（正在编辑的人），不写，也不看槽', async () => {
    const facts = partyFacts()
    const row = requested(CAT)
    expect(await decideRequestSend(occupied(row), AMY, facts)).toEqual({ kind: 'self', holder: row })
    expect(facts.sessionActive).not.toHaveBeenCalled()
  })

  it('pending（new）：别人占着、槽空着——写下一个新的请求，交回占着的那一行', async () => {
    const row = lease()
    expect(await decideRequestSend(occupied(row), BEN, partyFacts())).toEqual({ kind: 'pending', write: 'new', holder: row })
  })

  it('occupied：槽里是别人待回应的请求（单槽、先到先得），交回那个请求（先请求的人与时刻），不写', async () => {
    expect(await decideRequestSend(occupied(requested(CAT)), BEN, partyFacts())).toEqual({ kind: 'occupied', request: slot(CAT) })
  })

  it('pending（extend）：槽里是调用者自己待回应的请求——续期，标识不变', async () => {
    const row = requested(BEN)
    expect(await decideRequestSend(occupied(row), BEN, partyFacts())).toEqual({ kind: 'pending', write: 'extend', holder: row })
  })

  it('pending（new）：槽里的请求已谢绝或已失效（不占槽）——别人的被替换；调用者自己被谢绝之后显式再点一次，换成新的请求', async () => {
    const stale: readonly ObservedEditLease[] = [
      requested(CAT, { requestDeclinedAt: at(-SECOND) }),
      requested(CAT, { requestExpiresAt: NOW }),
      requested(BEN, { requestDeclinedAt: at(-SECOND) }),
      requested(BEN, { requestExpiresAt: NOW }),
    ]
    for (const row of stale)
      expect(await decideRequestSend(occupied(row), BEN, partyFacts()), `${row.requestedBy} ${String(row.requestDeclinedAt)}`).toEqual({ kind: 'pending', write: 'new', holder: row })
    // 请求方的登录失效、没了编辑权的请求同样不占槽
    expect(await decideRequestSend(occupied(requested(CAT)), BEN, partyFacts({ sessionActive: false }))).toMatchObject({ kind: 'pending', write: 'new' })
    expect(await decideRequestSend(occupied(requested(CAT)), BEN, partyFacts({ canEdit: false }))).toMatchObject({ kind: 'pending', write: 'new' })
  })

  it('R2 的"占着"（代次过时、其余都活着）与有效的一样：请求写在这一行上，等持有者续上', async () => {
    const row = lease()
    expect(await decideRequestSend(occupied(row, true), BEN, partyFacts())).toEqual({ kind: 'pending', write: 'new', holder: row })
  })

  it('没人占着：保留留给了调用者——reserved；留给了别人——reservedForOther（都交回保留）；没有算数的保留——free。都不写', async () => {
    expect(await decideRequestSend(vacant(handedOver(BEN)), BEN, partyFacts())).toEqual({ kind: 'reserved', reservation: { reservedFor: BEN, reservedUntil: RESERVED_UNTIL } })
    expect(await decideRequestSend(vacant(handedOver(CAT)), BEN, partyFacts())).toEqual({ kind: 'reservedForOther', reservation: { reservedFor: CAT, reservedUntil: RESERVED_UNTIL } })
    expect(await decideRequestSend(vacant(lease()), BEN, partyFacts())).toEqual({ kind: 'free' })
    expect(await decideRequestSend(vacant(undefined), BEN, partyFacts())).toEqual({ kind: 'free' })
    // 槽里还留着调用者的请求（持有者释放了、到期了）：照样 free，立即申请
    expect(await decideRequestSend(vacant(requested(BEN)), BEN, partyFacts())).toEqual({ kind: 'free' })
  })

  it('保留不算数（被保留的人没了编辑权；过期）：free', async () => {
    expect(await decideRequestSend(vacant(handedOver(CAT)), BEN, partyFacts({ canEdit: false }))).toEqual({ kind: 'free' })
    expect(await decideRequestSend(vacant({ ...handedOver(CAT), reservedUntil: NOW }), BEN, partyFacts())).toEqual({ kind: 'free' })
  })
})

describe('请求方续期（PUT）：怎样回答、要不要续期', () => {
  it('reserved：没人占着，保留留给了调用者（交出之后请求已经转成保留），交回保留，不续期', async () => {
    expect(await decideRequestRenewal(vacant(handedOver(BEN)), BEN, partyFacts())).toEqual({ kind: 'reserved', reservation: { reservedFor: BEN, reservedUntil: RESERVED_UNTIL }, extend: false })
  })

  it('pending：槽里是调用者待回应的请求、别人占着（有效的，或 R2 的）——续期，交回占着的那一行', async () => {
    const row = requested(BEN)
    expect(await decideRequestRenewal(occupied(row), BEN, partyFacts())).toEqual({ kind: 'pending', holder: row, extend: true })
    expect(await decideRequestRenewal(occupied(row, true), BEN, partyFacts())).toEqual({ kind: 'pending', holder: row, extend: true })
  })

  it('free：槽里是调用者待回应的请求、没人占着（持有者的页面不在了、释放了）——续期（页面看不见时接着等，持有者续上之后照常）', async () => {
    expect(await decideRequestRenewal(vacant(requested(BEN)), BEN, partyFacts())).toEqual({ kind: 'free', extend: true })
    expect(await decideRequestRenewal(vacant(requested(BEN, { endedAt: at(-SECOND), endReason: 'released' })), BEN, partyFacts())).toEqual({ kind: 'free', extend: true })
  })

  it('declined：槽里是调用者的请求，持有者谢绝了——交回那个请求与这一行（谢绝的人），不续期；谢绝之后过期了、没人占着也一样', async () => {
    const row = requested(BEN, { requestDeclinedAt: at(-SECOND) })
    expect(await decideRequestRenewal(occupied(row), BEN, partyFacts())).toEqual({ kind: 'declined', request: slot(BEN, at(-SECOND)), holder: row, extend: false })
    const expired = requested(BEN, { requestDeclinedAt: at(-SECOND), requestExpiresAt: NOW })
    expect(await decideRequestRenewal(vacant(expired), BEN, partyFacts())).toEqual({ kind: 'declined', request: { ...slot(BEN, at(-SECOND)), expiresAt: NOW }, holder: expired, extend: false })
  })

  it('gone：槽里不是调用者的请求（空槽、别人的、没有这一行），或者它已失效（过期、登录失效、没了编辑权）——不续期；交回现在占着的那一行，没人占着时没有', async () => {
    for (const occupancy of [occupied(lease()), occupied(requested(CAT))])
      expect(await decideRequestRenewal(occupancy, BEN, partyFacts())).toEqual({ kind: 'gone', holder: occupancy.lease, extend: false })
    for (const occupancy of [vacant(undefined), vacant(lease()), vacant(requested(CAT))])
      expect(await decideRequestRenewal(occupancy, BEN, partyFacts())).toEqual({ kind: 'gone', holder: undefined, extend: false })
    const expired = requested(BEN, { requestExpiresAt: NOW })
    expect(await decideRequestRenewal(occupied(expired), BEN, partyFacts())).toEqual({ kind: 'gone', holder: expired, extend: false })
    const row = requested(BEN)
    expect(await decideRequestRenewal(occupied(row), BEN, partyFacts({ sessionActive: false }))).toEqual({ kind: 'gone', holder: row, extend: false })
    expect(await decideRequestRenewal(occupied(row), BEN, partyFacts({ canEdit: false }))).toEqual({ kind: 'gone', holder: row, extend: false })
    expect(await decideRequestRenewal(vacant(row), BEN, partyFacts({ canEdit: false }))).toEqual({ kind: 'gone', holder: undefined, extend: false })
  })

  it('保留留给了别人：调用者的请求不在了时 gone；还在（交出转的是别人的请求，在一致的数据里走不到）时 reservedForOther，交回保留，续期', async () => {
    expect(await decideRequestRenewal(vacant(handedOver(CAT)), BEN, partyFacts())).toEqual({ kind: 'gone', holder: undefined, extend: false })
    const both = { ...handedOver(CAT), ...requested(BEN), endedAt: at(-SECOND), endReason: 'handed_over' as const, reservedFor: CAT, reservedUntil: at(SECOND) }
    expect(await decideRequestRenewal(vacant(both), BEN, partyFacts())).toEqual({ kind: 'reservedForOther', reservation: { reservedFor: CAT, reservedUntil: at(SECOND) }, extend: true })
  })

  it('有人占着时不看保留（保留只在交出之后有，那时没人占着）：不问被保留的人的编辑权', async () => {
    const facts = partyFacts()
    await decideRequestRenewal(occupied(requested(BEN)), BEN, facts)
    expect(facts.canEdit.mock.calls).toEqual([[BEN]])
  })
})
