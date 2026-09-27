// 新建表格用的模板快照（P4 设计 §3.4）：按生产档案"打开 → 保存"收敛之后的空白工作簿，新建时换上文档自己的 unitId。
// 由更新脚本生成，不要手改：SDK 升级或插件档案变更时重新生成（pnpm --filter @nerve-office/e2e run update:sheet-template），
// E2E 回归"新建的文档打开后立即保存，快照与模板逐字节相同（id 除外）"。

/** 模板里的占位 unitId：实例化时换成文档自己的。 */
export const SHEET_TEMPLATE_UNIT_ID = 'nerve-template-unit'

/** 收敛的空白工作簿（Univer 的 IWorkbookData）。键的顺序就是 SDK 保存时的顺序，序列化的结果与 SDK 保存的字节相同。 */
export const SHEET_TEMPLATE = {
  id: SHEET_TEMPLATE_UNIT_ID,
  sheetOrder: [
    'sheet-1',
  ],
  name: '',
  appVersion: '1.0.1',
  locale: 'zhCN',
  styles: {},
  sheets: {
    'sheet-1': {
      id: 'sheet-1',
      name: '工作表1',
      tabColor: '',
      hidden: 0,
      rowCount: 1000,
      columnCount: 20,
      zoomRatio: 1,
      freeze: {
        xSplit: 0,
        ySplit: 0,
        startRow: -1,
        startColumn: -1,
      },
      scrollTop: 0,
      scrollLeft: 0,
      defaultColumnWidth: 88,
      defaultRowHeight: 24,
      mergeData: [],
      cellData: {},
      rowData: {},
      columnData: {},
      showGridlines: 1,
      rowHeader: {
        width: 46,
        hidden: 0,
      },
      columnHeader: {
        height: 20,
        hidden: 0,
      },
      rightToLeft: 0,
    },
  },
  resources: [
    {
      name: 'SHEET_RANGE_PROTECTION_PLUGIN',
      data: '',
    },
    {
      name: 'SHEET_WORKSHEET_PROTECTION_PLUGIN',
      data: '{}',
    },
    {
      name: 'SHEET_WORKSHEET_PROTECTION_POINT_PLUGIN',
      data: '{}',
    },
    {
      name: 'SHEET_DRAWING_PLUGIN',
      data: '{}',
    },
    {
      name: 'SHEET_CONDITIONAL_FORMATTING_PLUGIN',
      data: '',
    },
    {
      name: 'SHEET_NOTE_PLUGIN',
      data: '{}',
    },
    {
      name: 'SHEET_DEFINED_NAME_PLUGIN',
      data: '{}',
    },
    {
      name: 'SHEET_RANGE_THEME_MODEL_PLUGIN',
      data: '{}',
    },
    {
      name: 'SHEET_FILTER_PLUGIN',
      data: '{}',
    },
    {
      name: 'SHEET_DATA_VALIDATION_PLUGIN',
      data: '{}',
    },
  ],
} as const

/** 一份新表格的快照 JSON：模板换上文档的 unitId。模板本身就是 JSON.stringify 的输出，只有 id 不同（单元测试核对）。 */
export function sheetSnapshotFor(unitId: string): string {
  return JSON.stringify({ ...SHEET_TEMPLATE, id: unitId })
}
