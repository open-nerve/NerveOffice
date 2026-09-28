// 单元格编辑器里还没提交的输入（Codex 评审 CX6）：A14 要求一有修改，页头立即显示"有未保存的修改"，正在编辑、还没回车的内容也是修改。
// 它还不在工作簿里（作用于单元格编辑器自己的文档），修改序号不计它（P4 设计 §3.7.2），这里单独跟踪。
// 用 Facade 的 SheetEditStarted、SheetEditChanging、SheetEditEnded（公开 API，sheets-ui 的 facade/f-univer.ts）：
// - 键入字符或退格开始编辑（键盘开始，F2 除外）：SDK 先换掉编辑中的内容（editing.render-controller.ts 的 clearAndEdit），已经是输入；
// - 双击、F2、点编辑栏开始编辑：只是打开，编辑中的内容改动（SheetEditChanging，编辑栏里的输入也同步到单元格编辑器）之后才算；
// - 按 Esc 放弃：立即没有。回车提交：写入单元格是本文档的修改，由变更检测计入。写入通常在结束事件之前同步完成；
//   跨工作表的提交在 SDK 里是异步的（_handleEditorInvisible 先 await 切换工作表），所以再过一个宏任务才清掉，
//   页头不会在写入之前闪一下"已保存到云端"。
// 离开提示仍按"单元格编辑器开着"判断（isCellEditing），宁可多提示一次。
// 这里的回调在 SDK 的命令执行过程中同步调用，抛出的异常会打断命令，所以一律接住、交给浏览器的错误报告
import type { FUniver } from '@univerjs/core/facade'
import { DeviceInputEventType } from '@univerjs/engine-render'
import { KeyCode } from '@univerjs/ui'

export interface CellEditingWatch {
  /** 单元格编辑器里有还没提交的输入 */
  readonly hasPendingInput: () => boolean
  /** 有没有还没提交的输入变了 */
  readonly onChange: (listener: () => void) => () => void
  readonly dispose: () => void
}

interface EditEvent {
  readonly workbook: { readonly getId: () => string }
}

/** 必须在创建工作簿之前挂上（与变更检测相同）：Facade 的编辑事件在第一次订阅时才注册 */
export function watchCellEditing(univerAPI: FUniver, unitId: string): CellEditingWatch {
  const listeners = new Set<() => void>()
  let pending = false
  /** 回车提交之后，等一个宏任务再清掉（见文件开头） */
  let clearing: ReturnType<typeof setTimeout> | undefined

  const set = (next: boolean): void => {
    if (clearing !== undefined) {
      clearTimeout(clearing)
      clearing = undefined
    }
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

  const ours = (event: EditEvent): boolean => event.workbook.getId() === unitId
  const guarded = <T extends EditEvent>(handle: (event: T) => void) => (event: T): void => {
    try {
      if (ours(event))
        handle(event)
    }
    catch (error) {
      reportError(error)
    }
  }

  const subscriptions = [
    univerAPI.addEvent(univerAPI.Event.SheetEditStarted, guarded((event) => {
      set(event.eventType === DeviceInputEventType.Keyboard && event.keycode !== KeyCode.F2)
    })),
    univerAPI.addEvent(univerAPI.Event.SheetEditChanging, guarded(() => set(true))),
    univerAPI.addEvent(univerAPI.Event.SheetEditEnded, guarded((event) => {
      if (!event.isConfirm) {
        set(false)
      }
      else if (pending && clearing === undefined) {
        clearing = setTimeout(() => {
          clearing = undefined
          set(false)
        }, 0)
      }
    })),
  ]

  return {
    hasPendingInput: () => pending,
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      listeners.clear()
      if (clearing !== undefined)
        clearTimeout(clearing)
      for (const subscription of subscriptions)
        subscription.dispose()
    },
  }
}
