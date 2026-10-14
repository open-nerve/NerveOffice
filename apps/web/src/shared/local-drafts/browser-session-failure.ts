import { openSessionChannel } from '../lib/session-channel.ts'
import { withOutboxLock } from '../outbox/outbox-lock.ts'
import { createSessionStore } from '../outbox/session-store.ts'
import { createBrowserCleanup } from './browser-cleanup.ts'
import { publishLocalSession } from './session-events.ts'
import { createSessionFailure } from './session-failure.ts'

const options = { blockedTimeoutMs: 3_000 }
const sessions = createSessionStore(options)
const cleanup = createBrowserCleanup(sessions, options)
const failure = createSessionFailure({
  sessions,
  exclusive: withOutboxLock,
  stopped: (previous, permit) => {
    publishLocalSession({ kind: 'stopped', previous, cleanup: permit })
    const channel = openSessionChannel()
    try {
      channel.announce()
    }
    finally {
      channel.close()
    }
    if (permit !== undefined) {
      // 不让目录占用/故障延长认证请求；清理资格已持久化，下一次启动仍可继续。
      void cleanup.removeUser(permit).then((outcome) => {
        publishLocalSession({ kind: 'cleanup', permit, outcome })
      }).catch((error: unknown) => {
        publishLocalSession({ kind: 'cleanup', permit, outcome: { kind: 'failed', error } })
      })
    }
  },
})

export const handleRequestSessionFailure = failure.request
export const handleQuerySessionFailure = failure.query
