import type { IDocumentData, IWorkbookData } from '@univerjs/core';
import type { EditorProfile } from '../profiles/types';
import type { UiOptions } from '../profiles/ui-config';
import type { ChangeDetector } from './change-detector';
import type { PageEvents } from './events';
import type { ReadModeHandle } from './read-mode';
import type { WorkerStats } from './worker-stats';
import type { ImageFunctionPolicy } from './image-function-policy';

import { IResourceManagerService, IUndoRedoService, LifecycleService, LifecycleStages, LocaleType, LogLevel, Univer, UserManagerService } from '@univerjs/core';
import { createChangeDetector } from './change-detector';
import { installImageFunctionPolicy } from './image-function-policy';
import { installImageGuards } from './image-guards';
import { installDocPolicy, normalizeDocFlavor } from './doc-policy';
import { alignImageFormats } from '../profiles/image-service';
import { GuardedResourceManagerService } from './guarded-resource-manager';
import { describeDocument } from './semantics';
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
    /** 启用资源加载错误捕获（V04）。 */
    guard?: boolean;
    /** 界面配置（P3）：默认取档案的编辑模式配置。 */
    ui?: UiOptions;
    /** 大表操作拆分（默认开启，与 SDK 一致）。 */
    largeSheetSplit?: boolean;
    /** 打开时的公式计算模式（V07 的重算基准用 forced）。 */
    calcMode?: 'default' | 'forced';
    /** 公式引擎的让出间隔（V10）。 */
    formulaIntervalCount?: number;
    /** 图片服务（P4）。 */
    imageService?: 'default' | 'platform';
    /** IMAGE() 的处理（P4）：主线程在这里安装，Worker 里由 Worker 自己安装（经 Worker 的 name 传入）。 */
    imageFunction?: ImageFunctionPolicy;
    /** 文字文档的平台策略（P5，doc-policy.ts）。 */
    docPolicy?: 'default' | 'platform';
    /** 文字文档的大纲侧栏（P5）。 */
    outline?: boolean;
    /** 文字文档的目录块插件（P5 评估用）。 */
    tocBlock?: boolean;
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
    /** 文档单元的 id。 */
    unitId(): string;
    /** 变更检测原型（P3）：在创建文档单元之前挂上。 */
    detector: ChangeDetector;
    /** 销毁 Univer 实例（V09：销毁重建）。 */
    dispose(): void;
    /** 本文档的撤销栈状态（IUndoRedoService，Facade 没有暴露）。 */
    undoStatus(): { undos: number; redos: number };
    /** IMAGE() 的限制是否已装上（P4；null 表示没有要求或还没到 Ready）。 */
    imageFunctionInstalled(): boolean | null;
    /** 捕获快照：FWorkbook.save() / FDocument.save()。 */
    save(): IWorkbookData | IDocumentData;
    /** 从开始创建到各生命周期阶段的耗时（毫秒）；t0 是开始创建时的 performance.now()。 */
    timings: Record<string, number>;
    /** 运行时注册的资源 hook：决定 save() 会输出哪些资源。 */
    resourceHooks(): ResourceHookInfo[];
    /** 档案中已注册的插件组所声明的资源名（用来与运行时 hook 自动核对）。 */
    declaredResources(): string[];
    /** 运行时模型的语义摘要（V03、V05）。 */
    semantics(): ReturnType<typeof describeDocument>;
    /** SDK 眼中的当前用户 id（本地模拟的授权服务会把它设成 Owner_xxx）。 */
    currentUserId(): string;
    /** 设置当前用户（V09：真实用户身份对本地授权服务的影响；UserManagerService 是内部 API）。 */
    setCurrentUser(user: { userID: string; name: string }): void;
    /** 文档创建之后再注册某个插件组（V04：验证晚注册的插件能否补加载资源）。 */
    lateRegister(groupId: string): void;
}

/** 按档案创建 Univer 实例与文档单元，等到生命周期进入 Steady 后返回。 */
export async function createEditor(options: CreateEditorOptions): Promise<EditorHandle> {
    const { profile, container, data, createWorker, without = [], guard = false } = options;
    const pluginOptions = {
        container,
        createWorker,
        ui: options.ui ?? profile.ui.edit,
        largeSheetSplit: options.largeSheetSplit ?? true,
        calcMode: options.calcMode ?? 'default',
        formulaIntervalCount: options.formulaIntervalCount,
        imageService: options.imageService ?? 'default',
        outline: options.outline ?? false,
        tocBlock: options.tocBlock ?? false,
    };
    const t0 = performance.now();
    const timings: Record<string, number> = { t0 };

    const univer = new Univer({
        locale: LocaleType.ZH_CN,
        locales: { [LocaleType.ZH_CN]: profile.locale },
        theme: defaultTheme,
        logLevel: LogLevel.WARN,
        override: guard ? [[IResourceManagerService, { useClass: GuardedResourceManagerService }]] : [],
    });

    // 平台图片服务：各入口接受的格式与平台一致（P4 审查 G4）
    if (options.imageService === 'platform') alignImageFormats();
    for (const [plugin, config] of resolvePlugins(profile, pluginOptions, without)) {
        univer.registerPlugin(plugin, config as never);
    }

    const univerAPI = FUniver.newAPI(univer);
    const lifecycle = univer.__getInjector().get(LifecycleService);
    // IMAGE() 的限制：主线程也装（函数说明与自动补全在主线程；主线程模式下计算也在这里）
    const imageFunctionInstalled = { value: null as boolean | null };
    if (profile.kind === 'sheet') installImageFunctionPolicy(univer.__getInjector(), options.imageFunction ?? 'default', (ok) => { imageFunctionInstalled.value = ok; });
    const stageNames: Partial<Record<LifecycleStages, string>> = {
        [LifecycleStages.Ready]: 'ready',
        [LifecycleStages.Rendered]: 'rendered',
        [LifecycleStages.Steady]: 'steady',
    };
    const sub = lifecycle.lifecycle$.subscribe((stage) => {
        const name = stageNames[stage];
        if (name != null && timings[name] == null) timings[name] = performance.now() - t0;
    });

    // 检测器必须先于文档单元挂上，才能看到加载过程中执行的命令
    const detector = createChangeDetector(univer, univerAPI, {
        unitId: typeof data.id === 'string' ? data.id : undefined,
        exclude: profile.changeDetectionExclude,
    });
    // 平台策略：版式固定为 MODERN（在创建文档单元之前规范）
    if (profile.kind === 'doc' && options.docPolicy === 'platform') normalizeDocFlavor(data as Partial<IDocumentData>);
    const unitId = profile.kind === 'sheet'
        ? univerAPI.createWorkbook(data as Partial<IWorkbookData>).getId()
        : univerAPI.createDocument(data as Partial<IDocumentData>).getId();
    detector.setUnitId(unitId);

    await lifecycle.onStage(LifecycleStages.Steady);
    sub.unsubscribe();
    const imageGuards = options.imageService === 'platform' ? [installImageGuards(univer, univerAPI), profile.platformImageExtras?.(univer)] : [];
    const docPolicy = profile.kind === 'doc' && options.docPolicy === 'platform' ? installDocPolicy(univer, univerAPI, unitId) : null;

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

    const declaredResources = (): string[] =>
        [...new Set(profile.groups.filter((g) => !without.includes(g.id)).flatMap((g) => g.resources))].sort();

    const lateRegister = (groupId: string): void => {
        if (!without.includes(groupId)) throw new Error(`插件组 ${groupId} 已经注册`);
        const group = profile.groups.find((g) => g.id === groupId);
        if (group == null) throw new Error(`没有插件组：${groupId}`);
        for (const entry of group.plugins(pluginOptions)) {
            if (entry != null) univer.registerPlugin(entry[0], entry[1] as never);
        }
    };

    const handle: EditorHandle = {
        kind: profile.kind,
        profileId: profile.id,
        univer,
        univerAPI,
        unitId: () => unitId,
        detector,
        dispose: () => {
            imageGuards.forEach((d) => d?.dispose());
            docPolicy?.dispose();
            detector.dispose();
            univer.dispose();
        },
        imageFunctionInstalled: () => imageFunctionInstalled.value,
        undoStatus: () => univer.__getInjector().get(IUndoRedoService).getUndoRedoStatus(unitId),
        save,
        timings,
        resourceHooks,
        declaredResources,
        lateRegister,
        semantics: () => describeDocument(handle),
        currentUserId: () => univer.__getInjector().get(UserManagerService).getCurrentUser().userID,
        setCurrentUser: (user) => univer.__getInjector().get(UserManagerService).setCurrentUser(user as never),
    };
    return handle;
}

/** 验证脚本通过 window.__m0 访问编辑器。 */
/** 样本构建器：在已加载的文档上用 Facade 或命令生成内容（P2）。 */
export type SampleBuilder = (editor: EditorHandle) => Promise<void>;

export interface M0Window {
    kind: EditorProfile['kind'];
    /** 把当前快照写回验证服务的文档存储。 */
    persist?: (id: string) => Promise<void>;
    builders?: Record<string, SampleBuilder>;
    /** 资源加载错误捕获记录（guard=1 时）。 */
    resourceLoadFailures?: import('./guarded-resource-manager').ResourceLoadFailure[];
    ready: Promise<EditorHandle>;
    editor?: EditorHandle;
    /** 阅读模式（mode=read 时，或者用 enterReadMode 原地进入之后）。 */
    readMode?: ReadModeHandle;
    /** 原地进入阅读模式（V09 的撤销重做拦截与原地切换实验）。 */
    enterReadMode?: (ro: string, options?: import('./read-mode').EnterReadModeOptions) => Promise<ReadModeHandle>;
    /** 菜单审计（V09）。 */
    auditMenus?: () => import('./menu-audit').MenuAuditItem[];
    /** 计时工具（V08、V10）。 */
    perf?: typeof import('./perf');
    /** 内容比较（V08 测规范化与哈希的开销）。 */
    content?: typeof import('./content-compare');
    /** P3 报告 §3.4 的捕获时机（审查后修订）。 */
    waitForCapture?: (options?: import('./capture-timing').CaptureWaitOptions) => Promise<import('./capture-timing').CaptureWait>;
    /** 资源比较（V08 测打开自检的耗时）。 */
    guard?: typeof import('./resource-guard');
    /** 加载时的快照文本（创建文档单元之前序列化，SDK 会改动传入的对象）。 */
    loadedText?: string;
    /** 文字文档当前的活动选区（P5；DocSelectionManagerService 是内部 API，只用于验证）。 */
    activeTextRange?: () => { startOffset: number; endOffset: number; segmentId: string } | null;
    /** 文字文档平台策略的操作记录（P5）。 */
    docPolicy?: { events: import('./doc-policy').DocPolicyEvent[] };
    /** 输入法记录页（P5，imelog=1）。 */
    imeRecorder?: import('@univerjs/core').IDisposable;
    /** 平台图片服务、粘贴钩子与命令守卫的操作记录（P4）。 */
    images?: { events: import('./platform-image-io').ImageEvent[]; io: () => import('@univerjs/core').IImageIoService };
    /** 销毁当前实例并按指定模式从文档存储重新创建（V09 的"销毁重建"）。 */
    remount?: (opts: { mode: 'edit' | 'read'; doc: string; ro?: string }) => Promise<{ ms: number }>;
    events: PageEvents;
    params: Record<string, unknown>;
    workerStats: WorkerStats;
}

declare global {
    interface Window {
        __m0?: M0Window;
    }
}
