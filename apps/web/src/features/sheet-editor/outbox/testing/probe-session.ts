// 仅测试构建：经真实 HTTP 与生产协调器取得许可；不读取最新持久代次来冒充新会话。
// 只有契约类型导入；生产协调器不含 zod，不改变入口关闭 JIT 的先后。
import type { SessionResponse } from '@nerve-office/contracts'
import type { DraftSessionPermit } from '../../../../shared/outbox/session-fence.ts'
import { draftSessionPermitOf, trackSessionRequest } from '../../../../shared/local-drafts/session-activation.ts'

export async function requestProbeSessionPermit(): Promise<DraftSessionPermit> {
  const response = await trackSessionRequest('query', async () => {
    const result = await fetch('/api/auth/session', { credentials: 'same-origin' })
    if (!result.ok)
      throw new Error(`探针会话查询失败：${result.status}`)
    // 测试服务器仍走真实会话契约；资格模块再次核对用户与来源，不在探针里伪造激活。
    return await result.json() as SessionResponse
  })
  const permit = draftSessionPermitOf(response)
  if (permit === undefined)
    throw new Error('探针没有取得本机会话许可')
  return Object.freeze(permit)
}
