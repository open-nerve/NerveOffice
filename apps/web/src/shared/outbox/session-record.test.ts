import { describe, expect, it } from 'vitest'
import { SESSION_SLOT } from './database.ts'
import { USER_ID } from './draft-record.test-support.ts'
import { readStoredActiveSession, readStoredSession, sessionRecord } from './session-record.ts'

const active = {
  phase: 'active',
  generation: '0199b0c4-7d3e-7a3b-9c4e-000000000001',
  activatedFrom: '0199b0c4-7d3e-7a3b-9c4e-000000000002',
  source: { userId: USER_ID, sourceHash: 'a'.repeat(64) },
} as const

describe('持久会话行的严格边界', () => {
  it('尚无状态与正常 active 明确区分；主线程和 Worker 对相同行达成一致', () => {
    expect(readStoredSession(undefined)).toBeUndefined()
    expect(readStoredActiveSession(undefined)).toBeUndefined()
    const raw = sessionRecord(active)
    expect(raw.slot).toBe(SESSION_SLOT)
    expect(readStoredSession(raw)).toEqual(active)
    expect(readStoredActiveSession(raw)).toEqual(active)
  })

  it.each([
    null,
    {},
    { slot: SESSION_SLOT },
    { slot: 'another', state: active },
    { slot: SESSION_SLOT, state: active, future: true },
    { slot: SESSION_SLOT, state: { ...active, phase: 'future' } },
    { slot: SESSION_SLOT, state: { ...active, csrf: 'unexpected' } },
    { slot: SESSION_SLOT, state: { ...active, activatedFrom: active.generation } },
    { slot: SESSION_SLOT, state: { ...active, source: { ...active.source, body: 'unexpected' } } },
  ])('未知或畸形行不能当成空状态，也不给用户操作资格：%j', (raw) => {
    expect(() => readStoredSession(raw)).toThrow('本机会话状态损坏或使用未知格式')
    expect(readStoredActiveSession(raw)).toBeUndefined()
  })

  it('主线程能识别清理中状态，Worker 用户操作仍一律拒绝', () => {
    const state = { phase: 'clearing', generation: active.generation, source: active.source, cause: 'logout' } as const
    const raw = sessionRecord(state)
    expect(readStoredSession(raw)).toEqual(state)
    expect(readStoredActiveSession(raw)).toBeUndefined()
  })
})
