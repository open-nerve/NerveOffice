// IMAGE() 的 restricted 包装（插件档案 v1 §6.2，计划书 §11.3，P4 设计 §3.6.7）：
// M5-P2-S3：名称在 AST 之前就已展开，必须同时验证展开前的词法证明、当前 AST 和求值字符串。
// 原执行器不读实例上的状态；其余参数继续通过 SDK 的 getVariant 求值/转换后转交。
import { BaseFunction, BaseValueObject, ErrorType, ErrorValueObject, imageLiteralSource } from '../internal-api/index.ts'

export class RestrictedImageFunction extends BaseFunction {
  override needsAstChildren = true
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

  override calculate(..._args: BaseValueObject[]): ReturnType<BaseFunction['calculate']> {
    // 无语法来源的直接调用不能放行，即使值恰好等于平台地址。
    return ErrorValueObject.create(ErrorType.VALUE)
  }

  override calculateAst(...[children, getVariant]: Parameters<BaseFunction['calculateAst']>): ReturnType<BaseFunction['calculateAst']> {
    const first = children[0]
    const literal = first && imageLiteralSource(first)
    if (literal === undefined || !this.isAllowedSource(literal) || !first)
      return ErrorValueObject.create(ErrorType.VALUE)
    const source = getVariant(first)
    if (!(source instanceof BaseValueObject) || !source.isString() || source.getValue() !== literal)
      return ErrorValueObject.create(ErrorType.VALUE)
    const rest: BaseValueObject[] = []
    for (const child of children.slice(1)) {
      const value = getVariant(child)
      // 与 SDK 原 _collectVariants 一样跳过 null；实际缺省参数是 NullValueObject。
      if (value == null)
        continue
      if (!(value instanceof BaseValueObject))
        return ErrorValueObject.create(ErrorType.VALUE)
      rest.push(value)
    }
    return this.original.calculate(source, ...rest)
  }
}
