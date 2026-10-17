import { describe, expect, it } from 'vitest'
import { createCrashWriteEvidence } from './selftest-crash-writes.ts'

const HASH = 'a'.repeat(64)
const identity = { userId: 'user', documentId: 'document', writeEpoch: 2, writerId: 'writer', draftSeq: 3, writtenBy: 'page' }
const request = () => ({ id: 7, type: 'write', capture: { key: { userId: 'user', documentId: 'document' }, writer: { writeEpoch: 2, writerId: 'writer' }, draftSeq: 3, writtenBy: 'page', bytes: new Uint8Array([1, 2, 3]) } })
const reply = () => ({ id: 7, ok: true, result: { kind: 'written', digest: HASH, mirror: { kind: 'mirrored' } } })

describe('崩溃自检只以对应生产 Worker 的实际镜像完成作为证据', () => {
  it('协议允许编号 0，不能遗漏其真实写入回包', () => {
    const observer = createCrashWriteEvidence()
    const worker = {}
    observer.sent(worker, { ...request(), id: 0 })
    observer.received(worker, { ...reply(), id: 0 })
    expect(observer.count()).toBe(1)
    expect(observer.mirrorFor(identity, HASH)).toEqual({ draftSeq: 3, snapshotHash: HASH })
  })

  it('只接受同一 Worker 的未消费请求，镜像证据绑定磁盘身份与独立摘要', () => {
    const observer = createCrashWriteEvidence()
    const worker = {}
    const other = {}
    const call = request()
    observer.sent(worker, call)
    call.capture.draftSeq = 99
    observer.received(other, reply())
    expect(observer.count()).toBe(0)
    observer.received(worker, reply())
    observer.received(worker, reply())
    expect(observer.count()).toBe(1)
    expect(observer.mirrorFor(identity, HASH)).toEqual({ draftSeq: 3, snapshotHash: HASH })
    expect(observer.mirrorFor(identity, 'b'.repeat(64))).toBeUndefined()
  })

  it.each([
    { ...reply(), ok: false },
    { ...reply(), result: { kind: 'unchanged', digest: HASH } },
    { ...reply(), result: { kind: 'written', digest: HASH, mirror: { kind: 'off' } } },
    { ...reply(), result: { kind: 'written', digest: HASH, mirror: { kind: 'not-mirrored', reason: 'busy' } } },
    { ...reply(), result: { kind: 'written', digest: 'invalid', mirror: { kind: 'mirrored' } } },
  ])('失败、去重、镜像关闭/失败或摘要无效不能证明镜像完成：%j', (message) => {
    const observer = createCrashWriteEvidence()
    const worker = {}
    observer.sent(worker, request())
    observer.received(worker, message)
    expect(observer.mirrorFor(identity, HASH)).toBeUndefined()
  })

  it.each([
    { userId: 'other' },
    { documentId: 'other' },
    { writeEpoch: 3 },
    { writerId: 'other' },
    { draftSeq: 4 },
    { writtenBy: 'other' },
  ])('其他写入不能给当前磁盘草稿提供镜像证据：%j', (change) => {
    const observer = createCrashWriteEvidence()
    const worker = {}
    observer.sent(worker, request())
    observer.received(worker, reply())
    expect(observer.mirrorFor({ ...identity, ...change }, HASH)).toBeUndefined()
  })

  it('只有 write 请求参与，取消或损坏的请求不能靠回包补出身份', () => {
    const observer = createCrashWriteEvidence()
    const worker = {}
    observer.sent(worker, { ...request(), type: 'read' })
    observer.received(worker, reply())
    observer.sent(worker, { ...request(), capture: {} })
    observer.received(worker, reply())
    expect(observer.count()).toBe(0)
    expect(observer.mirrorFor(identity, HASH)).toBeUndefined()
  })
})
