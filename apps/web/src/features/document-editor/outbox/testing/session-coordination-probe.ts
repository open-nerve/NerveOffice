// 仅测试构建：在原生 IDB get 已成功、生产 decide 尚未执行的同一事件内登记停用。
// 不替换事务或 fence；新事实的副作用仍按生产同源锁排队。
import type { SessionResponse } from '@nerve-office/contracts'
import type { LocalSessionState } from '../../../../shared/outbox/session-fence.ts'
import { draftSessionPermitOf } from '../../../../shared/local-drafts/session-activation.ts'
import { subscribeLocalSession } from '../../../../shared/local-drafts/session-events.ts'
import { SESSIONS_STORE } from '../../../../shared/outbox/database.ts'
import { readStoredSession } from '../../../../shared/outbox/session-record.ts'
import { createSessionStore } from '../../../../shared/outbox/session-store.ts'

/** 请求层由原页面入口注入；探针不引用 shared/api 或带 zod 的契约值。 */
export interface SessionCoordinationPorts {
  readonly request: () => Promise<SessionResponse>
  readonly adopt: (response: SessionResponse) => void
  readonly failed: (response: SessionResponse, kind: 'preserve' | 'disabled') => Promise<void>
}

export async function probeDisabledBeforeSessionDecision(ports: SessionCoordinationPorts) {
  const sessions = createSessionStore({ blockedTimeoutMs: 1_000 })
  const initial = await ports.request()
  ports.adopt(initial)
  if (draftSessionPermitOf(initial) === undefined)
    throw new Error('真实会话查询没有取得初始许可')
  await ports.failed(initial, 'preserve')
  const before = await sessions.readState()
  if (before.kind !== 'state' || before.state?.phase !== 'suspended')
    throw new Error('普通失效没有真实提交 suspended')

  const get: typeof IDBObjectStore.prototype.get = Reflect.get(IDBObjectStore.prototype, 'get')
  const put: typeof IDBObjectStore.prototype.put = Reflect.get(IDBObjectStore.prototype, 'put')
  const writes: { readonly phase: LocalSessionState['phase'], readonly generation: string }[] = []
  let sessionGets = 0
  let atDecision: LocalSessionState | undefined
  let durability: IDBTransactionDurability | undefined
  let stopping: Promise<void> | undefined
  let committedCleanup = false
  const unsubscribe = subscribeLocalSession((event) => {
    if (event.kind === 'stopped' && event.cleanup !== undefined)
      committedCleanup = true
  })
  IDBObjectStore.prototype.get = function (...args) {
    const request = Reflect.apply(get, this, args) as IDBRequest<unknown>
    if (this.name === SESSIONS_STORE && ++sessionGets === 2) {
      // 第一次是本轮 beginSessionCheck；第二次已在 accept 的锁与原生事务内。
      // 本监听先于 store-transaction 的 onsuccess 注册，生产 decide 随后才执行。
      request.addEventListener('success', () => {
        atDecision = readStoredSession(request.result)
        durability = this.transaction.durability
        stopping = ports.failed(initial, 'disabled')
      }, { once: true })
    }
    return request
  }
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === SESSIONS_STORE) {
      const state = readStoredSession(args[0])
      if (state !== undefined)
        writes.push({ phase: state.phase, generation: state.generation })
    }
    return Reflect.apply(put, this, args)
  }
  try {
    const confirmed = await ports.request()
    await stopping
    const after = await sessions.readState()
    return {
      before: before.state,
      atDecision,
      durability,
      registered: stopping !== undefined,
      permit: draftSessionPermitOf(confirmed),
      writes,
      committedCleanup,
      after,
    }
  }
  finally {
    await stopping
    IDBObjectStore.prototype.get = get
    IDBObjectStore.prototype.put = put
    unsubscribe()
    sessions.close()
  }
}
