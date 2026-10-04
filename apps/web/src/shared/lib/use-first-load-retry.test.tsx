// 第一次就没取到时的说明与"重试"（规范 §2.4）：说明显示着、又在请求时说明与按钮留着（正在重试），取到之后焦点交给一直在的元素；
// 只认这个组件里显示过的说明（重新挂上时缓存里的失败、页面另有说明的错误之后的重新请求，照常是加载中）；
// 页面另有说明的错误（retryable）不算加载失败，重试之后得到它时焦点同样有去处；失败时不显示数据的（hidesDataOnError）有数据也按失败算。
// 各页面的用法见 app/first-load-retry.test.tsx 与各组件的测试。
import type { FirstLoadRetryOptions } from './use-first-load-retry.ts'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef, useState } from 'react'
import { describe, expect, it } from 'vitest'
import { useFirstLoadRetry } from './use-first-load-retry.ts'

/** 由测试决定每一次请求的结果 */
class Answers {
  private readonly pending: { resolve: (value: string) => void, reject: (error: unknown) => void }[] = []
  calls = 0
  readonly fetch = async (): Promise<string> => {
    this.calls += 1
    return new Promise<string>((resolve, reject) => {
      this.pending.push({ resolve, reject })
    })
  }

  /**
   * 最早那一次还没有结果的请求：成功（value）或者失败（error）。等它发出；给出结果之后再等一个任务：
   * TanStack Query 经 setTimeout(0) 通知界面
   */
  async settle(outcome: { readonly value: string } | { readonly error: Error }): Promise<void> {
    await waitFor(() => expect(this.pending.length).toBeGreaterThan(0))
    const next = this.pending.shift()
    if (next === undefined)
      throw new Error('没有在等结果的请求')
    await act(async () => {
      if ('value' in outcome)
        next.resolve(outcome.value)
      else
        next.reject(outcome.error)
      await new Promise(resolve => setTimeout(resolve, 10))
    })
  }
}

/** 页面另有说明的错误（例如 404 的"不存在"） */
class Missing extends Error {}

function notMissing(error: unknown): boolean {
  return !(error instanceof Missing)
}

/** 像页面那样用：说明（可以重试）、另有说明的错误、加载中、数据；fallback 是一直在的标题 */
function Probe({ requestKey, answers, options }: { readonly requestKey: string, readonly answers: Answers, readonly options?: FirstLoadRetryOptions }) {
  const query = useQuery({ queryKey: ['probe', requestKey], queryFn: answers.fetch, retry: false })
  const titleRef = useRef<HTMLHeadingElement>(null)
  const firstLoad = useFirstLoadRetry(query, titleRef, options)
  let body
  if (firstLoad.failed) {
    body = (
      <div role="alert" onFocus={firstLoad.focus.onFocus} onBlur={firstLoad.focus.onBlur}>
        {!firstLoad.retrying && <span>{query.error?.message}</span>}
        <button type="button" aria-disabled={firstLoad.retrying} onClick={() => void query.refetch()}>{firstLoad.retrying ? '正在重试…' : '重试'}</button>
      </div>
    )
  }
  else if (query.error instanceof Missing) {
    body = <p>不存在</p>
  }
  else if (query.data === undefined) {
    body = <p role="status">加载中</p>
  }
  else {
    body = <p>{query.data}</p>
  }
  return (
    <section>
      <h1 ref={titleRef} tabIndex={-1}>标题</h1>
      {body}
    </section>
  )
}

/** 可以换请求键、可以卸下再挂上的外壳 */
function Host({ answers, options }: { readonly answers: Answers, readonly options?: FirstLoadRetryOptions }) {
  const [requestKey, setRequestKey] = useState('a')
  const [mounted, setMounted] = useState(true)
  return (
    <>
      <button type="button" onClick={() => setRequestKey('b')}>换一个</button>
      <button type="button" onClick={() => setMounted(!mounted)}>卸下或挂上</button>
      {mounted && <Probe requestKey={requestKey} answers={answers} options={options} />}
    </>
  )
}

function renderHost(options?: FirstLoadRetryOptions) {
  const answers = new Answers()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <Host answers={answers} options={options} />
    </QueryClientProvider>,
  )
  return { answers, client }
}

function retryButton(): HTMLElement {
  return screen.getByRole('button', { name: /重试/ })
}

describe('useFirstLoadRetry', () => {
  it('失败、按"重试"：重新请求期间说明与同一个按钮留着（正在重试）；又失败时换成新的原因，焦点还在按钮上；取到之后焦点交给 fallbackFocus', async () => {
    const { answers } = renderHost()
    await answers.settle({ error: new Error('第一次的原因') })
    const alert = screen.getByRole('alert')
    const retry = retryButton()
    retry.focus()
    fireEvent.click(retry)
    await waitFor(() => expect(retry).toHaveTextContent('正在重试…'))
    expect(screen.getByRole('alert')).toBe(alert)
    expect(alert).not.toHaveTextContent('第一次的原因')
    expect(screen.queryByRole('status')).toBeNull()
    expect(document.activeElement).toBe(retry)

    await answers.settle({ error: new Error('第二次的原因') })
    expect(alert).toHaveTextContent('第二次的原因')
    expect(retry).toHaveTextContent(/^重试$/)
    expect(document.activeElement).toBe(retry)

    fireEvent.click(retry)
    await answers.settle({ value: '数据' })
    expect(screen.getByText('数据')).toBeInTheDocument()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: '标题' }))
  })

  it('焦点不在说明里时（别处让它重新请求）：说明同样留着，取到之后不抢焦点', async () => {
    const { answers, client } = renderHost()
    await answers.settle({ error: new Error('原因') })
    const elsewhere = screen.getByRole('button', { name: '换一个' })
    elsewhere.focus()
    await act(async () => {
      void client.refetchQueries({ queryKey: ['probe', 'a'] })
    })
    await waitFor(() => expect(retryButton()).toHaveTextContent('正在重试…'))
    await answers.settle({ value: '数据' })
    expect(screen.getByText('数据')).toBeInTheDocument()
    expect(document.activeElement).toBe(elsewhere)
  })

  it('重新挂上时缓存里留着失败（TanStack Query 随即重新请求）：没有人按过"重试"，照常是加载中，不说正在重试', async () => {
    const { answers } = renderHost()
    await answers.settle({ error: new Error('原因') })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: '卸下或挂上' })
    fireEvent.click(toggle)
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(toggle)
    await waitFor(() => expect(answers.calls).toBe(2))
    expect(screen.getByRole('status')).toHaveTextContent('加载中')
    expect(screen.queryByRole('alert')).toBeNull()
    await answers.settle({ error: new Error('又一次') })
    expect(screen.getByRole('alert')).toHaveTextContent('又一次')
  })

  it('换了请求键（另一个请求，没失败过）：说明随之消失，是加载中，不说正在重试', async () => {
    const { answers } = renderHost()
    await answers.settle({ error: new Error('原因') })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '换一个' }))
    await waitFor(() => expect(answers.calls).toBe(2))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('加载中')
  })

  it('页面另有说明的错误（retryable 返回假）：不算加载失败；之后的重新请求是加载中，不说正在重试', async () => {
    const { answers, client } = renderHost({ retryable: notMissing })
    await answers.settle({ error: new Missing('不存在') })
    expect(screen.getByText('不存在')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    await act(async () => {
      void client.refetchQueries({ queryKey: ['probe', 'a'] })
    })
    await waitFor(() => expect(answers.calls).toBe(2))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('加载中'))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('重试之后得到页面另有说明的错误：加载失败的说明连同"重试"一起消失，焦点交给 fallbackFocus', async () => {
    const { answers } = renderHost({ retryable: notMissing })
    await answers.settle({ error: new Error('原因') })
    const retry = retryButton()
    retry.focus()
    fireEvent.click(retry)
    await waitFor(() => expect(retry).toHaveTextContent('正在重试…'))
    await answers.settle({ error: new Missing('不存在') })
    expect(screen.getByText('不存在')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: '标题' }))
  })

  it('失败时不显示数据（hidesDataOnError）：有数据、重新请求失败了也按失败算；按"重试"期间说明留着；取到之后焦点交给 fallbackFocus', async () => {
    const { answers, client } = renderHost({ hidesDataOnError: true })
    await answers.settle({ value: '之前的数据' })
    await act(async () => {
      void client.refetchQueries({ queryKey: ['probe', 'a'] })
    })
    await answers.settle({ error: new Error('原因') })
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('原因')
    expect(screen.queryByText('之前的数据')).toBeNull()
    const retry = retryButton()
    retry.focus()
    fireEvent.click(retry)
    await waitFor(() => expect(retry).toHaveTextContent('正在重试…'))
    expect(screen.getByRole('alert')).toBe(alert)
    expect(document.activeElement).toBe(retry)
    await answers.settle({ value: '新的数据' })
    expect(screen.getByText('新的数据')).toBeInTheDocument()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: '标题' }))
  })

  it('没有 hidesDataOnError：有数据时的重新请求失败不归它管（由"没能刷新"的说明处理）', async () => {
    const { answers, client } = renderHost()
    await answers.settle({ value: '之前的数据' })
    await act(async () => {
      void client.refetchQueries({ queryKey: ['probe', 'a'] })
    })
    await answers.settle({ error: new Error('原因') })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('之前的数据')).toBeInTheDocument()
  })
})
