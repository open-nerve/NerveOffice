// 有焦点的元素上方的内容变高之后把它滚回可视区域（M3-P6 复验 N1、再复核 D1、D5）。jsdom 没有布局：ResizeObserver 是由用例驱动的替身
// （shared/testing/resize.test-support.ts，resize 当作布局变了），scrollIntoView 记下调用；真实浏览器里的位置由 E2E 核对
// （admin/local-keys.spec.ts 靠下的一行、admin/transfer.spec.ts 长列表之后与有文档已经不在了、spaces/members.spec.ts 降低自己与滚走之后）。
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { isObserved, resize } from '../testing/resize.test-support.ts'
import { watchScrollIntoView } from '../testing/scroll.test-support.ts'
import { useKeepFocusInView } from './use-keep-focus-in-view.ts'

/** 页面：容器上面一个按钮，容器里一个按钮，下面一个按钮（做完操作之后焦点交还给它）。height 给了时，容器挂上之前先当作有这个高度 */
function Page({ enabled = true, height }: { readonly enabled?: boolean, readonly height?: number }) {
  const keepInView = useKeepFocusInView(enabled)
  return (
    <>
      <button type="button">上面的按钮</button>
      <div
        ref={(element) => {
          if (element !== null && height !== undefined)
            resize(element, height)
          return keepInView(element)
        }}
        data-testid="容器"
      >
        <button type="button">容器里的按钮</button>
      </div>
      <button type="button">下面的按钮</button>
    </>
  )
}

/** 等替身送完开始观察时的第一条记录（下一个微任务里） */
async function firstRecord(): Promise<void> {
  await act(async () => Promise.resolve())
}

describe('useKeepFocusInView：容器变高时把排在它后面、有焦点的元素滚回可视区域', () => {
  it('变高（写进说明、换成更长的、子组件自己变高、窗口变窄折行）时按最小距离滚；变矮、等高（说明变短、清空）不滚', async () => {
    const scrolled = watchScrollIntoView()
    render(<Page />)
    await firstRecord()
    const container = screen.getByTestId('容器')
    const below = screen.getByRole('button', { name: '下面的按钮' })
    below.focus()
    act(() => resize(container, 46))
    expect(scrolled).toHaveBeenCalledTimes(1)
    expect(scrolled).toHaveBeenLastCalledWith({ block: 'nearest' })
    expect(scrolled.mock.contexts.at(-1)).toBe(below)
    // 等高：不滚
    act(() => resize(container, 46))
    // 变矮（"列表还在刷新"一句消失、清空）：下面的内容往上走，不滚——用户这期间滚走了也不拉回去
    act(() => resize(container, 26))
    act(() => resize(container, 1))
    expect(scrolled).toHaveBeenCalledTimes(1)
    // 清空之后再写进同样长的说明（下一次操作）：比清空之后的高了，又滚——比的是上一次的高度，不是见过的最高
    act(() => resize(container, 46))
    expect(scrolled).toHaveBeenCalledTimes(2)
    // 再变高：又滚
    act(() => resize(container, 66))
    expect(scrolled).toHaveBeenCalledTimes(3)
    expect(scrolled.mock.contexts.at(-1)).toBe(below)
  })

  it('挂上时的高度只记下、不滚（开始观察时送来的第一条记录是同样的高度）', async () => {
    const scrolled = watchScrollIntoView()
    render(<Page height={46} />)
    // 第一条记录在下一个微任务里送来：焦点在那之前已经在下面的按钮上
    const below = screen.getByRole('button', { name: '下面的按钮' })
    below.focus()
    await firstRecord()
    expect(scrolled).not.toHaveBeenCalled()
    // 之后变高照常滚
    act(() => resize(screen.getByTestId('容器'), 66))
    expect(scrolled.mock.contexts.at(-1)).toBe(below)
  })

  it('焦点在 body 上、在容器里面、在容器前面（它变高挤不动）、在已经不在文档里的元素上：变高也不滚', async () => {
    const scrolled = watchScrollIntoView()
    render(<Page />)
    await firstRecord()
    const container = screen.getByTestId('容器')
    let height = 1
    const grow = (): void => {
      height += 20
      act(() => resize(container, height))
    }
    ;(document.activeElement as HTMLElement | null)?.blur()
    expect(document.activeElement).toBe(document.body)
    grow()
    screen.getByRole('button', { name: '容器里的按钮' }).focus()
    grow()
    screen.getByRole('button', { name: '上面的按钮' }).focus()
    grow()
    // 先把真实的焦点放到下面的按钮上：换掉 document.activeElement 的取值没有生效的话，滚的就是它，这一条随之失败
    screen.getByRole('button', { name: '下面的按钮' }).focus()
    const detached = document.createElement('button')
    const active = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(detached)
    try {
      grow()
    }
    finally {
      active.mockRestore()
    }
    expect(scrolled).not.toHaveBeenCalled()
    // 对照：焦点在下面的按钮上时照常滚
    grow()
    expect(scrolled).toHaveBeenCalledTimes(1)
  })

  it('关着：变高也不滚', async () => {
    const scrolled = watchScrollIntoView()
    render(<Page enabled={false} />)
    await firstRecord()
    screen.getByRole('button', { name: '下面的按钮' }).focus()
    act(() => resize(screen.getByTestId('容器'), 46))
    expect(scrolled).not.toHaveBeenCalled()
  })

  it('卸下之后不再盯（ResizeObserver 断开）', async () => {
    const { unmount } = render(<Page />)
    await firstRecord()
    const container = screen.getByTestId('容器')
    expect(isObserved(container)).toBe(true)
    unmount()
    expect(isObserved(container)).toBe(false)
  })
})
