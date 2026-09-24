import type { ILanguagePack, Plugin, PluginCtor } from '@univerjs/core';

/** 一个插件及其配置，按注册顺序排列。 */
export type PluginEntry = readonly [PluginCtor<Plugin>, unknown?];

export interface ProfileOptions {
    /** 编辑器挂载的容器。 */
    container: HTMLElement;
    /** 可选的 Web Worker 工厂：表格用于公式计算，文字文档用于排版。 */
    createWorker?: () => Worker;
}

/**
 * 插件组：一组一起注册、一起去掉的插件（通常是某个功能的核心插件加界面插件）。
 * `resources` 是这一组写进快照的资源名（来自源码检索，运行时以 resourceHooks() 为准）。
 */
export interface PluginGroup {
    id: string;
    resources: string[];
    /** 其他组不依赖它，可以单独去掉（V04 用来复现"插件缺失"）。 */
    removable: boolean;
    plugins(options: ProfileOptions): (PluginEntry | null)[];
}

/**
 * 插件档案：某种文档类型固定使用的插件列表、配置、语言包与适用的 SDK 版本。
 * P2 起为 v1 草案，M0 结束时定稿（00 号计划书 §8.2）。
 */
export interface EditorProfile {
    id: string;
    kind: 'sheet' | 'doc';
    sdkVersion: string;
    /** 是否支持 Worker 模式，以及 Worker 的用途。 */
    worker?: 'formula' | 'layout';
    groups: PluginGroup[];
    locale: ILanguagePack;
}

/** 按档案展开插件列表；`without` 中的组被去掉（只允许去掉可单独去掉的组）。 */
export function resolvePlugins(profile: EditorProfile, options: ProfileOptions, without: readonly string[] = []): PluginEntry[] {
    for (const id of without) {
        const group = profile.groups.find((g) => g.id === id);
        if (group == null) throw new Error(`档案 ${profile.id} 中没有插件组：${id}`);
        if (!group.removable) throw new Error(`插件组 ${id} 不能单独去掉`);
    }
    return profile.groups
        .filter((g) => !without.includes(g.id))
        .flatMap((g) => g.plugins(options))
        .filter((e): e is PluginEntry => e != null);
}
