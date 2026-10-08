// 用户的输入还没写进模型（Codex 评审 CX4，M3-P6 设计 §3.13）：适配层把单元格编辑器里的（cell-editing-watch.ts）与面板防抖中的
// （panel-debounce-watch.ts）合成一个状态交出去。保存的状态机只依赖它算未保存、页头与离开提示，不用知道单元格编辑器、面板的 DOM 标记
// 与 SDK 的防抖时长；写进模型之后由修改序号接着算。原来保存的状态机只看单元格编辑器，面板防抖的这一段它看不到：页头说"已保存到云端"、
// 离开不提示，离开就丢（CX4）。
// 通知只在"有没有还没写进模型的输入"（pending）变了时发：开始与结束各一次，两样输入先后、重叠时合成一次。单元格编辑器只是打开、关上
// （none 与 open 之间）不通知：它只影响离开提示，离开提示在离开的那一刻现读。
import type { CellEditingWatch } from './cell-editing-watch.ts'
import type { PanelDebounceWatch } from './panel-debounce-watch.ts'

/**
 * 用户的输入还没写进模型：
 * - pending：有还没写进模型的输入——单元格编辑器里改动了、还没提交（回车之后、写入之前也算，Codex 评审 CX6），或者批注浮层、
 *   数据验证面板里按 SDK 的防抖还没写进去的。页头算有未保存的修改，离开提示拦下；
 * - open：没有这样的输入，单元格编辑器开着（只是打开：双击、F2、点编辑栏）。页头不算修改，离开提示照样拦下（宁可多提示一次，ADR-010）；
 * - none：都没有。
 */
export type UncommittedInput = 'none' | 'open' | 'pending'

export interface UncommittedInputSources {
  /** 单元格编辑器开着（问工作簿） */
  readonly cellEditorOpen: () => boolean
  /** 单元格编辑器里还没提交的输入 */
  readonly cellInput: Pick<CellEditingWatch, 'hasPendingInput' | 'onChange'>
  /** 面板里防抖中的输入 */
  readonly panelInput: Pick<PanelDebounceWatch, 'pending' | 'onChange'>
}

export interface UncommittedInputWatch {
  readonly current: () => UncommittedInput
  /** 有没有还没写进模型的输入（pending）变了：开始与结束各通知一次 */
  readonly onChange: (listener: () => void) => () => void
  readonly dispose: () => void
}

export function watchUncommittedInput(sources: UncommittedInputSources): UncommittedInputWatch {
  const { cellEditorOpen, cellInput, panelInput } = sources
  const listeners = new Set<() => void>()
  const pendingNow = (): boolean => cellInput.hasPendingInput() || panelInput.pending()
  let pending = pendingNow()

  // 单元格的那一样在 SDK 执行命令的过程中同步到达：监听者的异常一律接住、交给浏览器的错误报告，不打断命令，也不妨碍别的监听者
  const onSourceChange = (): void => {
    const next = pendingNow()
    if (next === pending)
      return
    pending = next
    for (const listener of [...listeners]) {
      try {
        listener()
      }
      catch (error) {
        reportError(error)
      }
    }
  }
  const unsubscribes = [cellInput.onChange(onSourceChange), panelInput.onChange(onSourceChange)]

  return {
    current: () => pendingNow() ? 'pending' : cellEditorOpen() ? 'open' : 'none',
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      listeners.clear()
      for (const unsubscribe of unsubscribes.splice(0))
        unsubscribe()
    },
  }
}
