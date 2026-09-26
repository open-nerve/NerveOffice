// 编辑器的生命周期（P4 设计 §3.6.3）：用公开的 Facade 事件 LifeCycleChanged 跟踪（订阅时先收到当前的阶段）。
// - 到 Ready：在主线程装上 IMAGE() 的限制（内置函数在引擎插件 onReady 时注册，所以不能更早）；
// - 到 Rendered：可以输入，编辑器就绪的条件之一；
// - 到 Steady（Rendered 之后 3 秒，SDK 固定）：页面此后才判断"打开是否被判定为有修改"
import type { FUniver } from '@univerjs/core/facade'
import { LifecycleStages } from '@univerjs/core'
import { deferred } from './async-tools.ts'
import { SheetEditorLoadError } from './sheet-editor-error.ts'

/** 渲染完成之后可以输入；steady（渲染完成后 3 秒，SDK 固定）之后才判断"打开是否被判定为有修改" */
export type SheetEditorLifecycle = 'rendered' | 'steady'

export interface LifecycleWatch {
  /** 渲染完成之前为 null */
  readonly current: () => SheetEditorLifecycle | null
  readonly rendered: Promise<void>
  /** 主线程的 IMAGE() 限制装上了；没装上时以 image-policy-failed 失败 */
  readonly imagePolicyInstalled: Promise<void>
  readonly onChange: (listener: (stage: SheetEditorLifecycle) => void) => () => void
  readonly dispose: () => void
}

export interface LifecycleWatchOptions {
  readonly univerAPI: FUniver
  /** 到 Ready 时调用一次：返回限制是否生效 */
  readonly installImagePolicy: () => Promise<boolean>
}

export function watchLifecycle(options: LifecycleWatchOptions): LifecycleWatch {
  const { univerAPI, installImagePolicy } = options
  let current: SheetEditorLifecycle | null = null
  let disposed = false
  let imagePolicyStarted = false
  const listeners = new Set<(stage: SheetEditorLifecycle) => void>()
  const rendered = deferred<void>()
  const imagePolicy = deferred<void>()

  const fail = (message: string, cause?: unknown): void => {
    // 编辑器已经放弃加载时，结果没有人等：不再落定，免得留下没人接住的失败
    if (!disposed)
      imagePolicy.reject(new SheetEditorLoadError('image-policy-failed', message, { cause }))
  }
  const enter = (stage: SheetEditorLifecycle): void => {
    current = stage
    for (const listener of [...listeners]) {
      try {
        listener(stage)
      }
      catch (error) {
        // 这里在 SDK 推进生命周期的过程中同步调用，页面的异常不能打断它
        reportError(error)
      }
    }
  }

  const subscription = univerAPI.addEvent(univerAPI.Event.LifeCycleChanged, ({ stage }) => {
    if (stage >= LifecycleStages.Ready && !imagePolicyStarted) {
      imagePolicyStarted = true
      installImagePolicy().then(
        ok => ok ? imagePolicy.resolve() : fail('主线程没有装上 IMAGE() 的限制'),
        (error: unknown) => fail('主线程安装 IMAGE() 的限制时出错', error),
      )
    }
    if (stage >= LifecycleStages.Rendered && current === null) {
      enter('rendered')
      rendered.resolve()
    }
    if (stage >= LifecycleStages.Steady && current !== 'steady')
      enter('steady')
  })

  return {
    current: () => current,
    rendered: rendered.promise,
    imagePolicyInstalled: imagePolicy.promise,
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      disposed = true
      listeners.clear()
      subscription.dispose()
    },
  }
}
