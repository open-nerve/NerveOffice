// 失去编辑权之后的那一份：上传捕获的内容，标题用失去编辑权的时刻；结果未知之后再试沿用 requestId，确定被拒绝、成功之后换新的。
import type { ConflictCopyQuery, CreatedDocument } from '@nerve-office/contracts'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError } from '../../shared/api/index.ts'
import { conflictCopyLabel, createLostCopy } from './lost-copy.ts'

const DOCUMENT_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const CREATED = { id: '0199a2c4-1f2e-7a3b-8c4d-0000000000c1', title: '周报（冲突副本 2026-10-04 15:30）' } as unknown as CreatedDocument

function setup() {
  let id = 0
  let title = '周报'
  const conflictCopy = vi.fn(async (_documentId: string, _query: ConflictCopyQuery, _body: Uint8Array<ArrayBuffer>): Promise<CreatedDocument> => CREATED)
  const compress = vi.fn(async (snapshot: string) => new TextEncoder().encode(snapshot))
  const copy = createLostCopy({
    documentId: DOCUMENT_ID,
    snapshot: '{"id":"unit-1","v":"本页的"}',
    lostAt: new Date(2026, 9, 4, 15, 30, 59),
    title: () => title,
    newId: () => `request-${++id}`,
    compress,
    conflictCopy,
  })
  const rename = (next: string): void => {
    title = next
  }
  return { copy, conflictCopy, compress, rename }
}

describe('失去编辑权之后的那一份（M3-P2 设计 §3.2、§3.4）', () => {
  it('上传捕获的内容；标题是原文档现在的标题加"（冲突副本 失去编辑权的时刻）"', async () => {
    const context = setup()
    context.rename('周报（改过）')
    expect(await context.copy.save()).toBe(CREATED)
    expect(context.compress).toHaveBeenCalledExactlyOnceWith('{"id":"unit-1","v":"本页的"}')
    expect(context.conflictCopy).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, { requestId: 'request-1', title: '周报（改过）（冲突副本 2026-10-04 15:30）' }, expect.anything())
  })

  it('结果未知：再试沿用同一个请求（服务端只建一份）；确定被拒绝：下次换新的 requestId；成功之后也换新的', async () => {
    const context = setup()
    context.conflictCopy.mockRejectedValueOnce(new NetworkError('断网'))
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
