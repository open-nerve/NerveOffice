// 只读时冻结线拖不动（P3 审查 B2）。
// 问题：sheets-ui 的冻结线（HeaderFreezeRenderController）在鼠标移上、按下与拖动时先问它的拦截点 FREEZE_PERMISSION_CHECK
// （1.0.1 的 controllers/render-controllers/freeze.render-controller.ts；lib/es/index.js:14306、14325、14399、14415），
// 按权限拦它的是 SheetPermissionInterceptorCanvasRenderController 的 _initFreezePermissionInterceptor（工作簿可编辑才允许，
// lib/es/index.js:32070-32077），可构造函数没有调用它（:31973-31976 只调用了另外四个）。于是只读时冻结线照样显示可以拖动的
// 光标、拖得动；松开时的 set-frozen 被 mutation 防火墙取消，模型不变，界面上的冻结线却停在拖到的位置。
// 做法：只读时在这份文档的渲染单元上，给 FREEZE_PERMISSION_CHECK 注册一个总是不允许的拦截器（与 SDK 本来要注册的那个同一个
// 拦截点、同样的效果）。冻结线是渲染模块，sheets-ui 到 Rendered 才注册它（插件的 onRendered → _registerRenderModules，
// lib/es/index.js:36024-36088），所以在渲染完成之后装上。
// 冻结区域里行列标题的分隔线（调整行高、列宽）是另一个控制器的，只读时仍显示调整的光标、拖动后弹出只读的提示，数据不变
// （SDK 与非冻结区域不一致，已写入上游报告；E2E 核对它不改动）。
// 渲染单元与冻结线的控制器是 SDK 的内部 API，经 internal-api 的界面出口（ui.ts）引用、已登记
import type { IRenderManagerService } from '../internal-api/ui.ts'
import { HeaderFreezeRenderController } from '../internal-api/ui.ts'

/** 在 unitId 这份文档的渲染单元上拦下冻结线的拖动；返回撤掉拦截的函数，可以重复调用 */
export function lockFreezeHandles(renderManager: Pick<IRenderManagerService, 'getRenderUnitById'>, unitId: string): () => void {
  const render = renderManager.getRenderUnitById(unitId)
  if (render == null)
    throw new Error(`工作簿 ${unitId} 还没有渲染：冻结线的拦截要在渲染完成之后装上`)
  const { interceptor } = render.with(HeaderFreezeRenderController)
  const remove = interceptor.intercept(interceptor.getInterceptPoints().FREEZE_PERMISSION_CHECK, { handler: () => false })
  return () => {
    remove()
  }
}
