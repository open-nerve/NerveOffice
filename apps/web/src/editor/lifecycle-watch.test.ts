import type { FUniver } from '@univerjs/core/facade'
import { LifecycleStages } from '@univerjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchLifecycle } from './lifecycle-watch.ts'
import { SheetEditorLoadError } from './sheet-editor-error.ts'

/** 假的 Facade：与 SDK 一样，订阅 LifeCycleChanged 时先收到当前的阶段（BehaviorSubject） */
function fakeFacade(initial: LifecycleStages = LifecycleStages.Starting) {
  let stage = initial
  const listeners = new Set<(event: { stage: LifecycleStages }) => void>()
  const api = {
    Event: { LifeCycleChanged: 'LifeCycleChanged' },
    addEvent: (name: string, listener: (event: { stage: LifecycleStages }) => void) => {
      expect(name).toBe('LifeCycleChanged')
      listeners.add(listener)
      listener({ stage })
      return { dispose: () => listeners.delete(listener) }
    },
  }
  const advance = (next: LifecycleStages): void => {
    stage = next
    listeners.forEach(listener => listener({ stage }))
  }
  return { api: api as unknown as FUniver, advance, listenerCount: () => listeners.size }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('编辑器的生命周期', () => {
  it('到 Ready 时装一次 IMAGE() 的限制；到 Rendered 可以输入；到 Steady 通知页面', async () => {
    const facade = fakeFacade()
    const installImagePolicy = vi.fn(async () => true)
    const watch = watchLifecycle({ univerAPI: facade.api, installImagePolicy })
    const stages = vi.fn()
    watch.onChange(stages)
    expect(installImagePolicy).not.toHaveBeenCalled()
    expect(watch.current()).toBeNull()

    facade.advance(LifecycleStages.Ready)
    expect(installImagePolicy).toHaveBeenCalledTimes(1)
    await expect(watch.imagePolicyInstalled).resolves.toBeUndefined()

    facade.advance(LifecycleStages.Rendered)
    await expect(watch.rendered).resolves.toBeUndefined()
    expect(watch.current()).toBe('rendered')

    facade.advance(LifecycleStages.Steady)
    expect(watch.current()).toBe('steady')
    expect(stages.mock.calls).toEqual([['rendered'], ['steady']])
    expect(installImagePolicy).toHaveBeenCalledTimes(1)
  })

  it('订阅时已经过了这些阶段：立即补上（安装、渲染完成、steady）', async () => {
    const installImagePolicy = vi.fn(async () => true)
    const watch = watchLifecycle({ univerAPI: fakeFacade(LifecycleStages.Steady).api, installImagePolicy })
    expect(installImagePolicy).toHaveBeenCalledTimes(1)
    await expect(watch.rendered).resolves.toBeUndefined()
    expect(watch.current()).toBe('steady')
  })

  it('主线程没装上 IMAGE() 的限制，或者安装出错：以 image-policy-failed 失败', async () => {
    for (const installImagePolicy of [async () => false, async () => Promise.reject(new Error('坏了'))]) {
      const facade = fakeFacade()
      const watch = watchLifecycle({ univerAPI: facade.api, installImagePolicy })
      facade.advance(LifecycleStages.Ready)
      const error: unknown = await watch.imagePolicyInstalled.catch((reason: unknown) => reason)
      expect(error).toBeInstanceOf(SheetEditorLoadError)
      expect((error as SheetEditorLoadError).reason).toBe('image-policy-failed')
    }
  })

  it('放弃加载之后安装才失败：不再落定，不留下没人接住的失败', async () => {
    const facade = fakeFacade()
    let finish: (ok: boolean) => void = () => {}
    const watch = watchLifecycle({ univerAPI: facade.api, installImagePolicy: async () => new Promise<boolean>(resolve => (finish = resolve)) })
    facade.advance(LifecycleStages.Ready)
    watch.dispose()
    finish(false)
    const outcome = await Promise.race([watch.imagePolicyInstalled.then(() => 'resolved', () => 'rejected'), new Promise(resolve => setTimeout(resolve, 20, 'pending'))])
    expect(outcome).toBe('pending')
    expect(facade.listenerCount()).toBe(0)
  })

  it('页面的监听出错不打断 SDK 推进生命周期；取消订阅之后不再通知', () => {
    const reportError = vi.fn()
    vi.stubGlobal('reportError', reportError)
    const facade = fakeFacade(LifecycleStages.Ready)
    const watch = watchLifecycle({ univerAPI: facade.api, installImagePolicy: async () => true })
    const failure = new Error('页面出错')
    watch.onChange(() => {
      throw failure
    })
    const removed = vi.fn()
    watch.onChange(removed)()
    expect(() => facade.advance(LifecycleStages.Rendered)).not.toThrow()
    expect(reportError).toHaveBeenCalledWith(failure)
    expect(removed).not.toHaveBeenCalled()
    expect(watch.current()).toBe('rendered')
  })
})
