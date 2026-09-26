// M5 之前不开放的入口：命令守卫（P4 设计 §3.6.8）。
// 隐藏菜单不会停用命令与快捷键（例如超链接的 Ctrl/Cmd+K），粘贴图片文件也不经过菜单，所以这些命令在执行前取消。
// 用的是 Facade 的 BeforeCommandExecute（公开 API）：订阅者把 cancel 设为 true，命令不执行，也不进撤销栈（core 的 f-univer.ts:255-268）
import type { IDisposable } from '@univerjs/core'
import type { FUniver } from '@univerjs/core/facade'

export interface GuardedCommand {
  readonly id: string
  /** 命令定义的位置（refer/univer，v1.0.0）与取消它的原因 */
  readonly source: string
}

/** 图片：M1 不替换图片服务，SDK 默认把插入与粘贴的图片存成 data URL（M0-P4 报告 §2.2），M3、M5 的服务端校验会拒收这类快照 */
export const IMAGE_GUARDED_COMMANDS: readonly GuardedCommand[] = [
  { id: 'sheet.command.insert-float-image', source: 'sheets-drawing-ui/src/commands/commands/insert-image.command.ts:27（插入浮动图片；粘贴图片文件也经过它：controllers/sheet-drawing-copy-paste.controller.ts:208-222）' },
  { id: 'sheet.command.insert-cell-image', source: 'sheets-drawing-ui/src/commands/commands/insert-image.command.ts:55（插入单元格图片）' },
  { id: 'sheet.command.insert-sheet-image', source: 'sheets-drawing/src/commands/commands/insert-sheet-drawing.command.ts:37（底层的插入浮动图片，上面两条之外的调用方也经过它）' },
  { id: 'sheet.command.add-worksheet-background-image', source: 'sheets-drawing-ui/src/commands/commands/worksheet-background-image.command.ts:28（工作表背景图片：菜单已隐藏，同样写入图片数据）' },
]

/** 超链接：地址白名单在 M5（计划书 §11.3）。取消链接（cancel-hyper-link）只删除数据，不拦 */
export const HYPERLINK_GUARDED_COMMANDS: readonly GuardedCommand[] = [
  { id: 'sheet.operation.insert-hyper-link-toolbar', source: 'sheets-hyper-link-ui/src/commands/operations/popup.operations.ts:94（工具栏，快捷键 Ctrl/Cmd+K 绑定它：menu/menu.ts:156-160）' },
  { id: 'sheet.operation.insert-hyper-link', source: 'sheets-hyper-link-ui/src/commands/operations/popup.operations.ts:64（右键菜单）' },
  { id: 'sheet.operation.open-hyper-link-edit-panel', source: 'sheets-hyper-link-ui/src/commands/operations/popup.operations.ts:35（打开编辑面板，含已有链接的"编辑"）' },
  { id: 'sheets.command.add-hyper-link', source: 'sheets-hyper-link/src/commands/commands/add-hyper-link.command.ts:54' },
  { id: 'sheets.command.add-rich-hyper-link', source: 'sheets-hyper-link/src/commands/commands/add-hyper-link.command.ts:200（单元格编辑器里的链接）' },
  { id: 'sheets.command.update-hyper-link', source: 'sheets-hyper-link/src/commands/commands/update-hyper-link.command.ts:55' },
  { id: 'sheets.command.update-rich-hyper-link', source: 'sheets-hyper-link/src/commands/commands/update-hyper-link.command.ts:196' },
]

export const GUARDED_COMMANDS: readonly GuardedCommand[] = [...IMAGE_GUARDED_COMMANDS, ...HYPERLINK_GUARDED_COMMANDS]

const GUARDED_IDS: ReadonlySet<string> = new Set(GUARDED_COMMANDS.map(command => command.id))

export function isGuardedCommand(id: string): boolean {
  return GUARDED_IDS.has(id)
}

/** 在创建工作簿之前挂上：打开文档的过程中也不执行这些命令 */
export function installEntryGuards(univerAPI: FUniver): IDisposable {
  return univerAPI.addEvent(univerAPI.Event.BeforeCommandExecute, (event) => {
    if (isGuardedCommand(event.id))
      event.cancel = true
  })
}
