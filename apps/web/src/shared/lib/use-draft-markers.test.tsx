import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { draftDocumentIds } from '../outbox/draft-index.ts'
import { deferred } from '../outbox/outbox-lock.test-support.ts'
import { useDraftMarkers } from './use-draft-markers.ts'

vi.mock('../outbox/draft-index.ts', () => ({ draftDocumentIds: vi.fn() }))
beforeEach(() => {
  vi.mocked(draftDocumentIds).mockReset()
})

describe('本人列表标记的轻量索引', () => {
  it('未确认用户时不读索引，确认之后只读该用户', async () => {
    vi.mocked(draftDocumentIds).mockResolvedValue(new Set(['draft']))
    const h = renderHook(({ userId }) => useDraftMarkers(userId), { initialProps: { userId: undefined as string | undefined } })
    expect(h.result.current.size).toBe(0)
    expect(draftDocumentIds).not.toHaveBeenCalled()
    h.rerender({ userId: 'amy' })
    await waitFor(() => expect(h.result.current.has('draft')).toBe(true))
    expect(draftDocumentIds).toHaveBeenCalledExactlyOnceWith('amy')
  })

  it('换人当次渲染立即清空旧标记；旧用户的迟到结果不能进入新用户', async () => {
    const first = deferred<ReadonlySet<string>>()
    const second = deferred<ReadonlySet<string>>()
    vi.mocked(draftDocumentIds).mockImplementation(async id => id === 'amy' ? first.promise : second.promise)
    const h = renderHook(({ userId }) => useDraftMarkers(userId), { initialProps: { userId: 'amy' } })
    await waitFor(() => expect(draftDocumentIds).toHaveBeenCalledWith('amy'))
    h.rerender({ userId: 'ben' })
    await act(async () => first.resolve(new Set(['amy-only'])))
    expect(h.result.current.size).toBe(0)
    await act(async () => second.resolve(new Set(['ben-only'])))
    expect([...h.result.current]).toEqual(['ben-only'])
    h.rerender({ userId: 'amy' })
    expect(h.result.current.size).toBe(0)
  })

  it('重新可见与聚焦时重读；较早结果不能覆盖最新结果；卸载解除监听', async () => {
    const old = deferred<ReadonlySet<string>>()
    vi.mocked(draftDocumentIds).mockResolvedValueOnce(new Set(['initial'])).mockReturnValueOnce(old.promise).mockResolvedValue(new Set(['latest']))
    const h = renderHook(() => useDraftMarkers('amy'))
    await waitFor(() => expect(h.result.current.has('initial')).toBe(true))
    await act(async () => window.dispatchEvent(new Event('focus')))
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    await waitFor(() => expect(h.result.current.has('latest')).toBe(true))
    await act(async () => old.resolve(new Set(['stale'])))
    expect([...h.result.current]).toEqual(['latest'])
    h.unmount()
    window.dispatchEvent(new Event('focus'))
    expect(draftDocumentIds).toHaveBeenCalledTimes(3)
  })

  it('索引失败只失去提示，不保留旧标记也不阻挡列表', async () => {
    vi.mocked(draftDocumentIds).mockResolvedValueOnce(new Set(['draft'])).mockRejectedValueOnce(new Error('临时读失败'))
    const h = renderHook(() => useDraftMarkers('amy'))
    await waitFor(() => expect(h.result.current.has('draft')).toBe(true))
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(h.result.current.size).toBe(0)
  })
})
