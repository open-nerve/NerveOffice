import type { IDocumentData, IWorkbookData } from '@univerjs/core';
import type { EditorProfile } from '../profiles/types';
import type { PageEvents } from './events';
import type { WorkerStats } from './worker-stats';

import { IResourceManagerService, LifecycleService, LifecycleStages, LocaleType, LogLevel, Univer } from '@univerjs/core';
import { FUniver } from '@univerjs/core/facade';
import { defaultTheme } from '@univerjs/themes';
import { resolvePlugins } from '../profiles/types';

export interface CreateEditorOptions {
    profile: EditorProfile;
    container: HTMLElement;
    data: Record<string, unknown>;
    createWorker?: () => Worker;
    /** 去掉的插件组（V04：复现"插件缺失"）。 */
    without?: string[];
}

export interface ResourceHookInfo {
    name: string;
    businesses: number[];
}

export interface EditorHandle {
    kind: EditorProfile['kind'];
    profileId: string;
    univer: Univer;
    univerAPI: FUniver;
    /** 捕获快照：FWorkbook.save() / FDocument.save()。 */
    save(): IWorkbookData | IDocumentData;
    /** 从开始创建到各生命周期阶段的耗时（毫秒）。 */
    timings: Record<string, number>;
    /** 运行时注册的资源 hook：决定 save() 会输出哪些资源。 */
    resourceHooks(): ResourceHookInfo[];
}

/** 按档案创建 Univer 实例与文档单元，等到生命周期进入 Steady 后返回。 */
export async function createEditor(options: CreateEditorOptions): Promise<EditorHandle> {
    const { profile, container, data, createWorker, without = [] } = options;
    const t0 = performance.now();
    const timings: Record<string, number> = {};

    const univer = new Univer({
        locale: LocaleType.ZH_CN,
        locales: { [LocaleType.ZH_CN]: profile.locale },
        theme: defaultTheme,
        logLevel: LogLevel.WARN,
    });

    for (const [plugin, config] of resolvePlugins(profile, { container, createWorker }, without)) {
        univer.registerPlugin(plugin, config as never);
    }

    const univerAPI = FUniver.newAPI(univer);
    const lifecycle = univer.__getInjector().get(LifecycleService);
    const stageNames: Partial<Record<LifecycleStages, string>> = {
        [LifecycleStages.Ready]: 'ready',
        [LifecycleStages.Rendered]: 'rendered',
        [LifecycleStages.Steady]: 'steady',
    };
    const sub = lifecycle.lifecycle$.subscribe((stage) => {
        const name = stageNames[stage];
        if (name != null && timings[name] == null) timings[name] = performance.now() - t0;
    });

    if (profile.kind === 'sheet') {
        univerAPI.createWorkbook(data as Partial<IWorkbookData>);
    } else {
        univerAPI.createDocument(data as Partial<IDocumentData>);
    }

    await lifecycle.onStage(LifecycleStages.Steady);
    sub.unsubscribe();

    const save = (): IWorkbookData | IDocumentData => {
        if (profile.kind === 'sheet') {
            const wb = univerAPI.getActiveWorkbook();
            if (wb == null) throw new Error('没有活动的工作簿');
            return wb.save();
        }
        const doc = univerAPI.getActiveDocument();
        if (doc == null) throw new Error('没有活动的文字文档');
        return doc.save();
    };

    const resourceHooks = (): ResourceHookInfo[] =>
        univer.__getInjector().get(IResourceManagerService).getAllResourceHooks()
            .map((h) => ({ name: h.pluginName, businesses: [...h.businesses] }))
            .sort((a, b) => a.name.localeCompare(b.name));

    return { kind: profile.kind, profileId: profile.id, univer, univerAPI, save, timings, resourceHooks };
}

/** 验证脚本通过 window.__m0 访问编辑器。 */
/** 样本构建器：在已加载的文档上用 Facade 或命令生成内容（P2）。 */
export type SampleBuilder = (editor: EditorHandle) => Promise<void>;

export interface M0Window {
    kind: EditorProfile['kind'];
    /** 把当前快照写回验证服务的文档存储。 */
    persist?: (id: string) => Promise<void>;
    builders?: Record<string, SampleBuilder>;
    ready: Promise<EditorHandle>;
    editor?: EditorHandle;
    events: PageEvents;
    params: Record<string, unknown>;
    workerStats: WorkerStats;
}

declare global {
    interface Window {
        __m0?: M0Window;
    }
}
