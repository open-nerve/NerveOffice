import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { fakeOutboxLocks } from './src/shared/outbox/outbox-lock.test-support.ts'
import { restoreConnection } from './src/shared/testing/connection.test-support.ts'
import { FakeResizeObserver } from './src/shared/testing/resize.test-support.ts'
import '@testing-library/jest-dom/vitest'

// jsdom 没有布局，也没有 ResizeObserver 与 scrollIntoView：有焦点的元素上方的内容变高之后，共用的做法（shared/lib/use-keep-focus-in-view.ts：
// 状态区的 keepFocusInView、转移页"有文档已经不在了"的说明）盯着容器的高度、把有焦点的元素滚回可视区域。这里装上由用例驱动的
// ResizeObserver（shared/testing/resize.test-support.ts 的 resize 当作布局变了）与一个什么也不做的 scrollIntoView；
// 要核对滚了哪一个、怎样滚的用例用 shared/testing/scroll.test-support.ts 记下调用
globalThis.ResizeObserver = FakeResizeObserver
Element.prototype.scrollIntoView = function scrollIntoView() {}
// 发件箱跨页面/Worker 的短期互斥；真实来源间的共享由浏览器层用例核对。
Object.defineProperty(navigator, 'locks', { configurable: true, value: fakeOutboxLocks() })

// 没有开启 Vitest 的 globals，Testing Library 不会自动清理：每个用例之后卸载渲染的组件，恢复被替换的全局对象（fetch）
afterEach(() => {
  cleanup()
  restoreConnection()
  vi.unstubAllGlobals()
})
