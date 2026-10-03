// 列表留着之前的数据、重新请求失败了（Codex 对抗评审 CX5）：共用的说明——没能刷新、原因与重试。各列表的接线另在各自的测试里核对
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client.ts'
import { RefreshProblem } from './refresh-problem.tsx'

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
