import { describe, expect, it } from 'vitest'
import { SheetEditorLoadError } from '../sheet-editor-error.ts'
import { watchWorkerImagePolicy } from './worker-image-policy.ts'
import { imagePolicyReport } from './worker-report.ts'

/** 用 EventTarget 代替 Worker：测试按需派发 message、error、messageerror */
function fakeWorker() {
  const target = new EventTarget()
  const worker = target as unknown as Worker
  const message = (data: unknown): boolean => target.dispatchEvent(new MessageEvent('message', { data }))
  const fail = (type: 'error' | 'messageerror'): boolean => target.dispatchEvent(new Event(type))
  return { worker, message, fail }
}

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
})
