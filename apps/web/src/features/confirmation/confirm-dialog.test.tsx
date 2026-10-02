// 危险操作的确认：先说清楚后果再执行；进行中不能重复提交、不能关闭；失败时弹窗留着说明原因；
// 经请求缓存执行，管理界面标明只给系统管理员（审查 B4）；关闭之后焦点回到打开它的按钮，按钮不在了交给页面（审查 B9）。
import type { PendingConfirmation } from './confirm-dialog.tsx'
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError } from '../../shared/api/index.ts'
import { OUTCOME_REFRESH_TIME_LIMIT_MS } from '../../shared/api/write-outcome.ts'
import { SYSTEM_ADMIN_ONLY } from '../auth/index.ts'
import { ConfirmDialog } from './confirm-dialog.tsx'

function confirmation(changes: Partial<PendingConfirmation> = {}): PendingConfirmation {
  return { title: '停用 艾米？', description: '停用后不能登录。', confirmLabel: '停用', destructive: true, run: async () => {}, refresh: async () => {}, ...changes }
}

/** 页面：两个打开弹窗的按钮。"打开"执行成功之后这个按钮就不在了（随操作消失），"只打开"一直在 */
function Page({ pending: initial }: { readonly pending: PendingConfirmation }) {
  const [pending, setPending] = useState<PendingConfirmation>()
  const [opener, setOpener] = useState(true)
  async function runThenRemoveOpener(): Promise<void> {
    await initial.run()
    setOpener(false)
  }
  return (
    <>
      {opener && <button type="button" onClick={() => setPending({ ...initial, run: runThenRemoveOpener })}>打开</button>}
      <button type="button" onClick={() => setPending(initial)}>只打开</button>
      <input aria-label="别处" />
      <ConfirmDialog pending={pending} onClose={() => setPending(undefined)} meta={SYSTEM_ADMIN_ONLY} />
    </>
  )
}

function renderPage(pending: PendingConfirmation, onMutationError?: (meta: unknown) => void) {
  const client = new QueryClient({ mutationCache: new MutationCache({ onError: (_error, _variables, _context, mutation) => onMutationError?.(mutation.meta) }) })
  render(
    <QueryClientProvider client={client}>
      <Page pending={pending} />
    </QueryClientProvider>,
  )
}

async function open(name = '只打开'): Promise<HTMLElement> {
  const button = screen.getByRole('button', { name })
  button.focus()
  fireEvent.click(button)
  return screen.findByRole('dialog')
}

describe('ConfirmDialog', () => {
  it('说明后果；确认之后执行，成功就关闭', async () => {
    const run = vi.fn(async () => {})
    renderPage(confirmation({ run }))
    const dialog = await open()
    expect(dialog).toHaveAccessibleName('停用 艾米？')
    expect(dialog).toHaveAccessibleDescription('停用后不能登录。')
    fireEvent.click(within(dialog).getByRole('button', { name: '停用' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('进行中：按钮标为不可用；再点不重复执行；取消、Esc 都关不掉', async () => {
    let finish: () => void = () => {}
    const run = vi.fn(async () => new Promise<void>((resolve) => {
      finish = resolve
    }))
    renderPage(confirmation({ run }))
    const dialog = await open()
    fireEvent.click(within(dialog).getByRole('button', { name: '停用' }))
    const busy = await within(dialog).findByRole('button', { name: '正在处理…' })
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    expect(within(dialog).getByRole('button', { name: '取消' })).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(busy)
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(run).toHaveBeenCalledTimes(1)
    finish()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('失败：按错误码说明原因，弹窗留着；取消之后再打开，上一次的错误不留下', async () => {
    renderPage(confirmation({ run: async () => {
      throw new ApiError(409, 'LAST_ADMIN', 'x')
    } }))
    const dialog = await open()
    fireEvent.click(within(dialog).getByRole('button', { name: '停用' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('至少要保留一个有效的系统管理员')
    expect(within(dialog).getByRole('button', { name: '停用' })).toHaveAttribute('aria-disabled', 'false')
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const again = await open()
    expect(within(again).queryByRole('alert')).toBeNull()
  })

  it('结果未知（网络、5xx、回包读不出来）：先按 refresh 刷新页面上的状态，刷新完了才说明"可能已经生效"，弹窗留着可以再试（第二批 G-2）', async () => {
    const order: string[] = []
    let finishRefresh: () => void = () => {}
    const refresh = vi.fn(async () => new Promise<void>((resolve) => {
      order.push('刷新')
      finishRefresh = resolve
    }))
    renderPage(confirmation({
      run: async () => {
        throw new ApiError(500, 'INTERNAL_ERROR', 'x')
      },
      refresh,
    }))
    const dialog = await open()
    fireEvent.click(within(dialog).getByRole('button', { name: '停用' }))
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    // 刷新完成之前仍在进行中：说明里的"已按服务端现在的状态刷新"要成立
    expect(within(dialog).getByRole('button', { name: '正在处理…' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('alert')).toBeNull()
    finishRefresh()
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('没能确认是否已经完成（服务器出了点问题，请稍后重试）。可能已经生效：页面已按服务端现在的状态刷新，看得出是否已经生效；还没有的话，可以再试一次。')
    expect(within(dialog).getByRole('button', { name: '停用' })).toHaveAttribute('aria-disabled', 'false')
    expect(order).toEqual(['刷新'])
  })

  it('结果未知之后的刷新失败：说明可能已经生效、页面没能刷新，不说"已按服务端现在的状态刷新"；自定的说明拿到的也是没能刷新（第三批 G-a）', async () => {
    const describeFailure = vi.fn((_error: unknown, refreshed: boolean) => (refreshed ? '已刷新' : '没能刷新'))
    for (const custom of [false, true]) {
      renderPage(confirmation({
        run: async () => {
          throw new ApiError(500, 'INTERNAL_ERROR', 'x')
        },
        refresh: async () => {
          throw new NetworkError('网络请求失败')
        },
        ...(custom ? { describeFailure } : {}),
      }))
      const dialog = await open()
      fireEvent.click(within(dialog).getByRole('button', { name: '停用' }))
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(custom
        ? '没能刷新'
        : '没能确认是否已经完成（服务器出了点问题，请稍后重试）。可能已经生效，只是页面没能刷新，显示的可能还是之前的状态：请稍后再看；确认还没有生效的话，可以再试一次。')
      cleanup()
    }
    expect(describeFailure).toHaveBeenLastCalledWith(expect.any(ApiError), false)
  })

  it('结果未知之后的刷新一直不回来（服务端挂起）：到了时限（10 秒）先说明，页面没能刷新；弹窗不再卡在"正在处理…"，取消关得掉（第三批 S-a）', async () => {
    // 跟着真实的时间走，另外可以一下子拨过时限；在前面留出 2 秒的余量，测试本身的耗时不会让时限提前到
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const refresh = vi.fn(async () => new Promise<void>(() => {}))
      renderPage(confirmation({
        run: async () => {
          throw new ApiError(504, 'INTERNAL_ERROR', 'x')
        },
        refresh,
      }))
      const dialog = await open()
      fireEvent.click(within(dialog).getByRole('button', { name: '停用' }))
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
      await act(async () => vi.advanceTimersByTimeAsync(OUTCOME_REFRESH_TIME_LIMIT_MS - 2_000))
      expect(within(dialog).getByRole('button', { name: '正在处理…' })).toBeInTheDocument()
      expect(within(dialog).queryByRole('alert')).toBeNull()
      await act(async () => vi.advanceTimersByTimeAsync(2_000))
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(/^没能确认是否已经完成（服务器出了点问题，请稍后重试）。可能已经生效，只是页面没能刷新/)
      expect(within(dialog).getByRole('button', { name: '停用' })).toHaveAttribute('aria-disabled', 'false')
      fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('到了时限先说明页面没能刷新；后台的刷新随后成功了（表格已经更新）：说明改回"已刷新"，还是同一条 role="alert"，读屏读得到这次更新（第五批 G4）', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      let finish: () => void = () => {}
      const refresh = vi.fn(async () => new Promise<void>((resolve) => {
        finish = resolve
      }))
      renderPage(confirmation({
        run: async () => {
          throw new NetworkError('网络请求失败')
        },
        refresh,
      }))
      const dialog = await open()
      fireEvent.click(within(dialog).getByRole('button', { name: '停用' }))
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
      await act(async () => vi.advanceTimersByTimeAsync(OUTCOME_REFRESH_TIME_LIMIT_MS))
      const alert = await within(dialog).findByRole('alert')
      expect(alert).toHaveTextContent(/^没能确认是否已经完成（网络连接失败，请检查网络后重试）。可能已经生效，只是页面没能刷新/)
      await act(async () => {
        finish()
      })
      await waitFor(() => expect(alert).toHaveTextContent('没能确认是否已经完成（网络连接失败，请检查网络后重试）。可能已经生效：页面已按服务端现在的状态刷新，看得出是否已经生效；还没有的话，可以再试一次。'))
      expect(within(dialog).getByRole('alert')).toBe(alert)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('再试一次之后，前一次失败的刷新晚到：不改这一次的说法；这一次的刷新晚到才改（第五批 G4）', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const finishes: (() => void)[] = []
      const refresh = vi.fn(async () => new Promise<void>((resolve) => {
        finishes.push(resolve)
      }))
      renderPage(confirmation({
        run: async () => {
          throw new ApiError(502, 'INTERNAL_ERROR', 'x')
        },
        refresh,
      }))
      const dialog = await open()
      for (const attempt of [1, 2]) {
        fireEvent.click(within(dialog).getByRole('button', { name: '停用' }))
        await waitFor(() => expect(refresh).toHaveBeenCalledTimes(attempt))
        await act(async () => vi.advanceTimersByTimeAsync(OUTCOME_REFRESH_TIME_LIMIT_MS))
        expect(await within(dialog).findByRole('alert')).toHaveTextContent(/只是页面没能刷新/)
      }
      // 第一次的刷新晚到：这时说明的是第二次的失败，不改
      await act(async () => {
        finishes[0]?.()
      })
      await act(async () => vi.advanceTimersByTimeAsync(50))
      expect(within(dialog).getByRole('alert')).toHaveTextContent(/只是页面没能刷新/)
      await act(async () => {
        finishes[1]?.()
      })
      await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent(/页面已按服务端现在的状态刷新/))
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('确定的失败（4xx、服务端忙的 503）没有生效：不刷新，按错误码说明', async () => {
    const refresh = vi.fn(async () => {})
    for (const error of [new ApiError(409, 'LAST_ADMIN', 'x'), new ApiError(503, 'SERVICE_UNAVAILABLE', 'x')]) {
      renderPage(confirmation({
        run: async () => {
          throw error
        },
        refresh,
      }))
      const dialog = await open()
      fireEvent.click(within(dialog).getByRole('button', { name: '停用' }))
      expect(await within(dialog).findByRole('alert')).not.toHaveTextContent('没能确认是否已经完成')
      fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      cleanup()
    }
    expect(refresh).not.toHaveBeenCalled()
  })

  it('refreshAfter 认出的确定拒绝（上一次多半已经生效）：同样按 refresh 刷新，自定的说明拿到刷新好了没有；没认出的照旧不刷新（第四批）', async () => {
    const taken = new ApiError(409, 'USERNAME_TAKEN', 'x')
    const describeFailure = vi.fn((_error: unknown, refreshed: boolean) => (refreshed ? '已刷新' : '没能刷新'))
    for (const refreshFails of [false, true]) {
      const refresh = vi.fn(async () => {
        if (refreshFails)
          throw new NetworkError('网络请求失败')
      })
      renderPage(confirmation({
        run: async () => {
          throw taken
        },
        refresh,
        refreshAfter: error => error === taken,
        describeFailure,
      }))
      const dialog = await open()
      fireEvent.click(within(dialog).getByRole('button', { name: '停用' }))
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(refreshFails ? '没能刷新' : '已刷新')
      expect(refresh).toHaveBeenCalledTimes(1)
      expect(describeFailure).toHaveBeenLastCalledWith(taken, !refreshFails)
      cleanup()
    }

    const refresh = vi.fn(async () => {})
    renderPage(confirmation({
      run: async () => {
        throw new ApiError(409, 'LAST_ADMIN', 'x')
      },
      refresh,
      refreshAfter: error => error === taken,
    }))
    const dialog = await open()
    fireEvent.click(within(dialog).getByRole('button', { name: '停用' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('至少要保留一个有效的系统管理员')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('经请求缓存执行，标明只给系统管理员：被拒绝时由全局处理重新确认会话（审查 B4）', async () => {
    const metas: unknown[] = []
    renderPage(confirmation({ run: async () => {
      throw new ApiError(403, 'PERMISSION_DENIED', '没有执行这个操作的权限')
    } }), meta => metas.push(meta))
    const dialog = await open()
    fireEvent.click(within(dialog).getByRole('button', { name: '停用' }))
    // 看得到却不能做的原因由服务端给出（ADR-008 的例外，M2-P6 复核 S5）
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('没有执行这个操作的权限')
    expect(metas).toEqual([{ systemAdminOnly: true }])
  })

  it('取消：焦点回到打开它的按钮', async () => {
    renderPage(confirmation())
    const dialog = await open()
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: '只打开' })))
  })

  it('打开它的按钮随操作消失了：焦点交给页面（returnFocus），不落到 body（审查 B9）', async () => {
    const returnFocus = vi.fn(() => screen.getByLabelText('别处').focus())
    renderPage(confirmation({ returnFocus }))
    const dialog = await open('打开')
    fireEvent.click(within(dialog).getByRole('button', { name: '停用' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('别处')))
    expect(returnFocus).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: '打开' })).toBeNull()
  })

  it('按钮还在时不用 returnFocus', async () => {
    const returnFocus = vi.fn()
    renderPage(confirmation({ returnFocus }))
    const dialog = await open()
    fireEvent.click(within(dialog).getByRole('button', { name: '停用' }))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: '只打开' })))
    expect(returnFocus).not.toHaveBeenCalled()
  })
})
