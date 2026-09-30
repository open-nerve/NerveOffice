// 换上新会话的处理由应用的根组件提供（M2-P6 复验 一般-4）；没有提供时立即报错，而不是悄悄什么都不做。
import type { AdoptRenewedSession } from './renewed-session.ts'
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AdoptRenewedSessionContext, useAdoptRenewedSession } from './renewed-session.ts'

describe('useAdoptRenewedSession', () => {
  it('取到根组件提供的处理', () => {
    const adopt: AdoptRenewedSession = async () => false
    const { result } = renderHook(() => useAdoptRenewedSession(), { wrapper: ({ children }) => <AdoptRenewedSessionContext value={adopt}>{children}</AdoptRenewedSessionContext> })
    expect(result.current).toBe(adopt)
  })

  it('没有提供：报错', () => {
    // React 会把渲染错误打到控制台，这里是预期的
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderHook(() => useAdoptRenewedSession())).toThrow('换上新会话的处理由应用的根组件提供')
  })
})
