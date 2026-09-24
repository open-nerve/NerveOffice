// 插件档案的界面配置（P3）：按编辑 / 阅读模式隐藏菜单入口（00 号计划书 §6.5）。
// 菜单配置是全局的（各 UI 插件的 menu 合并到同一个配置），按菜单项 id、功能区标签或分组的 key 生效。
import type { MenuConfig } from '@univerjs/ui';

export interface UiOptions {
    menu: MenuConfig;
    /** 表格底栏的"新增工作表"按钮（它不是菜单项，只能用 UniverSheetsUIPlugin 的 footer 配置隐藏）。 */
    addSheetButton: boolean;
}

const hide = (ids: readonly string[]): MenuConfig => Object.fromEntries(ids.map((id) => [id, { hidden: true }]));

/** 保护相关：保护规则在本平台不是安全边界，还会被真实用户身份"激活"（P2 报告 §2.5），全部隐藏。 */
export const SHEET_PROTECTION_MENUS = [
    'sheet.command.add-range-protection-from-toolbar',
    'sheet.contextMenu.permission',
    'sheet.command.add-range-protection-from-context-menu',
    'sheet.command.set-range-protection-from-context-menu',
    'sheet.command.delete-range-protection-from-context-menu',
    'sheet.command.view-sheet-permission-from-context-menu',
    'sheet.command.add-range-protection-from-sheet-bar',
    'sheet.command.delete-worksheet-protection-from-sheet-bar',
    'sheet.command.change-sheet-protection-from-sheet-bar',
    'sheet.command.view-sheet-permission-from-sheet-bar',
] as const;

/** 本期目标能力之外：工作表背景图片（"视图 → 显示"）。 */
export const SHEET_UNSUPPORTED_MENUS = [
    'sheet.menu.worksheet-background-image',
    'sheet.command.add-worksheet-background-image',
    'sheet.command.delete-worksheet-background-image',
] as const;

/** 阅读模式另外隐藏：工作表标签菜单里没有被权限检查覆盖、或会改动工作簿结构的入口。 */
export const SHEET_READ_MODE_MENUS = [
    'sheet.command.remove-sheet-confirm',
    'sheet.command.copy-sheet',
    'sheet.operation.rename-sheet',
    'sheet.command.set-tab-color',
    'sheet.command.set-worksheet-hidden',
] as const;

export const sheetUi = {
    edit: { menu: hide([...SHEET_PROTECTION_MENUS, ...SHEET_UNSUPPORTED_MENUS]), addSheetButton: true },
    read: { menu: hide([...SHEET_PROTECTION_MENUS, ...SHEET_UNSUPPORTED_MENUS, ...SHEET_READ_MODE_MENUS]), addSheetButton: false },
} satisfies Record<'edit' | 'read', UiOptions>;

/** 文字文档：开源版没有保护相关的菜单；不支持功能的入口由 P5 按能力矩阵补充。 */
export const docUi = {
    edit: { menu: {}, addSheetButton: false },
    read: { menu: {}, addSheetButton: false },
} satisfies Record<'edit' | 'read', UiOptions>;
