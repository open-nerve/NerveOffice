// 危险操作的确认：先说清楚后果再执行；进行中不能重复提交、不能关闭；失败时弹窗留着说明原因；
// 经请求缓存执行，管理界面标明只给系统管理员（审查 B4）；关闭之后焦点回到打开它的按钮，按钮不在了交给页面（审查 B9）。
import type { PendingConfirmation } from './confirm-dialog.tsx'
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../shared/api/index.ts'
import { SYSTEM_ADMIN_ONLY } from '../auth/index.ts'
import { ConfirmDialog } from './confirm-dialog.tsx'

function confirmation(changes: Partial<PendingConfirmation> = {}): PendingConfirmation {
  return { title: '停用 艾米？', description: '停用后不能登录。', confirmLabel: '停用', destructive: true, run: async () => {}, ...changes }
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
