// 表格插件档案 sheet@1（插件档案 v1 §1，P4 设计 §3.6.2）。
// 档案是数据：插件清单、注册顺序、影响数据的配置、声明的资源名都集中在这里；
// 增删插件、改影响数据的配置、升级 SDK 都按数据格式变更处理（00 号计划书 §8.7），先做保存重开回归。
// 资源的白名单与规则在 contracts（documents/profile-resources.ts，服务端的快照检查共用，M3-P3 设计 §3.2）：各组按那里的名称声明资源
// （写错名字类型检查不通过），单元测试核对各组声明的合起来等于白名单。
// 插件按组注册，组内与组间的顺序按官方 preset；不注册 @univerjs/network、评论、水印、table、十字高亮等，不注册任何遥测实现。
// 界面的配置按这次的打开方式（EditorAccess）组合：只读时一开始就以只读的界面创建（插件档案 v1 §5.2 的"销毁重建"一栏，M2-P3 设计 §3.4）。
// 公式由谁执行按 FormulaExecution 组合（M3-P4 设计 §3.14）：生产用公式 Worker；主线程模式是同一份档案的变体（M4 的退路，M3 只给测试构建用）
import type { DocumentProfile, ProfileResourceName } from '@nerve-office/contracts'
import type { EditorAccess } from '../editor-access.ts'
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
import { sheetMenuConfig } from './menu-config.ts'
import { pluginEntry } from './plugin-entry.ts'

/** 插件档案的标识与版本，写进平台的元数据（00 号计划书 §8.1）；是 contracts 登记的档案之一 */
export const SHEET_PROFILE_ID = 'sheet@1' satisfies DocumentProfile

/**
 * 公式在哪里计算（插件档案 v1 §1，M0-P3 报告 §6.3，M3-P4 设计 §3.14）。两种都是 sheet@1：插件的组与顺序、资源、影响数据的配置相同，
 * 只差公式由谁执行，存下的数据一样（档案的标识不变）：
 * - worker（生产）：公式 Worker 由适配层以模块 Worker 创建后传入；插件不负责终止传入的实例（rpc/src/plugin.ts:74-87）；
 * - main-thread：主线程的引擎执行公式，不注册 RPC，让出间隔调到 MAIN_THREAD_FORMULA_INTERVAL_COUNT。这是 M0 推荐、M4 要用的退路
 *   （Worker 起不来时以它重建，计划书 §10.2、§13.2）；M3 里只有测试构建经地址参数选用它（US-M3-03 的两种模式），生产构建里没有开关
 */
export type FormulaExecution
  = | { readonly kind: 'worker', readonly worker: Worker }
    | { readonly kind: 'main-thread' }

export type FormulaMode = FormulaExecution['kind']

/**
 * 主线程模式下公式引擎每执行多少个公式让出一次主线程（UniverFormulaEnginePlugin 的 intervalCount，默认 500）：
 * M0-P3 报告 §3.3 第 5 条、§6.3——默认值时一次牵动约 320 个公式的修改冻结界面 0.66–0.83 秒，调到 20 降到 67–88 ms；
 * 让出时计算中的修改与 stop 也才有机会执行
 */
export const MAIN_THREAD_FORMULA_INTERVAL_COUNT = 20

export interface SheetProfileContext {
  /** 编辑器挂载的容器 */
  readonly container: HTMLElement
  /** 公式在哪里计算：只影响谁执行公式，不影响数据 */
  readonly formula: FormulaExecution
  /** 这次以什么方式打开：只影响界面的配置，不影响数据（插件、顺序、影响数据的配置与资源两种方式相同） */
  readonly access: EditorAccess
}

export interface PluginGroup {
  readonly id: string
  /** 这一组写进工作簿快照的资源名（插件档案 v1 §3，contracts 的白名单里的名称；运行时以注册的资源 hook 为准，P4 的打开自检核对） */
  readonly resources: readonly ProfileResourceName<typeof SHEET_PROFILE_ID>[]
  readonly plugins: (context: SheetProfileContext) => readonly PluginEntry[]
}

/**
 * 主线程的引擎、表格与表格公式这三处执不执行公式：Worker 模式下都不执行（插件档案 v1 §1，M0-P3 报告 §6.3），主线程模式下都执行。
 * 三处写明 true 或 false（不靠默认值），单元测试逐项核对
 */
function notExecuteFormula(formula: FormulaExecution): boolean {
  return formula.kind === 'worker'
}

/** 公式引擎的配置：主线程模式另把让出间隔调小 */
function formulaEngineConfig(formula: FormulaExecution): ConstructorParameters<typeof UniverFormulaEnginePlugin>[0] {
  return formula.kind === 'worker' ? { notExecuteFormula: true } : { notExecuteFormula: false, intervalCount: MAIN_THREAD_FORMULA_INTERVAL_COUNT }
}

type UIConfig = ConstructorParameters<typeof UniverUIPlugin>[0]
type SheetsUIConfig = ConstructorParameters<typeof UniverSheetsUIPlugin>[0]

/**
 * 界面插件的配置：挂到给定的容器，菜单按打开方式隐藏（menu-config.ts）。
 * 只读时关掉工具栏与右键菜单（整体关掉，不逐项隐藏）。编辑栏（header）保留：它显示当前单元格的内容，
 * 在编辑栏里的改动被权限点与只读守卫的防火墙拦住
 */
function uiConfig(container: HTMLElement, access: EditorAccess): UIConfig {
  const menu = sheetMenuConfig(access)
  return access === 'read' ? { container, menu, toolbar: false, contextMenu: false } : { container, menu }
}

/**
 * 表格界面插件的配置：能编辑时用默认配置。只读时关掉底栏的菜单（网格线开关会写进快照）、隐藏新增工作表按钮；
 * 底栏的其余部分（工作表标签、统计栏、缩放）照常显示：SDK 对 footer 的每一项分别取默认值，只传这两项不影响其他项
 * （sheets-ui 的 views/sheet-container/SheetContainer.tsx:55-60、views/sheet-bar/SheetBar.tsx:54-58）
 */
function sheetsUIConfig(access: EditorAccess): SheetsUIConfig | undefined {
  return access === 'read' ? { footer: { menus: false, addSheetButtonConfig: { show: false } } } : undefined
}

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
    plugins: ({ container, formula, access }) => [
      pluginEntry(UniverDocsPlugin),
      pluginEntry(UniverRenderEnginePlugin),
      pluginEntry(UniverUIPlugin, uiConfig(container, access)),
      pluginEntry(UniverDocsUIPlugin),
      // 传 Worker 实例：传地址时插件会建一个不带 type: 'module' 的经典 Worker（rpc/src/plugin.ts:86）。主线程模式不注册 RPC
      ...(formula.kind === 'worker' ? [pluginEntry(UniverRPCMainThreadPlugin, { workerURL: formula.worker })] : []),
      pluginEntry(UniverFormulaEnginePlugin, formulaEngineConfig(formula)),
      // onlyRegisterFormulaRelatedMutations 的类型只允许 true，官方 preset 写的 false 等同于不写，这里不写。
      // 关掉大表操作的拆分：复制大表同步执行，立即捕获也完整（插件档案 v1 §1，M0-P3 报告 §2.2）
      pluginEntry(UniverSheetsPlugin, {
        notExecuteFormula: notExecuteFormula(formula),
        largeSheetOperation: { largeSheetCellCountThreshold: Number.MAX_SAFE_INTEGER },
      }),
      pluginEntry(UniverSheetsUIPlugin, sheetsUIConfig(access)),
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
    plugins: ({ formula }) => [
      pluginEntry(UniverSheetsFormulaPlugin, { notExecuteFormula: notExecuteFormula(formula) }),
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

/** 档案声明的资源名（按名称排序）：快照的 resources 只应该有这些（等于 contracts 的白名单，单元测试核对） */
export function declaredSheetResources(): string[] {
  return [...new Set<string>(SHEET_PLUGIN_GROUPS.flatMap(group => group.resources))].sort()
}

/**
 * 变更检测的排除名单（插件档案 v1 §5.3）：类型声明为 MUTATION、实际只清除界面上的图片变换框。
 * 随 SDK 版本维护，由"打开不变脏"与"代表性的修改变脏"的 E2E 回归
 */
export const CHANGE_DETECTION_EXCLUDED_MUTATIONS: readonly string[] = ['sheet.operation.clear-drawing-transformer']
