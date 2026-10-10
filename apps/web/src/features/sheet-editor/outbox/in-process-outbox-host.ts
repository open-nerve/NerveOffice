// 进程内退路同样有等待上限。超时只结束调用方的等待、停用这个管道；不会提前放开 P1 正在执行的同源操作锁。
import type { DraftWriter } from '../../../shared/outbox/draft-writer.ts'
import type { FailureDescription } from '../../../shared/outbox/failure.ts'
import type { LeaseClock } from '../edit-lease.ts'
import type { OutboxHost } from './outbox-host.ts'
import type { OutboxCallType, OutboxResults } from './outbox-protocol.ts'
import { describeFailure } from '../../../shared/outbox/failure.ts'
import { failedResult } from './outbox-protocol.ts'

export function createInProcessOutboxHost(writer: DraftWriter, clock: Pick<LeaseClock, 'schedule'>, timeoutMs: number): OutboxHost {
  let failure: FailureDescription | undefined
  const pending = new Set<(error: FailureDescription) => void>()

  function stop(error: FailureDescription): void {
    if (failure !== undefined)
      return
    failure = error
    for (const abandon of [...pending])
      abandon(error)
    writer.dispose()
  }

  async function call<T extends OutboxCallType>(type: T, task: () => Promise<OutboxResults[T]>): Promise<OutboxResults[T]> {
    if (failure !== undefined)
      return failedResult(type, failure)
    return new Promise((resolve) => {
      let settled = false
      const cancelTimer = clock.schedule(() => stop({ name: 'OutboxHostTimeout', message: '进程内发件箱没有在时限内回应' }), timeoutMs)
      function done(value: OutboxResults[T]): void {
        if (settled)
          return
        settled = true
        cancelTimer()
        pending.delete(abandon)
        resolve(value)
      }
      function abandon(error: FailureDescription): void {
        done(failedResult(type, error))
      }
      pending.add(abandon)
      try {
        void task().then(done, (error: unknown) => abandon(describeFailure(error)))
      }
      catch (error) {
        abandon(describeFailure(error))
      }
    })
  }

  const dispose = () => stop({ name: 'InvalidStateError', message: '进程内发件箱已关闭' })
  const bounded: DraftWriter = {
    register: async (...args) => call('register', async () => writer.register(...args)),
    write: async (...args) => call('write', async () => writer.write(...args)),
    markInFlight: async (...args) => call('mark-in-flight', async () => writer.markInFlight(...args)),
    confirm: async (...args) => call('confirm', async () => writer.confirm(...args)),
    read: async (...args) => call('read', async () => writer.read(...args)),
    remove: async (...args) => call('remove', async () => writer.remove(...args)),
    setKey: async (...args) => call('set-key', async () => writer.setKey(...args)),
    seedDigest: async (...args) => {
      await call('seed-digest', async () => {
        await writer.seedDigest(...args)
        return { kind: 'seeded' }
      })
    },
    release: async (...args) => {
      await call('release', async () => {
        await writer.release(...args)
        return { kind: 'released' }
      })
    },
    mirroredDocuments: async (...args) => call('mirrored-documents', async () => writer.mirroredDocuments(...args)),
    reconcile: async (...args) => call('reconcile', async () => writer.reconcile(...args)),
    notices: async (...args) => call('notices', async () => writer.notices(...args)),
    clearNotice: async (...args) => call('clear-notice', async () => writer.clearNotice(...args)),
    dispose,
  }
  return { kind: 'in-process', writer: bounded, broken: () => failure !== undefined, dispose }
}
