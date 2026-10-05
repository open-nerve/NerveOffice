// 资源守卫（M3-P4 设计 §3.11 第 1 条）：真实的 Univer core（资源管理服务被守卫换掉、真实的资源加载服务）+ 假的资源 hook。
// 单元加入之前登记的 hook 由单元加入时的 loadResources 加载，之后登记的经 register$ 走 loadHookResource（晚注册）——
// 两条路径都要经过包装；四类失败、空串与深层为空不误报；包装只观察（异常原样抛出、返回值原样返回、this 与参数原样交给插件）
import type { IResourceHook, IResources, IResourceManagerService as ResourceManager } from '@univerjs/core'
import type { MockInstance } from 'vitest'
import { hasResourceContent, profileResourceNames, sheetSnapshotFor } from '@nerve-office/contracts'
import { IResourceManagerService, LogLevel, Univer, UniverInstanceType } from '@univerjs/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { editorIdentityOverride } from '../identity/editor-authz-io.service.ts'
import { dataPluginEntries, snapshotWithResources } from '../profile/data-plugins.test-support.ts'
import { injectorOf } from './index.ts'
import { createResourceLoadGuard } from './resource-load-guard.ts'

vi.hoisted(() => {
  // jsdom 没有 Path2D：档案里的界面包在模块求值时就创建它（data-plugins.test-support.ts 引用档案）。这里不渲染
  globalThis.Path2D ??= class {} as unknown as typeof Path2D
})

const UNIT_ID = 'guard-unit'

/** 记下每次调用的假 hook：parseJson 用给定的实现（默认 JSON.parse，空串给 {}），onLoad 记下载入的模型，toJson 给出记下的模型 */
interface FakeHook extends IResourceHook<unknown> {
  readonly loaded: unknown[]
}

function fakeHook(name: IResourceHook['pluginName'], options: {
  readonly parse?: (json: string) => unknown
  readonly load?: (model: unknown) => void
  readonly serialize?: (unitId: string) => string
  readonly businesses?: UniverInstanceType[]
} = {}): FakeHook {
  const loaded: unknown[] = []
  return {
    pluginName: name,
    businesses: options.businesses ?? [UniverInstanceType.UNIVER_SHEET],
    loaded,
    parseJson: options.parse ?? (json => (json === '' ? {} : JSON.parse(json) as unknown)),
    onLoad: (_unitId, model) => {
      options.load?.(model)
      loaded.push(model)
    },
    onUnLoad: () => {},
    toJson: options.serialize ?? (() => JSON.stringify(loaded.at(-1) ?? {})),
  }
}

let univer: Univer
let guard: ReturnType<typeof createResourceLoadGuard>
/** 晚注册的路径出错时 SDK 直接 console.error（resource-loader.service.ts）：接住，不打印，用例可以核对它 */
let consoleError: MockInstance<(...data: unknown[]) => void>

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  guard = createResourceLoadGuard()
  univer = new Univer({ logLevel: LogLevel.SILENT, override: guard.override })
})

afterEach(() => {
  univer.dispose()
  vi.restoreAllMocks()
})

function manager(): ResourceManager {
  return injectorOf(univer).get(IResourceManagerService)
}

/** 建工作簿：之前登记的 hook 经 loadResources 加载（单元加入时） */
function createWorkbook(resources: IResources): void {
  univer.createUnit(UniverInstanceType.UNIVER_SHEET, { id: UNIT_ID, sheetOrder: [], sheets: {}, resources })
}

type LoadPath = 'loadResources' | 'loadHookResource'

/**
 * 记下 parseJson 是在哪条路径上被调用的：资源管理服务的 loadResources 期间（单元加入时），还是之外（晚注册的 loadHookResource）。
 * 用例据此核对前提：构造的确实走了要测的那条路径
 */
function trackPaths(): { readonly paths: LoadPath[], readonly parse: (inner: (json: string) => unknown) => (json: string) => unknown } {
  const paths: LoadPath[] = []
  let inLoadResources = false
  const service = manager()
  const original = service.loadResources.bind(service)
  vi.spyOn(service, 'loadResources').mockImplementation((unitId, resources) => {
    inLoadResources = true
    try {
      original(unitId, resources)
    }
    finally {
      inLoadResources = false
    }
  })
  return {
    paths,
    parse: inner => (json) => {
      paths.push(inLoadResources ? 'loadResources' : 'loadHookResource')
      return inner(json)
    },
  }
}

/** 按路径登记 hook、建工作簿：loadResources 先登记再建，loadHookResource 先建再登记 */
function loadThrough(path: LoadPath, hook: FakeHook, resources: IResources): void {
  if (path === 'loadResources') {
    manager().registerPluginResource(hook)
    createWorkbook(resources)
  }
  else {
    createWorkbook(resources)
    manager().registerPluginResource(hook)
  }
}

describe('守卫装在资源管理服务上（new Univer({ override })）', () => {
  it('注入器里的资源管理服务就是守卫的实例：sheetHookNames 只列 business 含表格的 hook，按登记的先后', () => {
    manager().registerPluginResource(fakeHook('SHEET_A_PLUGIN'))
    manager().registerPluginResource(fakeHook('DOC_B_PLUGIN', { businesses: [UniverInstanceType.UNIVER_DOC] }))
    manager().registerPluginResource(fakeHook('SHEET_C_PLUGIN', { businesses: [UniverInstanceType.UNIVER_DOC, UniverInstanceType.UNIVER_SHEET] }))
    expect(guard.sheetHookNames()).toEqual(['SHEET_A_PLUGIN', 'SHEET_C_PLUGIN'])
  })

  it('一个守卫只用于一个 Univer 实例；没有经它创建资源管理服务时取 hook 名、捕获都报错（不悄悄当作没有失败）', () => {
    expect(() => new Univer({ logLevel: LogLevel.SILENT, override: guard.override })).toThrow()
    const unused = createResourceLoadGuard()
    expect(() => unused.sheetHookNames()).toThrow(/资源守卫没有生效/)
    expect(() => unused.captureSheetResources(UNIT_ID)).toThrow(/资源守卫没有生效/)
  })
})

describe('两条加载路径都经过包装', () => {
  it('单元加入之前登记的（loadResources）与之后登记的（晚注册的 loadHookResource）：模型照常载入，没有失败', () => {
    const tracking = trackPaths()
    const early = fakeHook('SHEET_EARLY_PLUGIN', { parse: tracking.parse(json => JSON.parse(json) as unknown) })
    manager().registerPluginResource(early)
    createWorkbook([{ name: 'SHEET_EARLY_PLUGIN', data: '{"s1":[1]}' }, { name: 'SHEET_LATE_PLUGIN', data: '{"s1":{"a":1}}' }])
    const late = fakeHook('SHEET_LATE_PLUGIN', { parse: tracking.parse(json => JSON.parse(json) as unknown) })
    manager().registerPluginResource(late)
    expect(tracking.paths).toEqual(['loadResources', 'loadHookResource'])
    expect(early.loaded).toEqual([{ s1: [1] }])
    expect(late.loaded).toEqual([{ s1: { a: 1 } }])
    expect(guard.loadFailures()).toEqual([])
  })

  it.each(['loadResources', 'loadHookResource'] as const)('%s：解析抛错（非空的截断 JSON，裸 JSON.parse）记 parse-threw 与构造器名，SDK 吞掉异常、模型没有载入', (path) => {
    const tracking = trackPaths()
    const hook = fakeHook('SHEET_FILTER_PLUGIN', { parse: tracking.parse(json => JSON.parse(json) as unknown) })
    loadThrough(path, hook, [{ name: 'SHEET_FILTER_PLUGIN', data: '{"s1":{"ref":' }])
    expect(tracking.paths).toEqual([path])
    expect(hook.loaded).toEqual([])
    expect(guard.loadFailures()).toEqual([{ kind: 'parse-threw', resource: 'SHEET_FILTER_PLUGIN', error: 'SyntaxError' }])
  })

  it.each(['loadResources', 'loadHookResource'] as const)('%s：非空的输入被吞成空值（解析不了给 {}）记 parse-swallowed', (path) => {
    const swallowing = (json: string): unknown => {
      try {
        return JSON.parse(json) as unknown
      }
      catch {
        return {}
      }
    }
    const tracking = trackPaths()
    const hook = fakeHook('SHEET_CONDITIONAL_FORMATTING_PLUGIN', { parse: tracking.parse(swallowing) })
    loadThrough(path, hook, [{ name: 'SHEET_CONDITIONAL_FORMATTING_PLUGIN', data: '{"s1":[{"cfId":"c' }])
    expect(tracking.paths).toEqual([path])
    expect(hook.loaded).toEqual([{}])
    expect(guard.loadFailures()).toEqual([{ kind: 'parse-swallowed', resource: 'SHEET_CONDITIONAL_FORMATTING_PLUGIN' }])
  })

  it.each(['loadResources', 'loadHookResource'] as const)('%s：载入抛错（结构不对）记 load-threw 与构造器名', (path) => {
    const tracking = trackPaths()
    const hook = fakeHook('SHEET_DATA_VALIDATION_PLUGIN', {
      parse: tracking.parse(json => JSON.parse(json) as unknown),
      load: (model) => {
        for (const rules of Object.values(model as Record<string, unknown>))
          (rules as unknown[]).forEach(() => {})
      },
    })
    loadThrough(path, hook, [{ name: 'SHEET_DATA_VALIDATION_PLUGIN', data: '{"s1":{"a":1}}' }])
    expect(tracking.paths).toEqual([path])
    expect(hook.loaded).toEqual([])
    expect(guard.loadFailures()).toEqual([{ kind: 'load-threw', resource: 'SHEET_DATA_VALIDATION_PLUGIN', error: 'TypeError' }])
  })
})

describe('不误报', () => {
  it('空串：loadResources 跳过它；晚注册的路径照样交给 parseJson，裸 JSON.parse 抛错——输入为空，不算', () => {
    const tracking = trackPaths()
    const early = fakeHook('SHEET_EARLY_PLUGIN', { parse: tracking.parse(json => JSON.parse(json) as unknown) })
    manager().registerPluginResource(early)
    createWorkbook([{ name: 'SHEET_EARLY_PLUGIN', data: '' }, { name: 'SHEET_FILTER_PLUGIN', data: '' }])
    const late = fakeHook('SHEET_FILTER_PLUGIN', { parse: tracking.parse(json => JSON.parse(json) as unknown) })
    manager().registerPluginResource(late)
    // 前提：loadResources 没把空串交给 parseJson，晚注册的路径交了，而且它抛错了（模型没有载入）
    expect(tracking.paths).toEqual(['loadHookResource'])
    expect(late.loaded).toEqual([])
    expect(early.loaded).toEqual([])
    expect(guard.loadFailures()).toEqual([])
  })

  it('深层为空的输入解析成空值（规则删光之后的 {表:[]}、{}）：不算吞成空值', () => {
    createWorkbook([{ name: 'SHEET_A_PLUGIN', data: '{"s1":[]}' }, { name: 'SHEET_B_PLUGIN', data: '{}' }])
    manager().registerPluginResource(fakeHook('SHEET_A_PLUGIN', { parse: () => ({}) }))
    manager().registerPluginResource(fakeHook('SHEET_B_PLUGIN'))
    expect(guard.loadFailures()).toEqual([])
  })

  it('深层为空的输入解析时抛错：不算解析抛错（输入本来就没有内容）', () => {
    createWorkbook([{ name: 'SHEET_A_PLUGIN', data: '{"s1":[]}' }])
    manager().registerPluginResource(fakeHook('SHEET_A_PLUGIN', {
      parse: () => {
        throw new TypeError('不认 {表:[]}')
      },
    }))
    expect(guard.loadFailures()).toEqual([])
  })

  it('非空的输入解析成非空的值、照常载入：没有失败', () => {
    createWorkbook([{ name: 'SHEET_A_PLUGIN', data: '{"s1":[{"id":"r1"}]}' }])
    manager().registerPluginResource(fakeHook('SHEET_A_PLUGIN'))
    expect(guard.loadFailures()).toEqual([])
  })
})

describe('包装只观察：委托给插件的 hook，异常原样抛出、返回值原样返回', () => {
  it('this、参数与返回值原样；异常是同一个对象；构造器名之外不记 message', () => {
    class ClassHook implements IResourceHook<{ readonly rules: number }> {
      readonly pluginName = 'SHEET_CLASS_PLUGIN' as const
      readonly businesses = [UniverInstanceType.UNIVER_SHEET]
      readonly model = { rules: 1 }
      readonly calls: unknown[][] = []
      readonly failure = new SyntaxError('Unexpected token \'机\', "{"note": 机密}" is not valid JSON')
      parseJson(json: string): { readonly rules: number } {
        if (json === 'bad')
          throw this.failure
        return this.model
      }

      onLoad(unitId: string, model: { readonly rules: number }): void {
        this.calls.push(['onLoad', unitId, model])
      }

      onUnLoad(unitId: string): void {
        this.calls.push(['onUnLoad', unitId])
      }

      toJson(unitId: string, model?: { readonly rules: number }): string {
        this.calls.push(['toJson', unitId, model])
        return 'serialized'
      }
    }
    const hook = new ClassHook()
    manager().registerPluginResource(hook)
    const wrapped = manager().getAllResourceHooks()[0] as IResourceHook<{ readonly rules: number }>
    expect(wrapped).not.toBe(hook)
    expect([wrapped.pluginName, wrapped.businesses]).toEqual([hook.pluginName, hook.businesses])
    expect(wrapped.businesses).toBe(hook.businesses)
    expect(wrapped.parseJson('{"rules":1}')).toBe(hook.model)
    expect(() => wrapped.parseJson('bad')).toThrow(hook.failure)
    wrapped.onLoad('u', hook.model)
    wrapped.onUnLoad('u')
    expect(wrapped.toJson('u', hook.model)).toBe('serialized')
    expect(wrapped.toJson('u')).toBe('serialized')
    expect(hook.calls).toEqual([['onLoad', 'u', hook.model], ['onUnLoad', 'u'], ['toJson', 'u', hook.model], ['toJson', 'u', undefined]])
    expect(guard.loadFailures()).toEqual([{ kind: 'parse-threw', resource: 'SHEET_CLASS_PLUGIN', error: 'SyntaxError' }])
    expect(JSON.stringify(guard.loadFailures())).not.toContain('机密')
  })

  it('onLoad 抛出的异常原样抛出；抛出的不是对象时不带构造器名', () => {
    const failure = new RangeError('x')
    manager().registerPluginResource(fakeHook('SHEET_A_PLUGIN', {
      load: () => {
        throw failure
      },
    }))
    manager().registerPluginResource(fakeHook('SHEET_B_PLUGIN', {
      load: () => {
        // eslint-disable-next-line no-throw-literal -- 构造：插件抛出的不是 Error
        throw 'not an error'
      },
    }))
    const [a, b] = manager().getAllResourceHooks()
    expect(() => a?.onLoad('u', {})).toThrow(failure)
    expect(() => b?.onLoad('u', {})).toThrow('not an error')
    expect(guard.loadFailures()).toEqual([{ kind: 'load-threw', resource: 'SHEET_A_PLUGIN', error: 'RangeError' }, { kind: 'load-threw', resource: 'SHEET_B_PLUGIN' }])
  })

  it('观察本身出错（模型上有抛错的 getter）：不改变加载，什么也不记', () => {
    const trap = Object.defineProperty({}, 'rules', {
      enumerable: true,
      get: () => {
        throw new Error('getter')
      },
    })
    manager().registerPluginResource(fakeHook('SHEET_A_PLUGIN', { parse: () => trap }))
    const [wrapped] = manager().getAllResourceHooks()
    expect(wrapped?.parseJson('{"rules":1}')).toBe(trap)
    expect(guard.loadFailures()).toEqual([])
  })
})

/**
 * SDK 的行为（registry.ts 这一项依赖的约定，升级 SDK 时先跑）：档案里的数据插件（profile/data-plugins.test-support.ts）在 jsdom 里起真实的
 * Univer core，与设计前的探索 B 在三个浏览器上的探针同样的构造（p4b-probe-summary.txt）
 */
describe('1.0.1 的表格资源 hook（真实的数据插件，档案里去掉界面的部分）', () => {
  const ALL_SHEET_HOOKS = profileResourceNames('sheet@1')

  /** 起一个带守卫与编辑器身份的 Univer、注册档案的数据插件，返回单元加入时（loadResources）已经注册的表格 hook */
  function loadWithPlugins(snapshot: string): { readonly atUnitAdded: readonly string[] } {
    univer.dispose()
    guard = createResourceLoadGuard()
    univer = new Univer({ logLevel: LogLevel.SILENT, override: [...editorIdentityOverride('edit'), ...guard.override] })
    for (const entry of dataPluginEntries())
      entry.register(univer)
    const service = manager()
    const original = service.loadResources.bind(service)
    let atUnitAdded: readonly string[] = []
    vi.spyOn(service, 'loadResources').mockImplementation((unitId, resources) => {
      atUnitAdded = guard.sheetHookNames()
      original(unitId, resources)
    })
    univer.createUnit(UniverInstanceType.UNIVER_SHEET, JSON.parse(snapshot) as object)
    return { atUnitAdded }
  }

  it('十个表格 hook 都在 createUnit 返回之前注册并加载完：6 个在单元加入时（loadResources），4 个在 Ready（晚注册）；没有白名单之外的', () => {
    const { atUnitAdded } = loadWithPlugins(snapshotWithResources(UNIT_ID))
    expect([...guard.sheetHookNames()].sort()).toEqual(ALL_SHEET_HOOKS)
    expect([...atUnitAdded].sort()).toEqual(['SHEET_CONDITIONAL_FORMATTING_PLUGIN', 'SHEET_DRAWING_PLUGIN', 'SHEET_NOTE_PLUGIN', 'SHEET_RANGE_PROTECTION_PLUGIN', 'SHEET_WORKSHEET_PROTECTION_PLUGIN', 'SHEET_WORKSHEET_PROTECTION_POINT_PLUGIN'])
  })

  it('模板与六项内容资源都非空的快照：没有加载失败；捕获出的六项都有内容（无误报的前提）', () => {
    loadWithPlugins(sheetSnapshotFor(UNIT_ID))
    expect(guard.loadFailures()).toEqual([])
    expect(guard.captureSheetResources(UNIT_ID).failures).toEqual([])
    loadWithPlugins(snapshotWithResources(UNIT_ID))
    expect(guard.loadFailures()).toEqual([])
    const captured = guard.captureSheetResources(UNIT_ID)
    expect(captured.failures).toEqual([])
    expect(captured.outputs.filter(output => hasResourceContent(output.data)).map(output => output.name).sort()).toEqual(['SHEET_CONDITIONAL_FORMATTING_PLUGIN', 'SHEET_DATA_VALIDATION_PLUGIN', 'SHEET_DEFINED_NAME_PLUGIN', 'SHEET_DRAWING_PLUGIN', 'SHEET_FILTER_PLUGIN', 'SHEET_NOTE_PLUGIN'])
  })

  it('筛选的 data 为空串：晚注册的路径照样解析而抛错（SDK 的 console.error），不算失败', () => {
    loadWithPlugins(snapshotWithResources(UNIT_ID, { SHEET_FILTER_PLUGIN: '' }))
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Resources{SHEET_FILTER_PLUGIN} Data Error.'))
    expect(guard.loadFailures()).toEqual([])
  })

  const truncate = (name: string): Record<string, string> => {
    const data = (JSON.parse(snapshotWithResources(UNIT_ID)) as { resources: { name: string, data: string }[] }).resources.find(item => item.name === name)?.data ?? ''
    return { [name]: data.slice(0, Math.floor(data.length / 2)) }
  }

  it('截断的筛选（裸 JSON.parse）：parse-threw，构造器名 SyntaxError；之后筛选为空', () => {
    loadWithPlugins(snapshotWithResources(UNIT_ID, truncate('SHEET_FILTER_PLUGIN')))
    expect(guard.loadFailures()).toEqual([{ kind: 'parse-threw', resource: 'SHEET_FILTER_PLUGIN', error: 'SyntaxError' }])
    expect(hasResourceContent(guard.captureSheetResources(UNIT_ID).outputs.find(output => output.name === 'SHEET_FILTER_PLUGIN')?.data)).toBe(false)
  })

  it.each(['SHEET_CONDITIONAL_FORMATTING_PLUGIN', 'SHEET_DATA_VALIDATION_PLUGIN', 'SHEET_NOTE_PLUGIN', 'SHEET_DRAWING_PLUGIN', 'SHEET_DEFINED_NAME_PLUGIN'])('截断的 %s（插件解析不了给 {}）：parse-swallowed；之后为空', (name) => {
    loadWithPlugins(snapshotWithResources(UNIT_ID, truncate(name)))
    expect(guard.loadFailures()).toEqual([{ kind: 'parse-swallowed', resource: name }])
    expect(hasResourceContent(guard.captureSheetResources(UNIT_ID).outputs.find(output => output.name === name)?.data)).toBe(false)
  })

  it.each([
    ['SHEET_CONDITIONAL_FORMATTING_PLUGIN', 5],
    ['SHEET_CONDITIONAL_FORMATTING_PLUGIN', { a: 1 }],
    ['SHEET_DATA_VALIDATION_PLUGIN', { a: 1 }],
    ['SHEET_DATA_VALIDATION_PLUGIN', 5],
  ])('%s 的规则表写成 %j：load-threw，构造器名 TypeError', (name, value) => {
    loadWithPlugins(snapshotWithResources(UNIT_ID, { [name]: JSON.stringify({ 'sheet-1': value }) }))
    expect(guard.loadFailures()).toEqual([{ kind: 'load-threw', resource: name, error: 'TypeError' }])
  })

  it('{表:5} 的备注：静默装不进（守卫没有记录），之后为空——只有资源比较认得出', () => {
    loadWithPlugins(snapshotWithResources(UNIT_ID, { SHEET_NOTE_PLUGIN: JSON.stringify({ 'sheet-1': 5 }) }))
    expect(guard.loadFailures()).toEqual([])
    expect(hasResourceContent(guard.captureSheetResources(UNIT_ID).outputs.find(output => output.name === 'SHEET_NOTE_PLUGIN')?.data)).toBe(false)
  })

  it('{表:5} 的筛选（不在当前的工作表上，与探针相同）：加载不报错，之后 toJson 抛错——serialize-threw，构造器名 TypeError', () => {
    // 在当前的工作表上时，筛选的控制器订阅加载完成之后取它的范围，在订阅里抛错（rxjs 异步报出）；放在第二张表上，与探针的构造一致
    const snapshot = JSON.parse(snapshotWithResources(UNIT_ID, { SHEET_FILTER_PLUGIN: JSON.stringify({ 'sheet-2': 5 }) })) as { sheetOrder: string[], sheets: Record<string, object> }
    snapshot.sheets['sheet-2'] = { ...snapshot.sheets['sheet-1'], id: 'sheet-2', name: '工作表2' }
    snapshot.sheetOrder.push('sheet-2')
    loadWithPlugins(JSON.stringify(snapshot))
    expect(guard.loadFailures()).toEqual([])
    expect(guard.captureSheetResources(UNIT_ID).failures).toEqual([{ kind: 'serialize-threw', resource: 'SHEET_FILTER_PLUGIN', error: 'TypeError' }])
  })
})

describe('逐个表格 hook 的捕获（captureSheetResources）', () => {
  it('每个表格 hook 的 toJson(unitId) 各自 try/catch：抛错的记 serialize-threw 与构造器名，没给出字符串的同样算；别的 business 的不捕获', () => {
    manager().registerPluginResource(fakeHook('SHEET_A_PLUGIN', { serialize: unitId => `{"unit":"${unitId}"}` }))
    manager().registerPluginResource(fakeHook('SHEET_FILTER_PLUGIN', {
      serialize: () => {
        throw new TypeError('Cannot read properties of undefined (reading \'rangeType\')')
      },
    }))
    manager().registerPluginResource(fakeHook('SHEET_B_PLUGIN', { serialize: () => 5 as unknown as string }))
    manager().registerPluginResource(fakeHook('DOC_C_PLUGIN', {
      businesses: [UniverInstanceType.UNIVER_DOC],
      serialize: () => {
        throw new Error('文字文档的不捕获')
      },
    }))
    expect(guard.captureSheetResources(UNIT_ID)).toEqual({
      outputs: [{ name: 'SHEET_A_PLUGIN', data: `{"unit":"${UNIT_ID}"}` }],
      failures: [{ kind: 'serialize-threw', resource: 'SHEET_FILTER_PLUGIN', error: 'TypeError' }, { kind: 'serialize-threw', resource: 'SHEET_B_PLUGIN' }],
    })
  })

  it('与保存同一个口径：输出就是 SDK 保存时写进 resources 的（getResourcesByType）', () => {
    manager().registerPluginResource(fakeHook('SHEET_A_PLUGIN'))
    manager().registerPluginResource(fakeHook('DOC_B_PLUGIN', { businesses: [UniverInstanceType.UNIVER_DOC] }))
    createWorkbook([{ name: 'SHEET_A_PLUGIN', data: '{"s1":[1]}' }])
    expect(guard.captureSheetResources(UNIT_ID).outputs).toEqual(manager().getResourcesByType(UNIT_ID, UniverInstanceType.UNIVER_SHEET))
  })
})
