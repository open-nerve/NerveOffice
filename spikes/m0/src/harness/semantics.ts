// 文档语义摘要：用 Facade 读出运行时模型中的关键内容（规则条数、图片数、链接数等），
// 用来证明样本真的包含预期内容、重开后内容没有变化（V03、V05），而不只是比较 JSON。
// 某个插件组被去掉时，对应的 Facade 方法不存在，记为 null。
import type { EditorHandle } from './create-editor';

type Maybe<T> = T | null;

function attempt<T>(fn: () => T): Maybe<T> {
    try {
        return fn();
    } catch {
        return null;
    }
}

const HYPERLINK = 0; // CustomRangeType.HYPERLINK

export interface SheetSemantics {
    sheets: {
        name: string;
        hidden: boolean;
        merges: number;
        frozen: string;
        conditionalFormats: Maybe<number>;
        dataValidations: Maybe<number>;
        filter: Maybe<{ range: string; columnsWithCriteria: number; filteredOutRows: number }>;
        notes: Maybe<number>;
        floatingImages: Maybe<number>;
    }[];
    definedNames: number;
    formulas: number;
    richTextCells: number;
    cellImages: number;
    hyperlinks: number;
}

export interface DocSemantics {
    textLength: number;
    namedStyles: Record<string, number>;
    lists: Record<string, number>;
    tables: number;
    images: { inline: number; floating: number; facade: Maybe<number> };
    hyperlinks: number;
}

export function describeDocument(editor: EditorHandle): SheetSemantics | DocSemantics {
    return editor.kind === 'sheet' ? describeWorkbook(editor) : describeDoc(editor);
}

function describeWorkbook(editor: EditorHandle): SheetSemantics {
    const wb = editor.univerAPI.getActiveWorkbook()!;
    const snap = editor.save() as { sheets: Record<string, { cellData?: Record<string, Record<string, any>> }> };
    let formulas = 0;
    let richTextCells = 0;
    let cellImages = 0;
    let hyperlinks = 0;
    for (const sheet of Object.values(snap.sheets)) {
        for (const row of Object.values(sheet.cellData ?? {})) {
            for (const cell of Object.values(row)) {
                if (cell?.f || cell?.si) formulas++;
                const p = cell?.p;
                if (p == null) continue;
                if ((p.body?.textRuns ?? []).length > 0) richTextCells++;
                if (Object.keys(p.drawings ?? {}).length > 0) cellImages++;
                hyperlinks += (p.body?.customRanges ?? []).filter((r: { rangeType: number }) => r.rangeType === HYPERLINK).length;
            }
        }
    }
    return {
        sheets: wb.getSheets().map((ws) => {
            const w = ws as any;
            const freeze = ws.getFreeze();
            return {
                name: ws.getSheetName(),
                hidden: ws.isSheetHidden(),
                merges: ws.getMergedRanges().length,
                frozen: `${freeze.xSplit ?? 0}x${freeze.ySplit ?? 0}`,
                conditionalFormats: attempt(() => w.getConditionalFormattingRules().length),
                dataValidations: attempt(() => w.getDataValidations().length),
                filter: attempt(() => {
                    const f = w.getFilter();
                    if (f == null) return null;
                    const range = f.getRange();
                    const start = range.getRange().startColumn;
                    const end = range.getRange().endColumn;
                    let columnsWithCriteria = 0;
                    for (let c = start; c <= end; c++) if (f.getColumnFilterCriteria(c) != null) columnsWithCriteria++;
                    return { range: range.getA1Notation(), columnsWithCriteria, filteredOutRows: f.getFilteredOutRows().length };
                }),
                notes: attempt(() => w.getNotes().length),
                floatingImages: attempt(() => w.getImages().length),
            };
        }),
        definedNames: wb.getDefinedNames().length,
        formulas,
        richTextCells,
        cellImages,
        hyperlinks,
    };
}

function describeDoc(editor: EditorHandle): DocSemantics {
    const doc = editor.univerAPI.getActiveDocument()! as any;
    const snap = editor.save() as { body?: any; drawings?: Record<string, { layoutType?: number }> };
    const body = snap.body ?? {};
    const namedStyles: Record<string, number> = {};
    const lists: Record<string, number> = {};
    for (const p of body.paragraphs ?? []) {
        const style = p.paragraphStyle?.namedStyleType;
        if (style != null) namedStyles[style] = (namedStyles[style] ?? 0) + 1;
        const list = p.bullet?.listType;
        if (list != null) lists[list] = (lists[list] ?? 0) + 1;
    }
    const drawings = Object.values(snap.drawings ?? {});
    return {
        textLength: (body.dataStream ?? '').length,
        namedStyles,
        lists,
        tables: (body.tables ?? []).length,
        images: {
            inline: drawings.filter((d) => (d.layoutType ?? 0) === 0).length,
            floating: drawings.filter((d) => (d.layoutType ?? 0) !== 0).length,
            facade: attempt(() => doc.getImages().length),
        },
        hyperlinks: (body.customRanges ?? []).filter((r: { rangeType: number }) => r.rangeType === HYPERLINK).length,
    };
}
