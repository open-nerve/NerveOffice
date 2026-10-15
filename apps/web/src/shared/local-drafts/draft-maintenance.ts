import type { LocalCleanup } from '../outbox/local-cleanup.ts'
import type { DraftSessionPermit, UserCleanupPermit } from '../outbox/session-fence.ts'
import type { DraftCatalog, DraftCatalogView } from './draft-catalog.ts'
import type { RecoveryDecision } from './recovery-decision.ts'
import { readDraftSessionPermit } from '../outbox/session-fence.ts'

type CompletedMaintenance = Extract<RecoveryDecision, { readonly kind: 'remove' }>['reason'] | 'confirmed'

export interface DraftMaintenanceView {
  readonly busy: boolean
  /** 公开页只能看这些无身份的结果；文档元数据仅存在当前原许可的 catalog 中。 */
  readonly cleanup: 'idle' | 'none' | 'cleared' | 'pending' | 'failed'
  readonly retention: 'idle' | 'done' | 'pending' | 'failed'
  readonly problem: 'storage' | undefined
  readonly catalog: DraftCatalogView | undefined
  /** 当前原许可下实际完成的原因；只留有限枚举，不保留已删除文档的身份或正文。 */
  readonly completed: readonly CompletedMaintenance[]
}
export interface DraftMaintenanceOptions {
  readonly readCleanup: () => Promise<{ readonly kind: 'ready', readonly permit: UserCleanupPermit | undefined } | { readonly kind: 'unavailable' }>
  readonly cleanup: Pick<LocalCleanup, 'removeUser' | 'purgeExpired'>
  readonly check: (permit: DraftSessionPermit) => Promise<'active' | 'session' | 'storage'>
  readonly makeCatalog: (permit: DraftSessionPermit, still: () => boolean) => Pick<DraftCatalog, 'refresh' | 'view' | 'dispose'> | Promise<Pick<DraftCatalog, 'refresh' | 'view' | 'dispose'>>
  readonly now: () => number
}
const EMPTY: DraftMaintenanceView = { busy: false, cleanup: 'idle', retention: 'idle', catalog: undefined, problem: undefined, completed: [] }

function completedReasons(previous: readonly CompletedMaintenance[], catalog: DraftCatalogView): readonly CompletedMaintenance[] {
  const reasons = new Set(previous)
  for (const { recovery } of catalog.rows) {
    if (recovery?.stage !== 'finished')
      continue
    if (recovery.decision?.kind === 'remove')
      reasons.add(recovery.decision.reason)
    else if (recovery.decision?.kind === 'confirmed')
      reasons.add('confirmed')
  }
  return [...reasons]
}

/** 不占阅读启动的等待链；一次扫描一个临时目录，结束便释放正文、密钥和 Worker。 */
export function createDraftMaintenance(options: DraftMaintenanceOptions) {
  let state = EMPTY
  let permit: DraftSessionPermit | undefined
  let epoch = 0
  let disposed = false
  let requested = false
  let pending: Promise<void> | undefined
  let scanning: Awaited<ReturnType<DraftMaintenanceOptions['makeCatalog']>> | undefined
  const listeners = new Set<() => void>()

  function publish(patch: Partial<DraftMaintenanceView>): void {
    if (disposed)
      return
    state = { ...state, ...patch }
    for (const listener of [...listeners])
      listener()
  }

  function release(): void {
    const old = scanning
    scanning = undefined
    old?.dispose()
  }

  async function resumeCleanup(): Promise<void> {
    try {
      const read = await options.readCleanup()
      if (disposed)
        return
      if (read.kind === 'unavailable') {
        publish({ cleanup: 'failed' })
        return
      }
      if (read.permit === undefined) {
        publish({ cleanup: 'none' })
        return
      }
      // 原资格来自持久 clearing；removeUser 在同源锁内再次核对，不重新 beginUser。
      const result = await options.cleanup.removeUser(read.permit)
      publish({ cleanup: result.kind === 'cleared' || result.kind === 'pending' ? result.kind : result.kind === 'invalidated' ? 'none' : 'failed' })
    }
    catch {
      publish({ cleanup: 'failed' })
    }
  }

  async function expire(): Promise<void> {
    try {
      const result = await options.cleanup.purgeExpired(options.now())
      publish({ retention: result.kind !== 'purged' ? 'failed' : result.pending.length > 0 || result.mirror.kind === 'failed' ? 'pending' : 'done' })
    }
    catch {
      publish({ retention: 'failed' })
    }
  }

  async function inspect(): Promise<void> {
    const source = permit
    const started = epoch
    const still = () => !disposed && epoch === started
    if (source === undefined)
      return
    const qualified = async (): Promise<boolean> => {
      const result = await options.check(source)
      if (!still())
        return false
      if (result !== 'active') {
        publish({ catalog: undefined, completed: [], problem: result === 'storage' ? 'storage' : undefined })
        if (result === 'session') {
          permit = undefined
          epoch += 1
        }
      }
      return result === 'active'
    }
    try {
      if (!await qualified())
        return
      const catalog = await options.makeCatalog(source, still)
      if (!still()) {
        catalog.dispose()
        return
      }
      scanning = catalog
      await catalog.refresh()
      // 冻结页可能漏过广播；发布前仍须按原许可读持久状态。
      if (still() && await qualified()) {
        const view = catalog.view()
        publish({ catalog: view, completed: completedReasons(state.completed, view), problem: undefined })
      }
    }
    catch {
      if (still())
        publish({ catalog: undefined, completed: [], problem: 'storage' })
    }
    finally {
      // 换人时已同步释放的旧目录不能再碰到新一轮目录。
      release()
    }
  }

  async function refresh(): Promise<void> {
    if (disposed)
      return Promise.resolve()
    requested = true
    pending ??= Promise.resolve().then(async () => {
      publish({ busy: true })
      try {
        while (requested) {
          requested = false
          await resumeCleanup()
          if (disposed)
            break
          await expire()
          if (!disposed)
            await inspect()
        }
      }
      finally {
        pending = undefined
        publish({ busy: false })
      }
    })
    return pending
  }

  return {
    view: (): DraftMaintenanceView => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    activate: (value: DraftSessionPermit | undefined) => {
      if (disposed)
        return
      const next = readDraftSessionPermit(value)
      if (permit?.userId === next?.userId && permit?.generation === next?.generation)
        return
      epoch += 1
      permit = next
      release()
      publish({ catalog: undefined, completed: [], problem: undefined })
      void refresh()
    },
    refresh,
    retry: refresh,
    dispose: () => {
      if (disposed)
        return
      disposed = true
      epoch += 1
      requested = false
      release()
      state = EMPTY
      listeners.clear()
    },
  }
}

export type DraftMaintenance = ReturnType<typeof createDraftMaintenance>
