// 读屏用的状态区（M2-P5 审查 B 的 M1）：一直是同一个 role="status" 元素，空的时候只做视觉隐藏（sr-only），不用 display: none 一类的类名。
// jsdom 不加载 Tailwind 的样式，这里核对的是类名与元素；真实浏览器里"空的时候在无障碍树里"由 E2E 核对（documents/sharing.spec.ts）。
// keepFocusInView（M3-P6 复验）：内容变了之后把有焦点的元素滚回可视区域；jsdom 没有布局，这里核对滚的是哪一个、什么时候滚，
// 真实浏览器里的位置由 E2E 核对（admin/local-keys.spec.ts 靠下的一行、admin/transfer.spec.ts 长列表之后的"转移"）
import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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

describe('StatusRegion 的 keepFocusInView（M3-P6 复验：长列表上方的状态区写进说明时下面的内容整体下移，焦点所在的元素要留在可视区域里）', () => {
  it('开着：说明从无到有、换了、清空之后，都把有焦点的元素按最小距离滚回可视区域；父组件重新渲染而画出来的文字没变时不滚', () => {
    const scrolled = watchScrollIntoView()
    const { rerender } = render(<ListPage keep />)
    const button = screen.getByRole('button', { name: '列表下面的按钮' })
    button.focus()
    rerender(<ListPage keep notice="已吊销 @amy 艾米 的本机密钥，换成了第 2 版。" />)
    expect(scrolled).toHaveBeenCalledTimes(1)
    expect(scrolled).toHaveBeenLastCalledWith({ block: 'nearest' })
    expect(scrolled.mock.contexts.at(-1)).toBe(button)
    // 父组件重新渲染：文字没变（换成同样文字的元素也一样）时不滚
    rerender(<ListPage keep notice="已吊销 @amy 艾米 的本机密钥，换成了第 2 版。" />)
    rerender(<ListPage keep notice={<span>已吊销 @amy 艾米 的本机密钥，换成了第 2 版。</span>} />)
    expect(scrolled).toHaveBeenCalledTimes(1)
    rerender(<ListPage keep notice="已把 2 份文档转移到 市场部" />)
    expect(scrolled).toHaveBeenCalledTimes(2)
    expect(scrolled.mock.contexts.at(-1)).toBe(button)
    // 清空：状态区不再占位置，下面的内容整体上移
    rerender(<ListPage keep />)
    expect(scrolled).toHaveBeenCalledTimes(3)
    expect(scrolled.mock.contexts.at(-1)).toBe(button)
  })

  it('开着、第一次画出来时就有说明（页面打开时一起画出来，没有谁被挤动）：只记下，不滚', () => {
    const scrolled = watchScrollIntoView()
    const outside = document.createElement('button')
    document.body.append(outside)
    try {
      outside.focus()
      render(<ListPage keep notice="成员列表还在刷新" />)
      expect(scrolled).not.toHaveBeenCalled()
    }
    finally {
      outside.remove()
    }
  })

  it('关着（默认）：说明出现、换了、清空都不滚', () => {
    const scrolled = watchScrollIntoView()
    const { rerender } = render(<ListPage />)
    screen.getByRole('button', { name: '列表下面的按钮' }).focus()
    rerender(<ListPage notice="已吊销" />)
    rerender(<ListPage notice="换了" />)
    rerender(<ListPage />)
    expect(scrolled).not.toHaveBeenCalled()
  })

  it('焦点在 body 上、在状态区自己里面、在已经不在文档里的元素上：什么也不做', () => {
    const scrolled = watchScrollIntoView()
    const withButton = (text: string): ReactNode => (
      <>
        <span>{text}</span>
        <button type="button">状态区里的按钮</button>
      </>
    )
    const { rerender } = render(<ListPage keep notice={withButton('第一句')} />)
    // 焦点在 body 上
    ;(document.activeElement as HTMLElement | null)?.blur()
    expect(document.activeElement).toBe(document.body)
    rerender(<ListPage keep notice={withButton('第二句')} />)
    // 焦点在状态区自己里面（例如说明里的"重试"）
    screen.getByRole('button', { name: '状态区里的按钮' }).focus()
    rerender(<ListPage keep notice={withButton('第三句')} />)
    // 焦点所在的元素已经不在文档里（document.activeElement 平时不会给出这样的元素，这里换掉它的取值）。先把真实的焦点放到列表下面的
    // 按钮上：换取值没有生效的话，滚的就是它，这条用例随之失败
    screen.getByRole('button', { name: '列表下面的按钮' }).focus()
    const detached = document.createElement('button')
    const active = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(detached)
    try {
      rerender(<ListPage keep notice={withButton('第四句')} />)
    }
    finally {
      active.mockRestore()
    }
    expect(scrolled).not.toHaveBeenCalled()
  })
})
