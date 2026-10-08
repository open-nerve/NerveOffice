// 测试用：记下把元素滚进可视区域的调用（scrollIntoView）。jsdom 没有布局，vitest.setup.ts 给了一个什么也不做的实现；
// 共用的 StatusRegion 开着 keepFocusInView 时，说明写进去之后把有焦点的元素滚回可视区域（账户页、成员页、转移页）——
// 这里核对滚的是哪一个（mock.contexts）、怎样滚（参数）。真实浏览器里的位置由 E2E 核对。
import type { MockInstance } from 'vitest'
import { onTestFinished, vi } from 'vitest'

/** 从现在起记下每一次 scrollIntoView 的调用，这条用例结束时还原 */
export function watchScrollIntoView(): MockInstance<Element['scrollIntoView']> {
  const spy = vi.spyOn(Element.prototype, 'scrollIntoView')
  onTestFinished(() => {
    spy.mockRestore()
  })
  return spy
}
