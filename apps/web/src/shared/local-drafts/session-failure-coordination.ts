import type { SessionResponse } from '@nerve-office/contracts'
import type { DraftSessionPermit, SessionCheckFailure } from '../outbox/session-fence.ts'
import { associatedSessionPermit, rememberSessionPermit } from '../api/session-association.ts'
import { currentApiSession, subscribeApiSession } from '../api/session-context.ts'
import { readDraftSessionPermit } from '../outbox/session-fence.ts'

interface PendingFailure {
  readonly source: DraftSessionPermit
  readonly facts: Map<SessionCheckFailure['kind'], SessionCheckFailure>
  readonly pending: Map<SessionCheckFailure['kind'], Promise<void>>
  readonly listeners: Set<() => void>
  readonly applied: Set<SessionCheckFailure['kind']>
  readonly sourceResponse: { readonly userId: string, readonly csrfToken: string } | undefined
  retry: boolean
  retired: boolean
}

/** 只保留本页采用的来源；同一来源至多有普通失效和确证停用两种在途事实。 */
let current: PendingFailure | undefined
const WAIT_MS = 3_000

function notify(entry: PendingFailure): void {
  for (const listener of [...entry.listeners])
    listener()
}

function retire(): void {
  const entry = current
  current = undefined
  if (entry !== undefined) {
    entry.retired = true
    notify(entry)
  }
}

subscribeApiSession((response) => {
  if (current !== undefined && (response === undefined || response.user.id !== current.source.userId
    || (current.sourceResponse !== undefined && response.csrfToken !== current.sourceResponse.csrfToken))) {
    retire()
  }
})

function same(a: DraftSessionPermit | undefined, b: DraftSessionPermit): boolean {
  return a?.userId === b.userId && a.generation === b.generation
}

function adopted(): DraftSessionPermit | undefined {
  const response = currentApiSession()
  return response === undefined ? undefined : readDraftSessionPermit(associatedSessionPermit(response))
}

function relevant(): PendingFailure | undefined {
  const permit = adopted()
  if (current !== undefined && permit !== undefined && !same(permit, current.source))
    retire()
  // 同人 200 可能因本机故障没有许可；换了响应对象/暂时没有许可不能忘掉原代次的否决。
  return current
}

async function dispatch(facts: SessionCheckFailure, permit: unknown): Promise<unknown> {
  const failure = await import('./browser-session-failure.ts')
  return failure.handleRequestSessionFailure(facts, permit)
}

async function start(entry: PendingFailure, facts: SessionCheckFailure): Promise<void> {
  const previous = entry.pending.get(facts.kind)
  if (previous !== undefined)
    return previous
  entry.facts.set(facts.kind, facts)
  const operation = Promise.resolve().then(async () => {
    if (await dispatch(facts, entry.source) === 'stopped')
      entry.applied.add(facts.kind)
  }).catch(() => {}).finally(() => {
    if (entry.pending.get(facts.kind) === operation)
      entry.pending.delete(facts.kind)
    notify(entry)
  })
  entry.pending.set(facts.kind, operation)
  return operation
}

/** 同步登记后才启动按需副作用；这里的来源只用于等待/否决，从不授予持久资格。 */
export async function registerRequestFailure(facts: SessionCheckFailure, original: unknown): Promise<void> {
  const source = readDraftSessionPermit(original)
  if (source === undefined || (facts.kind === 'disabled' && facts.userId !== source.userId))
    return dispatch(facts, original).then(() => {})
  const entry = relevant()
  const selected = adopted()
  if ((selected !== undefined && !same(selected, source)) || (entry !== undefined && !same(entry.source, source))
    || (selected === undefined && entry === undefined)) {
    return dispatch(facts, source).then(() => {})
  }
  const response = currentApiSession()
  const sourceResponse = same(selected, source) && response !== undefined ? { userId: response.user.id, csrfToken: response.csrfToken } : undefined
  current ??= { source, facts: new Map(), pending: new Map(), listeners: new Set(), applied: new Set(), sourceResponse, retry: false, retired: false }
  return start(current, facts)
}

/** 等待发生在 SessionActivation 取票、拿锁之前；截止时间不会因新的相关失败重置。 */
export async function waitForRequestFailure(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const entry = relevant()
  if (entry === undefined)
    return
  if (entry.retry) {
    entry.retry = false
    for (const facts of entry.facts.values()) {
      if (!entry.applied.has(facts.kind))
        void start(entry, facts)
    }
  }
  if (entry.pending.size === 0)
    return
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  let settled: (() => void) | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(resolve, WAIT_MS)
      abort = () => reject(signal?.reason)
      signal?.addEventListener('abort', abort, { once: true })
      settled = () => {
        if (entry.retired || entry.pending.size === 0)
          resolve()
      }
      entry.listeners.add(settled)
      settled()
    })
    signal?.throwIfAborted()
  }
  finally {
    clearTimeout(timer)
    if (abort !== undefined)
      signal?.removeEventListener('abort', abort)
    if (settled !== undefined)
      entry.listeners.delete(settled)
  }
}

/** 已登记却未落实的停用不能被同来源 query 重新激活而失去原清理资格。 */
export function allowFailureConfirmation(response: SessionResponse): boolean {
  // 不能冻结查询起点：网络、摘要及 IDB 读取期间都可能同步登记新的相关事实。
  const entry = relevant()
  return entry === undefined || !entry.facts.has('disabled') || entry.applied.has('disabled')
    || response.user.id !== entry.source.userId
    || (entry.sourceResponse !== undefined && response.csrfToken !== entry.sourceResponse.csrfToken)
}

/** settled/超时都不证明停写成功；只有 fence 真正给出的不同代次才可结束本次否决。 */
export function finishFailureConfirmation(response: SessionResponse): void {
  const entry = relevant()
  if (entry === undefined)
    return
  const permit = readDraftSessionPermit(associatedSessionPermit(response))
  if (permit === undefined || same(permit, entry.source)) {
    rememberSessionPermit(response, undefined)
    entry.retry = true
  }
  else if (current === entry) {
    retire()
  }
}
