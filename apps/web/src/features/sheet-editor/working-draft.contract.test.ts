import type { DraftPreparation, PreparedDraft, WorkingDraftOptions } from './working-draft.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as codec from '../../shared/outbox/draft-codec.ts'
import { CLIENT_INSTANCE_ID, sampleMeta } from '../../shared/outbox/draft-record.test-support.ts'
import { deferred } from '../../shared/outbox/outbox-lock.test-support.ts'
import { settle } from './fake-lease-clock.test-support.ts'
import { createMemoryWorkingDraft } from './memory-working-draft.ts'
import { persistentHarness } from './outbox/persistent-working-draft.test-support.ts'
import { createPersistentWorkingDraft } from './outbox/persistent-working-draft.ts'

afterEach(() => vi.restoreAllMocks())

const OPTIONS: WorkingDraftOptions = { sessionId: 'edit-1', initialDraftSeq: 40, baseRevision: 7, format: sampleMeta().format, writtenBy: CLIENT_INSTANCE_ID, reportError: () => {} }
const capture = (snapshot: string, editorSeq = 1, dedupe = true) => ({ snapshot, editorSeq, dedupe, formulasPending: false })

function prepared(result: DraftPreparation): PreparedDraft {
  expect(result.kind).toBe('prepared')
  if (result.kind !== 'prepared')
    throw new Error('测试需要可上传的原始内容')
  return result
}

async function textOf(value: PreparedDraft): Promise<string> {
  return new TextDecoder().decode(await codec.gunzipBytes(value.gzip))
}

describe.each(['memory', 'persistent'] as const)('工作草稿共同契约：%s', (mode) => {
  const create = async (options: Partial<WorkingDraftOptions> = {}) => {
    if (mode === 'memory')
      return createMemoryWorkingDraft({ ...OPTIONS, ...options, reason: 'disabled' })
    const h = await persistentHarness()
    try {
      return createPersistentWorkingDraft({ ...h.options, ...OPTIONS, ...options })
    }
    catch (error) {
      h.session.dispose()
      throw error
    }
  }

  it('同一同步段分配高水位与字节数，编辑器序号归零不影响 draftSeq', async () => {
    const source = await create()
    const first = source.capture(capture('你好 😀', 91))
    const second = source.capture(capture('重建后', 0))
    expect(first).toEqual({ sessionId: 'edit-1', serial: 1, draftSeq: 41, editorSeq: 91, bytes: 11, formulasPending: false })
    expect(second).toMatchObject({ serial: 2, draftSeq: 42, editorSeq: 0 })
    expect(await source.ready(second)).toMatchObject({ kind: 'ready', ref: second, contentSeq: 42, local: mode === 'memory' ? { kind: 'memory', reason: 'disabled' } : { kind: 'persisted' } })
    expect(source.view()).toMatchObject({ kind: 'working', ref: second })
    source.dispose()
  })

  it('序号不超过安全整数；非法起点不创建半有效来源', async () => {
    for (const initialDraftSeq of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])
      await expect(create({ initialDraftSeq })).rejects.toThrow(RangeError)
    const source = await create({ initialDraftSeq: Number.MAX_SAFE_INTEGER - 1 })
    expect(source.capture(capture('最后一个')).draftSeq).toBe(Number.MAX_SAFE_INTEGER)
    expect(() => source.capture(capture('越界'))).toThrow(RangeError)
    source.dispose()
  })

  it('准备时同步固定旧内容，随后新捕获不能改变原字节、序号、基准或格式', async () => {
    const source = await create()
    const first = source.capture(capture('原请求', 3))
    const pending = source.prepare(first)
    const second = source.capture(capture('继续编辑', 4))
    const upload = prepared(await pending)
    await source.ready(second)
    expect(await textOf(upload)).toBe('原请求')
    expect(upload).toMatchObject({ ref: first, contentSeq: 41, baseRevision: 7, format: OPTIONS.format, formulasPending: false })
    expect(await source.prepare(first)).toBe(upload)
    expect(await source.readLatest()).toEqual({ kind: 'snapshot', ref: second, snapshot: '继续编辑' })
    source.dispose()
  })

  it('同时只固定一份；release 之后才可准备第二份，伪造 release 无效', async () => {
    const source = await create()
    const first = source.capture(capture('甲'))
    const upload = prepared(await source.prepare(first))
    const second = source.capture(capture('乙'))
    expect(await source.prepare(second)).toMatchObject({ kind: 'failed', error: { name: 'DraftBusy' } })
    source.release({ ...upload })
    expect(await source.prepare(second)).toMatchObject({ kind: 'failed', error: { name: 'DraftBusy' } })
    source.release(upload)
    source.release(upload)
    expect(await textOf(prepared(await source.prepare(second)))).toBe('乙')
    expect(await source.prepare(first)).toMatchObject({ kind: 'superseded', ref: first })
    source.dispose()
  })

  it('来源身份不能用相同字段伪造，也不接受别的来源的引用', async () => {
    const source = await create()
    const other = await create()
    const ref = source.capture(capture('甲'))
    const foreign = other.capture(capture('乙'))
    for (const invalid of [{ ...ref }, foreign]) {
      expect(await source.ready(invalid)).toMatchObject({ kind: 'failed', error: { name: 'InvalidCapture' } })
      expect(await source.prepare(invalid)).toMatchObject({ kind: 'failed', error: { name: 'InvalidCapture' } })
    }
    source.dispose()
    other.dispose()
  })

  it('确认旧上传只推进基准，保留最新内容；固定请求仍保持原元数据供未知结果重试', async () => {
    const source = await create()
    const first = source.capture(capture('上传中'))
    const upload = prepared(await source.prepare(first))
    const inFlight = { requestId: 'request-1', clientInstanceId: CLIENT_INSTANCE_ID, localSeq: upload.contentSeq, sentAt: 1_000 }
    expect(await source.markInFlight(upload, inFlight)).toEqual(mode === 'memory' ? { kind: 'memory', reason: 'disabled' } : { kind: 'resealed' })
    const latest = source.capture(capture('还在改', 2))
    await source.ready(latest)
    expect(await source.prepare(first)).toBe(upload)
    expect(await source.confirm(upload, 8)).toEqual(mode === 'memory' ? { kind: 'memory', reason: 'disabled' } : { kind: 'rebased' })
    expect(await source.readLatest()).toEqual({ kind: 'snapshot', ref: latest, snapshot: '还在改' })
    expect(upload.baseRevision).toBe(7)
    source.release(upload)
    expect(prepared(await source.prepare(latest)).baseRevision).toBe(8)
    source.dispose()
  })

  it('无效在途序号、已释放或伪造的上传不能改变来源状态', async () => {
    const source = await create()
    const ref = source.capture(capture('正文'))
    const upload = prepared(await source.prepare(ref))
    expect(await source.markInFlight(upload, { requestId: 'request-1', clientInstanceId: CLIENT_INSTANCE_ID, localSeq: 99, sentAt: 1_000 })).toMatchObject({ kind: 'failed' })
    expect(await source.confirm({ ...upload }, 20)).toMatchObject({ kind: 'failed' })
    source.release(upload)
    expect(await source.confirm(upload, 20)).toMatchObject({ kind: 'failed' })
    expect(prepared(await source.prepare(ref)).baseRevision).toBe(7)
    source.dispose()
  })
  it('慢编码只保留当前执行、最新待处理与一份固定上传，普通中间捕获明确被取代', async () => {
    const compress = codec.gzipBytes
    const held = deferred<Uint8Array<ArrayBuffer>>()
    const gzip = vi.spyOn(codec, 'gzipBytes').mockReturnValueOnce(held.promise)
    const source = await create()
    const first = source.capture(capture('正在处理'))
    await vi.waitFor(() => expect(gzip).toHaveBeenCalledOnce())
    const pinned = source.capture(capture('固定上传'))
    const uploading = source.prepare(pinned)
    const intermediate = source.capture(capture('中间一份'))
    const latest = source.capture(capture('最新内容'))
    expect(await source.ready(intermediate)).toEqual({ kind: 'superseded', ref: intermediate })
    expect(gzip).toHaveBeenCalledTimes(1)
    held.resolve(await compress(new TextEncoder().encode('正在处理')))
    const upload = prepared(await uploading)
    expect(await textOf(upload)).toBe('固定上传')
    expect(await source.ready(latest)).toMatchObject({ kind: 'ready', ref: latest })
    expect(gzip).toHaveBeenCalledTimes(3)
    expect(await source.prepare(first)).toMatchObject({ kind: 'superseded' })
    expect(await source.readLatest()).toMatchObject({ ref: latest, snapshot: '最新内容' })
    source.dispose()
  })
  it('异步旧完成不把当前捕获显示成已完成；ready/view 只含元数据', async () => {
    const compress = codec.gzipBytes
    const firstDone = deferred<Uint8Array<ArrayBuffer>>()
    const secondDone = deferred<Uint8Array<ArrayBuffer>>()
    const gzip = vi.spyOn(codec, 'gzipBytes').mockReturnValueOnce(firstDone.promise).mockReturnValueOnce(secondDone.promise)
    const source = await create()
    const first = source.capture(capture('旧'))
    await vi.waitFor(() => expect(gzip).toHaveBeenCalledOnce())
    const second = source.capture(capture('新'))
    firstDone.resolve(await compress(new TextEncoder().encode('旧')))
    await source.ready(first)
    expect(source.view()).toMatchObject({ ref: second, local: { kind: 'writing' } })
    secondDone.resolve(await compress(new TextEncoder().encode('新')))
    const ready = await source.ready(second)
    expect(ready).not.toHaveProperty('snapshot')
    expect(ready).not.toHaveProperty('gzip')
    expect(ready).not.toHaveProperty('key')
    expect(source.view()).toMatchObject({ ref: second, summary: ready })
    source.dispose()
  })
  it('dispose 同步结束等待、拒绝新捕获和发布；迟到正文不复活来源', async () => {
    const held = deferred<Uint8Array<ArrayBuffer>>()
    const gzip = vi.spyOn(codec, 'gzipBytes').mockReturnValueOnce(held.promise)
    const source = await create()
    const listener = vi.fn()
    source.subscribe(listener)
    const ref = source.capture(capture('挂起'))
    const reading = source.ready(ref)
    const uploading = source.prepare(ref)
    await vi.waitFor(() => expect(gzip).toHaveBeenCalledOnce())
    source.dispose()
    source.dispose()
    const notifications = listener.mock.calls.length
    expect(await reading).toEqual({ kind: 'disposed', ref })
    expect(await uploading).toEqual({ kind: 'disposed', ref })
    expect(() => source.capture(capture('已关闭'))).toThrow()
    held.resolve(new Uint8Array([1]))
    await settle()
    expect(listener).toHaveBeenCalledTimes(notifications)
    expect(source.view()).toEqual({ kind: 'disposed' })
    expect(await source.readLatest()).toEqual({ kind: 'disposed' })
  })
})

describe('内存来源的压缩与有界排队', () => {
  const create = (options: Partial<WorkingDraftOptions> = {}) => createMemoryWorkingDraft({ ...OPTIONS, ...options, reason: 'disabled' })

  it('摘要只用捕获时编码的字节，固定上传重复准备不重复压缩', async () => {
    const encode = vi.spyOn(TextEncoder.prototype, 'encode')
    const gzip = vi.spyOn(codec, 'gzipBytes')
    const source = create()
    const ref = source.capture(capture('同一次编码'))
    const upload = prepared(await source.prepare(ref))
    expect(encode).toHaveBeenCalledTimes(1)
    expect(gzip).toHaveBeenCalledTimes(1)
    expect(await source.prepare(ref)).toBe(upload)
    expect(gzip).toHaveBeenCalledTimes(1)
    expect(upload.digest).toMatch(/^[a-f0-9]{64}$/u)
    source.dispose()
  })

  it('摘要失败仍可上传，压缩失败保留当前可读内容并如实报告', async () => {
    const reportError = vi.fn()
    vi.spyOn(codec, 'sha256Hex').mockRejectedValueOnce(new Error('摘要失败'))
    const source = create({ reportError })
    const first = source.capture(capture('可上传'))
    expect(prepared(await source.prepare(first)).digest).toBeUndefined()
    source.dispose()
    vi.spyOn(codec, 'gzipBytes').mockRejectedValueOnce(new Error('压缩失败'))
    const next = create({ reportError })
    const ref = next.capture(capture('仍可重建'))
    expect(await next.ready(ref)).toMatchObject({ kind: 'failed' })
    expect(await next.prepare(ref)).toMatchObject({ kind: 'failed' })
    expect(await next.readLatest()).toEqual({ kind: 'snapshot', ref, snapshot: '仍可重建' })
    expect(reportError).toHaveBeenCalledTimes(2)
    next.dispose()
  })

  it('销毁后的摘要迟到失败不再上报', async () => {
    const digest = deferred<string>()
    vi.spyOn(codec, 'sha256Hex').mockReturnValueOnce(digest.promise)
    const reportError = vi.fn()
    const source = create({ reportError })
    source.capture(capture('稍后完成'))
    await settle()
    source.dispose()
    digest.reject(new Error('迟到摘要失败'))
    await settle()
    expect(reportError).not.toHaveBeenCalled()
  })
})
