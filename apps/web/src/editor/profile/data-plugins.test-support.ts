// 测试辅助（打开自检的单元测试，M3-P4 设计 §3.11）：jsdom 里起真实的 Univer core 与档案里的数据插件——表格的十个资源 hook 都在它们里面。
// 插件取自档案本身（SHEET_PLUGIN_GROUPS），只去掉 jsdom 里起不来的：界面插件、渲染引擎、公式 Worker 的 RPC 与查找替换（要界面的服务）；
// 表格公式插件在档案里不执行公式、经 RPC 交给 Worker，这里换成默认配置（在主线程上，数据验证依赖它）。档案加了带资源的数据插件时，
// 这里自动带上，打开自检的单元测试随之看到新的 hook。另给一份六项内容资源都非空的快照（形状取自只读样本，工作表换成模板的那一张）
import type { PluginEntry } from './plugin-entry.ts'
import { SHEET_TEMPLATE } from '@nerve-office/contracts'
import { UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula'
import { pluginEntry } from './plugin-entry.ts'
import { SHEET_PLUGIN_GROUPS } from './sheet-profile.ts'

/** jsdom 里起不来的插件：界面（*_UI_PLUGIN）、渲染引擎、公式 Worker 的 RPC、查找替换 */
const NOT_IN_JSDOM = /(?:^|_)UI_PLUGIN$|^UNIVER_RENDER_ENGINE_PLUGIN$|^UNIVER_RPC_MAIN_THREAD_PLUGIN$|FIND_REPLACE/

/** 档案里的数据插件，按档案的顺序 */
export function dataPluginEntries(): PluginEntry[] {
  const context = { container: document.createElement('div'), formula: { kind: 'worker' as const, worker: {} as Worker }, access: 'edit' as const }
  return SHEET_PLUGIN_GROUPS.flatMap(group => group.plugins(context))
    .filter(entry => !NOT_IN_JSDOM.test(entry.plugin.pluginName))
    .map(entry => (entry.plugin.pluginName === UniverSheetsFormulaPlugin.pluginName ? pluginEntry(UniverSheetsFormulaPlugin) : entry))
}

/** 模板里唯一那张工作表 */
const SHEET_ID = 'sheet-1'

/** 六项内容资源的数据（都非空）：条件格式、数据验证、筛选、备注、定义名称与浮动图片 */
function contentResources(unitId: string): Readonly<Record<string, string>> {
  const range = { startRow: 0, startColumn: 4, endRow: 9, endColumn: 4, rangeType: 0, unitId, sheetId: SHEET_ID }
  const transform = { flipY: false, flipX: false, angle: 0, skewX: 0, skewY: 0 }
  const anchor = { from: { row: 1, rowOffset: 0, column: 9, columnOffset: 0 }, to: { row: 4, rowOffset: 8, column: 10, columnOffset: 32 } }
  return {
    SHEET_CONDITIONAL_FORMATTING_PLUGIN: JSON.stringify({ [SHEET_ID]: [{ rule: { type: 'highlightCell', subType: 'text', operator: 'containsText', value: '1', style: { it: 1 } }, ranges: [range], cfId: 'cf1', stopIfTrue: false }] }),
    SHEET_DATA_VALIDATION_PLUGIN: JSON.stringify({ [SHEET_ID]: [{ uid: 'dv1', ranges: [{ ...range, startColumn: 6, endColumn: 6 }], type: 'list', formula1: '是,否', showDropDown: true }] }),
    SHEET_FILTER_PLUGIN: JSON.stringify({ [SHEET_ID]: { ref: { startRow: 0, startColumn: 0, endRow: 19, endColumn: 2, rangeType: 0 }, filterColumns: [{ colId: 0, filters: { filters: ['研发'] } }], cachedFilteredOut: [2] } }),
    SHEET_NOTE_PLUGIN: JSON.stringify({ [SHEET_ID]: { 0: { 7: { note: '备注', width: 160, height: 60, id: 'n1', row: 0, col: 7 } } } }),
    SHEET_DEFINED_NAME_PLUGIN: JSON.stringify({ dn1: { id: 'dn1', name: '数量合计区', formulaOrRefString: '\'工作表1\'!$B$2:$B$6', localSheetId: 'AllDefaultWorkbook' } }),
    SHEET_DRAWING_PLUGIN: JSON.stringify({ [SHEET_ID]: { data: { d1: {
      drawingId: 'd1',
      drawingType: 0,
      imageSourceType: 'URL',
      source: '/api/assets/00000000-0000-4000-8000-000000000001',
      unitId,
      subUnitId: SHEET_ID,
      sheetTransform: { ...anchor, ...transform },
      axisAlignSheetTransform: { ...anchor, ...transform },
      transform: { ...transform, left: 838, top: 44, width: 120, height: 80 },
    } }, order: ['d1'] } }),
  }
}

/**
 * 模板换上 unitId、六项内容资源都非空的快照（JSON 文本）；overrides 按资源名换掉某几项的 data（构造损坏的文档）。
 * 资源的先后与模板相同
 */
export function snapshotWithResources(unitId: string, overrides: Readonly<Record<string, string>> = {}): string {
  const data = { ...contentResources(unitId), ...overrides }
  const resources = SHEET_TEMPLATE.resources.map(({ name, data: empty }) => ({ name, data: data[name] ?? empty }))
  return JSON.stringify({ ...SHEET_TEMPLATE, id: unitId, resources })
}
