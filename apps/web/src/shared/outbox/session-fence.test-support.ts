import type { DraftSessionPermit, UserCleanupPermit } from './session-fence.ts'
import { USER_ID } from './draft-record.test-support.ts'

/** 单元夹具的明确许可；不写入数据库，真实浏览器仍须经过 SessionStore 激活。 */
export function testSessionPermit(userId = USER_ID): DraftSessionPermit {
  return { userId, generation: '0199b0c4-7d3e-7a3b-9c4e-000000000001' }
}

/** 清理单元夹具；真实 IDB 的资格与完成转移由浏览器案例验证。 */
export function testCleanupPermit(userId = USER_ID): UserCleanupPermit {
  return { ...testSessionPermit(userId), cause: 'logout' }
}

export function testCleanupSessions() {
  return {
    beginUserCleanup: async () => ({ kind: 'clearing' as const, permit: testCleanupPermit() }),
    finishUserCleanup: async () => ({ kind: 'cleared' as const }),
  }
}
