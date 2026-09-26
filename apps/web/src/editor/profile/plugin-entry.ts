// 档案里的一个插件：插件类、配置，以及按这份配置注册的方法。
// 配置原样留在条目上，单元测试据此核对影响数据的配置（插件档案 v1 §1、§4）
import type { Plugin, PluginCtor, Univer } from '@univerjs/core'

export interface PluginEntry {
  readonly plugin: PluginCtor<Plugin>
  readonly config: unknown
  readonly register: (univer: Univer) => void
}

/** 配置的类型取自插件的构造参数，与 `Univer.registerPlugin` 的检查相同。 */
export function pluginEntry<T extends PluginCtor<Plugin>>(plugin: T, config?: ConstructorParameters<T>[0]): PluginEntry {
  return {
    plugin,
    config,
    register: univer => univer.registerPlugin(plugin, config),
  }
}
