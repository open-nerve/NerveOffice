// 变更检测原型（V06）：00 号计划书 §7.3 的候选规则，加上分析用的全部命令记录。
// 必须在创建文档单元之前挂上，才能看到加载过程中执行的命令。
import type { ICommandInfo, IExecutionOptions, Univer } from '@univerjs/core';

import { CommandType, ICommandService } from '@univerjs/core';

export type CommandKind = 'command' | 'operation' | 'mutation';

export interface CommandRecord {
    /** performance.now() */
    t: number;
    id: string;
    kind: CommandKind;
    /** 执行选项中取值为 true 的键，例如 onlyLocal、fromFormula、syncOnly。 */
    options: string[];
    /** 参数里的 unitId（没有则为 undefined）。 */
    unitId?: string;
    subUnitId?: string;
}

/** 候选规则排除的执行选项：这些 mutation 不改变需要保存的内容，或者内容来自别处。 */
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
    /** 只经协同钩子送出的 syncOnly mutation（onCommandExecuted 收不到）。 */
    syncOnly: CommandRecord[];
    lastDetectionAt: number | null;
}

export interface ChangeDetector {
    /** 文档单元创建后设置 unitId；之前的记录按新的 unitId 重新判定。 */
    setUnitId(unitId: string): void;
    /** 当前记录位置，配合 state(since) 只看某个时刻之后的记录。 */
    mark(): number;
    state(since?: number): ChangeDetectorState;
    /** 某条记录是否被候选规则判定为"有修改"。 */
    classify(record: CommandRecord): Verdict;
    /** 最近一次"检测到修改"的时间（performance.now()），没有则为 null。 */
    lastDetectionAt(): number | null;
    dispose(): void;
}

const KIND: Record<number, CommandKind> = {
    [CommandType.COMMAND]: 'command',
    [CommandType.OPERATION]: 'operation',
    [CommandType.MUTATION]: 'mutation',
};

const MAX_RECORDS = 50_000;

function toRecord(info: Readonly<ICommandInfo>, options: IExecutionOptions | undefined): CommandRecord {
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

export function createChangeDetector(univer: Univer, init: { unitId?: string; exclude?: readonly string[] }): ChangeDetector {
    const commandService = univer.__getInjector().get(ICommandService);
    const exclude = [...(init.exclude ?? [])];
    let unitId: string | null = init.unitId ?? null;
    const records: CommandRecord[] = [];
    const syncOnly: CommandRecord[] = [];
    let total = 0;

    const push = (list: CommandRecord[], r: CommandRecord) => {
        total += 1;
        if (list.length < MAX_RECORDS) list.push(r);
    };

    const classify = (r: CommandRecord): Verdict => {
        if (r.kind !== 'mutation') return 'not-mutation';
        const opt = EXCLUDED_OPTIONS.find((k) => r.options.includes(k));
        if (opt != null) return `option:${opt}`;
        if (r.unitId != null && unitId != null && r.unitId !== unitId) return 'other-unit';
        if (exclude.includes(r.id)) return 'excluded';
        return 'detected';
    };

    const d1 = commandService.onCommandExecuted((info, options) => push(records, toRecord(info, options)));
    // 协同钩子（内部 API）：只取 syncOnly 的 mutation，其余与 onCommandExecuted 重复
    const d2 = commandService.onMutationExecutedForCollab((info, options) => {
        if (options?.syncOnly) push(syncOnly, toRecord(info, options));
    });

    return {
        setUnitId(id) {
            unitId = id;
        },
        mark: () => records.length,
        classify,
        lastDetectionAt() {
            for (let i = records.length - 1; i >= 0; i--) if (classify(records[i]) === 'detected') return records[i].t;
            return null;
        },
        state(since = 0) {
            const slice = records.slice(since).map((r) => ({ ...r, verdict: classify(r) }));
            const detections = slice.filter((r) => r.verdict === 'detected');
            const firstT = records[since]?.t ?? Number.POSITIVE_INFINITY;
            return {
                unitId,
                exclude: [...exclude],
                total,
                detections,
                mutations: slice.filter((r) => r.kind === 'mutation' && !r.options.includes('onlyLocal')),
                syncOnly: syncOnly.filter((r) => r.t >= firstT),
                lastDetectionAt: detections.length > 0 ? detections[detections.length - 1].t : null,
            };
        },
        dispose() {
            d1.dispose();
            d2.dispose();
        },
    };
}
