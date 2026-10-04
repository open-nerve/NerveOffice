// 只读时第 1 行、A 列的分隔线拖不动（DEF-027，M3-P2 S3 的 E2E 核实根因）。
// 问题：sheets-ui 的行列调整控制器（HeaderResizeRenderController）在鼠标移到行、列标题的分隔线上时，先问它的拦截点
// HEADER_RESIZE_PERMISSION_CHECK（1.0.1 的 controllers/render-controllers/header-resize.render-controller.ts；lib/es/index.js:15640、15660），
// 允许才显示调整的控制点（移上去是 row-resize、col-resize 的光标，按下就能拖）。按权限回答它的是
// SheetPermissionInterceptorCanvasRenderController 的 _initHeaderResizePermissionInterceptor（:31993-32008）：
// 它写的是 if (rangeParams.row) …… else if (rangeParams.col) ……，第 1 行、A 列的索引是 0，两个条件都不成立，一律放行。
// 于是只读时第 1 行下面、A 列右边的分隔线照样显示调整的光标、拖得动，松开时的 delta-row-height、delta-column-width 被 SDK 的
// 权限检查拦下、弹出只读的提示，数据不变；别的行列的分隔线只读时不出现。原来登记的"冻结区域的分隔线"（DEF-027）是同一件事：
// 那份样本冻结的正是第 1 行（E2E 在没有冻结的表上核实：第 1、2 行之间与 A、B 列之间有光标、拖得动，第 5、6 行之间与 D、E 列之间没有）。
// 做法：只读时在这份文档的渲染单元上，给这个拦截点注册一个优先级高于 SDK 的、总是不允许的拦截器（拦截器按优先级从高到低执行，
// 不调用 next 的拦截器的返回值就是结果：core 的 common/interceptor.ts 的 composeInterceptors；SDK 的那个没有写优先级，是 0）。
// 行列调整的控制器是渲染模块，sheets-ui 到 Rendered 才注册它（插件的 onRendered → _registerRenderModules），所以在渲染完成之后装上。
// 渲染单元与这个控制器是 SDK 的内部 API，经 internal-api 的界面出口（ui.ts）引用、已登记
import type { IRenderManagerService } from '../internal-api/ui.ts'
import { HeaderResizeRenderController } from '../internal-api/ui.ts'

/** 排在 SDK 的拦截器（没有优先级，即 0）之前 */
export const HEADER_RESIZE_LOCK_PRIORITY = 100

/** 在 unitId 这份文档的渲染单元上拦下行高、列宽的调整；返回撤掉拦截的函数，可以重复调用 */
export function lockHeaderResize(renderManager: Pick<IRenderManagerService, 'getRenderUnitById'>, unitId: string): () => void {
  const render = renderManager.getRenderUnitById(unitId)
  if (render == null)
    throw new Error(`工作簿 ${unitId} 还没有渲染：行列调整的拦截要在渲染完成之后装上`)
  const { interceptor } = render.with(HeaderResizeRenderController)
  const remove = interceptor.intercept(interceptor.getInterceptPoints().HEADER_RESIZE_PERMISSION_CHECK, { priority: HEADER_RESIZE_LOCK_PRIORITY, handler: () => false })
  return () => {
    remove()
  }
}
