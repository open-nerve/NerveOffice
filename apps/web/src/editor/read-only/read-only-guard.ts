// 只读守卫（M2-P3 设计 §3.3；插件档案 v1 §5.2，M0-P3 报告 §5 的"本地权限点 + mutation 防火墙"）：以只读打开时装上。
// 授权服务按只读回答（identity/），SDK 据此把工作簿的权限点设为只读；只靠权限点拦不全（M0 漏掉 9 个入口），这里另做三件事：
// 1. mutation 防火墙：在 BeforeCommandExecute 上取消变更检测会认作修改的命令，判定与 change-tracker.ts 是同一个函数（isDocumentChange）。
//    由此有一条不变量：只读时，变更检测会认作修改的一律取消。所以：
//    - 公式的结果（Worker 同步回来，带 onlyLocal）照常显示；
//    - 单元格编辑器写内部文档单元（其他单元）不拦：拦了它，之后的编辑会写错内容（M0-P3 审查 R2）；
//    - 排除名单里的 sheet.operation.clear-drawing-transformer（类型是 MUTATION，只清除界面上的图片变换框）不拦；
//    - 比 M0 的条件（只看 onlyLocal）多放过 fromCollab、fromChangeset、fromFormula 与排除名单：前两个在本平台不出现（没有协同）；
//      排除名单里的 clear-drawing-transformer 只刷新界面。fromFormula 的 mutation 会改单元格（SDK 里它们同时带 onlyLocal，M0 的条件
//      同样放过）：一是公式结果的写回（上面第一条）；二是 sheets-formula 的 UpdateFormulaController 在它自己的执行前监听里，为每条
//      SetRangeValuesMutation 同步执行的嵌套写入，把公式写进单元格（controllers/update-formula.controller.ts:112、177，
//      1.0.1 的 lib/es/index.js:2005-2039）。放过第二种之所以安全，靠的是防火墙排在 SDK 的执行前监听之前：触发它的那条
//      SetRangeValuesMutation 先被取消，嵌套的写入不会发生（sheet-editor.ts 写明的不变量；M2-P6 复核 F3、F7，
//      E2E read-only.spec.ts 的用例"经 Facade 直接执行写公式的 mutation"）。
//    被取消的命令不执行、不进撤销栈：Facade 抛出 CanceledError，命令服务接住它，调用方拿到 false（core 的 f-univer.ts:217-272、
//    command.service.ts:467-474），不是页面错误。
//    另外取消只读时没有意义的界面操作（READ_ONLY_GUARDED_COMMANDS，M2-P3 S3 的 E2E 与 M2-P6 复核 F1、F2 发现之后）；
// 2. 撤销与重做：BeforeUndo、BeforeRedo 取消（重做直接重放 mutation，绕过权限检查；取消的方式同上）；clearUndoStack 清空这份文档的撤销栈；
// 3. 工作表的本地权限点：每张工作表"查看""复制"之外的权限点设为不允许，不存在的先加上。
//    工作表的权限点只在存在保护规则时才经授权服务设置，没有规则的表不会被 SDK 改回去；用户变化时 SDK 重新加入权限点，沿用原来的值
//    （sheets 的 sheet-permission-init.controller.ts:263-331、333-385）。不创建保护规则，不写保护类资源；
//    不用 FWorksheetPermission.setReadOnly()：它要求先 protect()，会写保护类资源，还会关掉复制（M0-P3 报告 §5.3）。
//    同一步里把浮动图片设为不可编辑（见 applyWorksheetPoints）。
// SDK 界面上还有几处只读时照样能碰，守卫一并处理、销毁时撤掉（M2-P3 S3 的 E2E 与 P3 审查发现之后）：
// 装上时：批注浮层的文本框设为只读（note-popup.ts）；编辑栏的编辑框按不下去（formula-bar.ts 的 blockFormulaBarInput）；
// 渲染完成之后（applyRenderedGuards）：冻结线拖不动（freeze-handles.ts）；编辑栏的编辑器不管从哪条路径被聚焦都马上放开
// （formula-bar.ts 的 releaseFormulaBarEditor）。
// 创建编辑器时按顺序调用（sheet-editor.ts）：创建工作簿之前装上（防火墙与撤销拦截在打开的过程中也生效；防火墙要排在 SDK 自己的
// 执行前监听之前，这条前提由 sheet-editor.ts 保证并写明）→ 工作簿创建之后
// applyWorksheetPoints → 就绪时（渲染已经完成）applyRenderedGuards、clearUndoStack。只读时新表建不出来（防火墙取消 insert-sheet），
// 所以权限点只在创建时设一次。
// M3 的原地切换复用这几个入口：进入只读时按同样的顺序，退出时销毁（权限点与图片的可编辑由它另外恢复，这里不管）
import type { IDisposable, Univer } from '@univerjs/core'
import type { FUniver } from '@univerjs/core/facade'
import type { ChangeClassifierConfig } from '../change-tracking/change-classifier.ts'
import type { GuardedCommand } from '../profile/entry-guards.ts'
import { isDocumentChange } from '../change-tracking/change-classifier.ts'
import { toCommandRecord } from '../change-tracking/command-event.ts'
import { getAllWorksheetPermissionPoint, getAllWorksheetPermissionPointByPointPanel, IContextService, IDrawingManagerService, injectorOf, IPermissionService, IUndoRedoService, WorksheetCopyPermission, WorksheetViewPermission } from '../internal-api/index.ts'
import { IEditorService, IRenderManagerService } from '../internal-api/ui.ts'
import { blockFormulaBarInput, releaseFormulaBarEditor } from './formula-bar.ts'
import { lockFreezeHandles } from './freeze-handles.ts'
import { lockNotePopups } from './note-popup.ts'

type WorksheetPoint = ReturnType<typeof getAllWorksheetPermissionPoint>[number] | ReturnType<typeof getAllWorksheetPermissionPointByPointPanel>[number]

/**
 * 只读时关掉的工作表权限点：SDK 的两份清单（sheets 的 worksheet-permission/utils.ts）去重，去掉"查看"与"复制"，1.0.x 共 16 个。
 * 保留的两个与授权服务在只读时允许的动作是同一组定义（identity/editor-authz-io.service.ts）
 */
export function closedWorksheetPoints(): WorksheetPoint[] {
  const kept: ReadonlySet<WorksheetPoint> = new Set([WorksheetViewPermission, WorksheetCopyPermission])
  return [...new Set([...getAllWorksheetPermissionPoint(), ...getAllWorksheetPermissionPointByPointPanel()])].filter(point => !kept.has(point))
}

/**
 * 只读时在执行前取消的界面操作（与入口守卫 profile/entry-guards.ts 同样的写法）：它们不改文档（防火墙管不着），
 * 但只读时打开的界面只会得到失败的提示，或者显示文档里没有的内容。
 * 快捷键是只读时界面上仍然摸得到的入口：E2E 的快捷键回归（tests/e2e/specs/editor/read-only-shortcuts.spec.ts）逐个按遍 SDK 注册的快捷键，
 * SDK 升级带来的新入口由它发现（M2-P6 复核 F1、F2 之后）
 */
export const READ_ONLY_GUARDED_COMMANDS: readonly GuardedCommand[] = [
  {
    id: 'ui.operation.open-replace-dialog',
    source: 'find-replace 的 commands/operations/find-replace.operation.ts:37（打开替换，或在查找面板里展开"替换 / 高级查找"：views/dialog/FindReplaceDialog.tsx:90-91；'
      + '快捷键 Ctrl+H，苹果的平台上同样是 Control+H：controllers/find-replace.shortcut.ts:78-88）。只读时替换的写入被拦下，面板只会提示"替换失败"（M2-P3 S3 的 E2E 发现）。'
      + '代价：只读时也没有高级查找的选项（查找顺序、查找范围、匹配方式），查找本身照常',
  },
  {
    id: 'ui.operation.open-feature-search',
    source: 'ui 的 commands/operations/open-feature-search.operation.ts:27（打开"搜索功能"面板；快捷键 Ctrl/Cmd+Shift+P，没有前提条件：'
      + 'controllers/feature-search/feature-search.controller.ts:23-39；1.0.1 的 lib/es/index.js:1958、28480-28482）。面板的候选项直接取自功能区与右键菜单的菜单登记'
      + '（views/components/feature-search/FeatureSearch.tsx:230，lib/es/index.js:1907），不看界面上隐藏了什么：只读时格式刷、清除格式、冻结、剪切、删除、粘贴等编辑功能'
      + '照样列着，执行时被防火墙或权限检查拦下（冻结没有权限检查，没有任何提示，看起来就是点了没反应；M2-P6 复核 F1）。'
      + '代价：只读时没有"搜索功能"面板（里面列的都是编辑功能，查看者用不上）',
  },
  {
    id: 'formula-ui.operation.insert-function',
    source: 'sheets-formula-ui 的 commands/operations/insert-function.operation.ts:51（快速求和；快捷键 Alt+=，苹果的平台上 Cmd+Option+=：'
      + 'controllers/shortcuts/quick-sum.shortcut.ts:25-27；1.0.1 的 lib/es/index.js:287、5708）。它不管单元格编辑器打没打开，直接往单元格编辑器与编辑栏的内部文档'
      + '写入"=SUM(…"（insert-function.operation.ts:225-226，lib/es/index.js:415-416）：只读时打开单元格编辑器被权限检查拦下，编辑栏却一直显示这个文档里没有的公式，'
      + '直到选区移开（M2-P6 复核 F2）。代价：只读时快速求和的快捷键没有反应（求和是编辑）',
  },
]

const READ_ONLY_GUARDED_IDS: ReadonlySet<string> = new Set(READ_ONLY_GUARDED_COMMANDS.map(command => command.id))

export interface ReadOnlyGuard {
  /** 工作簿创建之后调用：每张工作表"查看""复制"之外的权限点设为不允许（不存在的先加上），浮动图片设为不可编辑 */
  readonly applyWorksheetPoints: () => void
  /**
   * 渲染完成之后调用一次：冻结线拖不动（冻结线的控制器是渲染模块，SDK 到 Rendered 才注册）；编辑栏的编辑器一被聚焦就放开。
   * 编辑器页在就绪时调用（就绪之前的输入由页面的交互屏障拦住）
   */
  readonly applyRenderedGuards: () => void
  /** 清空这份文档的撤销栈：以只读创建时本来就空，这是给 M3 的原地切换用的同一个入口 */
  readonly clearUndoStack: () => void
  /** 移除防火墙与撤销、重做的拦截，撤掉批注、编辑栏与冻结线的处理；权限点与图片的可编辑不恢复。可以重复调用 */
  readonly dispose: () => void
}

/** config 与变更检测的判定用同一份（本文档的 unitId、排除名单），防火墙的条件因此与它一致 */
export function installReadOnlyGuard(univer: Univer, univerAPI: FUniver, config: ChangeClassifierConfig): ReadOnlyGuard {
  const { unitId } = config
  const subscriptions: IDisposable[] = [
    univerAPI.addEvent(univerAPI.Event.BeforeCommandExecute, (event) => {
      if (isDocumentChange(toCommandRecord(event), config) || READ_ONLY_GUARDED_IDS.has(event.id))
        event.cancel = true
    }),
    univerAPI.addEvent(univerAPI.Event.BeforeUndo, (event) => {
      event.cancel = true
    }),
    univerAPI.addEvent(univerAPI.Event.BeforeRedo, (event) => {
      event.cancel = true
    }),
  ]
  /** 界面上的处理：撤掉它们的函数（装上时的两项，渲染完成之后再加两项） */
  const uiGuards: (() => void)[] = [lockNotePopups(), blockFormulaBarInput()]
  let disposed = false

  return {
    applyWorksheetPoints() {
      const workbook = univerAPI.getWorkbook(unitId)
      if (workbook === null)
        throw new Error(`工作簿 ${unitId} 还没有创建：工作表的权限点要在创建工作簿之后设置`)
      const injector = injectorOf(univer)
      const permissions = injector.get(IPermissionService)
      const points = closedWorksheetPoints()
      // 隐藏的工作表也在内（getSheets 按 sheetOrder 给出全部工作表，与 SDK 加入权限点时相同）
      for (const sheet of workbook.getSheets()) {
        for (const Point of points) {
          const point = new Point(unitId, sheet.getSheetId())
          // 已有的不再加入：SDK 对重复的加入打出警告（core 的 permission.service.ts:48-63）
          if (permissions.getPermissionPoint(point.id) == null)
            permissions.addPermissionPoint(point)
          permissions.updatePermissionPoint(point.id, false)
        }
      }
      // 浮动图片：drawing-ui 画图片时按图片管理服务的标志决定挂不挂变换框（SDK 的权限控制器设的是表格图片服务的同名标志，渲染不读它；
      // internal-api 的登记）。sheets-drawing-ui 到 Rendered 才注册画图片的渲染模块，在这里设，之后画出来的图片都点不中、拖不动
      injector.get(IDrawingManagerService).setDrawingEditable(false)
    },
    applyRenderedGuards() {
      // 销毁之后再装，撤不掉了（dispose 已经清空过清单）：M3 的原地切换复用这几个入口，所以这里直接报错，不静默装上（复验 S1）
      if (disposed)
        throw new Error('只读守卫已经销毁：渲染完成之后的处理不能再装')
      const injector = injectorOf(univer)
      uiGuards.push(
        lockFreezeHandles(injector.get(IRenderManagerService), unitId),
        releaseFormulaBarEditor({ editors: injector.get(IEditorService), context: injector.get(IContextService) }),
      )
    },
    clearUndoStack() {
      injectorOf(univer).get(IUndoRedoService).clearUndoRedo(unitId)
    },
    dispose() {
      disposed = true
      for (const subscription of subscriptions.splice(0))
        subscription.dispose()
      for (const undo of uiGuards.splice(0))
        undo()
    },
  }
}
