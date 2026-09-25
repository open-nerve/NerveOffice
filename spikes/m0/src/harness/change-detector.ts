// 变更检测原型（V06）：P3 报告 §2.1 的规则，加上分析用的全部命令记录与公式计算会话的跟踪（V07）。
// 必须在创建文档单元之前挂上，才能看到加载过程中执行的命令。
// 检测只用公开 API（Facade 的 CommandExecuted 事件，带执行选项）；syncOnly 的旁路记录用协同钩子（内部 API，只用于分析）。
// 公式计算的跟踪另用 IActiveDirtyManagerService（内部 API，报告 §7 登记）判断一条命令会不会触发新一轮计算。
import type { ICommandInfo, IExecutionOptions, Univer } from '@univerjs/core';
import type { FUniver } from '@univerjs/core/facade';

import { CommandType, ICommandService } from '@univerjs/core';
import { IActiveDirtyManagerService, SetTriggerFormulaCalculationStartMutation } from '@univerjs/engine-formula';

export type CommandKind = 'command' | 'operation' | 'mutation';

export interface CommandRecord {
    /** performance.now() */
    t: number;
    id: string;
    kind: CommandKind;
    /** 执行选项中取值为 true 的键，例如 onlyLocal、fromFormula、syncOnly、applyFormulaCalculationResult。 */
    options: string[];
    /** 参数里的 unitId（没有则为 undefined）。 */
    unitId?: string;
    subUnitId?: string;
}

/** 规则排除的执行选项：这些 mutation 不是用户修改，或者内容来自别处。 */
export const EXCLUDED_OPTIONS = ['onlyLocal', 'fromCollab', 'fromChangeset', 'fromFormula', 'syncOnly'] as const;

export type Verdict = 'detected' | 'not-mutation' | `option:${(typeof EXCLUDED_OPTIONS)[number]}` | 'other-unit' | 'excluded';

export interface ClassifiedRecord extends CommandRecord {
    verdict: Verdict;
}

export interface ChangeDetectorState {
    unitId: string | null;
    exclude: string[];
    total: number;
    detections: ClassifiedRecord[];
    /** 全部非本地的 mutation（含被排除的），用于定排除名单。 */
    mutations: ClassifiedRecord[];
    /** 只经协同钩子送出的 syncOnly mutation（CommandExecuted 收不到）。 */
    syncOnly: CommandRecord[];
    /** onlyLocal 的 mutation（公式结果写回、懒执行等）：只统计条数与最后一条的时间。 */
    localMutations: { count: number; lastT: number | null };
    lastDetectionAt: number | null;
}

/**
 * 最近一轮公式计算的进度（V07）：
 * - started：见过 set-formula-calculation-start；stopped：之后见过 stop；
 * - completed：见过带 functionsExecutedState 的 notification（这一轮计算结束；没有需要重算的公式时只有它，没有结果 mutation）；
 * - resultSheets：最近一条 set-formula-calculation-result 中带结果的工作表（`unitId/sheetId`），还没收到结果时为 null；
 * - appliedSheets：本轮已经收到的公式结果写回（带 applyFormulaCalculationResult 的 set-range-values）；
 * - queued：最近一轮 start 之后，执行过会触发计算的命令（口径见下面的 trackTrigger），新的一轮还在排队。
 * Worker 模式下结果按工作表逐条同步回主线程，等待接口在第一条写回后就返回；逐表收齐才算这一轮完成。
 * 主线程上的顺序：结果 mutation → 各表写回 → 完成 notification（engine-formula 的 calculate.controller.ts:232-257 先发结果、后发通知；
 * 写回在结果 mutation 的监听里按表依次同步执行，sheets 的 calculate-result-apply.controller.ts:47-99；Worker 端按执行顺序同步回主线程，
 * rpc 的 data-sync-replica.controller.ts:59-70。升级 SDK 时由 e2e/v07-worker-timeline.spec.ts 回归）。
 * SDK 不把新的修改并进正在进行的一轮（formula-calculation-trigger.service.ts:122-188）：
 * 与正在计算的范围不相交就排队，相交就先发 stop（计算只在让出点检查 stop，常常照样算完）；
 * 这一轮的完成通知处理完、再过 10 ms 防抖，才发新一轮的 start。所以"最近一轮收齐"不代表最后一次修改的结果已经算出。
 */
export interface FormulaProgress {
    session: number;
    started: boolean;
    stopped: boolean;
    completed: boolean;
    resultSheets: string[] | null;
    appliedSheets: string[];
    queued: boolean;
}

/**
 * 组合输入（输入法）的状态（P5）：SDK 在每次 compositionupdate 时就把中间文字写进模型，
 * 这些 mutation 会被检测为"有修改"；组合进行中捕获，快照里就是拼音。按隐藏输入元素（id 以 __editor_ 开头）上的 DOM 事件判断。
 */
export interface CompositionState {
    active: boolean;
    /** 开始过的组合次数。 */
    count: number;
    lastStartAt: number | null;
    lastEndAt: number | null;
}

export interface ChangeDetector {
    /** 文档单元创建后设置 unitId；之前的记录按新的 unitId 重新判定。 */
    setUnitId(unitId: string): void;
    /** 当前记录位置，配合 state(since) 只看某个时刻之后的记录。 */
    mark(): number;
    state(since?: number): ChangeDetectorState;
    /** 某条记录是否被规则判定为"有修改"。 */
    classify(record: CommandRecord): Verdict;
    /** 最近一次"检测到修改"的时间（performance.now()），没有则为 null。 */
    lastDetectionAt(): number | null;
    formulaProgress(): FormulaProgress;
    composition(): CompositionState;
    dispose(): void;
}

const KIND: Record<number, CommandKind> = {
    [CommandType.COMMAND]: 'command',
    [CommandType.OPERATION]: 'operation',
    [CommandType.MUTATION]: 'mutation',
};

const MAX_RECORDS = 50_000;

export const FORMULA_START = 'formula.mutation.set-formula-calculation-start';
export const FORMULA_STOP = 'formula.mutation.set-formula-calculation-stop';
export const FORMULA_RESULT = 'formula.mutation.set-formula-calculation-result';
export const FORMULA_NOTIFICATION = 'formula.mutation.set-formula-calculation-notification';
export const SET_RANGE_VALUES = 'sheet.mutation.set-range-values';

interface RawCommand {
    id: string;
    type?: CommandType;
    params?: unknown;
}

/** 脏区转换（`IDirtyConversionManagerParams` 没有导出，从服务的类型推出）。 */
type DirtyConversion = Exclude<ReturnType<IActiveDirtyManagerService['get']>, null | undefined | void>;
type DirtyData = ReturnType<DirtyConversion['getDirtyData']>;

function hasNestedValue(value: unknown): boolean {
    if (value == null) return false;
    if (typeof value !== 'object') return true;
    return Object.values(value as Record<string, unknown>).some(hasNestedValue);
}

/** 与 SDK 触发服务的 hasDirtyData 同一口径（engine-formula/src/services/formula-calculation-trigger.service.ts:265-274）。 */
function hasDirtyData(d: DirtyData | null | undefined): boolean {
    if (d == null) return false;
    return d.forceCalculation === true ||
        (d.dirtyRanges?.length ?? 0) > 0 ||
        [d.dirtyNameMap, d.dirtyDefinedNameMap, d.dirtySuperTableMap, d.dirtyUnitFeatureMap, d.dirtyUnitOtherFormulaMap, d.clearDependencyTreeCache].some(hasNestedValue);
}

/** 会触发计算的候选命令：登记了脏区转换，且 shouldTrigger 没有排除它。脏区是否非空在需要时再算（getDirtyData 对大 mutation 不便宜）。 */
interface TriggerCandidate {
    command: ICommandInfo;
    conversion: DirtyConversion;
    dirty?: boolean;
}

function toRecord(info: RawCommand, options: IExecutionOptions | undefined): CommandRecord {
    const params = (info.params ?? {}) as { unitId?: unknown; subUnitId?: unknown };
    return {
        t: performance.now(),
        id: info.id,
        kind: KIND[info.type ?? CommandType.COMMAND] ?? 'command',
        options: Object.entries(options ?? {}).filter(([, v]) => v === true).map(([k]) => k),
        unitId: typeof params.unitId === 'string' ? params.unitId : undefined,
        subUnitId: typeof params.subUnitId === 'string' ? params.subUnitId : undefined,
    };
}

/** 结果 mutation 里带结果的工作表：与写回控制器的遍历一致（cellData 为 null 的跳过）。 */
function resultSheetsOf(params: unknown): string[] {
    const unitData = (params as { unitData?: Record<string, Record<string, unknown> | null> } | undefined)?.unitData ?? {};
    const out: string[] = [];
    for (const [unitId, sheets] of Object.entries(unitData)) {
        if (sheets == null) continue;
        for (const [sheetId, cellData] of Object.entries(sheets)) if (cellData != null) out.push(`${unitId}/${sheetId}`);
    }
    return out;
}

export function createChangeDetector(univer: Univer, univerAPI: FUniver, init: { unitId?: string; exclude?: readonly string[] }): ChangeDetector {
    const exclude = [...(init.exclude ?? [])];
    let unitId: string | null = init.unitId ?? null;
    const records: CommandRecord[] = [];
    const syncOnly: CommandRecord[] = [];
    let total = 0;
    let lastDetection: number | null = null;
    let formula: Omit<FormulaProgress, 'queued'> = { session: 0, started: false, stopped: false, completed: false, resultSheets: null, appliedSheets: [] };
    // 最近一轮 start 之后执行的、会触发计算的命令（start 时清空：之前的命令都已并入这一轮）
    let candidates: TriggerCandidate[] = [];
    let activeDirty: IActiveDirtyManagerService | null | undefined;
    const activeDirtyManager = (): IActiveDirtyManagerService | null => {
        if (activeDirty === undefined) {
            const injector = univer.__getInjector();
            // 文字文档不注册公式引擎；表格在插件启动前也还没有这项服务，下次再取
            if (!injector.has(IActiveDirtyManagerService)) return null;
            activeDirty = injector.get(IActiveDirtyManagerService);
        }
        return activeDirty;
    };
    /** 与 SDK 触发服务的判断一致（formula-calculation-trigger.service.ts:91-100、127）：这条命令会让 SDK 开始（或排队）一轮新的计算。 */
    const trackTrigger = (info: RawCommand, options: IExecutionOptions | undefined) => {
        const conversion = activeDirtyManager()?.get(info.id);
        if (conversion == null) return;
        const command = { id: info.id, type: info.type ?? CommandType.COMMAND, params: info.params } as ICommandInfo;
        if (conversion.shouldTrigger?.(command, options) === false) return;
        candidates.push({ command, conversion });
    };
    const queued = (): boolean => candidates.some((c) => {
        if (c.dirty === undefined) {
            c.dirty = c.command.id === SetTriggerFormulaCalculationStartMutation.id || hasDirtyData(c.conversion.getDirtyData(c.command));
        }
        return c.dirty;
    });

    const classify = (r: CommandRecord): Verdict => {
        if (r.kind !== 'mutation') return 'not-mutation';
        const opt = EXCLUDED_OPTIONS.find((k) => r.options.includes(k));
        if (opt != null) return `option:${opt}`;
        if (r.unitId != null && unitId != null && r.unitId !== unitId) return 'other-unit';
        if (exclude.includes(r.id)) return 'excluded';
        return 'detected';
    };

    const trackFormula = (r: CommandRecord, params: unknown) => {
        if (r.id === FORMULA_START) {
            formula = { session: formula.session + 1, started: true, stopped: false, completed: false, resultSheets: null, appliedSheets: [] };
            candidates = [];
        } else if (r.id === FORMULA_NOTIFICATION && (params as { functionsExecutedState?: unknown } | undefined)?.functionsExecutedState !== undefined) {
            formula = { ...formula, completed: true };
        } else if (r.id === FORMULA_STOP) {
            formula = { ...formula, stopped: true };
        } else if (r.id === FORMULA_RESULT) {
            formula = { ...formula, resultSheets: resultSheetsOf(params) };
        } else if (r.id === SET_RANGE_VALUES && r.options.includes('applyFormulaCalculationResult') && r.unitId != null && r.subUnitId != null) {
            formula = { ...formula, appliedSheets: [...new Set([...formula.appliedSheets, `${r.unitId}/${r.subUnitId}`])] };
        }
    };

    // 公开 API：Facade 的 CommandExecuted 事件（撤销、重做两个命令本身不送出，它们执行的 mutation 照常送出）
    const d1 = univerAPI.addEvent(univerAPI.Event.CommandExecuted, (e) => {
        const r = toRecord(e, e.options);
        total += 1;
        if (records.length < MAX_RECORDS) records.push(r);
        if (classify(r) === 'detected') lastDetection = r.t;
        trackFormula(r, e.params);
        trackTrigger(e, e.options);
    });
    // 组合输入：捕获阶段监听 document（输入法事件冒泡；P5 的事件归一也在捕获阶段，互不影响）
    const composition: CompositionState = { active: false, count: 0, lastStartAt: null, lastEndAt: null };
    const isEditorInput = (t: EventTarget | null) => t instanceof HTMLElement && t.id.startsWith('__editor_');
    const onCompositionStart = (e: Event) => {
        if (!isEditorInput(e.target)) return;
        composition.active = true;
        composition.count += 1;
        composition.lastStartAt = performance.now();
    };
    const onCompositionEnd = (e: Event) => {
        if (!isEditorInput(e.target)) return;
        composition.active = false;
        composition.lastEndAt = performance.now();
    };
    // 失焦复位（P5 审查 G4）：compositionend 因失焦、元素重建而没有到达时，不让"组合中"一直挡住捕获
    const onFocusOut = (e: Event) => {
        if (!isEditorInput(e.target) || !composition.active) return;
        composition.active = false;
        composition.lastEndAt = performance.now();
    };
    document.addEventListener('compositionstart', onCompositionStart, true);
    document.addEventListener('compositionend', onCompositionEnd, true);
    document.addEventListener('focusout', onFocusOut, true);
    // 内部 API（只用于分析）：只取 syncOnly 的 mutation，CommandExecuted 收不到它们
    const d2 = univer.__getInjector().get(ICommandService).onMutationExecutedForCollab((info, options) => {
        if (options?.syncOnly) {
            total += 1;
            if (syncOnly.length < MAX_RECORDS) syncOnly.push(toRecord(info, options));
        }
    });

    return {
        setUnitId(id) {
            unitId = id;
            lastDetection = null;
            for (const r of records) if (classify(r) === 'detected') lastDetection = r.t;
        },
        mark: () => records.length,
        classify,
        lastDetectionAt: () => lastDetection,
        formulaProgress: () => ({ ...formula, appliedSheets: [...formula.appliedSheets], queued: queued() }),
        composition: () => ({ ...composition }),
        state(since = 0) {
            const slice = records.slice(since).map((r) => ({ ...r, verdict: classify(r) }));
            const detections = slice.filter((r) => r.verdict === 'detected');
            const firstT = records[since]?.t ?? Number.POSITIVE_INFINITY;
            const local = slice.filter((r) => r.kind === 'mutation' && r.options.includes('onlyLocal'));
            return {
                unitId,
                exclude: [...exclude],
                total,
                detections,
                mutations: slice.filter((r) => r.kind === 'mutation' && !r.options.includes('onlyLocal')),
                syncOnly: syncOnly.filter((r) => r.t >= firstT),
                localMutations: { count: local.length, lastT: local.length > 0 ? local[local.length - 1].t : null },
                lastDetectionAt: detections.length > 0 ? detections[detections.length - 1].t : null,
            };
        },
        dispose() {
            d1.dispose();
            d2.dispose();
            document.removeEventListener('compositionstart', onCompositionStart, true);
            document.removeEventListener('compositionend', onCompositionEnd, true);
            document.removeEventListener('focusout', onFocusOut, true);
        },
    };
}
