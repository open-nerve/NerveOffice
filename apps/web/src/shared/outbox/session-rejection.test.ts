import type { LocalSessionState, SessionCheckTicket, SessionSource } from './session-fence.ts'
import { describe, expect, it } from 'vitest'
import { acceptSessionCheck, beginSessionChange, rejectSessionCheck } from './session-fence.ts'

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const G0 = '00000000-0000-4000-8000-000000000010'
const G1 = '00000000-0000-4000-8000-000000000011'
const G2 = '00000000-0000-4000-8000-000000000012'
const G3 = '00000000-0000-4000-8000-000000000013'
const SOURCE: SessionSource = { userId: USER, sourceHash: 'a'.repeat(64) }
const ACTIVE: LocalSessionState = { phase: 'active', generation: G1, source: SOURCE, activatedFrom: G0 }
const TICKET: SessionCheckTicket = { kind: 'query', generation: G1 }
const DISABLED = { kind: 'disabled', userId: USER } as const

describe('失败会话查询只作用于自己的原票据', () => {
  it('已知原账户确认停用，先换为 clearing；原许可与新清理许可各自固定', () => {
    expect(rejectSessionCheck(ACTIVE, TICKET, DISABLED, G2)).toEqual({
      state: { phase: 'clearing', generation: G2, source: SOURCE, cause: 'account_disabled' },
      result: { kind: 'clearing', previous: { userId: USER, generation: G1 }, permit: { userId: USER, generation: G2, cause: 'account_disabled' } },
    })
  })

  it('其他认证失败仅暂停原代次，不建立删除资格', () => {
    expect(rejectSessionCheck(ACTIVE, TICKET, { kind: 'preserve' }, G2)).toEqual({
      state: { phase: 'suspended', generation: G2, source: SOURCE },
      result: { kind: 'stopped', previous: { userId: USER, generation: G1 } },
    })
  })

  it('已暂停来源再次查询失败不再换代或重复通知；后续确认停用仍可清理', () => {
    const suspended: LocalSessionState = { phase: 'suspended', generation: G1, source: SOURCE }
    expect(rejectSessionCheck(suspended, TICKET, { kind: 'preserve' }, G2)).toBeUndefined()
    expect(rejectSessionCheck(suspended, TICKET, DISABLED, G2)?.result.kind).toBe('clearing')
  })

  it.each([USER, OTHER])('同人重新登录或换人（%s）后旧停用回包不能清理或暂停新登录', (userId) => {
    const change = beginSessionChange(ACTIVE, G2, 1000)
    const next = acceptSessionCheck(change.state, change.ticket, { userId, sourceHash: 'b'.repeat(64) }, G3, 1001)
    expect(next).toBeDefined()
    if (next === undefined)
      throw new Error('新登录必须激活')
    expect(rejectSessionCheck(next.state, TICKET, DISABLED, G0)).toBeUndefined()
    expect(rejectSessionCheck(next.state, TICKET, { kind: 'preserve' }, G0)).toBeUndefined()
  })

  it('错误回包不能借 active.activatedFrom 穿过一次已经成功的激活', () => {
    expect(rejectSessionCheck(ACTIVE, { kind: 'query', generation: G0 }, DISABLED, G2)).toBeUndefined()
  })

  it.each<LocalSessionState>([
    { phase: 'unconfirmed', generation: G1, changing: false },
    { phase: 'unconfirmed', generation: G1, changing: { startedAt: 1000, until: 61000 }, source: SOURCE },
    { phase: 'unconfirmed', generation: G1, changing: false, source: SOURCE, retired: true },
    { phase: 'clearing', generation: G1, source: SOURCE, cause: 'logout' },
    { phase: 'cleared', generation: G1, source: SOURCE, cause: 'account_disabled' },
  ])('状态 $phase 没有可用原来源或正在变更/已退役时不改动', (state) => {
    expect(rejectSessionCheck(state, TICKET, DISABLED, G2)).toBeUndefined()
  })

  it('停用详情的账户必须匹配原来源；变更请求失败不替旧账户删除', () => {
    expect(rejectSessionCheck(ACTIVE, TICKET, { kind: 'disabled', userId: OTHER }, G2)).toBeUndefined()
    expect(rejectSessionCheck(ACTIVE, { kind: 'mutation', generation: G1 }, DISABLED, G2)).toBeUndefined()
  })

  it.each<LocalSessionState>([
    { phase: 'suspended', generation: G1, source: SOURCE },
    { phase: 'unconfirmed', generation: G1, changing: false, source: SOURCE },
  ])('首次查询没有页面许可但持久 $phase 来源仍匹配，停用可取得清理资格', (state) => {
    expect(rejectSessionCheck(state, TICKET, DISABLED, G2)?.result).toEqual({ kind: 'clearing', previous: { userId: USER, generation: G1 }, permit: { userId: USER, generation: G2, cause: 'account_disabled' } })
  })
})
