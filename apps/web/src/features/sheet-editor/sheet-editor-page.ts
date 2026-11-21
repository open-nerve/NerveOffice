// 表格的编辑器页装配（M6-P1 S8b，S8 spec §2）：共用编辑会话层的通用页面（document-editor 的 editor-page.ts）加上表格的页面扩展。
// 表格专有的部分都在这里，经页面扩展的挂点挂在原来调用表格代码的位置，先后不变（spec §2.4、§2.9）：
// - CSV 控制器（csv-controller.ts）：选中装配时建（原来是页面构造时，紧跟第一次算视图；构造时没有副作用，选中之前没有人用它，spec §2.2）。
//   页面的环境变了时重新发布（写资格变了、update 里算视图之前、四个会话钩子里身份代次加一之后，CSV 的监听者先于页面的收到）；pagehide 与卸载的
//   第一件是销毁它。CSV 的目标按原来的先后组合：先取编辑模式门面的目标（新文档时它捕获一次），再取页面的那一半（actionGate），现行判断先查页面一侧、
//   最后查编辑模式的目标；可写在现行判断之后依次查编辑模式的可写与页面的写的门槛（writeReady）；
// - 公式恢复挡住动作（原来页面的 formulaBusy）：7 个入口的第一句；挡住输入时挂屏障；
// - 新建表格之后的导入（importCreatedCsv）：先核对意图（文档、用户与令牌），再取 CSV 的目标，再导入；
// - 工作表名（sheetName）：先过页面的门槛（没有卸载、会话是本人），再问编辑模式；公式恢复没成之后再试（retryFormulaRecovery）。
// 编辑模式的工厂是表格的门面（createSheetEditMode）：与页面扩展共用这里的闭包，扩展经它拿到有类型的 SheetEditMode，页面只看到通用的 EditMode。
// 编辑器的工厂由组装处给出（适配层的 createSheetEditor），页面以 bindEditor 包上自己的绑定；它的入参与会话层的绑定同形由这里的类型检查核对。
import type { ImageInputState } from '../../editor/index.ts'
import type { CsvTable } from '../../shared/csv/index.ts'
import type { EditorPage, EditorPageAssembly, EditorPageBindings, EditorPageView } from '../document-editor/index.ts'
import type { CsvController, CsvTarget } from './csv-controller.ts'
import type { SheetEditMode, SheetEditModeExtra } from './sheet-edit-mode.ts'
import type { CreateModeEditor } from './sheet-editor-slot.ts'
import { clientFormatOf } from '../../shared/api/client-format.ts'
import { createCsvController } from './csv-controller.ts'
import { downloadCsv } from './csv-download.ts'
import { createSheetEditMode } from './sheet-edit-mode.ts'

/** 新建表格之后的导入的意图（csv-create-start.tsx）：创建它的文档、用户与令牌，以及创建流程还算数 */
export interface CreatedCsvIntent {
  readonly documentId: string
  readonly userId: string
  readonly csrfToken: string
  readonly current: () => boolean
}

/** 表格的页面扩展交给使用方的成员（经 page.extension() 取，写法与原来页面上的相同） */
export interface SheetEditorPageMembers {
  readonly csv: CsvController
  readonly importCreatedCsv: (table: CsvTable, intent: CreatedCsvIntent) => Promise<boolean>
  readonly sheetName: SheetEditMode['sheetName']
  readonly retryFormulaRecovery: () => void
}

/** 表格编辑器页：通用页面，选中的扩展是表格的，视图里扩展的部分是 formulaRecovery，图片操作的状态是适配层的 */
export type SheetEditorPage = EditorPage<SheetEditorPageMembers, SheetEditModeExtra, ImageInputState>
export type SheetEditorPageView = EditorPageView<SheetEditModeExtra, ImageInputState>

/** 表格编辑器的工厂（适配层的 createSheetEditor）收到的：槽位给的快照、访问方式、视图状态与创建的选项（编辑模式的工厂的入参），加上页面的绑定 */
export type CreateSheetPageEditor = (options: Parameters<CreateModeEditor>[0] & EditorPageBindings<ImageInputState>) => ReturnType<CreateModeEditor>

export type SheetEditorAssembly = EditorPageAssembly<SheetEditorPageMembers, SheetEditModeExtra, ImageInputState>

/** 表格的装配：档案是表格的；createEditor 是表格编辑器的工厂（组装处给出适配层的 createSheetEditor，测试给假的） */
export function sheetEditorAssembly(createEditor: CreateSheetPageEditor): SheetEditorAssembly {
  return {
    format: clientFormatOf('sheet'),
    assemble: (host) => {
      /** 表格的编辑模式：页面建编辑模式时建（选中装配之后、载入完成之前），之前为 undefined */
      let mode: SheetEditMode | undefined

      /** CSV 的目标（原来页面的 csvTarget，先后见文件头）：newDocument 是新建表格之后的导入 */
      function csvTarget(newDocument = false): CsvTarget | undefined {
        const target = mode?.csvTarget(newDocument)
        if (target === undefined)
          return undefined
        const gate = host.actionGate()
        if (gate === undefined)
          return undefined
        const current = (): boolean => gate() && target.current()
        if (!current())
          return undefined
        return {
          editor: target.editor,
          current,
          writable: () => current() && target.writable() && host.writeReady(),
          formulasPending: target.formulasPending,
        }
      }

      const csv = createCsvController({
        current: csvTarget,
        prepareImport: host.confirmBeforeWrite,
        title: host.title,
        download: downloadCsv,
      })

      return {
        extension: {
          environmentChanged: () => csv.environmentChanged(),
          blocksActions: () => mode?.view().formulaRecovery?.blocksActions === true,
          blocksInput: () => mode?.view().formulaRecovery?.blocksInput === true,
          hide: () => csv.dispose(),
          dispose: () => csv.dispose(),
          csv,
          async importCreatedCsv(table, intent) {
            const matches = (): boolean => {
              const signedIn = host.pageSession()
              return intent.current() && host.documentId === intent.documentId
                && signedIn?.user.id === intent.userId && signedIn.csrfToken === intent.csrfToken
            }
            if (!matches())
              return false
            const target = csvTarget(true)
            if (!target)
              return false
            return csv.importPrepared(table, { ...target, current: () => matches() && target.current(), writable: () => matches() && target.writable() })
          },
          sheetName: sheetId => host.sessionActive() ? mode?.sheetName(sheetId) : undefined,
          retryFormulaRecovery: () => mode?.retryFormulaRecovery(),
        },
        createMode: ({ bindEditor, ...options }) => {
          mode = createSheetEditMode({ ...options, createEditor: bindEditor(createEditor) })
          return mode
        },
      }
    },
  }
}
