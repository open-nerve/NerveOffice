// 被本人接管的位置（M4-P2 S2、DEF-071）：服务端登录绑定优先，本机证据只作为查询失败或持有者变化后的退路。
// 这里只组合事实，不拥有或释放租约、本机锁、页面代次；readStatus 由请求层限制在 10 秒内。
import type { LeaseLoss } from './edit-lease.ts'
import type { FetchedEditStatus } from './editor-api.ts'

export async function resolveTakeoverLoss(loss: LeaseLoss, readStatus: () => Promise<FetchedEditStatus>, local: Promise<boolean>): Promise<LeaseLoss> {
  // 即使服务端先给出确定答案，也要接住本机工作之后的失败；不能留下未处理拒绝。
  const here = local.catch(() => false)
  if (loss.kind !== 'taken-over')
    return loss
  try {
    const { status } = await readStatus()
    if (status.editor?.sameUser === true)
      return { kind: 'taken-over', where: status.editor.sameSession ? 'this-browser' : 'elsewhere' }
  }
  catch {
    // 不能取得服务端事实时，保留原来的本机判断；不把查询失败当作新的失效原因。
  }
  return await here ? { kind: 'taken-over', where: 'this-browser' } : loss
}
