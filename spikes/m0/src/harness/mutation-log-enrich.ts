// V15：日志参数补全（P6）。个别 mutation 在处理器里（或处理器同步调用的模型方法里）随机生成 id，参数里没有，
// 重放时会生成不同的 id（静态排查见 P6 报告 §3.3）。两种补全：
// 1. 样式附带记录：样式 id 在 Styles.add 里随机生成（set-range-values、set.numfmt、remove.numfmt 都会走到），
//    复制工作表等 mutation 又按字符串引用样式 id。记录每条日志时，把"自上一条日志以来样式表新增的 id 及内容"附在这一条上
//    （公式结果写回等 onlyLocal 的写入也会新增样式，所以按增量算，不只看本条执行期间）；重放这一条之前先 addStyles，
//    处理器按内容查找时就会命中同一个 id，不再生成新的；
// 2. 批注：sheet.mutation.update-note 的批注 id 在 SheetsNoteModel.updateNote 里随机生成（参数里没有 id 时），
//    记录时从模型读回 id 写进日志里的参数（处理器优先用参数里的 id）。
// 用到的模型都是内部 API，只用于验证。
import type { IStyleData, Nullable, Univer, Workbook } from '@univerjs/core';

import { IUniverInstanceService, UniverInstanceType } from '@univerjs/core';
import { SheetsNoteModel } from '@univerjs/sheets-note';

type Json = Record<string, any>;

/** 返回补全后的参数副本（不需要补全时原样返回）。 */
export function enrichParams(univer: Univer, id: string, params: Json): Json {
    if (id === 'sheet.mutation.update-note') {
        const note = univer.__getInjector().get(SheetsNoteModel).getNote(params.unitId, params.sheetId, { row: params.row, col: params.col });
        return note?.id == null ? params : { ...params, note: { ...params.note, id: note.id } };
    }
    return params;
}

/** 样式附带记录：每次调用返回自上一次调用以来样式表新增的样式（没有新增时返回 null）。文字文档返回 null。 */
export function createStyleTracker(univer: Univer, unitId: string): () => Record<string, Nullable<IStyleData>> | null {
    const wb = univer.__getInjector().get(IUniverInstanceService).getUnit<Workbook>(unitId, UniverInstanceType.UNIVER_SHEET);
    if (wb == null) return () => null;
    const known = new Set(Object.keys(wb.getStyles().toJSON()));
    return () => {
        const all = wb.getStyles().toJSON();
        const added: Record<string, Nullable<IStyleData>> = {};
        for (const [sid, style] of Object.entries(all)) {
            if (known.has(sid)) continue;
            known.add(sid);
            added[sid] = structuredClone(style);
        }
        return Object.keys(added).length === 0 ? null : added;
    };
}

/** 重放一条日志之前：先把它附带的样式按原 id 装进样式表。 */
export function preloadStyles(univer: Univer, unitId: string, styles: Record<string, Nullable<IStyleData>> | undefined): void {
    if (styles == null) return;
    univer.__getInjector().get(IUniverInstanceService).getUnit<Workbook>(unitId, UniverInstanceType.UNIVER_SHEET)?.addStyles(styles);
}
