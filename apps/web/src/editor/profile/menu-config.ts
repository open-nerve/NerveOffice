// 编辑模式隐藏的菜单项（插件档案 v1 §5.1，P4 设计 §3.6.8）。
// 菜单配置是全局的：各 UI 插件的菜单合并成一份，按菜单项的 id 生效；工厂返回了菜单项时认它的 id，
// 不是 schema 里的键（ui/src/services/menu/menu-manager.service.ts:375 `menuConfig?.[item?.id ?? key]`），
// 所以右键菜单与工具栏的超链接各写一项。
// 隐藏菜单不会停用命令与快捷键，M5 之前不开放的入口另由命令守卫取消（entry-guards.ts）
import type { MenuConfig } from '@univerjs/ui'

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

export const HIDDEN_MENU_ITEMS: readonly HiddenMenuItem[] = [...PROTECTION_MENU_ITEMS, ...UNSUPPORTED_MENU_ITEMS, ...BEFORE_M5_MENU_ITEMS]

/** 编辑模式的菜单配置，交给 UniverUIPlugin 的 menu。阅读模式的配置在 M3 */
export function sheetEditMenuConfig(): MenuConfig {
  return Object.fromEntries(HIDDEN_MENU_ITEMS.map(item => [item.id, { hidden: true }]))
}
