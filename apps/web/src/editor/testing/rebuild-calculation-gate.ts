// 只在测试中安排“准备完成 → 旧实例开始重算 → 实际重建”的交错。
// 进入时暂留真实 writer 登记回包，退出时暂留真实租约释放回包；不替换工厂、不伪造成功、不发公式 STOP。
// 这两处之后到旧编辑器 dispose 只剩同步与微任务，先于公式下一次 MessageChannel 让出。Worker 模式也等真实进度通知。

interface RebuildProbe {
  readonly univerAPI: unknown
  readonly commands: (after?: number) => readonly { readonly seq: number, readonly at: number, readonly phase: string, readonly id: string }[]
}

export type RebuildGateResult
  = | { readonly kind: 'released', readonly boundaryAt: number, readonly startedAt: number, readonly startSeq: number, readonly notifiedAt: number, readonly notificationSeq: number, readonly releasedAt: number }
    | { readonly kind: 'failed', readonly reason: string }

export interface RebuildCalculationGate {
  readonly result: () => RebuildGateResult | undefined
  readonly dispose: () => void
}

/** 函数自包含：浏览器 E2E 可以把同一个函数送入页面；页面自检直接调用。仅匹配指定文档与一次准备。 */
export function installRebuildCalculationGate(documentId: string, direction: 'enter' | 'exit', probe: RebuildProbe): RebuildCalculationGate {
  interface FacadeEvents {
    readonly Event: { readonly CommandExecuted: string }
    readonly addEvent: (event: string, listener: (event: { readonly id: string }) => void) => { readonly dispose: () => void }
    readonly executeCommand: (id: string, params: object, options: object) => Promise<boolean>
  }
  const api = probe.univerAPI as FacadeEvents
  const NativeWorker = globalThis.Worker
  const nativeFetch = globalThis.fetch
  const cleanups: (() => void)[] = []
  let used = false
  let disposed = false
  let result: RebuildGateResult | undefined
  let cancelWaiting: (() => void) | undefined

  async function beforeRelease(): Promise<void> {
    const boundaryAt = performance.now()
    let stopListening: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if ((globalThis as unknown as { __nerveEditorProbe?: RebuildProbe }).__nerveEditorProbe !== probe)
        throw new Error('准备完成之前旧的编辑器已被替换')
      const mark = probe.commands().at(-1)?.seq ?? 0
      const progress = await new Promise<{ startedAt: number, startSeq: number, notifiedAt: number, notificationSeq: number }>((resolve, reject) => {
        let start: { readonly seq: number, readonly at: number } | undefined
        const subscription = api.addEvent(api.Event.CommandExecuted, (event) => {
          if (event.id === 'formula.mutation.set-formula-calculation-start')
            start = probe.commands(mark).find(command => command.phase === 'executed' && command.id === event.id)
          if (event.id !== 'formula.mutation.set-formula-calculation-notification' || start === undefined)
            return
          const notified = probe.commands(start.seq).find(command => command.phase === 'executed' && command.id === event.id)
          if (notified !== undefined)
            resolve({ startedAt: start.at, startSeq: start.seq, notifiedAt: notified.at, notificationSeq: notified.seq })
        })
        stopListening = () => subscription.dispose()
        cancelWaiting = () => reject(new Error('重建交错已取消'))
        // 小于退出的 5 秒等待上限：交错未建立就明确失败并放行原响应，不能靠生产超时冒充成功。
        timer = setTimeout(() => reject(new Error('准备完成后 2 秒内没有收到本轮公式的实际进度通知')), 2_000)
        void api.executeCommand('formula.mutation.set-trigger-formula-calculation-start', { forceCalculation: true }, { onlyLocal: true }).then((started) => {
          if (!started)
            reject(new Error('强制重算的命令被拒绝'))
        }, reject)
      })
      if (disposed || (globalThis as unknown as { __nerveEditorProbe?: RebuildProbe }).__nerveEditorProbe !== probe)
        throw new Error('放行准备回包之前旧的编辑器已被替换或交错已取消')
      result = { kind: 'released', boundaryAt, ...progress, releasedAt: performance.now() }
    }
    catch (error) {
      result = { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
    }
    finally {
      clearTimeout(timer)
      stopListening?.()
      cancelWaiting = undefined
    }
  }

  class RebuildWorker extends NativeWorker {
    private readonly registrations = new Set<number>()
    private readonly watched: boolean

    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options)
      this.watched = options?.name === 'nerve-outbox'
      if (!this.watched)
        return
      const intercept = (event: MessageEvent<unknown>): void => {
        const reply = event.data as { readonly id?: number, readonly ok?: boolean, readonly result?: { readonly kind?: string, readonly existing?: unknown } }
        if (disposed || used || reply.id === undefined || !this.registrations.has(reply.id) || reply.ok !== true || reply.result?.kind !== 'registered' || reply.result.existing !== undefined)
          return
        used = true
        event.stopImmediatePropagation()
        this.removeEventListener('message', intercept)
        // 在业务 client 订阅前安装。只暂留同一份成功数据，失败/取消时也原样交回，不扣公式的消息。
        void beforeRelease().finally(() => this.dispatchEvent(new MessageEvent('message', { data: event.data })))
      }
      this.addEventListener('message', intercept)
      cleanups.push(() => this.removeEventListener('message', intercept))
    }

    override postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions): void {
      const call = message as { readonly id?: number, readonly type?: string, readonly draft?: { readonly documentId?: string } }
      if (this.watched && call.type === 'register' && call.id !== undefined && call.draft?.documentId === documentId)
        this.registrations.add(call.id)
      if (Array.isArray(options))
        super.postMessage(message, options)
      else
        super.postMessage(message, options)
    }
  }

  const preparedFetch: typeof fetch = async (input, init) => {
    const response = await nativeFetch(input, init)
    const path = new URL(input instanceof Request ? input.url : input, location.href).pathname
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    if (!disposed && !used && method === 'DELETE' && path === `/api/documents/${documentId}/edit-lease` && response.status === 204) {
      used = true
      await beforeRelease()
    }
    return response
  }
  if (direction === 'enter')
    globalThis.Worker = RebuildWorker
  else
    globalThis.fetch = preparedFetch

  return {
    result: () => result,
    dispose: () => {
      disposed = true
      cancelWaiting?.()
      for (const cleanup of cleanups.splice(0))
        cleanup()
      if (globalThis.Worker === RebuildWorker)
        globalThis.Worker = NativeWorker
      if (globalThis.fetch === preparedFetch)
        globalThis.fetch = nativeFetch
    },
  }
}
