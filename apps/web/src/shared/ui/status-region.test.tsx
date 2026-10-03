// 读屏用的状态区（M2-P5 审查 B 的 M1）：一直是同一个 role="status" 元素，空的时候只做视觉隐藏（sr-only），不用 display: none 一类的类名。
// jsdom 不加载 Tailwind 的样式，这里核对的是类名与元素；真实浏览器里"空的时候在无障碍树里"由 E2E 核对（documents/sharing.spec.ts）。
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
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
