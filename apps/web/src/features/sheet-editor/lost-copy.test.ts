// 失去编辑权之后的那一份：上传捕获的内容，标题用失去编辑权的时刻；结果未知之后再试沿用 requestId，确定被拒绝、成功之后换新的。
import type { ConflictCopyQuery, CreatedDocument } from '@nerve-office/contracts'
import type { LostCopy } from './lost-copy.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError, RequestTimeoutError } from '../../shared/api/index.ts'
import { deferred } from '../../shared/outbox/outbox-lock.test-support.ts'
import { PAGE_CLIENT_FORMAT } from './client-format.ts'
import { conflictCopyLabel, createLostCopy } from './lost-copy.ts'
import { fakeWorkingDraft } from './working-draft.test-support.ts'

const DOCUMENT_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const CREATED = { id: '0199a2c4-1f2e-7a3b-8c4d-0000000000c1', title: '周报（冲突副本 2026-10-04 15:30）' } as unknown as CreatedDocument

const copies: LostCopy[] = []
afterEach(() => {
  for (const copy of copies.splice(0))
    copy.dispose()
})

function setup(formulasPending = false, compress = vi.fn(async (snapshot: string) => new TextEncoder().encode(snapshot))) {
  let id = 0
  let title = '周报'
  const conflictCopy = vi.fn(async (_documentId: string, _query: ConflictCopyQuery, _body: Uint8Array<ArrayBuffer>): Promise<CreatedDocument> => CREATED)
  const { draft } = fakeWorkingDraft({ compress })
  const ref = draft.capture({ editorSeq: 5, snapshot: '{"id":"unit-1","v":"本页的"}', formulasPending, dedupe: false })
  const disposed = vi.spyOn(draft, 'dispose')
  const copy = createLostCopy({
    documentId: DOCUMENT_ID,
    draft,
    ref,
    lostAt: new Date(2026, 9, 4, 15, 30, 59),
    title: () => title,
    newId: () => `request-${++id}`,
    conflictCopy,
  })
  copies.push(copy)
  const rename = (next: string): void => {
    title = next
  }
  return { copy, conflictCopy, compress, rename, draft, ref, disposed }
}

describe('失去编辑权之后的那一份（M3-P2 设计 §3.2、§3.4）', () => {
  it('上传捕获的内容；标题是原文档现在的标题加"（冲突副本 失去编辑权的时刻）"', async () => {
    const context = setup()
    context.rename('周报（改过）')
    expect(await context.copy.save()).toBe(CREATED)
    expect(context.compress).toHaveBeenCalledExactlyOnceWith('{"id":"unit-1","v":"本页的"}')
    expect(context.conflictCopy).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, { requestId: 'request-1', title: '周报（改过）（冲突副本 2026-10-04 15:30）', formulasPending: false, format: PAGE_CLIENT_FORMAT }, expect.anything())
    expect(context.compress).toHaveBeenCalledOnce()
  })

  it('未知请求固定原 gzip、标题、格式和公式标记，不因重试或改标题重新压缩', async () => {
    const h = setup(true)
    h.conflictCopy.mockRejectedValueOnce(new NetworkError('回包丢了'))
    await expect(h.copy.save()).rejects.toBeInstanceOf(NetworkError)
    h.rename('后来改的标题')
    await h.copy.save()
    const first = h.conflictCopy.mock.calls[0]!
    const second = h.conflictCopy.mock.calls[1]!
    expect(second[1]).toBe(first[1])
    expect(second[2]).toBe(first[2])
    expect(second[1]).toMatchObject({ title: '周报（冲突副本 2026-10-04 15:30）', formulasPending: true, format: PAGE_CLIENT_FORMAT })
    expect(h.compress).toHaveBeenCalledOnce()
  })

  it('并发按下只准备和发送同一份副本，成功不确认原文档的修订', async () => {
    const h = setup()
    const answer = deferred<CreatedDocument>()
    const confirm = vi.spyOn(h.draft, 'confirm')
    h.conflictCopy.mockReturnValueOnce(answer.promise)
    const first = h.copy.save()
    const second = h.copy.save()
    await vi.waitFor(() => expect(h.conflictCopy).toHaveBeenCalledOnce())
    answer.resolve(CREATED)
    expect(await first).toBe(CREATED)
    expect(await second).toBe(CREATED)
    expect(confirm).not.toHaveBeenCalled()
    expect((await h.draft.prepare(h.ref)).kind).toBe('prepared')
  })

  it('来源编码失败后显式再试从同一来源重新捕获，不留第二份正文或发半份内容', async () => {
    const compress = vi.fn(async (snapshot: string) => new TextEncoder().encode(snapshot)).mockRejectedValueOnce(new Error('编码暂时失败'))
    const h = setup(false, compress)
    await expect(h.copy.save()).rejects.toThrow('编码暂时失败')
    expect(h.conflictCopy).not.toHaveBeenCalled()
    expect(await h.copy.save()).toBe(CREATED)
    expect(h.compress).toHaveBeenCalledTimes(2)
    expect(h.draft.view()).toMatchObject({ ref: { editorSeq: 5, serial: 2 } })
  })

  it('未知结果仍持有唯一上传；dispose 幂等释放正文来源，之后不能重试', async () => {
    const h = setup()
    h.conflictCopy.mockRejectedValueOnce(new NetworkError('未知'))
    await expect(h.copy.save()).rejects.toBeInstanceOf(NetworkError)
    const next = h.draft.capture({ editorSeq: 6, snapshot: '后来内容', formulasPending: false, dedupe: false })
    expect(await h.draft.prepare(next)).toMatchObject({ kind: 'failed', error: { name: 'DraftBusy' } })
    h.copy.dispose()
    h.copy.dispose()
    expect(h.disposed).toHaveBeenCalledOnce()
    expect(h.draft.view()).toEqual({ kind: 'disposed' })
    await expect(h.copy.save()).rejects.toMatchObject({ name: 'LostCopyDisposed' })
    expect(h.conflictCopy).toHaveBeenCalledOnce()
  })

  it('准备期间卸载，晚到准备不发请求；原来源只销毁一次', async () => {
    const h = setup()
    const gate = deferred<void>()
    const prepare = h.draft.prepare
    const preparing = vi.spyOn(h.draft, 'prepare').mockImplementationOnce(async (ref) => {
      const prepared = await prepare(ref)
      await gate.promise
      return prepared
    })
    const saving = h.copy.save()
    await vi.waitFor(() => expect(preparing).toHaveBeenCalledOnce())
    h.copy.dispose()
    gate.resolve()
    await expect(saving).rejects.toMatchObject({ name: 'LostCopyDisposed' })
    expect(h.conflictCopy).not.toHaveBeenCalled()
    expect(h.disposed).toHaveBeenCalledOnce()
  })

  it('"公式待更新"（M3-P3 设计 §3.8）：捕获时公式还没收齐，副本的请求带上标记；再试照样带', async () => {
    const context = setup(true)
    context.conflictCopy.mockRejectedValueOnce(new NetworkError('断网'))
    await expect(context.copy.save()).rejects.toBeInstanceOf(NetworkError)
    await context.copy.save()
    expect(context.conflictCopy.mock.calls.map(call => call[1].formulasPending)).toEqual([true, true])
  })

  it.each([new NetworkError('断网'), new RequestTimeoutError(60_000)])('结果未知（%s）：再试沿用同一个请求（服务端只建一份）；确定被拒绝：下次换新的 requestId；成功之后也换新的', async (error) => {
    const context = setup()
    context.conflictCopy.mockRejectedValueOnce(error)
    await expect(context.copy.save()).rejects.toBeInstanceOf(NetworkError)
    context.conflictCopy.mockRejectedValueOnce(new ApiError(422, 'SNAPSHOT_INVALID', '快照不合格'))
    await expect(context.copy.save()).rejects.toBeInstanceOf(ApiError)
    await context.copy.save()
    await context.copy.save()
    expect(context.conflictCopy.mock.calls.map(call => call[1].requestId)).toEqual(['request-1', 'request-1', 'request-2', 'request-3'])
  })

  it('标题里的时间：页面所在的时区，写到分钟', () => {
    expect(conflictCopyLabel(new Date(2026, 0, 2, 3, 4, 59))).toBe('2026-01-02 03:04')
  })
})
