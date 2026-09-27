// 取 Univer 实例的依赖注入容器：Facade 没有暴露的服务都经它取得（M0-P3 报告 §7"取服务"）
import type { Injector, Univer } from '@univerjs/core'

export function injectorOf(univer: Univer): Injector {
  return univer.__getInjector()
}
