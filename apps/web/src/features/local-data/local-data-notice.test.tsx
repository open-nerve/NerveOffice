import type { DraftMaintenance, DraftMaintenanceView } from '../../shared/local-drafts/draft-maintenance.ts'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { localDataMessages } from '../../shared/i18n/zh-cn/local-data.ts'
import { LocalDataStatus } from './local-data-notice.tsx'
import { maintenanceMessage } from './notice-runtime.ts'

function fixture(patch: Partial<DraftMaintenanceView> = {}) {
  let state: DraftMaintenanceView = { busy: false, cleanup: 'none', retention: 'done', catalog: undefined, problem: undefined, completed: [], ...patch }
  const listeners = new Set<() => void>()
  const model: DraftMaintenance = { view: () => state, subscribe: (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }, activate: vi.fn(), refresh: vi.fn(async () => {}), retry: vi.fn(async () => {}), dispose: vi.fn() }
  render(
    <>
      <button type="button">正在编辑</button>
      <LocalDataStatus runtime={{ model, text: localDataMessages, describe: maintenanceMessage, dispose: vi.fn() }} />
    </>,
  )
  return { model, update: (next: Partial<DraftMaintenanceView>) => {
    state = { ...state, ...next }
    listeners.forEach(listener => listener())
  } }
}
describe('后台维护提示不会抢编辑焦点', () => {
  it.each([
    ['unreadable', '已无法访问这份文档，对应的本机草稿已清除'],
    ['revoked', '密钥失效的本机草稿已清除'],
    ['corrupted', '损坏的本机草稿已清除'],
  ] as const)('后台已清理 %s 时在当前页直接解释，不让人到已经空的目录找原因', (reason, message) => {
    fixture({ completed: [reason], catalog: {
      checked: true,
      completedCopies: [],
      uncertainCopies: [],
      busy: undefined,
      problem: undefined,
      incomplete: false,
      stale: false,
      held: undefined,
      copyPending: undefined,
      rows: [{ documentId: 'doc', title: undefined, updatedAt: 1, mirrorOnly: false, access: 'unavailable', recovery: {
        stage: 'finished',
        decision: { kind: 'remove', reason },
        updatedAt: 1,
        operation: undefined,
        cleanup: { kind: 'removed', mirror: { kind: 'removed' } },
        copy: { kind: 'idle' },
        notice: undefined,
        problem: undefined,
      } }],
    } })
    expect(screen.getByRole('status')).toHaveTextContent(message)
  })
  it('无问题不占视图；公开页遇未完成清理只显示通用说明和重试', () => {
    const t = fixture()
    const editing = screen.getByRole('button', { name: '正在编辑' })
    editing.focus()
    act(() => t.update({ cleanup: 'pending' }))
    expect(screen.getByRole('status')).toHaveTextContent('还有未完成的清理')
    expect(editing).toHaveFocus()
    expect(screen.queryByRole('link', { name: '查看本机草稿' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试本机维护' }))
    expect(t.model.retry).toHaveBeenCalledTimes(1)
  })
  it('重试按钮进行中保持焦点并防止再次提交，完成后保留按钮与焦点', () => {
    const t = fixture({ cleanup: 'failed' })
    const button = screen.getByRole('button', { name: '重试本机维护' })
    button.focus()
    act(() => t.update({ busy: true }))
    expect(button).toHaveFocus()
    fireEvent.click(button)
    expect(t.model.retry).not.toHaveBeenCalled()
    expect(button).toHaveAttribute('aria-disabled', 'true')
    act(() => t.update({ busy: false, cleanup: 'none' }))
    expect(button).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent('本机草稿检查已完成')
  })
})
