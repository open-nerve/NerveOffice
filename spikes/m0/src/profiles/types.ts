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
 * 候选插件档案：某种文档类型固定使用的插件列表、配置与语言包。
 * P1 的档案只是候选集合，档案 v1 在 P2 定稿。
 */
export interface EditorProfile {
    id: string;
    kind: 'sheet' | 'doc';
    /** 是否支持 Worker 模式，以及 Worker 的用途。 */
    worker?: 'formula' | 'layout';
    plugins(options: ProfileOptions): PluginEntry[];
    locale: ILanguagePack;
}
