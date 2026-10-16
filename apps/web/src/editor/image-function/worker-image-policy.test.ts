import { afterEach, describe, expect, it, vi } from 'vitest'
import { SheetEditorLoadError } from '../sheet-editor-error.ts'
import { watchWorkerImagePolicy } from './worker-image-policy.ts'
import { imagePolicyReport } from './worker-report.ts'

/** 用 EventTarget 代替 Worker：测试按需派发 message、error、messageerror */
function fakeWorker() {
  const target = new EventTarget()
  const worker = target as unknown as Worker
  const message = (data: unknown): boolean => target.dispatchEvent(new MessageEvent('message', { data }))
  const fail = (type: 'error' | 'messageerror'): boolean => target.dispatchEvent(new Event(type, { cancelable: true }))
  return { worker, message, fail }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function reasonOf(promise: Promise<void>): Promise<string | null> {
  return promise.then(() => null, (error: unknown) => (error instanceof SheetEditorLoadError ? error.reason : String(error)))
}

describe('等公式 Worker 回报 IMAGE() 限制的安装结果', () => {
  it('回报 ok：Worker 这边就绪；RPC 的消息不影响', async () => {
    const { worker, message } = fakeWorker()
    const watch = watchWorkerImagePolicy(worker)
    message({ type: 100, seq: 1 })
    message(imagePolicyReport(true))
    await expect(watch.installed).resolves.toBeUndefined()
  })

  it('只收到 RPC 的消息时仍在等回报', async () => {
    const { worker, message } = fakeWorker()
    const watch = watchWorkerImagePolicy(worker)
    message({ type: 100, seq: 1 })
    message({ type: 0, seq: 1, data: {} })
    const outcome = await Promise.race([watch.installed.then(() => 'resolved', () => 'rejected'), new Promise(resolve => setTimeout(resolve, 20, 'pending'))])
    expect(outcome).toBe('pending')
    watch.dispose()
  })

  it('回报没装上：image-policy-failed', async () => {
    const { worker, message } = fakeWorker()
    const watch = watchWorkerImagePolicy(worker)
    message(imagePolicyReport(false))
    await expect(reasonOf(watch.installed)).resolves.toBe('image-policy-failed')
  })

  it.each(['error', 'messageerror'] as const)('Worker 出 %s（脚本加载失败、执行出错、消息无法解析）：worker-failed', async (type) => {
    const { worker, fail } = fakeWorker()
    const watch = watchWorkerImagePolicy(worker)
    fail(type)
    await expect(reasonOf(watch.installed)).resolves.toBe('worker-failed')
  })

  it('移除监听之后的消息不再理会', async () => {
    const { worker, message, fail } = fakeWorker()
    const watch = watchWorkerImagePolicy(worker)
    watch.dispose()
    fail('error')
    message(imagePolicyReport(true))
    const outcome = await Promise.race([watch.installed.then(() => 'resolved', () => 'rejected'), new Promise(resolve => setTimeout(resolve, 20, 'pending'))])
    expect(outcome).toBe('pending')
  })

  it.each([
    ['error', 'error-before-ready'],
    ['messageerror', 'messageerror-before-ready'],
  ] as const)('就绪前 %s 保留可供恢复分类的首错', async (event, failure) => {
    const { worker, fail } = fakeWorker()
    const watch = watchWorkerImagePolicy(worker)
    const outcome = expect(watch.installed).rejects.toMatchObject({ reason: 'worker-failed', failure })
    fail(event)
    await outcome
    expect(watch.failure()).toBe(failure)
    watch.dispose()
  })

  it('Worker 的 IMAGE 安装失败带独立种类，不能被后来的成功回报覆盖', async () => {
    const { worker, message } = fakeWorker()
    const watch = watchWorkerImagePolicy(worker)
    const outcome = expect(watch.installed).rejects.toMatchObject({ reason: 'image-policy-failed', failure: 'image-policy' })
    message(imagePolicyReport(false))
    message(imagePolicyReport(true))
    await outcome
    expect(watch.failure()).toBe('image-policy')
    watch.dispose()
  })

  it('握手等满 20 秒才失败，普通 RPC 和不完整回报不能延长时限', async () => {
    vi.useFakeTimers()
    const { worker, message } = fakeWorker()
    const watch = watchWorkerImagePolicy(worker)
    let failure: unknown
    void watch.installed.catch((error) => {
      failure = error
    })
    await vi.advanceTimersByTimeAsync(19_999)
    message({ type: 100, seq: 1 })
    message({ type: 'nerve:image-policy', ok: 'yes' })
    expect(failure).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(failure).toMatchObject({ reason: 'worker-failed', failure: 'ready-timeout' })
    expect(watch.failure()).toBe('ready-timeout')
    expect(vi.getTimerCount()).toBe(0)
    watch.dispose()
  })

  it.each(['error', 'messageerror'] as const)('握手成功后 %s 仍通知，晚订阅可从 getter 读到故障', async (type) => {
    vi.useFakeTimers()
    const { worker, message, fail } = fakeWorker()
    const watch = watchWorkerImagePolicy(worker)
    const failures: string[] = []
    watch.onFailure(failure => failures.push(failure))
    message(imagePolicyReport(true))
    await watch.installed
    expect(vi.getTimerCount()).toBe(0)
    expect(watch.failure()).toBeUndefined()
    fail(type)
    expect(failures).toEqual([`${type}-after-ready`])
    expect(watch.failure()).toBe(`${type}-after-ready`)
    const late: string[] = []
    watch.onFailure(failure => late.push(failure))
    expect(late).toEqual([])
    expect(watch.failure()).toBe(`${type}-after-ready`)
    watch.dispose()
  })

  it('首错之后重复错误与迟到回报不再次通知，也不重新启动期限', async () => {
    vi.useFakeTimers()
    const { worker, message, fail } = fakeWorker()
    const watch = watchWorkerImagePolicy(worker)
    const failures: string[] = []
    watch.onFailure(failure => failures.push(failure))
    const outcome = reasonOf(watch.installed)
    fail('error')
    fail('messageerror')
    message(imagePolicyReport(true))
    message(imagePolicyReport(false))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await outcome).toBe('worker-failed')
    expect(failures).toEqual(['error-before-ready'])
    expect(watch.failure()).toBe('error-before-ready')
    expect(vi.getTimerCount()).toBe(0)
    watch.dispose()
  })

  it('取消订阅和销毁后不再通知，销毁也清掉启动期限', async () => {
    vi.useFakeTimers()
    const { worker, message, fail } = fakeWorker()
    const watch = watchWorkerImagePolicy(worker)
    const failures: string[] = []
    const stop = watch.onFailure(failure => failures.push(failure))
    stop()
    message(imagePolicyReport(true))
    await watch.installed
    fail('error')
    expect(failures).toEqual([])
    watch.dispose()
    const disposedFailures: string[] = []
    watch.onFailure(failure => disposedFailures.push(failure))
    fail('messageerror')
    expect(disposedFailures).toEqual([])
    const pending = watchWorkerImagePolicy(worker)
    pending.dispose()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(pending.failure()).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('一个观察者抛错不阻止其他观察者，也不破坏首错和计时器清理', async () => {
    vi.useFakeTimers()
    const report = vi.fn()
    vi.stubGlobal('reportError', report)
    const { worker, fail } = fakeWorker()
    const watch = watchWorkerImagePolicy(worker)
    const exception = new Error('观察者出错')
    const failures: string[] = []
    watch.onFailure(() => {
      throw exception
    })
    watch.onFailure(failure => failures.push(failure))
    const outcome = reasonOf(watch.installed)
    expect(fail('error')).toBe(false)
    expect(await outcome).toBe('worker-failed')
    expect(failures).toEqual(['error-before-ready'])
    expect(report).toHaveBeenCalledExactlyOnceWith(exception)
    expect(vi.getTimerCount()).toBe(0)
    watch.dispose()
  })
})
