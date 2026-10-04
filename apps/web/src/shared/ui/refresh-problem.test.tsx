// 列表留着之前的数据、重新请求失败了（Codex 对抗评审 CX5）：共用的说明——没能刷新、原因与重试。各列表的接线另在各自的测试里核对。
// 详情（DEF-040）同一个说明，另外不把按访问权限被拒绝说成没能刷新；说明连同"重试"消失时焦点交给页面给的元素。各页面的接线在 app/detail-refresh.test.tsx
import type { RefreshableQuery } from './refresh-problem.tsx'
import { fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError } from '../api/client.ts'
import { DetailRefreshProblem, RefreshProblem } from './refresh-problem.tsx'

describe('RefreshProblem', () => {
  it('没有"留着旧数据的刷新失败"（第一次就没取到、加载下一页失败、刷新成功）：什么也不显示', () => {
    render(<RefreshProblem query={{ isRefetchError: false, error: new ApiError(500, 'INTERNAL_ERROR', 'x'), refetch: async () => {} }} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('留着旧数据、刷新失败了：醒目的提示说没能刷新（列表叫什么可以指定）与原因，重试就是重新请求', () => {
    const refetch = vi.fn(async () => {})
    render(<RefreshProblem query={{ isRefetchError: true, error: new ApiError(500, 'INTERNAL_ERROR', 'x'), refetch }} list="成员列表" />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('成员列表没能刷新，显示的还是之前的内容')
    expect(alert).toHaveTextContent('服务器出了点问题，请稍后重试')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('默认叫"列表"', () => {
    render(<RefreshProblem query={{ isRefetchError: true, error: new ApiError(502, 'INTERNAL_ERROR', 'x'), refetch: async () => {} }} />)
    expect(screen.getByRole('alert')).toHaveTextContent(/^列表没能刷新，显示的还是之前的内容/)
  })
})

/** 页面的样子：一个一直在的"标题"（tabIndex -1）、页面上别的按钮，以及说明 */
function Page({ query, detail }: { readonly query: RefreshableQuery, readonly detail: boolean }) {
  const titleRef = useRef<HTMLHeadingElement>(null)
  return (
    <section>
      <h1 ref={titleRef} tabIndex={-1}>市场部</h1>
      <button type="button">别处的按钮</button>
      {detail
        ? <DetailRefreshProblem query={query} detail="空间信息" fallbackFocus={titleRef} />
        : <RefreshProblem query={query} list="成员列表" />}
    </section>
  )
}

function failed(error: unknown = new ApiError(500, 'INTERNAL_ERROR', 'x')): RefreshableQuery {
  return { isRefetchError: true, error, refetch: async () => {} }
}

const REFRESHED: RefreshableQuery = { isRefetchError: false, error: null, refetch: async () => {} }

describe('DetailRefreshProblem（DEF-040）', () => {
  it('留着上一次的详情、重新请求失败了（5xx、断网）：与列表同一个说明——详情叫什么、没能刷新与原因，重试就是重新请求', () => {
    const refetch = vi.fn(async () => {})
    const { rerender } = render(<DetailRefreshProblem query={{ ...failed(), refetch }} detail="空间信息" fallbackFocus={{ current: null }} />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('空间信息没能刷新，显示的还是之前的内容')
    expect(alert).toHaveTextContent('服务器出了点问题，请稍后重试')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(refetch).toHaveBeenCalledTimes(1)
    rerender(<DetailRefreshProblem query={failed(new NetworkError())} detail="空间信息" fallbackFocus={{ current: null }} />)
    expect(screen.getByRole('alert')).toHaveTextContent('网络连接失败，请检查网络后重试')
  })

  it.each([
    ['403 不能看了', new ApiError(403, 'PERMISSION_DENIED', '个人空间没有成员')],
    ['404 看不到了、不存在', new ApiError(404, 'NOT_FOUND', 'x')],
    ['400 地址里的 id 不合法（按不存在处理）', new ApiError(400, 'REQUEST_INVALID', 'x')],
  ])('按访问权限被拒绝（%s）：不是"没能刷新"，什么也不显示——由页面按现在的做法说明（空间不存在、不能查看成员、回到列表）', (_case, error) => {
    render(<DetailRefreshProblem query={failed(error)} detail="空间信息" fallbackFocus={{ current: null }} />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/没能刷新/)).toBeNull()
  })

  it('第一次就没取到、或者刷新成功了（isRefetchError 为假）：什么也不显示', () => {
    render(<DetailRefreshProblem query={{ ...REFRESHED, error: new ApiError(500, 'INTERNAL_ERROR', 'x') }} detail="空间信息" fallbackFocus={{ current: null }} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('按了"重试"（焦点在说明里）、重试成功、说明随之消失：焦点交给页面给的元素（标题），不落到 body', () => {
    const { rerender } = render(<Page query={failed()} detail />)
    const retry = screen.getByRole('button', { name: '重试' })
    retry.focus()
    rerender(<Page query={REFRESHED} detail />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: '市场部' }))
  })

  it('焦点不在说明里（在页面别处）：说明消失时不抢焦点', () => {
    const { rerender } = render(<Page query={failed()} detail />)
    const elsewhere = screen.getByRole('button', { name: '别处的按钮' })
    // 先在说明里，再移到别处：记下的随之忘掉
    screen.getByRole('button', { name: '重试' }).focus()
    elsewhere.focus()
    rerender(<Page query={REFRESHED} detail />)
    expect(document.activeElement).toBe(elsewhere)
  })

  it('焦点先移到别处、后来才落到 body（例如点了空白处）：说明消失时不交——焦点不是因为它消失才丢的', () => {
    const { rerender } = render(<Page query={failed()} detail />)
    screen.getByRole('button', { name: '重试' }).focus()
    const elsewhere = screen.getByRole('button', { name: '别处的按钮' })
    elsewhere.focus()
    elsewhere.blur()
    rerender(<Page query={REFRESHED} detail />)
    expect(document.activeElement).toBe(document.body)
  })

  it('说明消失的同一次更新里别的元素已经接过焦点（随之出现、自动聚焦的输入框）：不抢', () => {
    function FollowUp({ query }: { readonly query: RefreshableQuery }) {
      const titleRef = useRef<HTMLHeadingElement>(null)
      return (
        <section>
          <h1 ref={titleRef} tabIndex={-1}>市场部</h1>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus -- 用例要的正是"同一次更新里别处接过了焦点" */}
          {!query.isRefetchError && <input aria-label="接着要填的" autoFocus />}
          <DetailRefreshProblem query={query} detail="空间信息" fallbackFocus={titleRef} />
        </section>
      )
    }
    const { rerender } = render(<FollowUp query={failed()} />)
    screen.getByRole('button', { name: '重试' }).focus()
    rerender(<FollowUp query={REFRESHED} />)
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '接着要填的' }))
  })

  it('说明还在（重试又失败了）：焦点留在"重试"上，不挪走', () => {
    const { rerender } = render(<Page query={failed()} detail />)
    const retry = screen.getByRole('button', { name: '重试' })
    retry.focus()
    rerender(<Page query={failed(new NetworkError())} detail />)
    expect(document.activeElement).toBe(retry)
  })

  it('列表的说明不给交给谁时（由页面的 useFocusRescue 接住）：这里不动焦点', () => {
    const { rerender } = render(<Page query={failed()} detail={false} />)
    screen.getByRole('button', { name: '重试' }).focus()
    rerender(<Page query={REFRESHED} detail={false} />)
    expect(document.activeElement).toBe(document.body)
  })
})
