// 表格的启动装配（kit，M6-P1 S8c，S8 spec §3.3）：表格在启动时交给编辑器页（共用编辑会话层的 start.tsx，startEditorPage）的东西——
// - 装配表：只有表格（sheetEditorAssembly 带适配层的编辑器工厂 createSheetEditor），写成 satisfies Record<OpenableDocumentType, …>，
//   与本构建能打开的类型多一项或少一项都编译不过；
// - 编辑器的加载失败：适配层的 SheetEditorLoadError（页面开始离开之后不报，见会话层 start.tsx 的 loadFailureReporter）；
// - 测试构建的两个加载器：自动保存的控制（editor/testing/autosave-control.ts，M3-P4 设计 §3.14）与交接日志（editor/testing/handover-log.ts，
//   M3-P5 设计 §3.13 的观察钩子），组装之前装上；页面自检的挂接（selftest-hook.ts，M3-P2 设计 §3.5），载入之前挂上。两个加载器都在函数里面按
//   import.meta.env.MODE === 'e2e' 判断，import() 写在判断成立的分支里：生产构建靠常量折叠去掉这两块（门禁 artifacts 按来源、按分块名、
//   禁用关键字三道核对），别的构建里交回 undefined。两个钩子各自引入，一个没引入成不影响另一个；install(window) 时先装自动保存的控制、
//   再装交接日志（原来组装处的先后）。
// 文件名照旧，按路径写的规则少动：适配层 testing/ 的这两个文件只给这里开了动态引入的口子（eslint.config.ts 的模块边界）
import type { ImageInputState } from '../../editor/index.ts'
import type { OpenableDocumentType } from '../../shared/api/client-format.ts'
import type { EditorPageKit } from '../document-editor/index.ts'
import type { SheetEditModeExtra } from './sheet-edit-mode.ts'
import type { SheetEditorAssembly, SheetEditorPageMembers } from './sheet-editor-page.ts'
import { createSheetEditor, SheetEditorLoadError } from '../../editor/index.ts'
import { DEFAULT_AUTOSAVE_LIMITS } from '../document-editor/index.ts'
import { sheetEditorAssembly } from './sheet-editor-page.ts'

export const sheetEditorPageKit: EditorPageKit<SheetEditorPageMembers, SheetEditModeExtra, ImageInputState> = {
  // 本页的装配表（M6-P1 设计 §3.4，S8 spec §2.3）：表格的装配带适配层的编辑器工厂；文字文档的装配在 M6-P2
  assemblies: { sheet: sheetEditorAssembly(createSheetEditor) } satisfies Record<OpenableDocumentType, SheetEditorAssembly>,
  isLoadFailure: error => error instanceof SheetEditorLoadError,
  async testHooks() {
    if (import.meta.env.MODE === 'e2e') {
      const [control, log] = await Promise.allSettled([import('../../editor/testing/autosave-control.ts'), import('../../editor/testing/handover-log.ts')])
      return target => ({
        autosaveControl: control.status === 'fulfilled' ? control.value.installAutosaveControl(target, DEFAULT_AUTOSAVE_LIMITS) : undefined,
        handoverTrace: log.status === 'fulfilled' ? log.value.installHandoverLog(target).observe : undefined,
      })
    }
    return undefined
  },
  async selftest() {
    if (import.meta.env.MODE === 'e2e')
      return (await import('./selftest-hook.ts')).watchForSelftest
    return undefined
  },
}
