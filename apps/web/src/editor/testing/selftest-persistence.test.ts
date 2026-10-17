import { describe, expect, it } from 'vitest'
import { observeSelftestWrites } from './selftest-persistence.ts'

const HASH = 'a'.repeat(64)
const identity = { userId: 'user', documentId: 'document', writeEpoch: 2, writerId: 'writer', draftSeq: 3, writtenBy: 'page' }
const request = { id: 0, type: 'write', capture: { key: { userId: 'user', documentId: 'document' }, writer: { writeEpoch: 2, writerId: 'writer' }, draftSeq: 3, writtenBy: 'page' } }
const reply = { id: 0, ok: true, result: { kind: 'written', digest: HASH, mirror: { kind: 'mirrored' } } }

class FakeWorker extends EventTarget {
  readonly sent: unknown[] = []
  readonly url: string | URL
  readonly options: WorkerOptions | undefined
  constructor(url: string | URL, options?: WorkerOptions) {
    super()
    this.url = url
    this.options = options
  }

  postMessage(message: unknown, options?: unknown): void {
    this.sent.push({ message, options })
  }
}

function fixture() {
  const target = { Worker: FakeWorker as unknown as typeof Worker }
  const observer = observeSelftestWrites(target)
  const worker = new target.Worker('actual-outbox.js', { name: 'nerve-outbox', type: 'module' })
  return { target, observer, worker }
}

describe('测试持久证据的 Worker 观察接线', () => {
  it('保留实际构造与消息传递，只观察已确认的对应写入', () => {
    const { observer, worker } = fixture()
    const transfer: Transferable[] = []
    worker.postMessage(request, transfer)
    const actual = worker as unknown as FakeWorker
    expect(actual.url).toBe('actual-outbox.js')
    expect(actual.options).toEqual({ name: 'nerve-outbox', type: 'module' })
    expect(actual.sent).toEqual([{ message: request, options: transfer }])
    expect(observer.writtenFor(identity, HASH)).toBe(false)
    worker.dispatchEvent(new MessageEvent('message', { data: reply }))
    expect(observer.writtenFor(identity, HASH)).toBe(true)
    expect(observer.mirrorFor(identity, HASH)).toEqual({ draftSeq: 3, snapshotHash: HASH })
  })

  it('其他 Worker 的相同协议不能提供发件箱证据', () => {
    const { observer, target } = fixture()
    const other = new target.Worker('formula.js', { name: 'formula' })
    other.postMessage(request)
    other.dispatchEvent(new MessageEvent('message', { data: reply }))
    expect(observer.count()).toBe(0)
    expect(observer.writtenFor(identity, HASH)).toBe(false)
  })

  it('释放后停止记录并恢复原构造器，不覆盖后来安装的观察器', () => {
    const { observer, worker, target } = fixture()
    worker.postMessage(request)
    observer.dispose()
    worker.dispatchEvent(new MessageEvent('message', { data: reply }))
    expect(observer.count()).toBe(0)
    expect(target.Worker).toBe(FakeWorker)
    const earlier = observeSelftestWrites(target)
    const later = observeSelftestWrites(target)
    const latest = target.Worker
    earlier.dispose()
    expect(target.Worker).toBe(latest)
    later.dispose()
  })
})
