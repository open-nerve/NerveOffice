// 只读入口的共用清单（M2-P3 设计 §3.7，M3-P2 设计 §3.5）：E2E（tests/e2e/specs/editor/read-only.spec.ts）与测试构建的页面自检
// （./selftest.ts，在真实 Safari 上复核只读）用同一份入口与同一组预期，免得两份清单各自漂移。
// - Facade 入口（M0 的 F 类 21 项，另加"取消已有的超链接"）与经 Facade 直接执行的写公式的 mutation（M2-P6 复核 F3）：
//   两边都能直接调用，调用与预期都在这里；
// - 快捷键入口的预期（SHORTCUT_OUTCOMES）：按键的办法两边不同（E2E 用 Playwright 真实的键盘，自检派发合成的按键事件），
//   预期的命令与提示在这里；
// - 只读的提示（READ_ONLY_ALERT）：与 editor/profile/locale.ts 的 READ_ONLY_PERMISSION_TEXTS 相同，单元测试核对。
// 这个文件不引用任何模块：E2E 经模块边界的例外引用它（eslint.config.ts），Playwright 的进程里不能带进 Univer 与 web 的其他代码。
// 编辑器的生产代码不引用它（testing/ 只能动态引入，生产构建里没有引入它的分支）。
// Facade 入口的调用在两边执行的方式不同：E2E 把函数序列化到页面里执行（Function.prototype.toString，support/editor-probe.ts 的 runFacade），
// 自检直接调用。所以每个调用只能用它的参数，不能引用这个文件里的别的东西（常量也不行）。

/** 只读时被拦下的操作的提示（与 editor/profile/locale.ts 的 READ_ONLY_PERMISSION_TEXTS 相同，单元测试核对） */
export const READ_ONLY_ALERT = {
  edit: '这份文档只能查看，不能修改。',
  paste: '这份文档只能查看，不能粘贴。',
  cut: '这份文档只能查看，不能剪切。',
  style: '这份文档只能查看，不能修改格式。',
  sheet: '这份文档只能查看，不能调整工作表。',
  rowCol: '这份文档只能查看，不能调整行列。',
  insertRowCol: '这份文档只能查看，不能插入行列。',
  removeRowCol: '这份文档只能查看，不能删除行列。',
  image: '这份文档只能查看，不能修改图片。',
  conditionalFormat: '这份文档只能查看，不能修改条件格式。',
  dataValidation: '这份文档只能查看，不能修改数据验证。',
  filter: '这份文档只能查看，不能使用筛选。',
} as const

/** 任何一种只读的提示（READ_ONLY_PERMISSION_TEXTS 的说法都是这个开头） */
export const ANY_READ_ONLY_ALERT = /这份文档只能查看，不能[^。]+。/

/** 权限检查的提示的标题（sheets-ui 的 sheet-permission-check-ui.controller.ts 弹出的对话框） */
export const PERMISSION_ALERT_TITLE = '提示'

/** 提示里不该再出现的 SDK 原文（给保护区域写的：提保护、让人联系创建者） */
export const PROTECTION_WORDING = /保护|创建者/

/** 一步操作之后等到的信号（E2E 另有"不产生这条命令"，只用于界面上的手势） */
export type EntryOutcome
  /** 这条命令执行完 */
  = | { readonly executed: string }
  /** 被只读守卫（超链接是入口守卫）取消：执行前的记录里 canceled 为真 */
    | { readonly canceled: string }
  /** 被 SDK 的权限检查拦下：只有执行前的记录，没有执行完的。拦下时 SDK 弹出提示（alert 是提示的说法） */
    | { readonly blocked: string, readonly alert: string }

/** 两种打开方式下各自的预期 */
export interface EntryOutcomes {
  readonly read: EntryOutcome
  readonly edit: EntryOutcome
}

// ---- Facade 的声明：只写入口用到的部分（E2E 看不到 Univer 的类型，两边都按这份声明写；自检把真实的 Facade 当作它）----

export interface EntryRange {
  readonly getRange: () => unknown
  readonly createFilter: () => unknown
  readonly sort: (column: { readonly column: number, readonly ascending: boolean }) => unknown
  readonly merge: () => unknown
  readonly setFontWeight: (weight: 'bold') => unknown
  readonly setDataValidation: (rule: unknown) => unknown
  readonly setHyperLink: (url: string, label: string) => Promise<boolean>
  /** 取消左上角单元格里的超链接 */
  readonly cancelHyperLink: () => boolean
  readonly createOrUpdateNote: (note: { readonly note: string, readonly width: number, readonly height: number }) => unknown
}

export interface EntryImage {
  readonly setPositionAsync: (row: number, column: number) => Promise<boolean>
  readonly setSizeAsync: (width: number, height: number) => Promise<boolean>
  readonly remove: () => boolean
}

export interface EntryConditionalFormattingBuilder {
  readonly whenCellNotEmpty: () => EntryConditionalFormattingBuilder
  readonly setRanges: (ranges: readonly unknown[]) => EntryConditionalFormattingBuilder
  readonly setBackground: (color: string) => EntryConditionalFormattingBuilder
  readonly build: () => unknown
}

export interface EntryDataValidationBuilder {
  readonly requireNumberBetween: (from: number, to: number) => EntryDataValidationBuilder
  readonly build: () => unknown
}

export interface EntrySheet {
  readonly getRange: (a1: string) => EntryRange
  readonly getSheetId: () => string
  readonly setName: (name: string) => unknown
  readonly hideSheet: () => unknown
  readonly setRowHeight: (row: number, height: number) => unknown
  readonly insertRowAfter: (row: number) => unknown
  readonly deleteRows: (row: number, count: number) => unknown
  readonly getImages: () => readonly EntryImage[]
  readonly newConditionalFormattingRule: () => EntryConditionalFormattingBuilder
  readonly addConditionalFormattingRule: (rule: unknown) => unknown
}

export interface EntryWorkbook {
  readonly getId: () => string
  readonly getActiveSheet: () => EntrySheet
  /** 找不到时是 null：入口里按样本的名称取，取不到就让调用抛错（接住后这一项失败） */
  readonly getSheetByName: (name: string) => EntrySheet
  readonly insertSheet: (name: string) => unknown
  readonly deleteSheet: (sheet: EntrySheet) => unknown
  readonly duplicateSheet: (sheet: EntrySheet) => unknown
  readonly moveSheet: (sheet: EntrySheet, index: number) => unknown
}

export interface EntryTextFinder {
  readonly replaceAllWithAsync: (text: string) => Promise<number>
}

export interface EntryApi {
  readonly getActiveWorkbook: () => EntryWorkbook
  /** 直接执行一条命令或 mutation（经命令服务，执行前的事件照常送出） */
  readonly executeCommand: (id: string, params?: object, options?: object) => Promise<boolean>
  readonly newDataValidation: () => EntryDataValidationBuilder
  readonly createTextFinderAsync: (text: string) => Promise<EntryTextFinder>
}

/** Facade 入口拿到的：Facade、当前工作簿与当前工作表 */
export interface EntryScope {
  readonly api: EntryApi
  readonly workbook: EntryWorkbook
  readonly sheet: EntrySheet
}

/** Facade 入口：M0 的 F 类 21 项（spikes/m0/e2e/v09-read-mode.spec.ts 的 103–142 行），另加"取消已有的超链接" */
export interface FacadeEntry extends EntryOutcomes {
  readonly name: string
  /** 只能用参数（见文件开头）。调用抛出的错误由调用方接住：取消之后仍去取结果的 Facade 方法会抛错（例如 insertSheet 的 TypeError） */
  readonly call: (scope: EntryScope) => unknown
  /** 能编辑时也不改动：超链接在 M5 之前被入口守卫取消（P4 设计 §3.6.8） */
  readonly unchangedWhenEditable?: true
}

/** M0 的 Facade 入口（只读样本上；"数据"是打开时的当前表） */
export const FACADE_ENTRIES: readonly FacadeEntry[] = [
  { name: '筛选', call: ({ sheet }) => sheet.getRange('A1:F6').createFilter(), read: { canceled: 'sheet.mutation.set-filter-range' }, edit: { executed: 'sheet.command.set-filter-range' } },
  { name: '排序', call: ({ sheet }) => sheet.getRange('A2:F6').sort({ column: 1, ascending: false }), read: { canceled: 'sheet.mutation.reorder-range' }, edit: { executed: 'sheet.command.sort-range' } },
  { name: '新增工作表', call: ({ workbook }) => workbook.insertSheet('新表'), read: { canceled: 'sheet.mutation.insert-sheet' }, edit: { executed: 'sheet.command.insert-sheet' } },
  { name: '删除工作表', call: ({ workbook }) => workbook.deleteSheet(workbook.getSheetByName('汇总')), read: { canceled: 'sheet.mutation.remove-sheet' }, edit: { executed: 'sheet.command.remove-sheet' } },
  { name: '工作表改名', call: ({ workbook }) => workbook.getSheetByName('汇总').setName('汇总二'), read: { blocked: 'sheet.command.set-worksheet-name', alert: READ_ONLY_ALERT.sheet }, edit: { executed: 'sheet.command.set-worksheet-name' } },
  { name: '复制工作表', call: ({ workbook }) => workbook.duplicateSheet(workbook.getSheetByName('汇总')), read: { canceled: 'sheet.mutation.insert-sheet' }, edit: { executed: 'sheet.command.copy-sheet' } },
  { name: '隐藏工作表', call: ({ workbook }) => workbook.getSheetByName('汇总').hideSheet(), read: { canceled: 'sheet.mutation.set-worksheet-hidden' }, edit: { executed: 'sheet.command.set-worksheet-hidden' } },
  { name: '移动工作表', call: ({ workbook }) => workbook.moveSheet(workbook.getSheetByName('汇总'), 0), read: { blocked: 'sheet.command.set-worksheet-order', alert: READ_ONLY_ALERT.sheet }, edit: { executed: 'sheet.command.set-worksheet-order' } },
  { name: '移动图片', call: async ({ workbook }) => workbook.getSheetByName('功能').getImages()[0]?.setPositionAsync(12, 12), read: { blocked: 'sheet.command.set-sheet-image', alert: READ_ONLY_ALERT.image }, edit: { executed: 'sheet.command.set-sheet-image' } },
  { name: '删除图片', call: ({ workbook }) => workbook.getSheetByName('功能').getImages()[0]?.remove(), read: { blocked: 'sheet.command.remove-sheet-image', alert: READ_ONLY_ALERT.image }, edit: { executed: 'sheet.command.remove-sheet-image' } },
  { name: '缩放图片', call: async ({ workbook }) => workbook.getSheetByName('功能').getImages()[0]?.setSizeAsync(200, 150), read: { blocked: 'sheet.command.set-sheet-image', alert: READ_ONLY_ALERT.image }, edit: { executed: 'sheet.command.set-sheet-image' } },
  { name: '设行高', call: ({ sheet }) => sheet.setRowHeight(5, 40), read: { blocked: 'sheet.command.set-row-height', alert: READ_ONLY_ALERT.rowCol }, edit: { executed: 'sheet.command.set-row-height' } },
  { name: '插入行', call: ({ sheet }) => sheet.insertRowAfter(3), read: { blocked: 'sheet.command.insert-row-by-range', alert: READ_ONLY_ALERT.insertRowCol }, edit: { executed: 'sheet.command.insert-row-by-range' } },
  { name: '删除行', call: ({ sheet }) => sheet.deleteRows(16, 1), read: { blocked: 'sheet.command.remove-row-by-range', alert: READ_ONLY_ALERT.removeRowCol }, edit: { executed: 'sheet.command.remove-row-by-range' } },
  { name: '合并单元格', call: ({ sheet }) => sheet.getRange('K10:L11').merge(), read: { canceled: 'sheet.mutation.add-worksheet-merge' }, edit: { executed: 'sheet.command.add-worksheet-merge' } },
  { name: '加粗', call: ({ sheet }) => sheet.getRange('A2:B3').setFontWeight('bold'), read: { blocked: 'sheet.command.set-style', alert: READ_ONLY_ALERT.style }, edit: { executed: 'sheet.command.set-style' } },
  {
    name: '条件格式',
    call: ({ sheet }) => sheet.addConditionalFormattingRule(sheet.newConditionalFormattingRule().whenCellNotEmpty().setRanges([sheet.getRange('K1:K20').getRange()]).setBackground('#fecaca').build()),
    read: { blocked: 'sheet.command.add-conditional-rule', alert: READ_ONLY_ALERT.conditionalFormat },
    edit: { executed: 'sheet.command.add-conditional-rule' },
  },
  { name: '数据验证', call: ({ api, sheet }) => sheet.getRange('K20:K25').setDataValidation(api.newDataValidation().requireNumberBetween(1, 10).build()), read: { blocked: 'sheet.command.addDataValidation', alert: READ_ONLY_ALERT.dataValidation }, edit: { executed: 'sheet.command.addDataValidation' } },
  // M5 之前两种方式都被入口守卫取消（P4 设计 §3.6.8）：能编辑时同样不改动，对照组另有"取消已有的超链接"
  { name: '超链接', call: async ({ sheet }) => sheet.getRange('K31').setHyperLink('https://example.com/new', '新链接'), read: { canceled: 'sheets.command.add-hyper-link' }, edit: { canceled: 'sheets.command.add-hyper-link' }, unchangedWhenEditable: true },
  { name: '批注', call: ({ sheet }) => sheet.getRange('K30').createOrUpdateNote({ note: '新备注', width: 160, height: 60 }), read: { canceled: 'sheet.mutation.update-note' }, edit: { executed: 'sheet.mutation.update-note' } },
  { name: '全部替换', call: async ({ api }) => (await api.createTextFinderAsync('苹果')).replaceAllWithAsync('苹果X'), read: { blocked: 'sheet.command.set-range-values', alert: READ_ONLY_ALERT.edit }, edit: { executed: 'sheet.command.replace' } },
  { name: '取消已有的超链接（"功能"表 H3）', call: ({ workbook }) => workbook.getSheetByName('功能').getRange('H3').cancelHyperLink(), read: { canceled: 'sheet.mutation.set-range-values' }, edit: { executed: 'sheets.command.cancel-hyper-link' } },
]

/**
 * 经 Facade 直接执行一条写公式的 SetRangeValuesMutation："数据"表 K40 写 =1+1（M2-P6 复核 F3 的复现）。
 * 只读时要被只读守卫取消，SDK 的公式控制器也不能先把公式写进单元格（它在执行前同步执行一条带 onlyLocal、fromFormula 的嵌套 mutation）。
 * 只能用参数（见文件开头）
 */
export async function writeFormulaMutation({ api, workbook, sheet }: EntryScope): Promise<boolean> {
  return api.executeCommand('sheet.mutation.set-range-values', { unitId: workbook.getId(), subUnitId: sheet.getSheetId(), cellValue: { 39: { 10: { f: '=1+1' } } } })
}

/** writeFormulaMutation 写的那一格（"数据"表 K40，从 0 开始的行号与列号） */
export const FORMULA_MUTATION_CELL = { row: 39, column: 10 } as const

/** writeFormulaMutation 写的是哪条 mutation：只读时它被取消（执行前的记录里 canceled 为真） */
export const FORMULA_MUTATION_ID = 'sheet.mutation.set-range-values'

/**
 * 快捷键入口的预期（M2-P3 S3、M2-P6 复核 F1、F2）：E2E 用真实的键盘按（read-only.spec.ts），页面自检派发合成的按键事件（selftest.ts）。
 * - find：查找是阅读，两种打开方式都打开查找面板（合成按键到得了 SDK 的校准）；
 * - style：格式（Cmd/Ctrl+B、I、U）被权限检查拦下；clear：删除键清除内容同样被拦下；
 * - undo、redo：被只读守卫取消（重做直接重放 mutation，绕过权限检查）；
 * - featureSearch、quickSum、replace："搜索功能"面板、快速求和与打开替换被只读守卫取消
 */
export const SHORTCUT_OUTCOMES = {
  find: { read: { executed: 'ui.operation.open-find-dialog' }, edit: { executed: 'ui.operation.open-find-dialog' } },
  style: { read: { blocked: 'sheet.command.set-style', alert: READ_ONLY_ALERT.style }, edit: { executed: 'sheet.command.set-style' } },
  clear: { read: { blocked: 'sheet.command.clear-selection-content', alert: READ_ONLY_ALERT.edit }, edit: { executed: 'sheet.command.clear-selection-content' } },
  undo: { read: { canceled: 'univer.command.undo' }, edit: { executed: 'univer.command.undo' } },
  redo: { read: { canceled: 'univer.command.redo' }, edit: { executed: 'univer.command.redo' } },
  featureSearch: { read: { canceled: 'ui.operation.open-feature-search' }, edit: { executed: 'ui.operation.open-feature-search' } },
  quickSum: { read: { canceled: 'formula-ui.operation.insert-function' }, edit: { executed: 'formula-ui.operation.insert-function' } },
  replace: { read: { canceled: 'ui.operation.open-replace-dialog' }, edit: { executed: 'ui.operation.open-replace-dialog' } },
} as const satisfies Readonly<Record<string, EntryOutcomes>>
