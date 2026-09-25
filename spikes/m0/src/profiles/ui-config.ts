// 插件档案的界面配置（P3）：按编辑 / 阅读模式隐藏菜单入口（00 号计划书 §6.5）。
// 菜单配置是全局的（各 UI 插件的 menu 合并到同一个配置），按菜单项 id、功能区标签或分组的 key 生效。
import type { MenuConfig } from '@univerjs/ui';

export interface UiOptions {
    menu: MenuConfig;
    /** 表格底栏的"新增工作表"按钮（它不是菜单项，只能用 UniverSheetsUIPlugin 的 footer 配置隐藏）。 */
    addSheetButton: boolean;
    /** 工具栏与右键菜单（UniverUIPlugin 的 toolbar、contextMenu）：阅读模式整体关掉，而不是逐项隐藏。 */
    toolbar: boolean;
    contextMenu: boolean;
    /** 表格底栏的菜单（网格线开关等，UniverSheetsUIPlugin 的 footer.menus）：网格线会写进快照，阅读模式关掉。 */
    footerMenus: boolean;
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

/** 原地进入阅读模式时，在运行时隐藏的菜单项：工作表标签菜单里的结构性操作，以及底栏的网格线开关（它会写进快照）。 */
export const SHEET_READ_MODE_RUNTIME_MENUS = [...SHEET_READ_MODE_MENUS, 'sheet.command.toggle-gridlines'] as const;

export const sheetUi = {
    edit: { menu: hide([...SHEET_PROTECTION_MENUS, ...SHEET_UNSUPPORTED_MENUS]), addSheetButton: true, toolbar: true, contextMenu: true, footerMenus: true },
    read: { menu: hide([...SHEET_PROTECTION_MENUS, ...SHEET_UNSUPPORTED_MENUS, ...SHEET_READ_MODE_MENUS]), addSheetButton: false, toolbar: false, contextMenu: false, footerMenus: false },
} satisfies Record<'edit' | 'read', UiOptions>;

/**
 * 文字文档本期不提供的入口（00 号计划书 §4.3）：
 * - 形状（P4）：写入 SVG 的 data URL，平台配置下会被命令守卫取消；父菜单隐藏后子项仍能被功能搜索找到，子项一并隐藏（P5 审查 G6）；
 * - 页面设置（P5）：MODERN 版式下是"内容宽度"，并且会改写 documentFlavor；
 * - 页眉页脚、分隔符（分栏符、各类分节符）、分节设置（P5）：MODERN 版式下 SDK 已自动隐藏，平台显式隐藏，不依赖 SDK 的判断；
 * - 浮动图片的组合、层级、多图对齐（P5 审查 G9）：§4.3 之外，没有验证。
 * 隐藏菜单不会停用命令与快捷键，平台另用命令守卫取消会写入不支持内容的命令（src/harness/doc-policy.ts）。
 * 目录块插件不注册（P5），它的入口随之消失；"目录"由只读的大纲侧栏提供。
 */
export const DOC_UNSUPPORTED_MENUS = [
    'doc.command.menu-insert-shape',
    'doc.command.menu-insert-shape.below',
    'doc.command.insert-float-shape.rectangle',
    'doc.command.insert-float-shape.ellipse',
    'doc.command.insert-float-shape.rectangle.below',
    'doc.command.insert-float-shape.ellipse.below',
    'drawing.operation.set-drawing-group',
    'drawing.operation.cancel-drawing-group',
    'drawing.operation.set-drawing-arrange-front',
    'drawing.operation.set-drawing-arrange-back',
    'drawing.operation.set-drawing-arrange-forward',
    'drawing.operation.set-drawing-arrange-backward',
    'sheet.operation.set-drawing-align-left',
    'sheet.operation.set-drawing-align-center',
    'sheet.operation.set-drawing-align-right',
    'sheet.operation.set-drawing-align-top',
    'sheet.operation.set-drawing-align-middle',
    'sheet.operation.set-drawing-align-bottom',
    'sheet.operation.set-drawing-align-horizon',
    'sheet.operation.set-drawing-align-vertical',
    'docs.operation.open-page-setting',
    'doc.command.open-header-footer-panel',
    'doc.menu.breaks',
    'docs.operation.insert-column-break',
    'doc.menu.section-break.next-page',
    'doc.menu.section-break.continuous',
    'doc.menu.section-break.next-column',
    'doc.menu.section-break.even-page',
    'doc.menu.section-break.odd-page',
    'sidebar.operation.doc-section-setting-panel',
] as const;

/** 文字文档：开源版没有保护相关的菜单。 */
export const docUi = {
    edit: { menu: hide(DOC_UNSUPPORTED_MENUS), addSheetButton: false, toolbar: true, contextMenu: true, footerMenus: false },
    read: { menu: hide(DOC_UNSUPPORTED_MENUS), addSheetButton: false, toolbar: false, contextMenu: false, footerMenus: false },
} satisfies Record<'edit' | 'read', UiOptions>;
