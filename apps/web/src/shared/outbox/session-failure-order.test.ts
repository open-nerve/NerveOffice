// 同一会话的普通失效与确证停用可能乱序；暂停不能丢掉原来源，重登则必须切断它。
import type { LocalSessionState } from './session-fence.ts'
import { describe, expect, it } from 'vitest'
import { acceptSessionCheck, beginSessionChange, beginUserCleanup, canUseDraftSession, readLocalSessionState, rejectSessionCheck, suspendSession } from './session-fence.ts'

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const G0 = '00000000-0000-4000-8000-000000000010'
const G1 = '00000000-0000-4000-8000-000000000011'
const G2 = '00000000-0000-4000-8000-000000000012'
const G3 = '00000000-0000-4000-8000-000000000013'
const G4 = '00000000-0000-4000-8000-000000000014'
const SOURCE = { userId: USER, sourceHash: 'a'.repeat(64) }
const ACTIVE: LocalSessionState = { phase: 'active', generation: G1, source: SOURCE, activatedFrom: G0 }
const PERMIT = { userId: USER, generation: G1 }
const TICKET = { kind: 'query', generation: G1 } as const
const DISABLED = { kind: 'disabled', userId: USER } as const

function paused(by: 'request' | 'query'): LocalSessionState {
  const state = by === 'request' ? suspendSession(ACTIVE, PERMIT, G2) : rejectSessionCheck(ACTIVE, TICKET, { kind: 'preserve' }, G2)?.state
  if (state === undefined)
    throw new Error('普通失效应先暂停原会话')
  // 重新读取持久行，不能依赖当前进程里的对象引用。
  const stored = readLocalSessionState(JSON.parse(JSON.stringify(state)))
  if (stored === undefined)
    throw new Error('暂停状态应可以从磁盘重读')
  return stored
}

describe.each(['request', 'query'] as const)('普通 %s 失效先处理', (by) => {
  it.each(['request', 'query'] as const)('同一原会话迟到的 %s 停用事实仍建立清理资格', (late) => {
    const state = paused(by)
    expect(canUseDraftSession(state, PERMIT, USER)).toBe(false)
    const cleanup = late === 'request' ? beginUserCleanup(state, PERMIT, 'account_disabled', G3) : rejectSessionCheck(state, TICKET, DISABLED, G3)
    expect(cleanup?.state).toEqual({ phase: 'clearing', generation: G3, source: SOURCE, cause: 'account_disabled' })
  })

  it('暂停来源不授权旧写入、主动退出、另一用户或更早代次，普通失效也不再换代', () => {
    const state = paused(by)
    expect(beginUserCleanup(state, PERMIT, 'logout', G3)).toBeUndefined()
    expect(beginUserCleanup(state, { ...PERMIT, userId: OTHER }, 'account_disabled', G3)).toBeUndefined()
    expect(beginUserCleanup(state, { ...PERMIT, generation: G0 }, 'account_disabled', G3)).toBeUndefined()
    expect(rejectSessionCheck(state, TICKET, { kind: 'disabled', userId: OTHER }, G3)).toBeUndefined()
    expect(rejectSessionCheck(state, { ...TICKET, generation: G0 }, DISABLED, G3)).toBeUndefined()
    expect(rejectSessionCheck(state, TICKET, { kind: 'preserve' }, G3)).toBeUndefined()
    expect(suspendSession(state, PERMIT, G3)).toBeUndefined()
  })

  it.each([USER, OTHER])('重新登录 %s 并再次暂停后，旧停用事实仍不能穿越新代次', (userId) => {
    const change = beginSessionChange(paused(by), G3, 1000)
    expect(beginUserCleanup(change.state, PERMIT, 'account_disabled', G4)).toBeUndefined()
    expect(rejectSessionCheck(change.state, TICKET, DISABLED, G4)).toBeUndefined()
    const next = acceptSessionCheck(change.state, change.ticket, { userId, sourceHash: 'b'.repeat(64) }, G4, 1001)
    if (next === undefined)
      throw new Error('新登录必须激活')
    const suspended = suspendSession(next.state, next.permit, G3)
    if (suspended === undefined)
      throw new Error('新来源必须可以暂停')
    for (const state of [next.state, suspended]) {
      expect(beginUserCleanup(state, PERMIT, 'account_disabled', G2)).toBeUndefined()
      expect(rejectSessionCheck(state, TICKET, DISABLED, G2)).toBeUndefined()
    }
  })

  it('同来源成功复核也切断旧暂停的证据，不能借来源相同清理新会话', () => {
    const next = acceptSessionCheck(paused(by), { kind: 'query', generation: G2 }, SOURCE, G3, 1000)
    if (next === undefined)
      throw new Error('真实复核必须可以激活')
    expect(beginUserCleanup(next.state, PERMIT, 'account_disabled', G4)).toBeUndefined()
    expect(rejectSessionCheck(next.state, TICKET, DISABLED, G4)).toBeUndefined()
  })
})

it('没有暂停来源的既有记录不推断旧资格；未知或自引用的来源失败关闭', () => {
  const legacy = { phase: 'suspended', generation: G2, source: SOURCE } as const
  expect(readLocalSessionState(legacy)).toEqual(legacy)
  expect(beginUserCleanup(legacy, PERMIT, 'account_disabled', G3)).toBeUndefined()
  expect(rejectSessionCheck(legacy, TICKET, DISABLED, G3)).toBeUndefined()
  for (const suspendedFrom of [G2, 'invalid', 1, null])
    expect(readLocalSessionState({ ...legacy, suspendedFrom })).toBeUndefined()
})
