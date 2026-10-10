import type { DraftWriteInput, WorkingDraftBackend } from './working-draft-source.ts'
import type { DraftMutation, DraftReadLatest, DraftSummary, PreparedDraft } from './working-draft.ts'
import { describe, expect, it, vi } from 'vitest'
import { gunzipBytes, gzipBytes } from '../../shared/outbox/draft-codec.ts'
import { CLIENT_INSTANCE_ID, sampleMeta } from '../../shared/outbox/draft-record.test-support.ts'
import { deferred } from '../../shared/outbox/outbox-lock.test-support.ts'
import { settle } from './fake-lease-clock.test-support.ts'
import { createWorkingDraftSource } from './working-draft-source.ts'

const capture = (snapshot: string) => ({ snapshot, editorSeq: 1, formulasPending: false, dedupe: true })

function harness() {
  let stored: { readonly seq: number, readonly gzip: Uint8Array<ArrayBuffer> } | undefined
  const reportError = vi.fn()
  const write = vi.fn(async (input: DraftWriteInput) => {
    const gzip = await gzipBytes(input.bytes)
    stored = { seq: input.ref.draftSeq, gzip }
    return { contentSeq: input.ref.draftSeq, digest: undefined, local: { kind: 'persisted' as const, mirror: { kind: 'off' as const } }, gzip, retainBody: false }
  })
  const read = vi.fn(async (summary: DraftSummary) => {
    if (stored?.seq !== summary.contentSeq)
      throw new Error('这一行已被其他内容覆盖')
    return stored.gzip
  })
  const markInFlight = vi.fn(async (): Promise<DraftMutation> => ({ kind: 'resealed' }))
  const confirm = vi.fn(async (): Promise<DraftMutation> => ({ kind: 'deleted' }))
  const backend: WorkingDraftBackend = { write, read, markInFlight, confirm, dispose: vi.fn() }
  const source = createWorkingDraftSource({ sessionId: 'test', initialDraftSeq: 0, baseRevision: 1, format: sampleMeta().format, writtenBy: CLIENT_INSTANCE_ID, reportError }, backend)
  return { source, write, read, markInFlight, confirm, reportError }
}

async function upload(source: ReturnType<typeof harness>['source'], text: string): Promise<PreparedDraft> {
  const result = await source.prepare(source.capture(capture(text)))
  if (result.kind !== 'prepared')
    throw new Error('测试需要固定上传')
  return result
}

describe('工作草稿内容所有权与后端顺序', () => {
  it('release 时旧标记仍有一次写入在途，其晚到成功不能解除下一次清标记的强制写入', async () => {
    const h = harness()
    const first = await upload(h.source, 'A')
    const inFlight = { requestId: 'ended', clientInstanceId: CLIENT_INSTANCE_ID, localSeq: first.contentSeq, sentAt: 1_000 }
    await h.source.markInFlight(first, inFlight)
    const original = h.write.getMockImplementation()!
    const held = deferred<Awaited<ReturnType<typeof original>>>()
    h.write.mockReturnValueOnce(held.promise)
    const second = h.source.capture(capture('B'))
    await settle()
    expect(h.write.mock.calls[1]?.[0].inFlight).toEqual(inFlight)
    h.source.release(first)
    const third = h.source.capture(capture('B'))
    held.resolve(await original(h.write.mock.calls[1]![0]))
    await h.source.ready(second)
    await h.source.ready(third)
    expect(h.write.mock.calls[2]?.[0]).toMatchObject({ inFlight: null, dedupe: false })
    const fourth = h.source.capture(capture('B'))
    await h.source.ready(fourth)
    expect(h.write.mock.calls[3]?.[0]).toMatchObject({ inFlight: null, dedupe: true })
    h.source.dispose()
  })

  it('暂停前把当前正文保留在同一来源和引用里，之后读回不依赖旧宿主', async () => {
    const h = harness()
    const ref = h.source.capture(capture('暂停内容'))
    await h.source.ready(ref)
    await settle()
    expect(await h.source.retainLatest('paused')).toEqual({ kind: 'retained', ref })
    h.read.mockRejectedValue(new Error('旧宿主已关闭'))
    expect(await h.source.readLatest()).toEqual({ kind: 'snapshot', ref, snapshot: '暂停内容' })
    expect(h.source.view()).toMatchObject({ ref, local: { kind: 'memory', reason: 'paused' } })
    h.source.dispose()
  })

  it('保留旧正文期间有新捕获，晚到读回不改新内容或本机事实', async () => {
    const h = harness()
    const ref = h.source.capture(capture('旧'))
    await h.source.ready(ref)
    await settle()
    const held = deferred<Uint8Array<ArrayBuffer>>()
    h.read.mockReturnValueOnce(held.promise)
    const retaining = h.source.retainLatest('paused')
    await settle()
    const next = h.source.capture(capture('新'))
    held.resolve(await gzipBytes(new TextEncoder().encode('旧')))
    expect(await retaining).toEqual({ kind: 'superseded', ref })
    await h.source.ready(next)
    expect(h.source.view()).toMatchObject({ ref: next, local: { kind: 'persisted' } })
    expect(await h.source.readLatest()).toMatchObject({ ref: next, snapshot: '新' })
    h.source.dispose()
  })

  it('dispose 立即结束保留正文等待，晚到错误不上报', async () => {
    const h = harness()
    const ref = h.source.capture(capture('正文'))
    await h.source.ready(ref)
    await settle()
    const held = deferred<Uint8Array<ArrayBuffer>>()
    h.read.mockReturnValueOnce(held.promise)
    const retaining = h.source.retainLatest('paused')
    await settle()
    h.source.dispose()
    expect(await retaining).toEqual({ kind: 'disposed', ref })
    held.reject(new Error('迟到'))
    await settle()
    expect(h.reportError).not.toHaveBeenCalled()
  })

  it('保留旧正文时新捕获取代它，旧宿主关闭后的读回失败只表示已被替代，不上报页面异常', async () => {
    const h = harness()
    const ref = h.source.capture(capture('旧正文'))
    await h.source.ready(ref)
    await settle()
    const held = deferred<Uint8Array<ArrayBuffer>>()
    h.read.mockReturnValueOnce(held.promise)
    const retaining = h.source.retainLatest('paused')
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledOnce())
    const next = h.source.capture(capture('退出登录时重新捕获的正文'))
    held.reject(new Error('旧宿主已经清钥并关闭'))
    expect(await retaining).toEqual({ kind: 'superseded', ref })
    await h.source.ready(next)
    expect(h.reportError).not.toHaveBeenCalled()
    expect(h.source.view()).toMatchObject({ ref: next, local: { kind: 'persisted' } })
    expect(await h.source.readLatest()).toEqual({ kind: 'snapshot', ref: next, snapshot: '退出登录时重新捕获的正文' })
    h.source.dispose()
  })

  it('当前正文没有被替换时，保留失败仍交回失败并上报一次', async () => {
    const h = harness()
    const ref = h.source.capture(capture('仍是当前正文'))
    await h.source.ready(ref)
    await settle()
    const error = new Error('当前正文读回失败')
    h.read.mockRejectedValueOnce(error)
    expect(await h.source.retainLatest('paused')).toMatchObject({ kind: 'failed', ref, error: { name: 'Error', message: error.message } })
    expect(h.reportError).toHaveBeenCalledExactlyOnceWith(error)
    expect(h.source.view()).toMatchObject({ ref })
    h.source.dispose()
  })

  it('prepare 同步预留读回位置；读 A 没结束前，后来的 B 不能覆盖单行存储', async () => {
    const h = harness()
    const first = h.source.capture(capture('A'))
    await h.source.ready(first)
    await settle()
    const original = h.read.getMockImplementation()!
    const held = deferred<Uint8Array<ArrayBuffer>>()
    h.read.mockReturnValueOnce(held.promise)
    const pending = h.source.prepare(first)
    const second = h.source.capture(capture('B'))
    await settle()
    expect(h.read).toHaveBeenCalledTimes(1)
    expect(h.write).toHaveBeenCalledTimes(1)
    const summary = await h.source.ready(first)
    if (summary.kind !== 'ready')
      throw new Error('第一份应已落存储')
    held.resolve(await original(summary))
    const result = await pending
    expect(result.kind).toBe('prepared')
    if (result.kind === 'prepared')
      expect(new TextDecoder().decode(await gunzipBytes(result.gzip))).toBe('A')
    await h.source.ready(second)
    expect(h.write).toHaveBeenCalledTimes(2)
    h.source.dispose()
  })

  it('A 的只读仍在等待时捕获 B，第二次 readLatest 交回 B，不复用 A 的 Promise', async () => {
    const h = harness()
    const first = h.source.capture(capture('A'))
    await h.source.ready(first)
    await settle()
    const held = deferred<Uint8Array<ArrayBuffer>>()
    h.read.mockReturnValueOnce(held.promise)
    const oldRead = h.source.readLatest()
    await settle()
    const second = h.source.capture(capture('B'))
    const newRead = h.source.readLatest()
    held.resolve(await gzipBytes(new TextEncoder().encode('A')))
    expect(await oldRead).toEqual({ kind: 'snapshot', ref: first, snapshot: 'A' })
    expect(await newRead).toEqual({ kind: 'snapshot', ref: second, snapshot: 'B' })
    h.source.dispose()
  })

  it('排队标记在途尚未执行就释放上传：该标记被拒，后续捕获不能带从未发出的请求', async () => {
    const h = harness()
    const prepared = await upload(h.source, 'A')
    const original = h.write.getMockImplementation()!
    const held = deferred<Awaited<ReturnType<typeof original>>>()
    h.write.mockReturnValueOnce(held.promise)
    const second = h.source.capture(capture('B'))
    await settle()
    const marking = h.source.markInFlight(prepared, { requestId: 'never-issued', clientInstanceId: CLIENT_INSTANCE_ID, localSeq: prepared.contentSeq, sentAt: 1_000 })
    h.source.release(prepared)
    const third = h.source.capture(capture('C'))
    held.resolve(await original(h.write.mock.calls[1]![0]))
    expect(await marking).toMatchObject({ kind: 'failed' })
    expect(h.markInFlight).not.toHaveBeenCalled()
    await h.source.ready(second)
    await h.source.ready(third)
    expect(h.write.mock.calls[2]?.[0].inFlight).toBeNull()
    h.source.dispose()
  })

  it('dispose 立即结束已经开始的 readLatest；迟到错误不改结果或再报告', async () => {
    const h = harness()
    const ref = h.source.capture(capture('正文'))
    await h.source.ready(ref)
    await settle()
    const held = deferred<Uint8Array<ArrayBuffer>>()
    h.read.mockReturnValueOnce(held.promise)
    let result: DraftReadLatest | undefined
    const reading = h.source.readLatest().then((value) => {
      result = value
    })
    await settle()
    h.source.dispose()
    await settle()
    const atDispose = result
    held.reject(new Error('迟到错误'))
    await reading
    expect(atDispose).toEqual({ kind: 'disposed' })
    expect(result).toEqual({ kind: 'disposed' })
    expect(h.reportError).not.toHaveBeenCalled()
  })

  it('释放持久上传后来源不留正文，下一次 prepare 必须重新从后端读；旧 release 不影响新 pin', async () => {
    const h = harness()
    const prepared = await upload(h.source, '正文')
    expect(h.read).not.toHaveBeenCalled()
    h.source.release(prepared)
    const next = await h.source.prepare(prepared.ref)
    expect(h.read).toHaveBeenCalledTimes(1)
    h.source.release(prepared)
    expect(await h.source.prepare(prepared.ref)).toBe(next)
    h.source.dispose()
  })

  it.each(['markInFlight', 'confirm'] as const)('dispose 立即结清已开始的 %s；迟到成功或失败不能复活结果', async (method) => {
    const h = harness()
    const prepared = await upload(h.source, '正文')
    const held = deferred<DraftMutation>()
    h[method].mockReturnValueOnce(held.promise)
    let result: DraftMutation | undefined
    const pending = (method === 'confirm'
      ? h.source.confirm(prepared, 2)
      : h.source.markInFlight(prepared, { requestId: 'request', clientInstanceId: CLIENT_INSTANCE_ID, localSeq: prepared.contentSeq, sentAt: 1_000 })).then((value) => {
      result = value
    })
    await settle()
    expect(h[method]).toHaveBeenCalledTimes(1)
    h.source.dispose()
    await settle()
    const atDispose = result
    if (method === 'confirm')
      held.reject(new Error('迟到失败'))
    else
      held.resolve({ kind: 'resealed' })
    await pending
    expect(atDispose).toMatchObject({ kind: 'failed', error: { name: 'InvalidPreparedDraft' } })
    expect(result).toEqual(atDispose)
    expect(h.reportError).not.toHaveBeenCalled()
  })
})
