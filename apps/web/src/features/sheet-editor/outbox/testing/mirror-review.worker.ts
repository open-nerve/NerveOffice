// 真实浏览器复核里量 OPFS 镜像的测试 Worker（M4-P1 设计 §3.6 第 11 项）：同步访问句柄只在专用 Worker 里有，镜像那一段只能在这里量。
// 由 ./outbox-review-probe.ts 创建，量法在 ./mirror-review.ts（生产的 createDraftMirror 与 opfsMirrorDirectory，句柄外面包一层计时）；
// 这里只接消息、一问一答。只在测试构建里
import type { StoredDraft } from '../../../../shared/outbox/draft-record.ts'
import type { FailureDescription } from '../../../../shared/outbox/failure.ts'
import type { MirrorReadTimes, MirrorWriteTimes } from './mirror-review.ts'
import { describeFailure } from '../../../../shared/outbox/failure.ts'
import { opfsMirrorDirectory } from '../../../../shared/outbox/mirror-directory.ts'
import { createMirrorReview } from './mirror-review.ts'

/** 要做的：写一份（record 写进它自己那份文档的槽位）；读并与库里那一份比对；放开全部句柄 */
export type MirrorReviewCall
  = | { readonly op: 'write', readonly record: StoredDraft }
    | { readonly op: 'read', readonly stored: StoredDraft }
    | { readonly op: 'close' }

export type MirrorReviewRequest = MirrorReviewCall & { readonly id: number }

export type MirrorReviewReply
  = | { readonly id: number, readonly op: 'write', readonly result: MirrorWriteTimes }
    | { readonly id: number, readonly op: 'read', readonly result: MirrorReadTimes }
    | { readonly id: number, readonly op: 'close' }
    | { readonly id: number, readonly op: 'error', readonly error: FailureDescription }

const scope = globalThis as unknown as {
  addEventListener: (type: 'message', listener: (event: MessageEvent<MirrorReviewRequest>) => void) => void
  postMessage: (message: MirrorReviewReply) => void
}

const review = createMirrorReview(opfsMirrorDirectory(), () => performance.now())

async function handle(request: MirrorReviewRequest): Promise<MirrorReviewReply> {
  switch (request.op) {
    case 'write':
      return { id: request.id, op: 'write', result: await review.write(request.record) }
    case 'read':
      return { id: request.id, op: 'read', result: await review.read(request.stored) }
    case 'close':
      review.close()
      return { id: request.id, op: 'close' }
  }
}

scope.addEventListener('message', (event) => {
  const request = event.data
  void handle(request).then(
    reply => scope.postMessage(reply),
    (error: unknown) => scope.postMessage({ id: request.id, op: 'error', error: describeFailure(error) }),
  )
})
