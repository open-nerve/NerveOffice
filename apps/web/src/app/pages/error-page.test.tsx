import { render, screen, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../shared/api/index.ts'
import { ErrorPage } from './error-page.tsx'

function Broken(): never {
  throw new ApiError(500, 'INTERNAL_ERROR', 'x', { requestId: 'req-42' })
}

describe('ErrorPage', () => {
  it('渲染出错时：说明、请求标识与重新加载；main 地标保留，提示放在里面（审查 B15）', async () => {
    // React 会把渲染错误打到控制台，这里是预期的
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const router = createMemoryRouter([{ path: '/', Component: Broken, ErrorBoundary: ErrorPage }])
    render(<RouterProvider router={router} />)
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('heading', { name: '页面出错了' })).toBeInTheDocument()
    expect(within(alert).getByText('请求标识：req-42')).toBeInTheDocument()
    expect(within(screen.getByRole('main')).getByRole('button', { name: '重新加载' })).toBeInTheDocument()
  })
})
