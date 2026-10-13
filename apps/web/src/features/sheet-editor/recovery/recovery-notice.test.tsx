import type { RecoveryView } from '../../../shared/local-drafts/document-recovery.ts'
import type { RecoveryNoticeProps } from './recovery-notice.tsx'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../shared/api/index.ts'
import { RecoveryNotice } from './recovery-notice.tsx'

const VIEW: RecoveryView = { stage: 'ready', decision: { kind: 'restore', baseRevision: 3, formulasPending: false, reason: 'fast-forward' }, updatedAt: new Date(2026, 9, 4, 15, 30).getTime(), operation: undefined, cleanup: undefined, copy: { kind: 'idle' }, notice: undefined, problem: undefined }

function props(view: RecoveryView | undefined = VIEW): RecoveryNoticeProps {
  return { view, available: true, active: true, reading: true, canRestore: true, entering: false, onRestore: vi.fn(), onCopy: vi.fn(), onRetry: vi.fn(), onDiscard: vi.fn(), onRetryCleanup: vi.fn(), onAcknowledge: vi.fn(), onReload: vi.fn() }
}

describe('本机恢复提示', () => {
  it('原清理许可失效时显示需要确认登录，不伪报已清除', () => {
    render(<RecoveryNotice {...props({ ...VIEW, stage: 'restored', cleanup: { kind: 'session-invalid' } })} />)
    expect(screen.getByText('暂时无法确认登录状态，本机修改仍保留')).toBeVisible()
    expect(screen.queryByText('这份本机草稿已清除')).not.toBeInTheDocument()
  })

  it('副本被明确拒绝不承诺重复同一次请求；进行中说明当前操作', () => {
    const p = props({ ...VIEW, copy: { kind: 'failed', error: new ApiError(403, 'FORBIDDEN', '没有访问权限') } })
    const rendered = render(<RecoveryNotice {...p} />)
    expect(screen.getByRole('status').textContent).not.toContain('重试会核对同一次保存')
    expect(screen.getByText(/副本未能保存/)).toBeVisible()
    rendered.rerender(<RecoveryNotice {...p} view={{ ...VIEW, operation: 'copy', copy: { kind: 'saving' } }} />)
    expect(screen.getByText('正在保存副本…')).toBeVisible()
  })
  it.each(['restore', 'copy', 'held'] as const)('%s 删除已提交但回包未知时不保证原件仍在', (kind) => {
    const decision: RecoveryView['decision'] = kind === 'restore' ? VIEW.decision : kind === 'copy' ? { kind: 'copy', reason: 'conflict' } : { kind: 'held' }
    render(<RecoveryNotice {...props({ ...VIEW, decision, cleanup: { kind: 'failed', error: { name: 'Inactive', message: 'Worker 已关闭' } }, problem: 'invalidated' })} />)
    expect(screen.getByText('本机草稿的清理结果未能确认，请重新检查')).toBeVisible()
    expect(screen.getByRole('status').textContent).not.toContain('仍保留')
  })
  it.each([
    { kind: 'failed', error: new Error('连接中断') },
    { kind: 'failed', error: new ApiError(403, 'FORBIDDEN', '没有访问权限') },
    { kind: 'refused', refusal: 'content', error: new ApiError(400, 'SNAPSHOT_INVALID', '内容无效') },
    { kind: 'refused', refusal: 'outdated', error: new ApiError(409, 'CLIENT_OUTDATED', '版本过旧') },
  ] satisfies RecoveryView['copy'][])('副本 $kind 后清理结果未知，补充说明也不承诺原件仍在', (copy) => {
    render(<RecoveryNotice {...props({ ...VIEW, decision: { kind: 'copy', reason: 'conflict' }, copy, cleanup: { kind: 'failed', error: { name: 'Inactive', message: 'Worker 已关闭' } }, problem: 'invalidated' })} />)
    expect(screen.getByText('本机草稿的清理结果未能确认，请重新检查')).toBeVisible()
    expect(screen.getByRole('status').textContent).not.toContain('仍保留')
  })
  it('明确放弃完成后不再声称发现未同步修改', () => {
    render(<RecoveryNotice {...props({ ...VIEW, stage: 'finished', cleanup: { kind: 'absent' } })} />)
    expect(screen.queryByText('发现 15:30 未同步的修改')).toBeNull()
    expect(screen.getByText('这份本机草稿已清除')).toBeVisible()
    expect(screen.queryByRole('button', { name: '恢复并编辑' })).toBeNull()
  })
  it('提示按本地时间显示；恢复、副本和放弃只发对应动作', () => {
    const p = props()
    render(<RecoveryNotice {...p} />)
    expect(screen.getByText('发现 15:30 未同步的修改')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '恢复并编辑' }))
    fireEvent.click(screen.getByRole('button', { name: '另存为副本' }))
    fireEvent.click(screen.getByRole('button', { name: '放弃本机修改' }))
    expect(p.onRestore).toHaveBeenCalledOnce()
    expect(p.onCopy).toHaveBeenCalledOnce()
    expect(p.onDiscard).toHaveBeenCalledOnce()
  })

  it.each(['copy', 'held'] as const)('%s 只给副本和放弃，不给恢复覆盖', (kind) => {
    render(<RecoveryNotice {...props({ ...VIEW, decision: kind === 'copy' ? { kind: 'copy', reason: 'conflict' } : { kind: 'held' } })} />)
    expect(screen.queryByRole('button', { name: '恢复并编辑' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '另存为副本' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '放弃本机修改' })).toBeEnabled()
  })

  it.each(['offline', 'newer-format', 'key', 'replay', 'storage', 'session', 'identity'] as const)('%s 保留说明，不出现可上传/删除按钮', (reason) => {
    render(<RecoveryNotice {...props({ ...VIEW, decision: { kind: 'preserve', reason } })} />)
    expect(screen.queryByRole('button', { name: '另存为副本' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '放弃本机修改' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '恢复并编辑' })).not.toBeInTheDocument()
    expect(screen.getByRole('status').textContent).not.toBe('')
  })

  it('阅读缺修订来源时允许经新租约再核对，不直接判成冲突', () => {
    render(<RecoveryNotice {...props({ ...VIEW, decision: { kind: 'preserve', reason: 'server' } })} />)
    expect(screen.getByRole('button', { name: '恢复并编辑' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: '另存为副本' })).not.toBeInTheDocument()
  })

  it.each(['discover', 'prepare', 'copy', 'discard', 'cleanup', 'acknowledge'] as const)('%s 进行中保留按钮，但禁止重复动作', (operation) => {
    render(<RecoveryNotice {...props({ ...VIEW, operation })} />)
    for (const button of screen.getAllByRole('button'))
      expect(button).toBeDisabled()
  })

  it.each(['available', 'active', 'canRestore'] as const)('%s=false 时不授予恢复资格', (permission) => {
    render(<RecoveryNotice {...props()} {...{ [permission]: false }} />)
    expect(screen.getByRole('button', { name: '恢复并编辑' })).toBeDisabled()
  })

  it('已经恢复后说明真实状态；清理失败仍能重试原动作，不再提供恢复副本', () => {
    const p = props({ ...VIEW, stage: 'restored', cleanup: { kind: 'quota' } })
    render(<RecoveryNotice {...p} reading={false} canRestore={false} />)
    expect(screen.getByText('已恢复 15:30 的本机修改，等待保存到云端')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '重试清理' }))
    expect(p.onRetryCleanup).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: '恢复并编辑' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '另存为副本' })).not.toBeInTheDocument()
  })

  it('副本成功与原件 changed 同时呈现，保留链接且不能新建第二份', () => {
    const document = { id: '0199a2c4-0000-7000-8000-000000000001', title: '周报（冲突副本）' } as Extract<RecoveryView['copy'], { kind: 'done' }>['document']
    render(<RecoveryNotice {...props({ ...VIEW, decision: { kind: 'copy', reason: 'read-only' }, copy: { kind: 'done', document }, cleanup: { kind: 'changed' }, problem: 'changed' })} />)
    expect(screen.getByRole('link', { name: '打开副本（新标签页）' })).toHaveAttribute('href', `/documents/${document.id}`)
    expect(screen.getByText('本机修改已经变化，新内容仍保留，请重新检查')).toBeVisible()
    expect(screen.queryByRole('button', { name: '另存为副本' })).not.toBeInTheDocument()
  })

  it('旧副本成功链接不遮住新候选的操作，未决副本在当前候选结束后仍可重试', () => {
    const document = { id: '0199a2c4-0000-7000-8000-000000000001', title: '原本机修改的副本' } as Extract<RecoveryView['copy'], { kind: 'done' }>['document']
    const p = props({ ...VIEW, completedCopies: [document] })
    const rendered = render(<RecoveryNotice {...p} />)
    expect(screen.getByRole('link', { name: '打开副本（新标签页）' })).toHaveAttribute('href', `/documents/${document.id}`)
    expect(screen.getByRole('button', { name: '恢复并编辑' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '另存为副本' })).toBeEnabled()
    rendered.rerender(<RecoveryNotice {...p} view={{ ...VIEW, stage: 'finished', copy: { kind: 'failed', error: new Error('此前副本结果未知') } }} />)
    expect(screen.getByRole('button', { name: '重试另存为副本' })).toBeEnabled()
  })

  it('P1 提示只有明确确认才清原 at；没有提示时读屏区仍保留', () => {
    const p = props({ ...VIEW, decision: { kind: 'none' }, notice: { userId: 'user', documentId: 'doc', kind: 'restored', at: 123 } })
    const h = render(<RecoveryNotice {...p} />)
    expect(p.onAcknowledge).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '知道了' }))
    expect(p.onAcknowledge).toHaveBeenCalledExactlyOnceWith(123)
    const region = screen.getByRole('status')
    h.rerender(<RecoveryNotice {...props(undefined)} view={undefined} />)
    expect(screen.getByRole('status')).toBe(region)
    expect(region).toHaveTextContent('')
    expect(region).not.toHaveAttribute('hidden')
  })
})
