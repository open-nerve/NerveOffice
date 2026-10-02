import { fireEvent, render, screen, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError } from '../../shared/api/index.ts'
import { PageLocationContext } from '../../shared/lib/page-location.ts'
import { recordingPage } from '../render-app.test-support.tsx'
import { ErrorPage } from './error-page.tsx'

function brokenBy(error: unknown) {
  return function Broken(): never {
    throw error
  }
}

function renderBroken(error: unknown) {
  // React 会把渲染错误打到控制台，这里是预期的
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const page = recordingPage()
  const router = createMemoryRouter([{ path: '/', Component: brokenBy(error), ErrorBoundary: ErrorPage }])
  render(
    <PageLocationContext value={page}>
      <RouterProvider router={router} />
    </PageLocationContext>,
  )
  return page
}

describe('ErrorPage', () => {
  it('渲染出错时：说明、请求标识与重新加载；main 地标保留，提示放在里面（审查 B15）', async () => {
    const page = renderBroken(new ApiError(500, 'INTERNAL_ERROR', 'x', { requestId: 'req-42' }))
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('heading', { name: '页面出错了' })).toBeInTheDocument()
    expect(within(alert).getByText('页面遇到了意外的问题。可以重新加载试试；问题一直出现时，把下面的请求标识告诉管理员。')).toBeInTheDocument()
    expect(within(alert).getByText('请求标识：req-42')).toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: '重新加载' }))
    expect(page.visits).toEqual(['reload'])
  })

  it('没有请求标识时不提"把下面的请求标识告诉管理员"；焦点交给标题，不留在 body（M2-P6 复核 S6）', async () => {
    renderBroken(new TypeError('意外'))
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('页面遇到了意外的问题。可以重新加载试试；问题一直出现时，请告诉管理员。')).toBeInTheDocument()
    expect(within(alert).queryByText(/请求标识/)).toBeNull()
    expect(document.activeElement).toBe(within(alert).getByRole('heading', { name: '页面出错了' }))
    expect(document.title).toBe('页面出错了 - NerveOffice')
  })

  it('断网：说网络连接失败，而不是"意外的问题"（M2-P6 复核 S6）', async () => {
    renderBroken(new NetworkError('网络请求失败'))
    expect(within(await screen.findByRole('alert')).getByText('网络连接失败，请检查网络后重试')).toBeInTheDocument()
  })
})
