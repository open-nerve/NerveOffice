import type { SessionResponse } from '@nerve-office/contracts'
import type { LocalSessionState } from '../outbox/session-fence.ts'
import type { SessionStore } from '../outbox/session-store.ts'
import { describe, expect, it, vi } from 'vitest'
import { createLogoutQualification, qualifyLogoutState } from './logout-qualification.ts'
import { sessionSourceOf } from './session-activation.ts'

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const G0 = '00000000-0000-4000-8000-000000000010'
const G1 = '00000000-0000-4000-8000-000000000011'
const G2 = '00000000-0000-4000-8000-000000000012'
const G3 = '00000000-0000-4000-8000-000000000013'
const SOURCE = { userId: USER, sourceHash: 'a'.repeat(64) }
const PERMIT = { userId: USER, generation: G1 }
const CLEANUP = { userId: USER, generation: G2, cause: 'logout' as const }
const ACTIVE: LocalSessionState = { phase: 'active', generation: G1, source: SOURCE, activatedFrom: G0 }
const CLEARING: LocalSessionState = { phase: 'clearing', generation: G2, source: SOURCE, cause: 'logout' }
const CLEARED: LocalSessionState = { phase: 'cleared', generation: G3, source: SOURCE, cause: 'logout' }

describe('退出原来源的资格核对', () => {
  it('只有原活动代次、原清理代次或同一来源已完成清理这三种事实成立', () => {
    expect(qualifyLogoutState(ACTIVE, SOURCE, PERMIT, undefined)).toBe('active')
    expect(qualifyLogoutState(CLEARING, SOURCE, PERMIT, CLEANUP)).toBe('clearing')
    expect(qualifyLogoutState(CLEARED, SOURCE, PERMIT, CLEANUP)).toBe('cleared')
  })
  it('未建立过清理许可不能借持久 clearing/cleared 补办旧确认', () => {
    expect(qualifyLogoutState(CLEARING, SOURCE, PERMIT, undefined)).toBe('invalidated')
    expect(qualifyLogoutState(CLEARED, SOURCE, PERMIT, undefined)).toBe('invalidated')
    expect(qualifyLogoutState(ACTIVE, SOURCE, PERMIT, CLEANUP)).toBe('invalidated')
  })
  it.each<LocalSessionState | undefined>([
    undefined,
    { ...ACTIVE, generation: G3 },
    { ...ACTIVE, source: { ...SOURCE, sourceHash: 'b'.repeat(64) } },
    { ...CLEARING, generation: G3 },
    { ...CLEARED, source: { ...SOURCE, sourceHash: 'b'.repeat(64) } },
    { ...CLEARED, source: { ...SOURCE, userId: G0 } },
    { ...CLEARED, cause: 'account_disabled' },
    { phase: 'unconfirmed', generation: G2, source: SOURCE, changing: false },
    { phase: 'suspended', generation: G2, source: SOURCE },
  ])('新代次/新来源/不属于本次确认的状态不允许重试 %#', (state) => {
    expect(qualifyLogoutState(state, SOURCE, PERMIT, CLEANUP)).toBe('invalidated')
  })
  it('固定许可本身属于另一人时拒绝，不只比较状态中的 userId', () => {
    expect(qualifyLogoutState(CLEARED, SOURCE, { ...PERMIT, userId: G0 }, CLEANUP)).toBe('invalidated')
    expect(qualifyLogoutState(CLEARED, SOURCE, PERMIT, { ...CLEANUP, userId: G0 })).toBe('invalidated')
  })
  it('实际来源在创建时固定；摘要在锁外，持久行在锁内读取，不给出新的许可', async () => {
    let locked = false
    const session: SessionResponse = { user: { id: USER, username: 'alice', displayName: '甲', systemRole: 'member' }, personalSpace: { id: G0, name: '甲' }, csrfToken: 'original-csrf', features: { localDraftsEnabled: true } }
    const expected = await sessionSourceOf(session)
    const readState = vi.fn<SessionStore['readState']>(async () => {
      expect(locked).toBe(true)
      return { kind: 'state', state: { ...CLEARED, source: expected } }
    })
    const qualify = createLogoutQualification({ session, permit: PERMIT, sessions: { readState }, exclusive: async (work) => {
      locked = true
      try {
        return await work()
      }
      finally {
        locked = false
      }
    } })
    session.csrfToken = 'later-csrf'
    expect(await qualify(CLEANUP)).toBe('cleared')
    expect(readState).toHaveBeenCalledTimes(1)
    readState.mockResolvedValueOnce({ kind: 'unavailable', reason: 'blocked' })
    expect(await qualify(CLEANUP)).toBe('unavailable')
    readState.mockRejectedValueOnce(new Error('库断开'))
    expect(await qualify(CLEANUP)).toBe('unavailable')
  })
})
