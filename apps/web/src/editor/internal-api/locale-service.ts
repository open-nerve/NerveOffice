// 销毁之后不抛错的语言服务（registry.ts 的 disposalSafeLocaleOverride，ADR-010）：经 new Univer({ override }) 换掉核心注入器里的 LocaleService。
// 问题：SDK 的 LocaleService 销毁时清空语言包，之后 t() 一律抛出"[LocaleService]: Locale not initialized"（core 的 locale.service.ts:41-46、84；
// 1.0.1 的 lib/es/index.js:25443-25448、25431）；而 SDK 里有销毁之后才到点、还会调 t() 的计时器：sheets-formula 的 TriggerCalculationController
// 收到一轮计算的开始通知时设一个 1 秒的计时器，到点调 t() 取"正在分析公式..."，这一轮算完时清掉，销毁时却不清
// （trigger-calculation.controller.ts:79-85、196-215、141-146；1.0.1 的 lib/es/index.js:392-397、466-476、438-442）。阅读与编辑之间的切换一律重建
// 编辑器（M3-P2 设计 §3.1），旧的那一个在这 1 秒里销毁、这一轮又还没算完时，到点就是一条没接住的页面异常（main 16f8a1d 的 CI）。
// 做法：子类只改销毁之后的 t()——交回键本身（与 SDK 找不到译文时的结果相同），不抛错；那时调用方已经销毁，它的进度 Subject 已经完成，
// 交回的文字没有去处。销毁之前的行为完全不变，load 之前调用照样抛错。其余方法销毁之后本来就不抛错（getLocales 用可选链；setLocale、
// getCurrentLocale、getDirection 读写的 BehaviorSubject 只是完成、没有退订），所以只改 t()。不依赖计时器的时长，也不延迟销毁。
// 依赖的 SDK 行为（升级时由 locale-service.test.ts 核对）：
// (1) t 是构造时定义在实例上的箭头函数，不在原型上（1.0.1 的 lib/es/index.js:25402-25442）：子类在 super() 之后取下它、换上自己的；
// (2) 核心注入器按 [LocaleService] 登记它，override 按标识符换掉（core 的 univer.ts:274-297、plugin-override.ts:28-43；1.0.1 的
//     lib/es/index.js:28681-28684、26444-26455），插件按 LocaleService 注入的都是这一个实例；
// (3) univer.dispose() 销毁注入器，注入器调用实例的 dispose()（1.0.1 的 lib/es/index.js:28631-28634；redi 1.1.3 的
//     ResolvedDependencyCollection.dispose，dist/esm/index.js:715）。
import type { DependencyOverride } from '@univerjs/core'
import { LocaleService } from '@univerjs/core'

export class DisposalSafeLocaleService extends LocaleService {
  /** 已经开始销毁：销毁的过程中（完成各个 Subject 时）调用 t() 同样不抛错 */
  private disposing = false

  constructor() {
    super()
    const translate = this.t
    this.t = (key, ...args) => this.disposing ? key : translate(key, ...args)
  }

  override dispose(): void {
    this.disposing = true
    super.dispose()
  }
}

/** 交给 new Univer({ override })：核心注入器里的 LocaleService 换成 DisposalSafeLocaleService（每个 Univer 实例各自构造一个） */
export function disposalSafeLocaleOverride(): DependencyOverride {
  return [[LocaleService, { useClass: DisposalSafeLocaleService }]]
}
