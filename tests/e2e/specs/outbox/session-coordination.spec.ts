// 真正的 strict IDB 接受回调前登记新事实，核对状态转移而非仅响应对象的 WeakMap 关联。
import { createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { openOutboxProbe } from '../../support/outbox-probe.ts'
import { fence } from '../../support/session-fence-probe.ts'
import { loginThroughApi } from '../../support/session.ts'

test.describe('会话确认与迟到停用的真实 IDB 边界', { tag: '@test-build' }, () => {
  test('accept 已入锁、IDB decide 前到达的停用禁止先写新 active，并仍能提交 clearing', async ({ page }) => {
    const user = await createUser('ob-session-coordination')
    await loginThroughApi(page, user)
    await openOutboxProbe(page, { authorize: false })
    const result = await fence(page, 'disabledBeforeDecision')
    expect(result.before.phase).toBe('suspended')
    expect(result.atDecision).toEqual(result.before)
    expect(result.durability).toBe('strict')
    expect(result.registered).toBe(true)
    expect.soft(result.permit).toBeUndefined()
    expect.soft(result.writes.filter(state => state.phase === 'active')).toEqual([])
    expect.soft(result.committedCleanup).toBe(true)
    expect.soft(result.writes.some(state => state.phase === 'clearing')).toBe(true)
    expect.soft(result.after.kind).toBe('state')
    expect.soft(result.after.state?.phase).not.toBe('active')
  })
})
