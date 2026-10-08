// 读屏用的状态区（M2-P5 审查 B 的 M1）：一直是同一个 role="status" 元素，空的时候只做视觉隐藏（sr-only），不用 display: none 一类的类名。
// jsdom 不加载 Tailwind 的样式，这里核对的是类名与元素；真实浏览器里"空的时候在无障碍树里"由 E2E 核对（documents/sharing.spec.ts）。
// keepFocusInView（M3-P6 复验 N1、再复核 D1）：状态区变高之后把排在它后面、有焦点的元素滚回可视区域（共用的 shared/lib/use-keep-focus-in-view.ts，
// 规则在那里的单元测试里逐条核对）。jsdom 没有布局：ResizeObserver 是由用例驱动的替身（resize 当作布局变了），这里核对开关接没接上；
// 真实浏览器里的位置由 E2E 核对（admin/local-keys.spec.ts 靠下的一行、admin/transfer.spec.ts 长列表之后、spaces/members.spec.ts 降低自己与滚走之后）
import type { ReactNode } from 'react'
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { resize } from '../testing/resize.test-support.ts'
import { watchScrollIntoView } from '../testing/scroll.test-support.ts'
import { StatusRegion } from './status-region.tsx'

/** 让元素不在无障碍树里的类名：hidden、invisible，带变体前缀的（empty:hidden、md:hidden）也算 */
const HIDING_CLASS = /(?:^|\s)(?:\S+:)?!?(?:hidden|invisible)!?(?:\s|$)/

describe('StatusRegion', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['false', false],
    ['空串', ''],
  ] as const)('没有要说的（%s）：照样是一个 role="status" 的元素，只做视觉隐藏，不用有内容时的样式', (_name, empty) => {
    render(<StatusRegion className="rounded-lg border p-2">{empty}</StatusRegion>)
    const status = screen.getByRole('status')
    expect(status).toBeEmptyDOMElement()
    expect(status).toHaveClass('sr-only')
    expect(status.className).not.toMatch(HIDING_CLASS)
    expect(status).not.toHaveClass('rounded-lg')
    expect(status).not.toHaveAttribute('hidden')
  })

  it('有内容时照常显示：用给的样式，不再视觉隐藏', () => {
    render(<StatusRegion className="rounded-lg border p-2"><span>已分享给 某人</span></StatusRegion>)
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('已分享给 某人')
    expect(status).toHaveClass('rounded-lg', 'border', 'p-2')
    expect(status).not.toHaveClass('sr-only')
  })

  it('内容出现、换掉、清空都在同一个元素里：读屏软件据此播报（与内容一起插入的状态区部分读屏不播报，M2-P2 复验）', () => {
    const { rerender } = render(<StatusRegion className="text-sm">{undefined}</StatusRegion>)
    const status = screen.getByRole('status')
    rerender(<StatusRegion className="text-sm">正在查找…</StatusRegion>)
    expect(screen.getByRole('status')).toBe(status)
    expect(status).toHaveTextContent('正在查找…')
    rerender(<StatusRegion className="text-sm">没有找到</StatusRegion>)
    expect(screen.getByRole('status')).toBe(status)
    expect(status).toHaveTextContent('没有找到')
    const nothing = ''
    rerender(<StatusRegion className="text-sm">{nothing}</StatusRegion>)
    expect(screen.getByRole('status')).toBe(status)
    expect(status).toBeEmptyDOMElement()
    expect(status).toHaveClass('sr-only')
  })
})

/** 长列表上方的状态区：下面有一个一直在的按钮（做完操作之后焦点交还给它）；keep 是 keepFocusInView */
function ListPage({ notice, keep }: { readonly notice?: ReactNode, readonly keep?: boolean }) {
  return (
    <>
      <StatusRegion className="rounded-lg border p-3" keepFocusInView={keep}>{notice}</StatusRegion>
      <button type="button">列表下面的按钮</button>
    </>
  )
}

/** 等替身送完开始观察时的第一条记录（下一个微任务里） */
async function firstRecord(): Promise<void> {
  await act(async () => Promise.resolve())
}

describe('StatusRegion 的 keepFocusInView（M3-P6 复验 N1、再复核 D1：长列表上方的状态区变高时下面的内容整体下移，焦点所在的元素要留在可视区域里）', () => {
  it('开着：只看状态区的高度——写进说明（变高）时把排在它后面、有焦点的元素按最小距离滚回可视区域；说明变长而高度不变、变短、清空（不变高）时不滚', async () => {
    const scrolled = watchScrollIntoView()
    const { rerender } = render(<ListPage keep />)
    await firstRecord()
    const region = screen.getByRole('status')
    const button = screen.getByRole('button', { name: '列表下面的按钮' })
    button.focus()
    // 写进说明：状态区从 1 像素（空的时候视觉隐藏）撑开
    rerender(<ListPage keep notice="已吊销 @amy 艾米 的本机密钥第 1 版，换成了第 2 版。" />)
    act(() => resize(region, 46))
    expect(scrolled).toHaveBeenCalledTimes(1)
    expect(scrolled).toHaveBeenLastCalledWith({ block: 'nearest' })
    expect(scrolled.mock.contexts.at(-1)).toBe(button)
    // 换成更长的说明、同一行放得下（高度不变）：不滚
    rerender(<ListPage keep notice="已吊销 @amy 艾米 的本机密钥第 1 版，换成了第 2 版；列表还在刷新" />)
    // 那一句消失、清空：变矮，下面的内容往上走，不滚
    rerender(<ListPage keep notice="已吊销 @amy 艾米 的本机密钥第 1 版，换成了第 2 版。" />)
    rerender(<ListPage keep />)
    act(() => resize(region, 1))
    expect(scrolled).toHaveBeenCalledTimes(1)
  })

  it('开着：变高与谁重新渲染无关——状态区里的子组件自己重新渲染、窗口变窄折行，状态区自己没有重新渲染时变高同样滚', async () => {
    const scrolled = watchScrollIntoView()
    render(<ListPage keep notice="已把 2 份文档转移到 市场部" />)
    await firstRecord()
    const button = screen.getByRole('button', { name: '列表下面的按钮' })
    button.focus()
    // 不重新渲染任何组件，只当作布局变了（说明折成了两行）
    act(() => resize(screen.getByRole('status'), 66))
    expect(scrolled.mock.contexts.at(-1)).toBe(button)
  })

  it('开着、第一次画出来时就有说明（页面打开时一起画出来，没有谁被挤动）：只记下，不滚', async () => {
    const scrolled = watchScrollIntoView()
    render(<ListPage keep notice="成员列表还在刷新" />)
    screen.getByRole('button', { name: '列表下面的按钮' }).focus()
    await firstRecord()
    expect(scrolled).not.toHaveBeenCalled()
  })

  it('关着（默认）：状态区变高也不滚', async () => {
    const scrolled = watchScrollIntoView()
    const { rerender } = render(<ListPage />)
    await firstRecord()
    screen.getByRole('button', { name: '列表下面的按钮' }).focus()
    rerender(<ListPage notice="已吊销" />)
    act(() => resize(screen.getByRole('status'), 46))
    expect(scrolled).not.toHaveBeenCalled()
  })
})
