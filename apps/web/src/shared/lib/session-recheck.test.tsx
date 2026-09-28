// 会话复核由应用的根组件提供；没有提供时立即报错，而不是悄悄什么都不做。
import type { SessionRecheck } from './session-recheck.ts'
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SessionRecheckContext, useSessionRecheck } from './session-recheck.ts'

describe('useSessionRecheck', () => {
  it('取到根组件提供的复核', () => {
    const recheck: SessionRecheck = async () => {}
    const { result } = renderHook(() => useSessionRecheck(), { wrapper: ({ children }) => <SessionRecheckContext value={recheck}>{children}</SessionRecheckContext> })
    expect(result.current).toBe(recheck)
  })

  it('没有提供：报错', () => {
    // React 会把渲染错误打到控制台，这里是预期的
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderHook(() => useSessionRecheck())).toThrow('会话复核由应用的根组件提供')
  })
})
