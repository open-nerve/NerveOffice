import type { EditorPage, EditorPageLoad, EditorPageView } from './editor-page.ts'
import type { SaveView } from './save-coordinator.ts'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError } from '../../shared/api/index.ts'
import { EditorChrome } from './editor-chrome.tsx'

const READY: EditorPageLoad = { kind: 'ready', title: '周报', readOnly: false, stage: 'steady' }
const CLEAN: SaveView = { status: 'clean', formulasPending: false, problem: undefined, conflict: undefined, canSave: true }

/** 假的编辑器页：视图由测试设定 */
function fakePage(initial: Partial<EditorPageView> = {}) {
  let view: EditorPageView = { load: READY, save: CLEAN, sessionChanged: false, ...initial }
  const listeners = new Set<() => void>()
  const page: EditorPage = {
    view: () => view,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    load: async () => {},
    save: vi.fn(async () => {}),
    hasUnsavedWork: () => false,
    reload: vi.fn(),
    dispose: () => {},
  }
  return {
    page,
    set(next: Partial<EditorPageView>): void {
      view = { ...view, ...next }
      act(() => listeners.forEach(listener => listener()))
    },
  }
}

function renderChrome(initial: Partial<EditorPageView> = {}, apple = false) {
  const fake = fakePage(initial)
  render(<EditorChrome page={fake.page} apple={apple} />)
  return fake
}

describe('编辑器页的页头（P4 设计 §3.7.3）', () => {
  it('载入中：说明正在打开，页头有回到我的空间的链接（整页跳转）', () => {
    renderChrome({ load: { kind: 'loading' }, save: undefined })
    expect(screen.getByRole('status')).toHaveTextContent('正在打开表格…')
    expect(screen.getByRole('link', { name: '我的空间' })).toHaveAttribute('href', '/')
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
  })

  it('就绪：标题、保存状态（role="status"）与保存按钮；浏览器标签页的标题', () => {
    renderChrome()
    expect(screen.getByRole('heading', { name: '周报' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('已保存到云端')
    expect(document.title).toBe('周报 - NerveOffice')
  })

  it('保存按钮：点击保存；快捷键按平台标注', () => {
    const { page } = renderChrome()
    const button = screen.getByRole('button', { name: '保存' })
    expect(button).toHaveAttribute('aria-keyshortcuts', 'Control+S')
    expect(button).toHaveAttribute('title', '保存（Ctrl+S）')
    fireEvent.click(button)
    expect(page.save).toHaveBeenCalledOnce()
  })

  it('苹果的平台：Cmd+S', () => {
    renderChrome({}, true)
    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute('aria-keyshortcuts', 'Meta+S')
  })

  it('保存状态随状态机变化；保存中按钮标为不可用（aria-disabled），焦点不丢', () => {
    const fake = renderChrome()
    fake.set({ save: { ...CLEAN, status: 'dirty' } })
    expect(screen.getByRole('status')).toHaveTextContent('有未保存的修改')
    fake.set({ save: { ...CLEAN, status: 'saving', canSave: false } })
    expect(screen.getByRole('status')).toHaveTextContent('保存中…')
    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute('aria-disabled', 'true')
    fake.set({ save: CLEAN })
    expect(screen.getByRole('status')).toHaveTextContent('已保存到云端')
    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute('aria-disabled', 'false')
  })

  it('版本冲突：说明保留本页内容，提供重新加载', () => {
    const { page } = renderChrome({ save: { ...CLEAN, status: 'conflict', canSave: false, conflict: { currentRevision: 5, source: null } } })
    expect(screen.getByRole('status')).toHaveTextContent('版本冲突')
    expect(screen.getByRole('alert')).toHaveTextContent('别处保存了更新的版本。本页的修改没有保存')
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    expect(page.reload).toHaveBeenCalledOnce()
  })

  it.each([
    ['单元格的编辑提交不了', { kind: 'cell-editing' } as const, '请先完成单元格的编辑'],
    ['超过容量上限（本页判断）', { kind: 'too-large' } as const, '表格超过容量上限（5 MiB），无法保存'],
    ['超过容量上限（服务端 413）', { kind: 'request', error: new ApiError(413, 'PAYLOAD_TOO_LARGE', '请求体解压后超过上限') } as const, '表格超过容量上限（5 MiB），无法保存'],
    ['快照不合格（422）', { kind: 'request', error: new ApiError(422, 'SNAPSHOT_INVALID', 'x', { requestId: 'req-9' }) } as const, '保存失败：表格内容的格式不正确，无法保存'],
    ['网络错误', { kind: 'request', error: new NetworkError('断网') } as const, '保存失败：网络连接失败，请检查网络后重试'],
  ])('保存没有完成：%s', (_case, problem, text) => {
    renderChrome({ save: { ...CLEAN, status: problem.kind === 'cell-editing' ? 'dirty' : 'failed', problem } })
    expect(screen.getByText(text)).toBeInTheDocument()
  })

  it('失败的说明带请求标识', () => {
    renderChrome({ save: { ...CLEAN, status: 'failed', problem: { kind: 'request', error: new ApiError(500, 'INTERNAL_ERROR', 'x', { requestId: 'req-42' }) } } })
    expect(screen.getByText('请求标识：req-42')).toBeInTheDocument()
  })

  it('公式结果尚未保存：提示稍后再保存一次；保存中不提示', () => {
    const fake = renderChrome({ save: { ...CLEAN, status: 'dirty', formulasPending: true } })
    expect(screen.getByText('公式结果尚未保存，请稍后再保存一次')).toBeInTheDocument()
    fake.set({ save: { ...CLEAN, status: 'saving', formulasPending: true, canSave: false } })
    expect(screen.queryByText('公式结果尚未保存，请稍后再保存一次')).not.toBeInTheDocument()
  })

  it('别的标签页换了人：提示不能再保存', () => {
    renderChrome({ sessionChanged: true, save: { ...CLEAN, canSave: false } })
    expect(screen.getByRole('alert')).toHaveTextContent('登录状态在别的标签页里变了，本页不能再保存')
  })

  it('只能查看：没有保存按钮', () => {
    renderChrome({ load: { ...READY, readOnly: true } as EditorPageLoad, save: undefined })
    expect(screen.getByText('只能查看')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
  })
})

describe('编辑器页的载入失败', () => {
  it('内容不存在或无权访问（别人的与不存在的相同）：说明，可以回到我的空间', () => {
    renderChrome({ load: { kind: 'not-found' }, save: undefined })
    expect(screen.getByText('内容不存在，或者你没有访问权限')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '我的空间' })).toHaveAttribute('href', '/')
  })

  it.each([
    ['格式不认识', { kind: 'unsupported' } as const, '这份表格的格式比当前页面新，请刷新页面'],
    ['编辑器加载失败', { kind: 'editor-failed', error: new Error('x') } as const, '编辑器加载失败，请刷新页面重试'],
    ['请求失败', { kind: 'failed', error: new NetworkError('断网') } as const, '表格加载失败：网络连接失败，请检查网络后重试'],
  ])('%s', (_case, load, text) => {
    renderChrome({ load, save: undefined })
    expect(screen.getByRole('alert')).toHaveTextContent(text)
  })

  it('请求失败的说明带请求标识', () => {
    renderChrome({ load: { kind: 'failed', error: new ApiError(503, 'SERVICE_UNAVAILABLE', 'x', { requestId: 'req-7' }) }, save: undefined })
    expect(screen.getByText('请求标识：req-7')).toBeInTheDocument()
  })
})
