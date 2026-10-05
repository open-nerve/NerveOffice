// 组合输入（输入法组字，00 号计划书 §7.3，M3-P4 设计 §3.6）：组字中不捕获——表格里组字时写模型的有批注的输入框（300 ms 防抖的
// SheetUpdateNoteCommand，sheets-note-ui 的 views/Note.tsx:110-143），组字停住 300 ms 就把拼音写进批注、变更检测算修改。
// 只用 DOM 事件、不认 SDK 的 DOM 标记，所以批注的输入框、单元格编辑器、编辑栏与各种面板都盖得到：在 document 上以捕获阶段监听
// compositionstart、compositionend（早于 SDK 自己的处理；交互屏障挂着时它在窗口的捕获阶段就拦下了，这里收不到，那时也不能输入）。
// - 组字的元素失焦（focusout）与页面隐藏时复位：浏览器在这两种情况下不一定派发 compositionend，不复位的话会一直"组字中"；
// - 目标在页面自己的界面里的不算（编辑器页的页头，ignoreWithin）：那里的输入不进表格。分享对话框挂在 body 下（Radix 的 Portal），
//   不在页头里，在它的输入框里组字照样算组字中——只是让捕获等到上限（3 秒，从第一处没捕获的修改算起），不影响正确性；
// - 真实输入法在自动化里驱动不了：E2E 用 CDP 的 Input.imeSetComposition（Chromium 内核）与合成事件，真实输入法是人工核对的盲区。
// 结束（含复位）时通知：自动保存从这一刻起算捕获的静默（capture-policy.ts）。

export interface CompositionWatch {
  /** 正在组字 */
  readonly composing: () => boolean
  /** 组字开始或结束（组字的元素失焦、页面隐藏时的复位也算结束） */
  readonly onChange: (listener: () => void) => () => void
  readonly dispose: () => void
}

export interface CompositionWatchOptions {
  /** 目标在它里面的组字不算（编辑器页的页头）；没有时都算 */
  readonly ignoreWithin?: Node | undefined
}

export function watchComposition(target: Document, options: CompositionWatchOptions = {}): CompositionWatch {
  const listeners = new Set<() => void>()
  /** 正在组字的元素；没有组字时为 undefined */
  let composingTarget: EventTarget | undefined

  const ignored = (eventTarget: EventTarget | null): boolean => eventTarget instanceof Node && options.ignoreWithin?.contains(eventTarget) === true

  const set = (next: EventTarget | undefined): void => {
    const changed = (next === undefined) !== (composingTarget === undefined)
    composingTarget = next
    if (!changed)
      return
    for (const listener of [...listeners]) {
      try {
        listener()
      }
      catch (error) {
        reportError(error)
      }
    }
  }

  const onStart = (event: Event): void => {
    if (!ignored(event.target))
      set(event.target ?? target)
  }
  const onEnd = (event: Event): void => {
    if (!ignored(event.target))
      set(undefined)
  }
  // 组字的元素（或包着它的元素）失去焦点：输入法的组字随之中止，有的浏览器不再派发 compositionend
  const onFocusOut = (event: Event): void => {
    if (composingTarget instanceof Node && event.target instanceof Node && event.target.contains(composingTarget))
      set(undefined)
  }
  const onVisibility = (): void => {
    if (target.visibilityState === 'hidden')
      set(undefined)
  }

  target.addEventListener('compositionstart', onStart, { capture: true })
  target.addEventListener('compositionend', onEnd, { capture: true })
  target.addEventListener('focusout', onFocusOut, { capture: true })
  target.addEventListener('visibilitychange', onVisibility)

  return {
    composing: () => composingTarget !== undefined,
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      listeners.clear()
      composingTarget = undefined
      target.removeEventListener('compositionstart', onStart, { capture: true })
      target.removeEventListener('compositionend', onEnd, { capture: true })
      target.removeEventListener('focusout', onFocusOut, { capture: true })
      target.removeEventListener('visibilitychange', onVisibility)
    },
  }
}
