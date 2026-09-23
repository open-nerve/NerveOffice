// V03 的预期差异基线："第一次打开再保存"（S0→S1）允许出现、且已经解释过的差异。
// 回归时，实际差异必须与基线完全一致；多出任何一条都说明 SDK 行为变了（例如升级后丢了字段）。
export interface Baseline {
    /** 实际差异（空值等价已排除），格式为 "<kind> <path>"。 */
    realDiff: string[];
    /** 内容发生变化的资源名。 */
    resourcesChanged: string[];
}

const NONE: Baseline = { realDiff: [], resourcesChanged: [] };

export const V03_BASELINES: Record<string, Baseline> = {
    // 手写样本：SDK 第一次打开时补齐默认字段（报告 §2.3 第 3 条）
    'sheet/minimal': {
        realDiff: [
            'added $.appVersion',
            'added $.resources',
            'added $.sheets.sheet-1.columnData',
            'added $.sheets.sheet-1.columnHeader',
            'added $.sheets.sheet-1.defaultColumnWidth',
            'added $.sheets.sheet-1.defaultRowHeight',
            'added $.sheets.sheet-1.freeze',
            'added $.sheets.sheet-1.hidden',
            'added $.sheets.sheet-1.mergeData',
            'added $.sheets.sheet-1.rightToLeft',
            'added $.sheets.sheet-1.rowData',
            'added $.sheets.sheet-1.rowHeader',
            'added $.sheets.sheet-1.scrollLeft',
            'added $.sheets.sheet-1.scrollTop',
            'added $.sheets.sheet-1.showGridlines',
            'added $.sheets.sheet-1.tabColor',
            'added $.sheets.sheet-1.zoomRatio',
        ],
        resourcesChanged: [],
    },
    'doc/minimal': {
        realDiff: [
            'added $.body.sectionBreaks[0].sectionId',
            'added $.documentStyle.autoHyphenation',
            'added $.documentStyle.consecutiveHyphenLimit',
            'added $.documentStyle.defaultFooterId',
            'added $.documentStyle.defaultHeaderId',
            'added $.documentStyle.doNotHyphenateCaps',
            'added $.documentStyle.evenAndOddHeaders',
            'added $.documentStyle.evenPageFooterId',
            'added $.documentStyle.evenPageHeaderId',
            'added $.documentStyle.firstPageFooterId',
            'added $.documentStyle.firstPageHeaderId',
            'added $.documentStyle.marginFooter',
            'added $.documentStyle.marginHeader',
            'added $.documentStyle.renderConfig',
            'added $.documentStyle.useFirstPageHeaderFooter',
            'added $.drawings',
            'added $.drawingsOrder',
            'added $.footers',
            'added $.headers',
            'added $.noteSettings',
            'added $.notes',
            'added $.resources',
            'added $.settings',
            'added $.tableSource',
        ],
        resourcesChanged: [],
    },
    // DEF-002：浮动图片所跨的行在生成样本时因单元格图片自动变高，重开时按过时的终点锚点重算尺寸
    'sheet/sheet-drawing': {
        realDiff: ['changed $.resources[*].data.sheet-1.data.*.transform.height'],
        resourcesChanged: ['SHEET_DRAWING_PLUGIN'],
    },
};

/** 基线条目里的 * 匹配一段路径（资源下标、随机生成的图片 id），重新生成样本后基线仍然有效。 */
export function matchesBaseline(actual: string[], expected: string[]): boolean {
    if (actual.length !== expected.length) return false;
    const patterns = expected.map((e) => new RegExp(`^${e.replace(/[.[\]$]/g, '\\$&').replace(/\*/g, '[^.\\]]+')}$`));
    const used = new Set<number>();
    return actual.every((a) => {
        const i = patterns.findIndex((p, k) => !used.has(k) && p.test(a));
        if (i < 0) return false;
        used.add(i);
        return true;
    });
}

export function baselineOf(sample: string): Baseline {
    return V03_BASELINES[sample] ?? NONE;
}
