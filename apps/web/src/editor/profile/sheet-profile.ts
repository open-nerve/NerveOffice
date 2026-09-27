// 表格插件档案 sheet@1（插件档案 v1 §1，P4 设计 §3.6.2）。
// 档案是数据：插件清单、注册顺序、影响数据的配置、声明的资源名都集中在这里；
// 增删插件、改影响数据的配置、升级 SDK 都按数据格式变更处理（00 号计划书 §8.7），先做保存重开回归。
// 插件按组注册，组内与组间的顺序按官方 preset；不注册 @univerjs/network、评论、水印、table、十字高亮等，不注册任何遥测实现
import type { PluginEntry } from './plugin-entry.ts'
import { UniverDataValidationPlugin } from '@univerjs/data-validation'
import { UniverDocsPlugin } from '@univerjs/docs'
import { UniverDocsDrawingPlugin } from '@univerjs/docs-drawing'
import { UniverDocsUIPlugin } from '@univerjs/docs-ui'
import { UniverDrawingPlugin } from '@univerjs/drawing'
import { UniverDrawingUIPlugin } from '@univerjs/drawing-ui'
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula'
import { UniverRenderEnginePlugin } from '@univerjs/engine-render'
import { UniverFindReplacePlugin } from '@univerjs/find-replace'
import { UniverRPCMainThreadPlugin } from '@univerjs/rpc'
import { UniverSheetsPlugin } from '@univerjs/sheets'
import { UniverSheetsConditionalFormattingPlugin } from '@univerjs/sheets-conditional-formatting'
import { UniverSheetsConditionalFormattingUIPlugin } from '@univerjs/sheets-conditional-formatting-ui'
import { UniverSheetsDataValidationPlugin } from '@univerjs/sheets-data-validation'
import { UniverSheetsDataValidationUIPlugin } from '@univerjs/sheets-data-validation-ui'
import { UniverSheetsDrawingPlugin } from '@univerjs/sheets-drawing'
import { UniverSheetsDrawingUIPlugin } from '@univerjs/sheets-drawing-ui'
import { UniverSheetsFilterPlugin } from '@univerjs/sheets-filter'
import { UniverSheetsFilterUIPlugin } from '@univerjs/sheets-filter-ui'
import { UniverSheetsFindReplacePlugin } from '@univerjs/sheets-find-replace'
import { UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula'
import { UniverSheetsFormulaUIPlugin } from '@univerjs/sheets-formula-ui'
import { UniverSheetsHyperLinkPlugin } from '@univerjs/sheets-hyper-link'
import { UniverSheetsHyperLinkUIPlugin } from '@univerjs/sheets-hyper-link-ui'
import { UniverSheetsNotePlugin } from '@univerjs/sheets-note'
import { UniverSheetsNoteUIPlugin } from '@univerjs/sheets-note-ui'
import { UniverSheetsNumfmtPlugin } from '@univerjs/sheets-numfmt'
import { UniverSheetsNumfmtUIPlugin } from '@univerjs/sheets-numfmt-ui'
import { UniverSheetsSortPlugin } from '@univerjs/sheets-sort'
import { UniverSheetsSortUIPlugin } from '@univerjs/sheets-sort-ui'
import { UniverSheetsUIPlugin } from '@univerjs/sheets-ui'
import { UniverUIPlugin } from '@univerjs/ui'
import { sheetEditMenuConfig } from './menu-config.ts'
import { pluginEntry } from './plugin-entry.ts'

/** 插件档案的标识与版本，写进平台的元数据（00 号计划书 §8.1） */
export const SHEET_PROFILE_ID = 'sheet@1'

export interface SheetProfileContext {
  /** 编辑器挂载的容器 */
  readonly container: HTMLElement
  /** 公式 Worker：由适配层以模块 Worker 创建后传入；插件不负责终止传入的实例（rpc/src/plugin.ts:74-87） */
  readonly formulaWorker: Worker
}

export interface PluginGroup {
  readonly id: string
  /** 这一组写进工作簿快照的资源名（插件档案 v1 §3；运行时以注册的资源 hook 为准，E2E 核对） */
  readonly resources: readonly string[]
  readonly plugins: (context: SheetProfileContext) => readonly PluginEntry[]
}

/** 公式在 Worker 里计算（插件档案 v1 §1，M0-P3 报告 §6.3）：主线程的引擎、表格与表格公式都不执行公式 */
const NOT_EXECUTE_FORMULA = true

export const SHEET_PLUGIN_GROUPS: readonly PluginGroup[] = [
  {
    // 与官方 UniverSheetsCorePreset 相同，但不注册 UniverNetworkPlugin（除它自身外没有插件使用 IHTTPService）。
    // 不再声明 SHEET_AuthzIoMockService_PLUGIN：身份替换之后本地授权服务不再构造，它注册的这项资源随之消失（P4 设计 §3.6.9）
    id: 'core',
    resources: [
      'SHEET_DEFINED_NAME_PLUGIN',
      'SHEET_RANGE_THEME_MODEL_PLUGIN',
      'SHEET_RANGE_PROTECTION_PLUGIN',
      'SHEET_WORKSHEET_PROTECTION_PLUGIN',
      'SHEET_WORKSHEET_PROTECTION_POINT_PLUGIN',
    ],
    plugins: ({ container, formulaWorker }) => [
      pluginEntry(UniverDocsPlugin),
      pluginEntry(UniverRenderEnginePlugin),
      pluginEntry(UniverUIPlugin, { container, menu: sheetEditMenuConfig() }),
      pluginEntry(UniverDocsUIPlugin),
      // 传 Worker 实例：传地址时插件会建一个不带 type: 'module' 的经典 Worker（rpc/src/plugin.ts:86）
      pluginEntry(UniverRPCMainThreadPlugin, { workerURL: formulaWorker }),
      pluginEntry(UniverFormulaEnginePlugin, { notExecuteFormula: NOT_EXECUTE_FORMULA }),
      // onlyRegisterFormulaRelatedMutations 的类型只允许 true，官方 preset 写的 false 等同于不写，这里不写。
      // 关掉大表操作的拆分：复制大表同步执行，立即捕获也完整（插件档案 v1 §1，M0-P3 报告 §2.2）
      pluginEntry(UniverSheetsPlugin, {
        notExecuteFormula: NOT_EXECUTE_FORMULA,
        largeSheetOperation: { largeSheetCellCountThreshold: Number.MAX_SAFE_INTEGER },
      }),
      pluginEntry(UniverSheetsUIPlugin),
    ],
  },
  {
    id: 'numfmt',
    resources: [],
    plugins: () => [pluginEntry(UniverSheetsNumfmtPlugin), pluginEntry(UniverSheetsNumfmtUIPlugin)],
  },
  {
    id: 'formula',
    resources: [],
    plugins: () => [
      pluginEntry(UniverSheetsFormulaPlugin, { notExecuteFormula: NOT_EXECUTE_FORMULA }),
      pluginEntry(UniverSheetsFormulaUIPlugin),
    ],
  },
  {
    // 浮动图片写进资源；单元格图片存在单元格的富文本里
    id: 'drawing',
    resources: ['SHEET_DRAWING_PLUGIN'],
    plugins: () => [
      pluginEntry(UniverDrawingPlugin),
      pluginEntry(UniverDocsDrawingPlugin),
      pluginEntry(UniverDrawingUIPlugin),
      pluginEntry(UniverSheetsDrawingPlugin),
      pluginEntry(UniverSheetsDrawingUIPlugin),
    ],
  },
  {
    id: 'cf',
    resources: ['SHEET_CONDITIONAL_FORMATTING_PLUGIN'],
    plugins: () => [pluginEntry(UniverSheetsConditionalFormattingPlugin), pluginEntry(UniverSheetsConditionalFormattingUIPlugin)],
  },
  {
    id: 'filter',
    resources: ['SHEET_FILTER_PLUGIN'],
    plugins: () => [pluginEntry(UniverSheetsFilterPlugin), pluginEntry(UniverSheetsFilterUIPlugin)],
  },
  {
    // 超链接存在单元格富文本的 customRanges 里，不走资源
    id: 'hyperlink',
    resources: [],
    plugins: () => [pluginEntry(UniverSheetsHyperLinkPlugin), pluginEntry(UniverSheetsHyperLinkUIPlugin)],
  },
  {
    id: 'dv',
    resources: ['SHEET_DATA_VALIDATION_PLUGIN'],
    plugins: () => [
      pluginEntry(UniverDataValidationPlugin),
      pluginEntry(UniverSheetsDataValidationPlugin),
      pluginEntry(UniverSheetsDataValidationUIPlugin),
    ],
  },
  {
    id: 'find-replace',
    resources: [],
    plugins: () => [pluginEntry(UniverFindReplacePlugin), pluginEntry(UniverSheetsFindReplacePlugin)],
  },
  {
    id: 'note',
    resources: ['SHEET_NOTE_PLUGIN'],
    plugins: () => [pluginEntry(UniverSheetsNotePlugin), pluginEntry(UniverSheetsNoteUIPlugin)],
  },
  {
    id: 'sort',
    resources: [],
    plugins: () => [pluginEntry(UniverSheetsSortPlugin), pluginEntry(UniverSheetsSortUIPlugin)],
  },
]

/** 按注册顺序展开的全部插件 */
export function sheetPluginEntries(context: SheetProfileContext): PluginEntry[] {
  return SHEET_PLUGIN_GROUPS.flatMap(group => group.plugins(context))
}

/** 档案声明的资源名（按名称排序）：快照的 resources 只应该有这些 */
export function declaredSheetResources(): string[] {
  return [...new Set(SHEET_PLUGIN_GROUPS.flatMap(group => group.resources))].sort()
}

/**
 * 变更检测的排除名单（插件档案 v1 §5.3）：类型声明为 MUTATION、实际只清除界面上的图片变换框。
 * 随 SDK 版本维护，由"打开不变脏"与"代表性的修改变脏"的 E2E 回归
 */
export const CHANGE_DETECTION_EXCLUDED_MUTATIONS: readonly string[] = ['sheet.operation.clear-drawing-transformer']
