// 界面的包里的内部 API（P3 审查 A1、B2 之后）：只在主线程引用。公式 Worker 引用的是 index.ts，界面的包不能从那里再导出
// （会整包打进 Worker，见 index.ts 的开头）。其余同 index.ts：只写再导出，每一项在 registry.ts 登记，单元测试核对
export { IEditorService } from '@univerjs/docs-ui'
export { IRenderManagerService } from '@univerjs/engine-render'
export { HeaderFreezeRenderController } from '@univerjs/sheets-ui'
