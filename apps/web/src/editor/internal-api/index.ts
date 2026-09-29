// Univer 内部 API 的出口（P4 设计 §3.6.9，ADR-010）：适配层用到的、Facade 之外的符号与约定只从 internal-api/ 引用。
// 出口有两个：这里（主线程与公式 Worker 都引用），与 ui.ts（界面的包里的内部 API，只在主线程引用）。公式 Worker 引用这里，
// 这里再导出的包都会打进 Worker（Univer 的包没有声明 sideEffects，打包时去不掉），所以这里不从界面的包再导出（单元测试核对，
// P3 修复时 Worker 因此超出体积预算）。
// 每一项都在 registry.ts 里登记用途、M0 的证据与回归用例（单元测试核对两个出口导出的每一项都已登记）；
// 在这个目录之外直接引用受限的符号或调用 __getInjector，lint 会失败（eslint.config.ts 的 UNIVER_INTERNAL_SYMBOLS）。
// 这个文件只写再导出：登记表的核对按这里的写法取出导出的名字
export { FORMULA_BAR_INPUT_SELECTOR, NOTE_TEXTAREA_SELECTOR } from './dom-markers.ts'
export { FORMULA_PROTOCOL } from './formula-protocol.ts'
export { injectorOf } from './injector.ts'
export { DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY, FOCUSING_FX_BAR_EDITOR, IAuthzIoService, IContextService, IPermissionService, IUndoRedoService, LifecycleService } from '@univerjs/core'
export { IDrawingManagerService } from '@univerjs/drawing'
export { BaseFunction, ErrorType, ErrorValueObject, IActiveDirtyManagerService, IFunctionService } from '@univerjs/engine-formula'
export type { BaseValueObject } from '@univerjs/engine-formula'
export { getAllWorksheetPermissionPoint, getAllWorksheetPermissionPointByPointPanel, WorkbookCopyPermission, WorkbookViewPermission, WorksheetCopyPermission, WorksheetViewPermission } from '@univerjs/sheets'
