import type { IWorkbookData } from '@univerjs/core'
import type { EditorAccess } from '../editor-access.ts'
import { LocaleType, LogLevel, Univer } from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { createChangeTracker } from '../change-tracking/change-tracker.ts'
import { stopRunningRound } from '../formula-round-stop.ts'
import { editorIdentityOverride } from '../identity/editor-authz-io.service.ts'
import { disposalSafeLocaleOverride, FORMULA_PROTOCOL, injectorOf, IUndoRedoService } from '../internal-api/index.ts'
import { dataPluginEntries, snapshotWithResources } from '../profile/data-plugins.test-support.ts'
import { SHEET_ZH_CN } from '../profile/locale.ts'
import { CHANGE_DETECTION_EXCLUDED_MUTATIONS } from '../profile/sheet-profile.ts'
import '@univerjs/sheets/facade'

export function csvBook(): IWorkbookData {
  return JSON.parse(snapshotWithResources('csv-book')) as IWorkbookData
}

/** 真实 core、资源插件、数字格式与命令栈；不用假 Facade 证明插入/撤销及显示。 */
export function csvFixture(snapshot = csvBook(), access: EditorAccess = 'edit') {
  const univer = new Univer({
    locale: LocaleType.ZH_CN,
    locales: { [LocaleType.ZH_CN]: SHEET_ZH_CN },
    logLevel: LogLevel.SILENT,
    override: [...editorIdentityOverride(access), ...disposalSafeLocaleOverride()],
  })
  for (const entry of dataPluginEntries())
    entry.register(univer)
  const api = FUniver.newAPI(univer)
  const changes = createChangeTracker(univer, api, { unitId: snapshot.id, excludedMutationIds: CHANGE_DETECTION_EXCLUDED_MUTATIONS })
  // SDK 接管传入的嵌套对象；每个实例拿自己的副本，避免边界对照共享已改写的样本。
  const workbook = api.createWorkbook(structuredClone(snapshot))
  const history = injectorOf(univer).get(IUndoRedoService)
  return {
    univer,
    api,
    workbook,
    changes,
    state: () => ({ snapshot: JSON.stringify(workbook.save()), history: history.getUndoRedoStatus(snapshot.id) }),
    dispose: async () => {
      const stopped = await stopRunningRound({
        running: changes.formulaRoundRunning,
        onProgress: changes.onFormulaProgress,
        stop: () => { api.syncExecuteCommand(FORMULA_PROTOCOL.stopMutationId, {}, { onlyLocal: true }) },
      })
      changes.dispose()
      univer.dispose()
      if (stopped === 'timeout')
        throw new Error('CSV fixture formula stop timed out')
    },
  }
}
