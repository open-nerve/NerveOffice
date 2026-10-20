import { runImageTask } from './image-task.ts'

export interface ImageInputTarget {
  readonly isCurrent: () => boolean
  readonly subscribe: (listener: () => void) => () => void
}

export interface ImageInputTask {
  readonly signal: AbortSignal
  readonly check: () => void
  readonly run: <T>(start: () => Promise<T>, discard?: (value: T) => void) => Promise<T>
  readonly finish: () => void
}

export function createImageInputTasks(changed: (busy: boolean) => void) {
  let disposed = false
  let active: { cancel: () => void } | undefined

  function start(target: ImageInputTarget): ImageInputTask | undefined {
    if (disposed || active !== undefined || !target.isCurrent())
      return undefined
    const controller = new AbortController()
    let finished = false
    let unsubscribe = (): void => {}
    const slot = { cancel }
    const finish = (): void => {
      if (finished)
        return
      finished = true
      unsubscribe()
      if (active === slot) {
        active = undefined
        changed(false)
      }
    }
    function cancel(): void {
      controller.abort(new DOMException('图片操作已取消', 'AbortError'))
      finish()
    }
    const check = (): void => {
      if (finished || !target.isCurrent())
        cancel()
      controller.signal.throwIfAborted()
    }
    active = slot
    changed(true)
    try {
      const remove = target.subscribe(() => {
        if (!target.isCurrent())
          cancel()
      })
      if (finished)
        remove()
      else
        unsubscribe = remove
      if (finished || !target.isCurrent()) {
        cancel()
        return undefined
      }
    }
    catch (error) {
      cancel()
      throw error
    }
    return {
      signal: controller.signal,
      check,
      run: async <T>(operation: () => Promise<T>, discard?: (value: T) => void): Promise<T> => {
        check()
        const value = await runImageTask(controller.signal, operation, discard)
        try {
          check()
        }
        catch (error) {
          discard?.(value)
          throw error
        }
        return value
      },
      finish,
    }
  }
  return {
    busy: () => active !== undefined,
    start,
    cancel: () => active?.cancel(),
    dispose: () => {
      disposed = true
      active?.cancel()
    },
  }
}
