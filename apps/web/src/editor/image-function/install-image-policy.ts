// 安装 IMAGE() 的限制（P4 设计 §3.6.7，沿用 M0 验证过的做法）：主线程与公式 Worker 各装一次。
// 内置函数在公式引擎插件 onReady 时注册（engine-formula 的 formula.controller.ts:135-147），所以在生命周期到达 Ready 之后调用：
// 取出原执行器、注册同名的包装（后注册的覆盖先注册的，function.service.ts:74-79）、清掉 IMAGE 的公式缓存，
// 再在下一个宏任务核对一次生效的仍是包装，防止同一轮里晚到的注册把它覆盖掉。
// 平台的图片地址的判定在 contracts（documents/asset-address.ts），服务端快照检查的图片规则共用它（M3-P3 设计 §3.2）
import type { Univer } from '@univerjs/core'
import { isPlatformAssetAddress } from '@nerve-office/contracts'
import { IFunctionService, injectorOf } from '../internal-api/index.ts'
import { RestrictedImageFunction } from './restricted-image-function.ts'

const IMAGE = 'IMAGE'

function applyRestriction(univer: Univer, isAllowedSource: (source: string) => boolean): boolean {
  const functions = injectorOf(univer).get(IFunctionService)
  const current = functions.getExecutor(IMAGE)
  if (current instanceof RestrictedImageFunction)
    return true
  // 引擎还没有注册 IMAGE：装早了，按失败处理（编辑器不进入编辑）
  if (current == null)
    return false
  functions.registerExecutors(new RestrictedImageFunction(current, isAllowedSource))
  functions.deleteFormulaAstCacheKey(IMAGE)
  return functions.getExecutor(IMAGE) instanceof RestrictedImageFunction
}

async function nextMacrotask(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

/** 返回 true 表示包装在 Ready 时装上、下一个宏任务时仍然生效。`origin` 是页面（或 Worker）的源 */
export async function installRestrictedImageFunction(univer: Univer, origin: string): Promise<boolean> {
  const isAllowedSource = (source: string): boolean => isPlatformAssetAddress(source, origin)
  const installed = applyRestriction(univer, isAllowedSource)
  await nextMacrotask()
  return applyRestriction(univer, isAllowedSource) && installed
}
