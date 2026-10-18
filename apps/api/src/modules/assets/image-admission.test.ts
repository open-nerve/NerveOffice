import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageAdmission } from './image-admission.ts'

const signal = (): AbortSignal => new AbortController().signal
function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
const busy = { code: 'ASSET_BUSY', status: 503, headers: { 'Retry-After': '10' } }
afterEach(() => vi.useRealTimers())

describe('图片正文读取前的准入', () => {
  it('一份执行、四份等待，先来先执行；等待时不读取正文', async () => {
    const admission = new ImageAdmission()
    const hold = deferred()
    const started: number[] = []
    const first = admission.run('a', signal(), async () => {
      started.push(0)
      await hold.promise
    })
    const waiting = [1, 2, 3, 4].map(async i => admission.run(String(i), signal(), async () => {
      started.push(i)
      return i
    }))
    await expect(admission.run('overflow', signal(), async () => 9)).rejects.toMatchObject(busy)
    expect(started).toEqual([0])
    hold.release()
    await first
    expect(await Promise.all(waiting)).toEqual([1, 2, 3, 4])
    expect(started).toEqual([0, 1, 2, 3, 4])
  })

  it('同账户执行与等待合计二份，其他账户仍可进入', async () => {
    const admission = new ImageAdmission()
    const hold = deferred()
    const first = admission.run('a', signal(), async () => hold.promise)
    const second = admission.run('a', signal(), async () => 2)
    await expect(admission.run('a', signal(), async () => 3)).rejects.toMatchObject(busy)
    const another = admission.run('b', signal(), async () => 4)
    hold.release()
    await first
    expect(await second).toBe(2)
    expect(await another).toBe(4)
    expect(await admission.run('a', signal(), async () => 5)).toBe(5)
  })

  it('满十秒等待超时，清理计时器和账户占用，下一份能进入', async () => {
    vi.useFakeTimers()
    const admission = new ImageAdmission()
    const hold = deferred()
    const first = admission.run('a', signal(), async () => hold.promise)
    const task = vi.fn(async () => 2)
    const waiting = admission.run('a', signal(), task)
    const rejected = expect(waiting).rejects.toMatchObject(busy)
    await vi.advanceTimersByTimeAsync(9999)
    expect(task).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(vi.getTimerCount()).toBe(0)
    const next = admission.run('a', signal(), async () => 3)
    hold.release()
    await first
    expect(await next).toBe(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('取消等待立即归还全局/账户名额，不回显 AbortSignal 的原始理由', async () => {
    const admission = new ImageAdmission()
    const hold = deferred()
    const first = admission.run('a', signal(), async () => hold.promise)
    const controller = new AbortController()
    const task = vi.fn(async () => 2)
    const waiting = admission.run('a', controller.signal, task)
    const rejected = expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort('private-body-fragment')
    await rejected
    const next = admission.run('a', signal(), async () => 3)
    hold.release()
    await first
    expect(await next).toBe(3)
    expect(task).not.toHaveBeenCalled()
  })

  it('执行中收到取消不提前放槽，必须等任务自己完成收尾', async () => {
    const admission = new ImageAdmission()
    const hold = deferred()
    const controller = new AbortController()
    const first = admission.run('a', controller.signal, async () => hold.promise)
    const task = vi.fn(async () => 2)
    const next = admission.run('b', signal(), task)
    controller.abort()
    await Promise.resolve()
    expect(task).not.toHaveBeenCalled()
    hold.release()
    await first
    expect(await next).toBe(2)
  })

  it('关闭立即取消等待、拒绝新请求；已运行任务继续持有槽直到收尾', async () => {
    const admission = new ImageAdmission()
    const hold = deferred()
    const first = admission.run('a', signal(), async () => hold.promise)
    const task = vi.fn(async () => 2)
    const waiting = admission.run('b', signal(), task)
    const rejected = expect(waiting).rejects.toMatchObject(busy)
    admission.close()
    admission.close()
    await rejected
    await expect(admission.run('c', signal(), task)).rejects.toMatchObject(busy)
    expect(task).not.toHaveBeenCalled()
    hold.release()
    await first
  })

  it('预先取消不进入任务；任务失败后归还名额，错误原样交给调用方', async () => {
    const admission = new ImageAdmission()
    const controller = new AbortController()
    controller.abort()
    const task = vi.fn(async () => 1)
    await expect(admission.run('a', controller.signal, task)).rejects.toMatchObject({ name: 'AbortError' })
    expect(task).not.toHaveBeenCalled()
    const error = new Error('controlled failure')
    await expect(admission.run('a', signal(), async () => {
      throw error
    })).rejects.toBe(error)
    expect(await admission.run('a', signal(), task)).toBe(1)
  })
})
