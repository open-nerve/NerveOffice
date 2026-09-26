// 公式 Worker 里的插件（插件档案 v1 §1，P4 设计 §3.6.4）：与官方 UniverSheetsCoreWorkerPreset 加 UniverSheetsFilterWorkerPreset 的组合相同
// （presets/packages/preset-sheets-core/src/worker.ts:31-42、preset-sheets-filter/src/worker.ts）。
// 单独成文件：Worker 只引用这一份，主线程档案里的界面插件不进 Worker 的包
import type { PluginEntry } from './plugin-entry.ts'
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula'
import { UniverRPCWorkerThreadPlugin } from '@univerjs/rpc'
import { UniverSheetsPlugin } from '@univerjs/sheets'
import { UniverSheetsFilterPlugin } from '@univerjs/sheets-filter'
import { UniverRemoteSheetsFormulaPlugin } from '@univerjs/sheets-formula'
import { pluginEntry } from './plugin-entry.ts'

export function formulaWorkerPluginEntries(): PluginEntry[] {
  return [
    pluginEntry(UniverSheetsPlugin, { onlyRegisterFormulaRelatedMutations: true }),
    pluginEntry(UniverFormulaEnginePlugin),
    pluginEntry(UniverRPCWorkerThreadPlugin),
    pluginEntry(UniverRemoteSheetsFormulaPlugin),
    pluginEntry(UniverSheetsFilterPlugin),
  ]
}
