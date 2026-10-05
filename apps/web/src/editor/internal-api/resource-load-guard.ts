// 资源加载的守卫（M3-P4 设计 §3.11 第 1 条，ADR-010 的登记）：打开自检要知道插件的资源 hook 有没有完整注册、各项资源有没有完整载入。
// SDK 没有资源相关的公开 API，资源管理服务又只能在创建 Univer 时换掉：注入器构造时就 touch 资源加载服务，它拿走资源管理服务的实例、
// 订阅它的 register$（core 的 univer.ts 的 createUniverInjector；1.0.1 的 lib/es/index.js:28719），之后再替换无效。所以：
// - 在 new Univer({ override }) 里以 useFactory（deps: ILogService）换上 ResourceManagerService 的子类，只覆盖 registerPluginResource：
//   把插件交来的 hook 包一层再交给原来的实现。两条加载路径——单元加入时的 loadResources（全部已注册的 hook）与之后注册的 hook 经
//   register$ 走资源加载服务的 loadHookResource——取到的都是包过的 hook；
// - 包装只观察：parseJson、onLoad 显式委托给插件的 hook（this 不丢，类实例写的 hook 也成立），出错时记下再原样抛出（SDK 自己的 catch
//   照旧只记日志），返回值原样返回；toJson、onUnLoad 原样委托。观察本身出错（例如模型上有抛错的 getter）一律吞掉，不改变加载的行为；
// - 记下的失败：parse-threw（非空的输入解析时抛错；空串的不算——晚注册的路径照样把空串交给 parseJson，筛选的裸 JSON.parse 会抛错）、
//   parse-swallowed（非空的输入解析成深层为空的值）、load-threw（onLoad 抛错）。"非空"与"空"按 contracts 的 hasResourceContent、
//   isDeepEmpty，与资源比较同一个口径。只记资源名、种类与异常的构造器名，不记 message（JSON.parse 的报错带着输入的片段）；
// - 另外给出表格（business 含 UNIVER_SHEET）的 hook 名，以及逐个 hook 调 toJson 的捕获（各自 try/catch，抛错的记 serialize-threw）：
//   与保存时 FWorkbook.save() → saveUnit → getResourcesByType 同一个口径，只是不让一项抛错拖垮整份捕获。
// 能不能编辑由编辑器页决定，这里只报告（profile/open-check.ts 合成结果）。依赖的 SDK 行为与回归用例见 registry.ts 的这一项
import type { OpenCheckFailure, ResourceOutput } from '@nerve-office/contracts'
import type { DependencyOverride, IDisposable, IResourceHook } from '@univerjs/core'
import { errorNameOf, hasResourceContent, isDeepEmpty } from '@nerve-office/contracts'
import { ILogService, IResourceManagerService, ResourceManagerService, UniverInstanceType } from '@univerjs/core'

/** 守卫在加载时记下的三种失败 */
type LoadFailureKind = Extract<OpenCheckFailure['kind'], 'parse-threw' | 'parse-swallowed' | 'load-threw'>

/** 逐个表格 hook 的捕获：序列化出的资源，与序列化出错的（serialize-threw） */
export interface CapturedResources {
  readonly outputs: readonly ResourceOutput[]
  readonly failures: readonly OpenCheckFailure[]
}

export interface ResourceLoadGuard {
  /** 并进 new Univer({ override }) 的那一项（与编辑器身份的替换并列） */
  readonly override: DependencyOverride
  /** 到现在为止记下的加载失败（按发生的先后） */
  readonly loadFailures: () => readonly OpenCheckFailure[]
  /** 现在注册着的表格资源 hook 的名字（按注册的先后） */
  readonly sheetHookNames: () => readonly string[]
  /** 逐个表格 hook 调 toJson(unitId)：不执行命令、不改模型（变更检测看不到它） */
  readonly captureSheetResources: (unitId: string) => CapturedResources
}

function failureOf(kind: OpenCheckFailure['kind'], resource: string, thrown?: unknown): OpenCheckFailure {
  const error = errorNameOf(thrown)
  return error === undefined ? { kind, resource } : { kind, resource, error }
}

/** 观察出错不能改变加载的行为：吞掉（记不下来的就不记） */
function observe(look: () => void): void {
  try {
    look()
  }
  catch {}
}

/** 包一层只观察的 hook：每个方法都显式委托给插件的 hook，出错原样抛出，返回值原样返回 */
function observedHook<T>(hook: IResourceHook<T>, record: (failure: OpenCheckFailure) => void): IResourceHook<T> {
  const note = (kind: LoadFailureKind, thrown?: unknown): void => record(failureOf(kind, hook.pluginName, thrown))
  return {
    pluginName: hook.pluginName,
    businesses: hook.businesses,
    toJson: (...args) => hook.toJson(...args),
    onUnLoad: (...args) => hook.onUnLoad(...args),
    parseJson: (json) => {
      let model: T
      try {
        model = hook.parseJson(json)
      }
      catch (error) {
        observe(() => {
          if (hasResourceContent(json))
            note('parse-threw', error)
        })
        throw error
      }
      observe(() => {
        if (isDeepEmpty(model) && hasResourceContent(json))
          note('parse-swallowed')
      })
      return model
    },
    onLoad: (unitId, model) => {
      try {
        hook.onLoad(unitId, model)
      }
      catch (error) {
        observe(() => note('load-threw', error))
        throw error
      }
    },
  }
}

/** 资源管理服务：只换掉登记 hook 的那一步，其余全是 SDK 的实现 */
class GuardedResourceManagerService extends ResourceManagerService {
  readonly #record: (failure: OpenCheckFailure) => void

  constructor(logService: ILogService, record: (failure: OpenCheckFailure) => void) {
    super(logService)
    this.#record = record
  }

  override registerPluginResource<T = unknown>(hook: IResourceHook<T>): IDisposable {
    return super.registerPluginResource(observedHook(hook, this.#record))
  }
}

/**
 * 一个编辑器（一个 Univer 实例）一个守卫：创建 Univer 之前建好，把 override 并进 new Univer({ override })。
 * 注入器构造时就经工厂建出资源管理服务；之后取 hook 名或捕获时它还没建出来，说明 SDK 改了创建的方式，守卫看不见加载，直接报错
 * （编辑器按加载失败处理），不悄悄地当作"没有失败"
 */
export function createResourceLoadGuard(): ResourceLoadGuard {
  const failures: OpenCheckFailure[] = []
  let manager: GuardedResourceManagerService | undefined
  const created = (): GuardedResourceManagerService => {
    if (manager === undefined)
      throw new Error('资源守卫没有生效：Univer 没有经它创建资源管理服务（SDK 改了创建的方式，回头核对 internal-api 的登记）')
    return manager
  }
  const sheetHooks = (): IResourceHook[] => created().getAllResourceHooks().filter(hook => hook.businesses.includes(UniverInstanceType.UNIVER_SHEET))
  const factory = (logService: ILogService): IResourceManagerService => {
    if (manager !== undefined)
      throw new Error('一个资源守卫只用于一个 Univer 实例')
    manager = new GuardedResourceManagerService(logService, failure => failures.push(failure))
    return manager
  }
  return {
    override: [[IResourceManagerService, { useFactory: factory, deps: [ILogService] }]],
    loadFailures: () => [...failures],
    sheetHookNames: () => sheetHooks().map(hook => hook.pluginName),
    captureSheetResources: (unitId) => {
      const outputs: ResourceOutput[] = []
      const thrown: OpenCheckFailure[] = []
      for (const hook of sheetHooks()) {
        try {
          const data: unknown = hook.toJson(unitId)
          // SDK 的类型是字符串；不是的话保存出的快照服务端不收（之后每次保存都会失败），与抛错同样处理
          if (typeof data === 'string')
            outputs.push({ name: hook.pluginName, data })
          else
            thrown.push(failureOf('serialize-threw', hook.pluginName))
        }
        catch (error) {
          thrown.push(failureOf('serialize-threw', hook.pluginName, error))
        }
      }
      return { outputs, failures: thrown }
    },
  }
}
