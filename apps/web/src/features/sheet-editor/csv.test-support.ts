import type { SheetCsv } from '../../editor/index.ts'
import type { CsvController, CsvView } from './csv-controller.ts'

/** 原会话/切换用例没有 CSV 场景；若未来路径开始调用它，必须补充真实场景而不是默认成功。 */
export function unusedCsv(): SheetCsv {
  const unexpected = (): never => {
    throw new Error('本用例未配置 CSV 行为')
  }
  return { sheets: unexpected, read: unexpected, insert: unexpected }
}

/** 原页头用例只观察旧功能；CSV 动作必须由专门夹具配置。 */
export function unusedCsvController(): CsvController {
  const unexpected = (): never => {
    throw new Error('本用例未配置 CSV 宿主行为')
  }
  const view: CsvView = { canImport: false, canExport: false, dialog: { kind: 'closed' }, problem: undefined, notice: undefined }
  return {
    view: () => view,
    subscribe: () => () => {},
    openImport: unexpected,
    openExport: unexpected,
    chooseFile: unexpected,
    selectSheet: unexpected,
    confirmImport: unexpected,
    importPrepared: unexpected,
    exportSelected: unexpected,
    cancel: unexpected,
    environmentChanged: unexpected,
    dispose: unexpected,
  }
}
