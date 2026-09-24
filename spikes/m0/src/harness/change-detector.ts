// 变更检测原型（V06）：P3 报告 §2.1 的规则，加上分析用的全部命令记录与公式计算会话的跟踪（V07）。
// 必须在创建文档单元之前挂上，才能看到加载过程中执行的命令。
// 检测只用公开 API（Facade 的 CommandExecuted 事件，带执行选项）；syncOnly 的旁路记录用协同钩子（内部 API，只用于分析）。
import type { IExecutionOptions, Univer } from '@univerjs/core';
import type { FUniver } from '@univerjs/core/facade';

import { CommandType, ICommandService } from '@univerjs/core';

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
 * - resultSheets：最近一条 set-formula-calculation-result 中带结果的工作表（`unitId/sheetId`），还没收到结果时为 null；
 * - appliedSheets：本轮已经收到的公式结果写回（带 applyFormulaCalculationResult 的 set-range-values）。
 * Worker 模式下结果按工作表逐条同步回主线程，等待接口在第一条写回后就返回；逐表收齐才算这一轮完成。
 */
export interface FormulaProgress {
    session: number;
    started: boolean;
    stopped: boolean;
    resultSheets: string[] | null;
    appliedSheets: string[];
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
export const SET_RANGE_VALUES = 'sheet.mutation.set-range-values';

interface RawCommand {
    id: string;
    type?: CommandType;
    params?: unknown;
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
    let formula: FormulaProgress = { session: 0, started: false, stopped: false, resultSheets: null, appliedSheets: [] };

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
            formula = { session: formula.session + 1, started: true, stopped: false, resultSheets: null, appliedSheets: [] };
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
    });
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
        formulaProgress: () => ({ ...formula, appliedSheets: [...formula.appliedSheets] }),
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
        },
    };
}
