// Univer 内部 API 的唯一出口（P4 设计 §3.6.9，ADR-010）：适配层用到的、Facade 之外的符号与约定只从这里引用。
// 每一项都在 registry.ts 里登记用途、M0 的证据与回归用例（单元测试核对导出的每一项都已登记）；
// 在这个目录之外直接引用受限的符号或调用 __getInjector，lint 会失败（eslint.config.ts 的 UNIVER_INTERNAL_SYMBOLS）。
// 这个文件只写再导出：登记表的核对按这里的写法取出导出的名字
export { FORMULA_PROTOCOL } from './formula-protocol.ts'
export { injectorOf } from './injector.ts'
export { IAuthzIoService, IPermissionService, IUndoRedoService, LifecycleService } from '@univerjs/core'
export { BaseFunction, ErrorType, ErrorValueObject, IActiveDirtyManagerService, IFunctionService } from '@univerjs/engine-formula'
export type { BaseValueObject } from '@univerjs/engine-formula'
export { getAllWorksheetPermissionPoint, getAllWorksheetPermissionPointByPointPanel, WorkbookCopyPermission, WorkbookViewPermission, WorksheetCopyPermission, WorksheetViewPermission } from '@univerjs/sheets'
