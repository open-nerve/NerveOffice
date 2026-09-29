// 隐藏的菜单项（插件档案 v1 §5.1、§5.2，P4 设计 §3.6.8，M2-P3 设计 §3.4）：两种打开方式都隐藏的，与只读时另外隐藏的。
// 菜单配置是全局的：各 UI 插件的菜单合并成一份，按菜单项的 id 生效；工厂返回了菜单项时认它的 id，
// 不是 schema 里的键（ui/src/services/menu/menu-manager.service.ts:375 `menuConfig?.[item?.id ?? key]`），
// 所以右键菜单与工具栏的超链接各写一项。
// 隐藏菜单不会停用命令与快捷键，M5 之前不开放的入口另由命令守卫取消（entry-guards.ts），只读时的改动由只读守卫取消（read-only/）
import type { MenuConfig } from '@univerjs/ui'
import type { EditorAccess } from '../editor-access.ts'

export interface HiddenMenuItem {
  readonly id: string
  /** 菜单项或它的命令定义的位置（refer/univer，v1.0.0） */
  readonly source: string
}

/** 保护：保护规则在本平台不是安全边界，保护类资源必须为空（插件档案 v1 §3、§5.1） */
export const PROTECTION_MENU_ITEMS: readonly HiddenMenuItem[] = [
  { id: 'sheet.command.add-range-protection-from-toolbar', source: 'sheets-ui/src/commands/commands/range-protection.command.ts:38（工具栏）' },
  { id: 'sheet.contextMenu.permission', source: 'sheets-ui/src/menu/permission.menu.ts:47（右键的父菜单）' },
  { id: 'sheet.command.add-range-protection-from-context-menu', source: 'sheets-ui/src/commands/commands/range-protection.command.ts:48（右键）' },
  { id: 'sheet.command.set-range-protection-from-context-menu', source: 'sheets-ui/src/commands/commands/range-protection.command.ts:141（右键）' },
  { id: 'sheet.command.delete-range-protection-from-context-menu', source: 'sheets-ui/src/commands/commands/range-protection.command.ts:88（右键）' },
  { id: 'sheet.command.view-sheet-permission-from-context-menu', source: 'sheets-ui/src/commands/commands/range-protection.command.ts:58（右键）' },
  { id: 'sheet.command.add-range-protection-from-sheet-bar', source: 'sheets-ui/src/commands/commands/range-protection.command.ts:68（工作表标签）' },
  { id: 'sheet.command.delete-worksheet-protection-from-sheet-bar', source: 'sheets-ui/src/commands/commands/worksheet-protection.command.ts:25（工作表标签）' },
  { id: 'sheet.command.change-sheet-protection-from-sheet-bar', source: 'sheets-ui/src/commands/commands/worksheet-protection.command.ts:69（工作表标签）' },
  { id: 'sheet.command.view-sheet-permission-from-sheet-bar', source: 'sheets-ui/src/commands/commands/range-protection.command.ts:78（工作表标签）' },
]

/** 本期目标能力之外：工作表背景图片（插件档案 v1 §5.1）；父菜单隐藏后子项仍能被功能搜索找到，子项一并隐藏 */
export const UNSUPPORTED_MENU_ITEMS: readonly HiddenMenuItem[] = [
  { id: 'sheet.menu.worksheet-background-image', source: 'sheets-drawing-ui/src/menu/worksheet-background-image.menu.ts:40（视图 → 显示）' },
  { id: 'sheet.command.add-worksheet-background-image', source: 'sheets-drawing-ui/src/menu/schema.ts（子项）' },
  { id: 'sheet.command.delete-worksheet-background-image', source: 'sheets-drawing-ui/src/menu/schema.ts（子项）' },
]

/**
 * M5 之前不开放的入口（M1 总设计 §2.1、P4 设计 §3.6.8）：M1 不替换图片服务，SDK 默认把图片存成 data URL（M0-P4 报告 §2.2）；
 * 超链接的地址白名单在 M5。依据是计划书 §4.1"编辑器能力不足时，不显示用不了的按钮"
 */
export const BEFORE_M5_MENU_ITEMS: readonly HiddenMenuItem[] = [
  { id: 'sheet.menu.image', source: 'sheets-drawing-ui/src/menu/image.menu.ts:30（插入 → 媒体 → 图片的父菜单）' },
  { id: 'sheet.command.insert-float-image', source: 'sheets-drawing-ui/src/menu/schema.ts（子项：插入浮动图片）' },
  { id: 'sheet.command.insert-cell-image', source: 'sheets-drawing-ui/src/menu/schema.ts（子项：插入单元格图片）' },
  { id: 'sheet.command.save-cell-images', source: 'sheets-drawing-ui/src/menu/schema.ts（右键：保存单元格图片）' },
  { id: 'sheet.operation.insert-hyper-link-toolbar', source: 'sheets-hyper-link-ui/src/menu/menu.ts:150（工具栏的插入链接）' },
  { id: 'sheet.operation.insert-hyper-link', source: 'sheets-hyper-link-ui/src/menu/menu.ts:138（右键的插入链接：schema 的键是工具栏的 id，工厂返回的 id 是这一个）' },
]

/** 两种打开方式都隐藏的菜单项 */
export const HIDDEN_MENU_ITEMS: readonly HiddenMenuItem[] = [...PROTECTION_MENU_ITEMS, ...UNSUPPORTED_MENU_ITEMS, ...BEFORE_M5_MENU_ITEMS]

/**
 * 只读时另外隐藏的：工作表标签右键菜单里改动工作簿结构的 5 项（删除、复制、改名、标签颜色、隐藏；插件档案 v1 §5.2，M0 的 ui-config.ts:40-46）。
 * 只读时右键菜单已经整体关掉（sheet-profile.ts），这 5 项隐藏是档案的约定：以后打开右键菜单时不会漏掉它们。
 * 它们的命令另由只读守卫的防火墙取消
 */
export const READ_ONLY_MENU_ITEMS: readonly HiddenMenuItem[] = [
  { id: 'sheet.command.remove-sheet-confirm', source: 'sheets-ui/src/menu/sheet.menu.ts:43（工作表标签：删除；命令在 commands/commands/remove-sheet-confirm.command.ts:41）' },
  { id: 'sheet.command.copy-sheet', source: 'sheets-ui/src/menu/sheet.menu.ts:81（工作表标签：复制；命令在 sheets 的 commands/commands/copy-worksheet.command.ts:148）' },
  { id: 'sheet.operation.rename-sheet', source: 'sheets-ui/src/menu/sheet.menu.ts:91（工作表标签：重命名；操作在 commands/operations/rename-sheet.operation.ts:27）' },
  { id: 'sheet.command.set-tab-color', source: 'sheets-ui/src/menu/sheet.menu.ts:101（工作表标签：标签颜色；命令在 sheets 的 commands/commands/set-tab-color.command.ts:30）' },
  { id: 'sheet.command.set-worksheet-hidden', source: 'sheets-ui/src/menu/sheet.menu.ts:119（工作表标签：隐藏；命令在 sheets 的 commands/commands/set-worksheet-hide.command.ts:42）' },
]

/** 按打开方式的菜单配置，交给 UniverUIPlugin 的 menu：两种方式都隐藏 HIDDEN_MENU_ITEMS，只读时另外隐藏 READ_ONLY_MENU_ITEMS */
export function sheetMenuConfig(access: EditorAccess): MenuConfig {
  const hidden = access === 'read' ? [...HIDDEN_MENU_ITEMS, ...READ_ONLY_MENU_ITEMS] : HIDDEN_MENU_ITEMS
  return Object.fromEntries(hidden.map(item => [item.id, { hidden: true }]))
}
