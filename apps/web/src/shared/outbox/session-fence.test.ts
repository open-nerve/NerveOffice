import type { DraftSessionPermit, LocalSessionState, SessionActivation, SessionCheckTicket, SessionSource, UserCleanupPermit } from './session-fence.ts'
import { describe, expect, it } from 'vitest'
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../api/client.ts'
import { acceptSessionCheck, beginSessionChange, beginUserCleanup, canCleanUserSession, canUseDraftSession, cleanupPermitOf, createUnconfirmedSession, expireSessionChange, failSessionChange, finishUserCleanup, readDraftSessionPermit, readLocalSessionState, readSessionCheckTicket, readSessionSource, readUserCleanupPermit, SESSION_CHANGE_WINDOW_MS, sessionCheckTicket, suspendSession } from './session-fence.ts'

const NOW = 1_700_000_000_000
const G0 = '00000000-0000-4000-8000-000000000010'
const G1 = '00000000-0000-4000-8000-000000000011'
const G2 = '00000000-0000-4000-8000-000000000012'
const G3 = '00000000-0000-4000-8000-000000000013'
const G4 = '00000000-0000-4000-8000-000000000014'
const A: SessionSource = Object.freeze({ userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sourceHash: 'a'.repeat(64) })
const A_NEW: SessionSource = Object.freeze({ ...A, sourceHash: 'b'.repeat(64) })
const B: SessionSource = Object.freeze({ userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', sourceHash: 'c'.repeat(64) })
const ACTIVE: LocalSessionState = Object.freeze({ phase: 'active', generation: G1, activatedFrom: G0, source: A })
const PERMIT: DraftSessionPermit = Object.freeze({ userId: A.userId, generation: G1 })
const CLEARING: LocalSessionState = Object.freeze({ phase: 'clearing', generation: G2, source: A, cause: 'logout' })
const CLEANUP: UserCleanupPermit = Object.freeze({ userId: A.userId, generation: G2, cause: 'logout' })
const CLEARED: LocalSessionState = Object.freeze({ phase: 'cleared', generation: G3, source: A, cause: 'logout' })
const QUERY: SessionCheckTicket = Object.freeze({ kind: 'query', generation: G1 })

function accept(state: LocalSessionState, ticket: SessionCheckTicket, source: SessionSource, generation: string) {
  return acceptSessionCheck(state, ticket, source, generation, NOW)
}

function change(state: LocalSessionState, generation: string) {
  return beginSessionChange(state, generation, NOW)
}

function activation(result: SessionActivation | undefined): SessionActivation {
  expect(result).toBeDefined()
  if (result === undefined)
    throw new Error('本次响应应取得资格')
  return result
}

describe('本机会话状态的持久形状', () => {
  const states: LocalSessionState[] = [
    { phase: 'unconfirmed', generation: G0, changing: false },
    { phase: 'unconfirmed', generation: G2, changing: { startedAt: NOW, until: NOW + 60_000 }, source: A },
    { phase: 'unconfirmed', generation: G2, changing: false, source: A, retired: true },
    ACTIVE,
    { phase: 'suspended', generation: G2, source: A },
    CLEARING,
    CLEARED,
    { ...CLEARED, cause: 'account_disabled' },
  ]

  it.each(states)('可读回 $phase 的已知形状，不借引用修改持久记录', (state) => {
    expect(readLocalSessionState(JSON.parse(JSON.stringify(state)))).toEqual(state)
  })

  it.each([
    undefined,
    null,
    [],
    {},
    { ...ACTIVE, phase: 'future' },
    { ...ACTIVE, generation: 1 },
    { ...ACTIVE, generation: 'not-a-uuid' },
    { ...ACTIVE, activatedFrom: G1 },
    { ...ACTIVE, activatedFrom: undefined },
    { ...ACTIVE, source: undefined },
    { ...ACTIVE, source: { ...A, sourceHash: 'a'.repeat(63) } },
    { ...ACTIVE, source: { ...A, csrfToken: 'must-not-be-stored' } },
    { ...ACTIVE, unknown: true },
    { ...CLEARING, cause: 'expired' },
    { phase: 'unconfirmed', generation: G0, changing: 'yes' },
    { phase: 'unconfirmed', generation: G0, changing: true },
    { phase: 'unconfirmed', generation: G0, changing: { startedAt: NOW, until: NOW + 3_600_000 } },
    { phase: 'unconfirmed', generation: G0, changing: { startedAt: Number.NaN, until: NOW + 60_000 } },
    { phase: 'unconfirmed', generation: G0, changing: false, retired: true },
    { phase: 'unconfirmed', generation: G0, changing: false, source: A, retired: false },
  ])('畸形或未知的记录失败关闭 %#', (value) => {
    expect(readLocalSessionState(value)).toBeUndefined()
  })

  it('空库必须先有唯一代次；它本身不授予写入或删除资格', () => {
    const state = createUnconfirmedSession(G0)
    expect(state).toEqual({ phase: 'unconfirmed', generation: G0, changing: false })
    expect(canUseDraftSession(state, { userId: A.userId, generation: G0 }, A.userId)).toBe(false)
    expect(cleanupPermitOf(state)).toBeUndefined()
    expect(() => createUnconfirmedSession('')).toThrow()
  })

  it('来源与跨 Worker 资格仅接受约定字段和有效值', () => {
    expect(readSessionSource(A)).toEqual(A)
    expect(readSessionSource({ ...A, sourceHash: 'plaintext-token' })).toBeUndefined()
    expect(readSessionSource({ ...A, userId: '' })).toBeUndefined()
    expect(readDraftSessionPermit(PERMIT)).toEqual(PERMIT)
    expect(readDraftSessionPermit({ ...PERMIT, sourceHash: A.sourceHash })).toBeUndefined()
    expect(readDraftSessionPermit({ ...PERMIT, generation: '' })).toBeUndefined()
    expect(readUserCleanupPermit(CLEANUP)).toEqual(CLEANUP)
    expect(readUserCleanupPermit({ ...CLEANUP, cause: 'logout_from_other_page' })).toBeUndefined()
    expect(readSessionCheckTicket(QUERY)).toEqual(QUERY)
    expect(readSessionCheckTicket({ ...QUERY, kind: 'retry-old-response' })).toBeUndefined()
  })
})

describe('真实请求的票据与激活', () => {
  it('查询只观察，不推进代次、不打断现有写入', () => {
    expect(sessionCheckTicket(ACTIVE)).toEqual(QUERY)
    expect(canUseDraftSession(ACTIVE, PERMIT, A.userId)).toBe(true)
    expect(ACTIVE).toEqual({ phase: 'active', generation: G1, activatedFrom: G0, source: A })
  })

  it('首次响应固定新代次，另一条同轮同来源查询共享这次资格', () => {
    const initial = createUnconfirmedSession(G0)
    const ticket = sessionCheckTicket(initial)
    const first = activation(accept(initial, ticket, A, G1))
    expect(first).toEqual({ state: ACTIVE, permit: PERMIT })
    const concurrent = activation(accept(first.state, ticket, A, G2))
    expect(concurrent).toEqual(first)
    expect(accept(first.state, ticket, B, G2)).toBeUndefined()
  })

  it('普通复核同来源沿用资格；匹配票据查到新来源时换代次', () => {
    expect(accept(ACTIVE, QUERY, A, G2)).toEqual({ state: ACTIVE, permit: PERMIT })
    const next = activation(accept(ACTIVE, QUERY, A_NEW, G2))
    expect(next.state).toEqual({ phase: 'active', generation: G2, activatedFrom: G1, source: A_NEW })
    expect(canUseDraftSession(next.state, PERMIT, A.userId)).toBe(false)
    expect(canUseDraftSession(next.state, next.permit, A.userId)).toBe(true)
  })

  it('旧查询不能跨越暂停后的再次激活，即使用户与来源都没变', () => {
    const resumed: LocalSessionState = { phase: 'active', generation: G3, activatedFrom: G2, source: A }
    expect(accept(resumed, QUERY, A, G4)).toBeUndefined()
    expect(accept(resumed, { kind: 'query', generation: G2 }, A, G4)?.permit).toEqual({ userId: A.userId, generation: G3 })
  })

  it('删库后的新初始代次拒绝删库前票据，不把两次空库当成同一个时刻', () => {
    expect(accept(createUnconfirmedSession(G2), { kind: 'query', generation: G0 }, A, G3)).toBeUndefined()
    expect(accept(createUnconfirmedSession(G2), { kind: 'query', generation: G2 }, A, G3)?.permit).toEqual({ userId: A.userId, generation: G3 })
  })

  it.each([CLEARING, CLEARED])('$phase 拒绝同一退役来源；匹配的新来源可激活', (state) => {
    const ticket = sessionCheckTicket(state)
    expect(accept(state, ticket, A, G4)).toBeUndefined()
    expect(accept(state, QUERY, A_NEW, G4)).toBeUndefined()
    const next = activation(accept(state, ticket, A_NEW, G4))
    expect(next.permit).toEqual({ userId: A.userId, generation: G4 })
    expect(canCleanUserSession(next.state, CLEANUP)).toBe(false)
  })

  it('同代次的暂停来源可以复核，但旧宿主仍然失效', () => {
    const state: LocalSessionState = { phase: 'suspended', generation: G2, source: A }
    const next = activation(accept(state, sessionCheckTicket(state), A, G3))
    expect(next.permit).toEqual({ userId: A.userId, generation: G3 })
    expect(canUseDraftSession(next.state, PERMIT, A.userId)).toBe(false)
  })

  it('匹配代次也不能用畸形来源或复用代次激活', () => {
    expect(accept(ACTIVE, QUERY, { ...A, sourceHash: 'bad' }, G2)).toBeUndefined()
    expect(() => accept(ACTIVE, QUERY, B, G1)).toThrow()
  })
})

describe('登录等会话变更的未决窗口', () => {
  it.each([ACTIVE, CLEARING, CLEARED])('变更开始立即让 $phase 的旧写入与清理失效', (state) => {
    const changing = change(state, G4)
    expect(changing.ticket).toEqual({ kind: 'mutation', generation: G4 })
    expect(changing.state).toMatchObject({ phase: 'unconfirmed', generation: G4, changing: { startedAt: NOW, until: NOW + 60_000 }, source: A })
    expect(canUseDraftSession(changing.state, PERMIT, A.userId)).toBe(false)
    expect(canCleanUserSession(changing.state, CLEANUP)).toBe(false)
    expect(accept(changing.state, QUERY, A, G0)).toBeUndefined()
  })

  it('未决时新发起的查询也不能抢先激活旧 Cookie；变更回包仍可完成', () => {
    const changing = change(ACTIVE, G2)
    expect(accept(changing.state, sessionCheckTicket(changing.state), A, G3)).toBeUndefined()
    const next = activation(accept(changing.state, changing.ticket, A_NEW, G3))
    expect(next.permit).toEqual({ userId: A.userId, generation: G3 })
  })

  it('更晚变更先完成后，旧变更成功或失败都不能覆盖它', () => {
    const first = change(ACTIVE, G2)
    const second = change(first.state, G3)
    const next = activation(accept(second.state, second.ticket, B, G4))
    expect(accept(next.state, first.ticket, A_NEW, G0)).toBeUndefined()
    expect(failSessionChange(next.state, first.ticket, G0)).toBeUndefined()
    expect(canUseDraftSession(next.state, next.permit, B.userId)).toBe(true)
  })

  it('变更失败以原票据结束未决状态；须重新发查询，旧回包不可重包装', () => {
    const changing = change(ACTIVE, G2)
    const failed = failSessionChange(changing.state, changing.ticket, G3)
    expect(failed).toEqual({ phase: 'unconfirmed', generation: G3, changing: false, source: A })
    if (failed === undefined)
      throw new Error('当前变更应能结束')
    expect(accept(failed, changing.ticket, A_NEW, G4)).toBeUndefined()
    expect(accept(failed, { kind: 'query', generation: G2 }, A, G4)).toBeUndefined()
    expect(accept(failed, sessionCheckTicket(failed), A, G4)?.permit).toEqual({ userId: A.userId, generation: G4 })
    expect(failSessionChange(changing.state, { kind: 'query', generation: G2 }, G3)).toBeUndefined()
  })

  it('清理后的来源限制穿过失败登录与再次登录，不能借一次变更取消退役', () => {
    const changing = change(CLEARED, G4)
    expect(changing.state).toMatchObject({ retired: true, source: A })
    expect(accept(changing.state, changing.ticket, A, G0)).toBeUndefined()
    const failed = failSessionChange(changing.state, changing.ticket, G0)
    expect(failed).toMatchObject({ phase: 'unconfirmed', changing: false, retired: true, source: A })
    if (failed === undefined)
      throw new Error('当前变更应能结束')
    expect(accept(failed, sessionCheckTicket(failed), A, G1)).toBeUndefined()
    const again = change(failed, G1)
    expect(accept(again.state, again.ticket, A, G2)).toBeUndefined()
    expect(accept(again.state, again.ticket, A_NEW, G2)?.permit).toEqual({ userId: A.userId, generation: G2 })
  })
})

describe('宿主资格、暂停和用户清理', () => {
  it('用户与代次都要吻合，不能操作其他用户的键；未知状态或资格不默认放行', () => {
    expect(canUseDraftSession(ACTIVE, PERMIT, A.userId)).toBe(true)
    expect(canUseDraftSession(ACTIVE, PERMIT, B.userId)).toBe(false)
    expect(canUseDraftSession(ACTIVE, { ...PERMIT, userId: B.userId }, B.userId)).toBe(false)
    expect(canUseDraftSession(ACTIVE, { ...PERMIT, generation: G0 }, A.userId)).toBe(false)
    expect(canUseDraftSession(undefined, PERMIT, A.userId)).toBe(false)
    expect(canUseDraftSession(ACTIVE, undefined, A.userId)).toBe(false)
  })

  it('只有当前宿主可暂停，不删除数据，不给旧宿主再次登记的资格', () => {
    const suspended = suspendSession(ACTIVE, PERMIT, G2)
    expect(suspended).toEqual({ phase: 'suspended', generation: G2, source: A })
    expect(canUseDraftSession(suspended, PERMIT, A.userId)).toBe(false)
    expect(suspendSession(ACTIVE, { ...PERMIT, generation: G0 }, G2)).toBeUndefined()
    expect(suspendSession(CLEARING, PERMIT, G3)).toBeUndefined()
  })

  it.each(['logout', 'account_disabled'] as const)('只有匹配的 active 可建立 %s 清理资格', (cause) => {
    const result = beginUserCleanup(ACTIVE, PERMIT, cause, G2)
    expect(result).toEqual({ state: { ...CLEARING, cause }, permit: { ...CLEANUP, cause } })
    expect(beginUserCleanup(ACTIVE, { ...PERMIT, generation: G0 }, cause, G2)).toBeUndefined()
    expect(beginUserCleanup(ACTIVE, { ...PERMIT, userId: B.userId }, cause, G2)).toBeUndefined()
    expect(beginUserCleanup(CLEARED, PERMIT, cause, G4)).toBeUndefined()
  })

  it('pending 资格可从持久状态取回，但原因、用户或代次不同就不能重试', () => {
    expect(cleanupPermitOf(CLEARING)).toEqual(CLEANUP)
    expect(canCleanUserSession(CLEARING, CLEANUP)).toBe(true)
    for (const permit of [{ ...CLEANUP, userId: B.userId }, { ...CLEANUP, generation: G1 }, { ...CLEANUP, cause: 'account_disabled' as const }]) {
      expect(canCleanUserSession(CLEARING, permit)).toBe(false)
      expect(finishUserCleanup(CLEARING, permit, G3)).toBeUndefined()
    }
    expect(canCleanUserSession(undefined, CLEANUP)).toBe(false)
    expect(canCleanUserSession(CLEARING, undefined)).toBe(false)
  })

  it('清理完成保留退役来源与新代次，旧资格不能再清；新登录后旧完成回包也不能盖回去', () => {
    expect(finishUserCleanup(CLEARING, CLEANUP, G3)).toEqual(CLEARED)
    expect(cleanupPermitOf(CLEARED)).toBeUndefined()
    expect(canCleanUserSession(CLEARED, CLEANUP)).toBe(false)
    const newLogin: LocalSessionState = { phase: 'active', generation: G4, activatedFrom: G3, source: A_NEW }
    expect(finishUserCleanup(newLogin, CLEANUP, G0)).toBeUndefined()
    expect(canUseDraftSession(newLogin, { userId: A.userId, generation: G4 }, A.userId)).toBe(true)
  })

  it('所有真实转移都拒绝复用当前代次', () => {
    expect(() => change(ACTIVE, G1)).toThrow()
    expect(() => suspendSession(ACTIVE, PERMIT, G1)).toThrow()
    expect(() => beginUserCleanup(ACTIVE, PERMIT, 'logout', G1)).toThrow()
    expect(() => finishUserCleanup(CLEARING, CLEANUP, G2)).toThrow()
    const changing = change(ACTIVE, G2)
    expect(() => failSessionChange(changing.state, changing.ticket, G2)).toThrow()
  })
})

describe('浏览器退出后遗留的变更请求', () => {
  it('未决窗口覆盖请求层的完整时限；失效时间只会取消资格', () => {
    expect(SESSION_CHANGE_WINDOW_MS).toBeGreaterThan(DEFAULT_REQUEST_TIMEOUT_MS)
    expect(() => beginSessionChange(ACTIVE, G2, Number.NaN)).toThrow()
    expect(() => beginSessionChange(ACTIVE, G2, Number.MAX_SAFE_INTEGER)).toThrow()
    expect(acceptSessionCheck(ACTIVE, QUERY, A, G2, Number.NaN)).toBeUndefined()
  })

  it('持久化有界的未决窗口，活请求期间不抢占', () => {
    const pending = change(ACTIVE, G2)
    expect(pending.state).toMatchObject({ changing: { startedAt: NOW, until: NOW + 60_000 } })
    expect(expireSessionChange(pending.state, NOW + 59_999, G3)).toBeUndefined()
  })

  it.each([NOW + 60_000, NOW - 1])('到期或时钟回拨后废弃原票据，先推进代次再发真实查询（%s）', (now) => {
    const pending = change(ACTIVE, G2)
    const expired = expireSessionChange(pending.state, now, G3)
    expect(expired).toEqual({ phase: 'unconfirmed', generation: G3, changing: false, source: A })
    if (expired === undefined)
      throw new Error('失效窗口应能结束')
    expect(acceptSessionCheck(expired, pending.ticket, A_NEW, G4, now)).toBeUndefined()
    const fresh = activation(acceptSessionCheck(expired, sessionCheckTicket(expired), A, G4, now))
    expect(fresh.permit).toEqual({ userId: A.userId, generation: G4 })
  })

  it('未发生下一次查询时，已经超期的变更回包也不能激活', () => {
    const pending = change(ACTIVE, G2)
    expect(acceptSessionCheck(pending.state, pending.ticket, A_NEW, G3, NOW + 60_000)).toBeUndefined()
    expect(acceptSessionCheck(pending.state, pending.ticket, A_NEW, G3, NOW - 1)).toBeUndefined()
    expect(expireSessionChange(ACTIVE, NOW + 60_000, G2)).toBeUndefined()
  })

  it('清理后的来源限制不会随未决窗口过期被遗忘', () => {
    const pending = change(CLEARED, G4)
    const expired = expireSessionChange(pending.state, NOW + 60_000, G0)
    expect(expired).toMatchObject({ phase: 'unconfirmed', changing: false, retired: true, source: A })
    if (expired === undefined)
      throw new Error('失效窗口应能结束')
    expect(acceptSessionCheck(expired, sessionCheckTicket(expired), A, G1, NOW + 60_000)).toBeUndefined()
    expect(acceptSessionCheck(expired, sessionCheckTicket(expired), A_NEW, G1, NOW + 60_000)?.permit).toEqual({ userId: A.userId, generation: G1 })
  })
})
