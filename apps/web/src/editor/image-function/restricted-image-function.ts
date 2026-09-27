// IMAGE() 的 restricted 包装（插件档案 v1 §6.2，计划书 §11.3，P4 设计 §3.6.7）：
// 第一个参数是平台资源地址（字符串）才交给原执行器，否则返回 #VALUE!，不产生请求。
// 引用在计算时已经变成数组（engine-formula 的 function-node.ts:166-168），数组不是字符串，所以单元格引用、区域与数组常量都被拒绝；
// 拼接出来的字符串在这里与字面量分不开，要到 M5 有了资源服务再定。原执行器不读实例上的状态，直接转交即可
import type { BaseValueObject } from '../internal-api/index.ts'
import { BaseFunction, ErrorType, ErrorValueObject } from '../internal-api/index.ts'

export class RestrictedImageFunction extends BaseFunction {
  private readonly original: BaseFunction
  private readonly isAllowedSource: (source: string) => boolean

  constructor(original: BaseFunction, isAllowedSource: (source: string) => boolean) {
    super(original.name)
    this.original = original
    this.isAllowedSource = isAllowedSource
    // 参数个数的检查沿用原执行器（1 到 5 个）
    this.minParams = original.minParams
    this.maxParams = original.maxParams
  }

  override calculate(source: BaseValueObject, ...rest: BaseValueObject[]): ReturnType<BaseFunction['calculate']> {
    if (!source.isString() || !this.isAllowedSource(String(source.getValue())))
      return ErrorValueObject.create(ErrorType.VALUE)
    return this.original.calculate(source, ...rest)
  }
}
