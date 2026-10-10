import type { DraftPreparation, PreparedDraft } from '../working-draft.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gunzipBytes } from '../../../shared/outbox/draft-codec.ts'
import { CLIENT_INSTANCE_ID, OTHER_WRITER_ID } from '../../../shared/outbox/draft-record.test-support.ts'
import { deferred } from '../../../shared/outbox/outbox-lock.test-support.ts'
import { settle } from '../fake-lease-clock.test-support.ts'
import { DRAFT_KEY, persistentHarness } from './persistent-working-draft.test-support.ts'
import { createPersistentWorkingDraft } from './persistent-working-draft.ts'

afterEach(() => vi.restoreAllMocks())

const capture = (snapshot: string, editorSeq = 1, dedupe = true) => ({ snapshot, editorSeq, dedupe, formulasPending: false })
function prepared(result: DraftPreparation): PreparedDraft {
  expect(result.kind).toBe('prepared')
  if (result.kind !== 'prepared')
    throw new Error('测试需要固定上传')
  return result
}
async function textOf(result: PreparedDraft): Promise<string> {
  return new TextDecoder().decode(await gunzipBytes(result.gzip))
}

describe('持久工作草稿：内容、真实序号与失败退路', () => {
  it.each(['failed', 'throw'] as const)('确认已删除但宿主 %s 丢掉回包，释放上传后仍拥有云端已确认的当前正文', async (failure) => {
    const h = await persistentHarness()
    const source = createPersistentWorkingDraft(h.options)
    const ref = source.capture(capture('云端已收下的当前正文'))
    const upload = prepared(await source.prepare(ref))
    const confirm = h.writer.confirm.bind(h.writer)
    vi.spyOn(h.writer, 'confirm').mockImplementationOnce(async (...input) => {
      expect(await confirm(...input)).toEqual({ kind: 'deleted' })
      if (failure === 'throw')
        throw new Error('确认回包丢失')
      return { kind: 'failed', error: { name: 'OutboxWorkerError', message: '确认回包丢失' } }
    })
    expect(await source.confirm(upload, 8)).toMatchObject({ kind: 'failed' })
    expect(h.store.rawDraft(DRAFT_KEY)).toBeUndefined()
    source.release(upload)
    expect(await source.readLatest()).toEqual({ kind: 'snapshot', ref, snapshot: '云端已收下的当前正文' })
    expect(source.view()).toMatchObject({ summary: { confirmedRevision: 8, baseRevision: 8 } })
    expect(await textOf(prepared(await source.prepare(ref)))).toBe('云端已收下的当前正文')
    source.dispose()
  })

  it('旧确认丢回包不能把旧正文交给更新的当前内容', async () => {
    const h = await persistentHarness()
    const source = createPersistentWorkingDraft(h.options)
    const upload = prepared(await source.prepare(source.capture(capture('旧上传'))))
    const current = source.capture(capture('之后的新输入', 2))
    await source.ready(current)
    const confirm = h.writer.confirm.bind(h.writer)
    vi.spyOn(h.writer, 'confirm').mockImplementationOnce(async (...input) => {
      expect(await confirm(...input)).toEqual({ kind: 'rebased' })
      return { kind: 'failed', error: { name: 'OutboxWorkerError', message: '确认回包丢失' } }
    })
    expect(await source.confirm(upload, 8)).toMatchObject({ kind: 'failed' })
    source.release(upload)
    expect(await source.readLatest()).toEqual({ kind: 'snapshot', ref: current, snapshot: '之后的新输入' })
    expect(source.view()).toMatchObject({ summary: { confirmedRevision: undefined, baseRevision: 8 } })
    expect(await textOf(prepared(await source.prepare(current)))).toBe('之后的新输入')
    source.dispose()
  })

  it('明确拒绝后 release 结束请求，同样内容也写新序号以清除旧在途标记', async () => {
    const h = await persistentHarness()
    const source = createPersistentWorkingDraft(h.options)
    const ref = source.capture(capture('同样正文'))
    const first = prepared(await source.prepare(ref))
    await source.markInFlight(first, { requestId: 'definitely-rejected', clientInstanceId: CLIENT_INSTANCE_ID, localSeq: first.contentSeq, sentAt: 1_000 })
    source.release(first)
    const second = source.capture(capture('同样正文', 2))
    expect(await source.ready(second)).toMatchObject({ contentSeq: 2 })
    expect(h.store.rawDraft(DRAFT_KEY)).toMatchObject({ draftSeq: 2, inFlight: null })
    const third = source.capture(capture('同样正文', 3))
    expect(await source.ready(third)).toMatchObject({ contentSeq: 2 })
    source.dispose()
  })

  it('旧上传或字段副本的 release 不能清掉新固定上传的在途请求', async () => {
    const h = await persistentHarness()
    const source = createPersistentWorkingDraft(h.options)
    const first = prepared(await source.prepare(source.capture(capture('旧请求'))))
    source.release(first)
    const second = prepared(await source.prepare(source.capture(capture('新请求'))))
    const inFlight = { requestId: 'current-request', clientInstanceId: CLIENT_INSTANCE_ID, localSeq: second.contentSeq, sentAt: 2_000 }
    await source.markInFlight(second, inFlight)
    source.release(first)
    source.release({ ...second })
    const third = source.capture(capture('继续编辑'))
    await source.ready(third)
    expect(h.store.rawDraft(DRAFT_KEY)).toMatchObject({ draftSeq: 3, inFlight })
    expect(await source.prepare(second.ref)).toBe(second)
    source.dispose()
  })

  it.each(['denied', 'newer-version', 'blocked'] as const)('存储 %s 的具体问题保留在元数据中，不把失败 gzip 留在状态里', async (reason) => {
    const h = await persistentHarness()
    const source = createPersistentWorkingDraft(h.options)
    h.store.failNext('writeDraft', { kind: 'unavailable', reason })
    const ref = source.capture(capture('存储退路'))
    const result = await source.ready(ref)
    expect(result).toMatchObject({ local: { kind: 'memory', reason: 'unavailable', problem: { kind: 'unavailable', reason } } })
    if (result.kind === 'ready')
      expect(result.local).not.toHaveProperty('problem.gzip')
    expect(await textOf(prepared(await source.prepare(ref)))).toBe('存储退路')
    source.dispose()
  })

  it('等待本机写入尝试结束才给上传；成功后再次准备从同一份持久记录读回', async () => {
    const h = await persistentHarness()
    const held = h.store.holdNext('writeDraft')
    const source = createPersistentWorkingDraft(h.options)
    const ref = source.capture(capture('本机先于上传'))
    let completed = false
    const pending = source.prepare(ref).then((result) => {
      completed = true
      return result
    })
    await held.reached
    expect(completed).toBe(false)
    held.release()
    const first = prepared(await pending)
    expect(await textOf(first)).toBe('本机先于上传')
    expect(await source.ready(ref)).toMatchObject({ contentSeq: ref.draftSeq, local: { kind: 'persisted' } })
    const read = vi.spyOn(h.session, 'read')
    source.release(first)
    const second = prepared(await source.prepare(ref))
    expect(read).toHaveBeenCalledTimes(1)
    expect(await textOf(second)).toBe('本机先于上传')
    source.dispose()
  })

  it('unchanged 映射到旧真实 contentSeq；确认删除后同样内容重新落盘，显式保存不去重', async () => {
    const h = await persistentHarness()
    const source = createPersistentWorkingDraft(h.options)
    const first = source.capture(capture('相同正文', 5))
    await source.ready(first)
    const second = source.capture(capture('相同正文', 0))
    expect(await source.ready(second)).toMatchObject({ ref: second, contentSeq: first.draftSeq })
    expect(second.draftSeq).toBe(2)
    expect(h.store.calls.filter(call => call === 'writeDraft')).toHaveLength(1)
    const upload = prepared(await source.prepare(second))
    expect(upload.contentSeq).toBe(first.draftSeq)
    expect(await source.markInFlight(upload, { requestId: 'request-1', clientInstanceId: CLIENT_INSTANCE_ID, localSeq: upload.contentSeq, sentAt: 1_000 })).toEqual({ kind: 'resealed' })
    expect(h.store.rawDraft(DRAFT_KEY)).toMatchObject({ draftSeq: 1, inFlight: { localSeq: 1 } })
    expect(await source.confirm(upload, 8)).toEqual({ kind: 'deleted' })
    expect(h.store.rawDraft(DRAFT_KEY)).toBeUndefined()
    source.release(upload)
    expect(await source.readLatest()).toMatchObject({ ref: second, snapshot: '相同正文' })
    const third = source.capture(capture('相同正文', 1))
    expect(await source.ready(third)).toMatchObject({ contentSeq: 3 })
    expect(h.store.rawDraft(DRAFT_KEY)).toMatchObject({ draftSeq: 3, baseRevision: 8 })
    const fourth = source.capture(capture('相同正文', 2, false))
    expect(await source.ready(fourth)).toMatchObject({ contentSeq: 4 })
    expect(h.store.calls.filter(call => call === 'writeDraft')).toHaveLength(3)
    source.dispose()
  })

  it('未知请求固定原字节，新捕获不去重并携带该请求；旧确认只改新记录基准', async () => {
    const h = await persistentHarness()
    const source = createPersistentWorkingDraft(h.options)
    const first = source.capture(capture('同样内容'))
    const upload = prepared(await source.prepare(first))
    const inFlight = { requestId: 'unknown-request', clientInstanceId: CLIENT_INSTANCE_ID, localSeq: upload.contentSeq, sentAt: 1_000 }
    await source.markInFlight(upload, inFlight)
    const second = source.capture(capture('同样内容', 2))
    expect(await source.ready(second)).toMatchObject({ contentSeq: second.draftSeq })
    expect(h.store.rawDraft(DRAFT_KEY)).toMatchObject({ draftSeq: 2, inFlight })
    expect(await source.prepare(first)).toBe(upload)
    expect(await source.confirm(upload, 8)).toEqual({ kind: 'rebased' })
    expect(h.store.rawDraft(DRAFT_KEY)).toMatchObject({ draftSeq: 2, baseRevision: 8, inFlight: null })
    expect(await source.readLatest()).toMatchObject({ snapshot: '同样内容', ref: second })
    expect(upload.baseRevision).toBe(7)
    source.dispose()
  })

  it('写满仍用本次 gzip 上传且不编造摘要；新捕获只再尝试一次', async () => {
    const h = await persistentHarness()
    const write = vi.spyOn(h.writer, 'write')
    const source = createPersistentWorkingDraft(h.options)
    h.store.failNext('writeDraft', { kind: 'quota' })
    const first = source.capture(capture('写满退路'))
    expect(await source.ready(first)).toMatchObject({ local: { kind: 'memory', reason: 'quota' }, digest: undefined })
    const upload = prepared(await source.prepare(first))
    expect(await textOf(upload)).toBe('写满退路')
    expect(h.store.rawDraft(DRAFT_KEY)).toBeUndefined()
    expect(write).toHaveBeenCalledTimes(1)
    source.release(upload)
    const second = source.capture(capture('再次尝试', 2))
    expect(await source.ready(second)).toMatchObject({ local: { kind: 'persisted' } })
    expect(write).toHaveBeenCalledTimes(2)
    source.dispose()
  })

  it('Worker 接收转移字节后失败，只用对应引用的临时文本恢复，不能拿新内容顶替固定上传', async () => {
    const h = await persistentHarness()
    const finished = deferred<Awaited<ReturnType<typeof h.writer.write>>>()
    vi.spyOn(h.writer, 'write').mockImplementationOnce(async (input) => {
      structuredClone(input.bytes, { transfer: [input.bytes.buffer] })
      return finished.promise
    })
    const source = createPersistentWorkingDraft(h.options)
    const first = source.capture(capture('被转移的旧请求'))
    const pending = source.prepare(first)
    await settle()
    const second = source.capture(capture('新的编辑', 2))
    finished.resolve({ kind: 'failed', gzip: null, error: { name: 'OutboxWorkerError', message: '崩溃' } })
    const upload = prepared(await pending)
    expect(await textOf(upload)).toBe('被转移的旧请求')
    expect(await source.ready(first)).toMatchObject({ local: { kind: 'memory' } })
    await source.ready(second)
    expect(await source.readLatest()).toMatchObject({ ref: second, snapshot: '新的编辑' })
    source.dispose()
  })

  it.each(['writer', 'document', 'seq'] as const)('持久读回的 %s 不符时拒绝，不能把另一份内容交给引用', async (mismatch) => {
    const h = await persistentHarness()
    const source = createPersistentWorkingDraft(h.options)
    const ref = source.capture(capture('属于这一份'))
    await source.ready(ref)
    await settle()
    const existing = await h.writer.read(DRAFT_KEY)
    if (existing.kind !== 'draft')
      throw new Error('测试需要可读持久记录')
    vi.spyOn(h.session, 'read').mockResolvedValue({ ...existing, meta: { ...existing.meta, ...(mismatch === 'writer' ? { writerId: OTHER_WRITER_ID } : mismatch === 'document' ? { documentId: 'another-doc' } : { draftSeq: 99 }) } })
    expect(await source.prepare(ref)).toMatchObject({ kind: 'failed', error: { name: 'DraftIdentityMismatch' } })
    expect(h.host).toHaveBeenCalledTimes(1)
    source.dispose()
  })

  it('宿主崩溃且编辑权无法核对，仍能只读取回匹配的本会话内容，不登记或 force', async () => {
    const h = await persistentHarness()
    const source = createPersistentWorkingDraft(h.options)
    const ref = source.capture(capture('已落盘的当前内容'))
    await source.ready(ref)
    await settle()
    const before = h.store.rawWriter(DRAFT_KEY)
    h.hosts[0]!.break()
    h.confirm.mockResolvedValue({ kind: 'unknown', error: undefined })
    expect(await source.readLatest()).toEqual({ kind: 'snapshot', ref, snapshot: '已落盘的当前内容' })
    expect(h.host).toHaveBeenCalledTimes(2)
    expect(h.confirm).not.toHaveBeenCalled()
    expect(h.store.rawWriter(DRAFT_KEY)).toEqual(before)
    expect(h.session.view()).toMatchObject({ kind: 'memory', reason: 'worker-failed' })
    source.dispose()
  })
})
