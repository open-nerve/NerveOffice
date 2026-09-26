import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'

// 没有开启 Vitest 的 globals，Testing Library 不会自动清理：每个用例之后卸载渲染的组件，恢复被替换的全局对象（fetch）
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
