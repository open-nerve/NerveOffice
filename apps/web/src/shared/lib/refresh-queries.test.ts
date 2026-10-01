// 写操作之后重新请求显示它的查询（M2-P6 复核第三批 G-a；第五批 G6）：在路上、还没有数据的请求先取消再重来；
// 全部作废、只重新请求正在显示的；有一个没能刷新时默认拒绝，成功之后的刷新可以不拒绝。用真的 QueryClient 与观察者。
import type { QueryKey } from '@tanstack/react-query'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { refreshQueries } from './refresh-queries.ts'

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0))
    cleanup()
})

function client(): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  cleanups.push(() => queryClient.clear())
  return queryClient
}

/** 正在显示的查询（有观察者）：queryFn 由用例给 */
function shown(queryClient: QueryClient, queryKey: QueryKey, queryFn: () => Promise<string>): void {
  const observer = new QueryObserver(queryClient, { queryKey, queryFn })
  cleanups.push(observer.subscribe(() => {}))
}

/** 由用例决定何时返回的请求：每次请求一个 */
function controlled() {
  const pending: ((value: string) => void)[] = []
  return {
    queryFn: async () => new Promise<string>((resolve) => {
      pending.push(resolve)
    }),
    calls: () => pending.length,
    resolve: (index: number, value: string) => pending[index]?.(value),
  }
}

describe('refreshQueries', () => {
  it('正在请求、还没有数据的查询（例如刚换了过滤条件）：先取消在路上的那一次再重新请求，结果是写操作之后的（第五批 G6）', async () => {
    const queryClient = client()
    const list = controlled()
    shown(queryClient, ['spaces', 'filtered'], list.queryFn)
    await vi.waitFor(() => expect(list.calls()).toBe(1))

    const refreshing = refreshQueries(queryClient, [['spaces']])
    // 在路上的那一次（写操作之前发出的）被取消，重新请求了一次
    await vi.waitFor(() => expect(list.calls()).toBe(2))
    list.resolve(0, '写操作之前')
    list.resolve(1, '写操作之后')
    await refreshing
    expect(queryClient.getQueryData(['spaces', 'filtered'])).toBe('写操作之后')
  })

  it('前缀有重叠、查询还没有数据：全部取消完再统一重新请求，后一个前缀不会把前一个刚发出的请求又取消掉（不拒绝）', async () => {
    const queryClient = client()
    const list = controlled()
    shown(queryClient, ['spaces', 'filtered'], list.queryFn)
    await vi.waitFor(() => expect(list.calls()).toBe(1))

    const refreshing = refreshQueries(queryClient, [['spaces'], ['spaces', 'filtered']])
    await vi.waitFor(() => expect(list.calls()).toBe(2))
    list.resolve(1, '写操作之后')
    await expect(refreshing).resolves.toBeUndefined()
    expect(list.calls()).toBe(2)
    expect(queryClient.getQueryData(['spaces', 'filtered'])).toBe('写操作之后')
  })

  it('全部作废、只重新请求正在显示的：没在显示的等下次显示时再请求（invalidateQueries 的语义）', async () => {
    const queryClient = client()
    let hidden = 0
    queryClient.setQueryData(['spaces', 'other'], '旧的')
    queryClient.getQueryCache().find({ queryKey: ['spaces', 'other'] })?.setOptions({
      queryKey: ['spaces', 'other'],
      queryFn: async () => {
        hidden += 1
        return '新的'
      },
    })
    let visible = 0
    shown(queryClient, ['spaces', 'list'], async () => {
      visible += 1
      return `第 ${visible} 次`
    })
    await vi.waitFor(() => expect(visible).toBe(1))

    await refreshQueries(queryClient, [['spaces']])
    expect(visible).toBe(2)
    expect(hidden).toBe(0)
    expect(queryClient.getQueryState(['spaces', 'other'])?.isInvalidated).toBe(true)
  })

  it('有一个没能刷新：默认拒绝（结果未知之后，说明里不能说"已刷新"）；throwOnError 为 false 时不拒绝（成功之后，列表自己显示加载失败）', async () => {
    const queryClient = client()
    let fail = false
    shown(queryClient, ['trash'], async () => {
      if (fail)
        throw new Error('网络请求失败')
      return '回收站'
    })
    await vi.waitFor(() => expect(queryClient.getQueryData(['trash'])).toBe('回收站'))
    fail = true
    await expect(refreshQueries(queryClient, [['trash']])).rejects.toThrow('网络请求失败')
    await expect(refreshQueries(queryClient, [['trash']], { throwOnError: false })).resolves.toBeUndefined()
    // 失败时保留上一次的数据，状态是失败（列表据此显示加载失败）
    expect(queryClient.getQueryState(['trash'])?.status).toBe('error')
    expect(queryClient.getQueryData(['trash'])).toBe('回收站')
  })
})
