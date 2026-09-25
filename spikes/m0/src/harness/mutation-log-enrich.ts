// V15：日志参数补全（P6）。个别 mutation 在处理器里（或处理器同步调用的模型方法里）随机生成 id，参数里没有，
// 重放时会生成不同的 id。补全在记录时（执行之后）从模型里读回生成的值，写进日志里的参数副本：
// - sheet.mutation.insert-sheet（复制工作表）：参数里的单元格按字符串引用样式 id，重放的实例里没有这些 id（样式 id 随机生成），
//   处理器支持参数里的 styles（"来自协同"时加入样式表），这里按引用补上样式对象；
// - sheet.mutation.update-note：批注 id 在模型的 updateNote 里随机生成，这里读回模型里的批注 id。
// 用到的模型都是内部 API，只用于验证。
import type { IStyleData, Univer, Workbook } from '@univerjs/core';

import { IUniverInstanceService, UniverInstanceType } from '@univerjs/core';
import { SheetsNoteModel } from '@univerjs/sheets-note';

type Json = Record<string, any>;

function referencedStyleIds(sheet: Json): Set<string> {
    const ids = new Set<string>();
    for (const row of Object.values((sheet.cellData ?? {}) as Record<string, Record<string, Json>>)) {
        for (const cell of Object.values(row)) if (typeof cell?.s === 'string') ids.add(cell.s);
    }
    for (const r of Object.values((sheet.rowData ?? {}) as Record<string, Json>)) if (typeof r?.s === 'string') ids.add(r.s);
    for (const c of Object.values((sheet.columnData ?? {}) as Record<string, Json>)) if (typeof c?.s === 'string') ids.add(c.s);
    return ids;
}

/** 返回补全后的参数副本（不需要补全时原样返回）；记录与补全的失败由调用方记下，不能抛出到 SDK。 */
export function enrichParams(univer: Univer, id: string, params: Json): Json {
    const injector = univer.__getInjector();
    if (id === 'sheet.mutation.insert-sheet') {
        const wb = injector.get(IUniverInstanceService).getUnit<Workbook>(params.unitId, UniverInstanceType.UNIVER_SHEET);
        if (wb == null) return params;
        const styles: Record<string, IStyleData> = { ...(params.styles ?? {}) };
        for (const sid of referencedStyleIds(params.sheet ?? {})) {
            const style = wb.getStyles().get(sid);
            if (style != null) styles[sid] = style;
        }
        return Object.keys(styles).length === 0 ? params : { ...params, styles };
    }
    if (id === 'sheet.mutation.update-note') {
        const note = injector.get(SheetsNoteModel).getNote(params.unitId, params.sheetId, { row: params.row, col: params.col });
        return note?.id == null ? params : { ...params, note: { ...params.note, id: note.id } };
    }
    return params;
}
