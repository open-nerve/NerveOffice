import type { IdleWatch } from './idle-watch.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeLeaseClock } from './fake-lease-clock.test-support.ts'
import { createIdleWatch } from './idle-watch.ts'

const MINUTE = 60_000
const THRESHOLD = 10 * MINUTE

/** 可以设的页面可见性：变了时同步通知 */
function fakeVisibility() {
  let hidden = false
  const listeners = new Set<() => void>()
  return {
    visibility: {
      hidden: () => hidden,
      onChange: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    set: (next: boolean) => {
      hidden = next
      listeners.forEach(listener => listener())
    },
    listeners,
  }
}

const watches: IdleWatch[] = []

afterEach(() => {
  for (const watch of watches.splice(0))
    watch.dispose()
})

/** 空闲计时的环境：最后一次操作的时刻可设（默认打开页面的那一刻，早于进入编辑），进入编辑的时刻 since */
function setup(options: { readonly lastActivity?: number, readonly since?: number } = {}) {
  const time = fakeLeaseClock()
  const page = fakeVisibility()
  let lastActivity = options.lastActivity ?? time.now()
  const onIdle = vi.fn()
  const watch = createIdleWatch({
    clock: time.clock,
    visibility: page.visibility,
    lastActivity: () => lastActivity,
    since: options.since ?? time.now(),
    thresholdMs: THRESHOLD,
    onIdle,
  })
  watches.push(watch)
  return {
    time,
    page,
    onIdle,
    watch,
    /** 本页有一次操作（在现在） */
    act: () => {
      lastActivity = time.now()
    },
  }
}

describe('空闲释放的计时（M3-P5 设计 §3.9）', () => {
  it('满了阈值才交出，恰好满就交出；交出一次之后停下（不再到点）', async () => {
    const context = setup()
    await context.time.advance(THRESHOLD - 1)
    expect(context.onIdle).not.toHaveBeenCalled()
    await context.time.advance(1)
    expect(context.onIdle).toHaveBeenCalledOnce()
    await context.time.advance(THRESHOLD * 3)
    expect(context.onIdle).toHaveBeenCalledOnce()
    expect(context.time.pending()).toBe(0)
  })

  it('其间有操作：按新的截止时刻（最后一次操作加阈值）重排，到点再判断', async () => {
    const context = setup()
    await context.time.advance(4 * MINUTE)
    context.act()
    await context.time.advance(6 * MINUTE)
    expect(context.onIdle).not.toHaveBeenCalled()
    await context.time.advance(4 * MINUTE - 1)
    expect(context.onIdle).not.toHaveBeenCalled()
    await context.time.advance(1)
    expect(context.onIdle).toHaveBeenCalledOnce()
    // 只排一个计时器（到点重算，不是每次操作都排）
    expect(context.time.pending()).toBe(0)
  })

  it('起点不早于进入编辑的时刻：打开很久之后才进入编辑（最后一次操作在进入之前），从进入编辑算起有完整的一段', async () => {
    const time = fakeLeaseClock()
    const onIdle = vi.fn()
    // 最后一次操作在 20 分钟之前，现在进入编辑
    const entered = time.now() + 20 * MINUTE
    await time.advance(20 * MINUTE)
    const watch = createIdleWatch({ clock: time.clock, visibility: fakeVisibility().visibility, lastActivity: () => entered - 20 * MINUTE, since: entered, thresholdMs: THRESHOLD, onIdle })
    watches.push(watch)
    await time.advance(0)
    expect(onIdle).not.toHaveBeenCalled()
    await time.advance(THRESHOLD - 1)
    expect(onIdle).not.toHaveBeenCalled()
    await time.advance(1)
    expect(onIdle).toHaveBeenCalledOnce()
  })

  it('回到前台时按隐藏之前的最后一次操作算（Safari 隐藏之后计时器停止）：满了就在可见性的通知里同步交出，回来时的第一下操作冲不掉它', async () => {
    const context = setup()
    context.page.set(true)
    // 隐藏期间计时器不走（elapse 只拨时间、不执行计时器）
    context.time.elapse(30 * MINUTE)
    expect(context.onIdle).not.toHaveBeenCalled()
    context.page.set(false)
    expect(context.onIdle).toHaveBeenCalledOnce()
    // 回来时的第一下鼠标移动；之后停在暂停里的计时器恢复、到点：不再交出
    context.act()
    await context.time.advance(THRESHOLD)
    expect(context.onIdle).toHaveBeenCalledOnce()
  })

  it('回到前台时还没满：照常按截止时刻（隐藏之前的最后一次操作加阈值）', async () => {
    const context = setup()
    context.page.set(true)
    context.time.elapse(4 * MINUTE)
    context.page.set(false)
    expect(context.onIdle).not.toHaveBeenCalled()
    context.act()
    await context.time.advance(THRESHOLD - 1)
    expect(context.onIdle).not.toHaveBeenCalled()
    await context.time.advance(1)
    expect(context.onIdle).toHaveBeenCalledOnce()
  })

  it('变成隐藏时不判断（只在回到前台时）', () => {
    const context = setup()
    context.time.elapse(THRESHOLD)
    context.page.set(true)
    expect(context.onIdle).not.toHaveBeenCalled()
  })

  it('停下之后到点、回到前台都不交出；接着看（resume）时过 delayMs 判断一次：还满就再交出，期间有过操作就按截止时刻重排', async () => {
    const context = setup()
    await context.time.advance(THRESHOLD)
    expect(context.onIdle).toHaveBeenCalledOnce()
    // 空闲释放没存上、留在编辑：过一个心跳周期再看
    context.watch.resume(10_000)
    await context.time.advance(9_999)
    expect(context.onIdle).toHaveBeenCalledOnce()
    await context.time.advance(1)
    expect(context.onIdle).toHaveBeenCalledTimes(2)
    // 再接着看，这期间人回来了：不交出，按新的截止时刻
    context.watch.resume(10_000)
    context.act()
    await context.time.advance(10_000)
    expect(context.onIdle).toHaveBeenCalledTimes(2)
    await context.time.advance(THRESHOLD - 10_000)
    expect(context.onIdle).toHaveBeenCalledTimes(3)
  })

  it('stop：离开编辑的过程中不交出（到点、回到前台都不）；resume 不给时尽快判断', async () => {
    const context = setup()
    context.watch.stop()
    await context.time.advance(THRESHOLD * 2)
    context.page.set(true)
    context.page.set(false)
    expect(context.onIdle).not.toHaveBeenCalled()
    context.watch.resume()
    await context.time.advance(0)
    expect(context.onIdle).toHaveBeenCalledOnce()
  })

  it('dispose：取消计时器、退订可见性，之后 resume 也不再看', async () => {
    const context = setup()
    context.watch.dispose()
    expect(context.time.pending()).toBe(0)
    expect(context.page.listeners.size).toBe(0)
    context.watch.resume(0)
    await context.time.advance(THRESHOLD * 2)
    expect(context.onIdle).not.toHaveBeenCalled()
  })
})
