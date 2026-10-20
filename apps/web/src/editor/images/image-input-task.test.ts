import { describe, expect, it, vi } from 'vitest'
import { deferred } from '../async-tools.ts'
import { createImageInputTasks } from './image-input-task.ts'

function setup() {
  let valid = true
  const listeners = new Set<() => void>()
  const target = {
    isCurrent: () => valid,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const changed = vi.fn()
  const tasks = createImageInputTasks(changed)
  const start = () => {
    const task = tasks.start(target)
    if (task === undefined)
      throw new Error('应取得图片输入任务')
    return task
  }
  return { tasks, target, changed, start, listeners, invalidate: () => {
    valid = false
    for (const listener of [...listeners])
      listener()
  }, silentlyInvalidate: () => { valid = false } }
}

describe('实例内的图片输入任务', () => {
  it('同步取得任务，同一实例只允许一个；结束后才可重试', () => {
    const h = setup()
    const task = h.start()
    expect(h.tasks.busy()).toBe(true)
    expect(h.changed.mock.calls).toEqual([[true]])
    expect(h.tasks.start(h.target)).toBeUndefined()
    task.finish()
    task.finish()
    expect(h.tasks.busy()).toBe(false)
    expect(h.changed.mock.calls).toEqual([[true], [false]])
    expect(h.listeners.size).toBe(0)
    h.start().finish()
  })

  it('无效目标不启动任何操作或注册监听', () => {
    const h = setup()
    h.invalidate()
    expect(h.tasks.start(h.target)).toBeUndefined()
    expect(h.changed).not.toHaveBeenCalled()
    expect(h.listeners.size).toBe(0)
  })

  it('任务 run 同步启动底层，保留剪贴板所需的用户动作时机', async () => {
    const h = setup()
    const task = h.start()
    const pending = deferred<number>()
    const start = vi.fn(async () => pending.promise)
    const result = task.run(start)
    expect(start).toHaveBeenCalledOnce()
    pending.resolve(42)
    expect(await result).toBe(42)
    task.finish()
  })

  it.each(['invalidate', 'cancel', 'dispose'] as const)('%s 立即取消等待并释放忙碌状态，迟到资源只释放一次', async (action) => {
    const h = setup()
    const task = h.start()
    const pending = deferred<object>()
    const discard = vi.fn()
    const result = task.run(async () => pending.promise, discard)
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    if (action === 'invalidate')
      h.invalidate()
    else
      h.tasks[action]()
    expect(task.signal.aborted).toBe(true)
    expect(h.tasks.busy()).toBe(false)
    expect(h.listeners.size).toBe(0)
    await rejected
    const value = {}
    pending.resolve(value)
    await pending.promise
    await Promise.resolve()
    expect(discard.mock.calls).toEqual([[value]])
    task.finish()
    expect(h.changed.mock.calls).toEqual([[true], [false]])
  })

  it('校验时重新核对目标，没有订阅通知也不能迟到写入', async () => {
    const h = setup()
    const task = h.start()
    const pending = deferred<number>()
    const discard = vi.fn()
    const result = task.run(async () => pending.promise, discard)
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    h.silentlyInvalidate()
    pending.resolve(42)
    await rejected
    expect(discard.mock.calls).toEqual([[42]])
    expect(h.tasks.busy()).toBe(false)
  })

  it('取消的旧任务不能结束后来重试的任务，也不能再次启动读取', async () => {
    const h = setup()
    const old = h.start()
    h.tasks.cancel()
    const current = h.start()
    old.finish()
    expect(h.tasks.busy()).toBe(true)
    const read = vi.fn(async () => 42)
    await expect(old.run(read)).rejects.toMatchObject({ name: 'AbortError' })
    expect(read).not.toHaveBeenCalled()
    current.finish()
  })

  it('销毁幂等并永久停止新任务；空闲取消不伪造状态变化', () => {
    const h = setup()
    h.tasks.cancel()
    h.tasks.dispose()
    h.tasks.dispose()
    expect(h.tasks.start(h.target)).toBeUndefined()
    expect(h.changed).not.toHaveBeenCalled()
  })

  it('监听注册时已经失效也释放刚注册的监听', () => {
    const h = setup()
    const remove = vi.fn()
    expect(h.tasks.start({
      isCurrent: h.target.isCurrent,
      subscribe: (listener) => {
        h.silentlyInvalidate()
        listener()
        return remove
      },
    })).toBeUndefined()
    expect(remove).toHaveBeenCalledOnce()
    expect(h.tasks.busy()).toBe(false)
  })

  it('底层同步异常与异步失败均交给调用方，不吞失败；finally 释放后可重试', async () => {
    const h = setup()
    const task = h.start()
    const error = new Error('failed')
    await expect(task.run(() => {
      throw error
    })).rejects.toBe(error)
    await expect(task.run(async () => {
      throw error
    })).rejects.toBe(error)
    task.finish()
    h.start().finish()
    expect(h.tasks.busy()).toBe(false)
  })
})
