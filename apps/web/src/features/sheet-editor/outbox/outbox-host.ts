// 只负责放置：初始握手失败才用进程内退路；运行中失败交回会话核对资格，不能在这里偷偷重建写入者。
import type { DraftWriter } from '../../../shared/outbox/draft-writer.ts'
import type { LeaseClock } from '../edit-lease.ts'
import type { WorkerLike } from './outbox-worker-client.ts'
import { createDraftStore } from '../../../shared/outbox/draft-store.ts'
import { createDraftWriter } from '../../../shared/outbox/draft-writer.ts'
import { createInProcessOutboxHost } from './in-process-outbox-host.ts'
import { createOutboxWorker, createOutboxWorkerClient } from './outbox-worker-client.ts'

/** 长于 P1 同源锁等待（10 秒）和 IDB 升级等待（3 秒），不让仍在正常等待的操作被提前杀掉。 */
export const OUTBOX_REQUEST_TIMEOUT_MS = 15_000

const hostClock: Pick<LeaseClock, 'schedule'> = {
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, Math.min(delayMs, 2 ** 31 - 1))
    return () => clearTimeout(timer)
  },
}

export interface OutboxHost {
  readonly kind: 'worker' | 'in-process'
  readonly writer: DraftWriter
  readonly broken: () => boolean
  readonly dispose: () => void
}

export interface OutboxHostOptions {
  readonly createWorker?: () => WorkerLike
  readonly createFallback?: () => DraftWriter
  readonly clock?: Pick<LeaseClock, 'schedule'>
  readonly now?: () => number
  readonly requestTimeoutMs?: number
  /** 会话在握手中暂停/销毁时马上结束，不等看门狗、不创建退路。准备完成后由会话持有并销毁宿主。 */
  readonly signal?: AbortSignal
}

export async function createOutboxHost(options: OutboxHostOptions = {}): Promise<OutboxHost> {
  options.signal?.throwIfAborted()
  const client = createOutboxWorkerClient({
    create: options.createWorker ?? createOutboxWorker,
    clock: options.clock ?? hostClock,
    requestTimeoutMs: options.requestTimeoutMs ?? OUTBOX_REQUEST_TIMEOUT_MS,
  })
  const abort = () => client.dispose()
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    options.signal?.throwIfAborted()
    const ready = await client.ready()
    options.signal?.throwIfAborted()
    if (ready.kind === 'ready')
      return { kind: 'worker', writer: client, broken: () => client.broken() !== undefined, dispose: client.dispose }
  }
  catch (error) {
    client.dispose()
    throw error
  }
  finally {
    options.signal?.removeEventListener('abort', abort)
  }
  client.dispose()
  // 保留 P1 的默认只读镜像恢复；主线程不提供 OPFS 写入镜像，也不以空 recovery 绕过它。
  const writer = options.createFallback?.() ?? createDraftWriter({
    store: createDraftStore({ blockedTimeoutMs: 3_000 }),
    now: options.now ?? Date.now,
  })
  return createInProcessOutboxHost(writer, options.clock ?? hostClock, options.requestTimeoutMs ?? OUTBOX_REQUEST_TIMEOUT_MS)
}
