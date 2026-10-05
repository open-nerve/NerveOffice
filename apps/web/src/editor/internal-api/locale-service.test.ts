// 销毁之后不抛错的语言服务（locale-service.ts）：销毁之前与 SDK 的 LocaleService 相同，销毁之后与销毁的过程中 t() 交回键本身。
// 另外核对依赖的 SDK 行为（升级时先跑）：SDK 的 LocaleService 销毁之后仍抛错（不再抛时这项替换可以撤掉）；经 new Univer({ override })
// 换上的是这个子类，univer.dispose() 时销毁的就是它
import type { ILocales } from '@univerjs/core'
import { LocaleService, LocaleType, Univer } from '@univerjs/core'
import { describe, expect, it } from 'vitest'
import { injectorOf } from './injector.ts'
import { disposalSafeLocaleOverride, DisposalSafeLocaleService } from './locale-service.ts'

const ANALYZING = 'sheets-formula.progress.analyzing'
const COUNTED = 'sheets-formula.progress.counted'

const LOCALES: ILocales = {
  [LocaleType.ZH_CN]: { 'sheets-formula': { progress: { analyzing: '正在分析公式...', counted: '第 {0} 个，共 {1} 个' } } },
  [LocaleType.EN_US]: { 'sheets-formula': { progress: { analyzing: 'Analyzing...' } } },
}

function loaded<T extends LocaleService>(service: T): T {
  service.load(LOCALES)
  service.setLocale(LocaleType.ZH_CN)
  return service
}

/** 订阅 currentLocale$ 的完成，在完成的回调里调用 t()：SDK 销毁时先清空语言包、再完成各个 Subject（locale.service.ts:41-46） */
function translateOnComplete(service: LocaleService): unknown[] {
  const seen: unknown[] = []
  service.currentLocale$.subscribe({
    complete: () => {
      try {
        seen.push(service.t(ANALYZING))
      }
      catch (error) {
        seen.push(error)
      }
    },
  })
  return seen
}

describe('DisposalSafeLocaleService：销毁之前', () => {
  it('与 SDK 的 LocaleService 相同：按当前语言翻译、替换参数，找不到的键交回键本身，换了语言照常', () => {
    const sdk = loaded(new LocaleService())
    const safe = loaded(new DisposalSafeLocaleService())
    const cases: [string, ...string[]][] = [[ANALYZING], [COUNTED, '3', '10'], ['sheets-formula.progress.missing'], ['no-such-key']]
    for (const [key, ...args] of cases)
      expect(safe.t(key, ...args), key).toBe(sdk.t(key, ...args))
    expect(safe.t(ANALYZING)).toBe('正在分析公式...')
    expect(safe.t(COUNTED, '3', '10')).toBe('第 3 个，共 10 个')
    sdk.setLocale(LocaleType.EN_US)
    safe.setLocale(LocaleType.EN_US)
    expect(safe.t(ANALYZING)).toBe(sdk.t(ANALYZING))
    expect(safe.t(ANALYZING)).toBe('Analyzing...')
  })

  it('还没载入语言包时与 SDK 一样抛错（只改销毁之后）', () => {
    expect(() => new LocaleService().t(ANALYZING)).toThrow('[LocaleService]: Locale not initialized')
    expect(() => new DisposalSafeLocaleService().t(ANALYZING)).toThrow('[LocaleService]: Locale not initialized')
  })
})

describe('DisposalSafeLocaleService：销毁之后', () => {
  it('依赖的 SDK 行为：SDK 的 LocaleService 销毁之后 t() 抛错（不再抛时这项替换可以撤掉）', () => {
    const sdk = loaded(new LocaleService())
    sdk.dispose()
    expect(() => sdk.t(ANALYZING)).toThrow('[LocaleService]: Locale not initialized')
  })

  it('t() 交回键本身、不抛错，带参数的也一样；再销毁一次照样', () => {
    const safe = loaded(new DisposalSafeLocaleService())
    safe.dispose()
    expect(safe.t(ANALYZING)).toBe(ANALYZING)
    expect(safe.t(COUNTED, '3', '10')).toBe(COUNTED)
    safe.dispose()
    expect(safe.t(ANALYZING)).toBe(ANALYZING)
  })

  it('销毁的过程中（SDK 已经清空语言包、正在完成各个 Subject）在完成的回调里调用 t() 同样不抛错；对照：SDK 的这时抛错', () => {
    const safe = loaded(new DisposalSafeLocaleService())
    const seenBySafe = translateOnComplete(safe)
    safe.dispose()
    expect(seenBySafe).toEqual([ANALYZING])

    const sdk = loaded(new LocaleService())
    const seenBySdk = translateOnComplete(sdk)
    sdk.dispose()
    expect(seenBySdk).toHaveLength(1)
    expect(seenBySdk[0]).toBeInstanceOf(Error)
  })

  it('依赖的 SDK 行为：其余方法销毁之后本来就不抛错（所以只改 t）——取语言包、读写当前语言与方向', () => {
    const sdk = loaded(new LocaleService())
    sdk.dispose()
    expect(sdk.getLocales()).toBeUndefined()
    expect(() => sdk.setLocale(LocaleType.EN_US)).not.toThrow()
    expect(() => sdk.getCurrentLocale()).not.toThrow()
    expect(() => sdk.setDirection('rtl')).not.toThrow()
    expect(() => sdk.getDirection()).not.toThrow()
  })
})

describe('disposalSafeLocaleOverride（交给 new Univer({ override })）', () => {
  it('核心注入器里的 LocaleService 换成这个子类：Univer 照常载入语言包、设语言；univer.dispose() 之后 t() 交回键本身', () => {
    const univer = new Univer({ locale: LocaleType.ZH_CN, locales: LOCALES, override: disposalSafeLocaleOverride() })
    const service = injectorOf(univer).get(LocaleService)
    expect(service).toBeInstanceOf(DisposalSafeLocaleService)
    expect(service.t(ANALYZING)).toBe('正在分析公式...')
    univer.dispose()
    expect(service.t(ANALYZING)).toBe(ANALYZING)
  })

  it('对照：不换时 univer.dispose() 之后 t() 抛错（main 16f8a1d 的 CI 上那条页面异常）', () => {
    const univer = new Univer({ locale: LocaleType.ZH_CN, locales: LOCALES })
    const service = injectorOf(univer).get(LocaleService)
    univer.dispose()
    expect(() => service.t(ANALYZING)).toThrow('[LocaleService]: Locale not initialized')
  })

  it('只替换 LocaleService 这一项，每次给出新的数组；每个 Univer 实例各自构造一个', () => {
    const override = disposalSafeLocaleOverride()
    expect(override).toEqual([[LocaleService, { useClass: DisposalSafeLocaleService }]])
    expect(disposalSafeLocaleOverride()).not.toBe(override)
    const first = new Univer({ locales: LOCALES, override })
    const second = new Univer({ locales: LOCALES, override })
    expect(injectorOf(first).get(LocaleService)).not.toBe(injectorOf(second).get(LocaleService))
    first.dispose()
    second.dispose()
  })
})
