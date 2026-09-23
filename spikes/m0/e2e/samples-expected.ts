// 样本的预期语义：由样本构建器的意图写出（src/experiments/v03-samples/），生成样本与重开后都要逐项核对，
// 避免"样本本身就是 save() 的输出"导致保真测试变成自证。
const sheet = (s: Partial<{ name: string; hidden: boolean; merges: number; frozen: string; conditionalFormats: number; dataValidations: number; filter: { range: string; columnsWithCriteria: number; filteredOutRows: number } | null; notes: number; floatingImages: number }>) => ({
    name: '数据',
    hidden: false,
    merges: 0,
    frozen: '0x0',
    conditionalFormats: 0,
    dataValidations: 0,
    filter: null,
    notes: 0,
    floatingImages: 0,
    ...s,
});
const wb = (sheets: ReturnType<typeof sheet>[], extra: Partial<{ definedNames: number; formulas: number; richTextCells: number; cellImages: number; hyperlinks: number }> = {}) => ({
    sheets,
    definedNames: 0,
    formulas: 0,
    richTextCells: 0,
    cellImages: 0,
    hyperlinks: 0,
    ...extra,
});
const doc = (d: Partial<{ textLength: number; namedStyles: Record<string, number>; lists: Record<string, number>; tables: number; images: { inline: number; floating: number; facade: number }; hyperlinks: number }>) => ({
    namedStyles: {},
    lists: {},
    tables: 0,
    images: { inline: 0, floating: 0, facade: 0 },
    hyperlinks: 0,
    ...d,
});

const CORE_SHEETS = [
    sheet({ merges: 1, frozen: '1x1' }),
    sheet({ name: '汇总' }),
    sheet({ name: '隐藏', hidden: true }),
];
const HEADINGS = { 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1 }; // 标题、副标题、H1–H5（NamedStyleType 取值）
const LISTS = { BULLET_LIST: 2, ORDER_LIST: 2, CHECK_LIST: 1, CHECK_LIST_CHECKED: 1 };
const FILTER = { range: 'A1:C20', columnsWithCriteria: 1, filteredOutRows: 6 };

export const EXPECTED_SEMANTICS: Record<string, unknown> = {
    'sheet-core': wb(CORE_SHEETS, { definedNames: 1, formulas: 6, richTextCells: 1 }),
    'sheet-cf': wb([sheet({ conditionalFormats: 6 })]),
    'sheet-dv': wb([sheet({ dataValidations: 5 })]),
    'sheet-filter': wb([sheet({ filter: FILTER })]),
    'sheet-hyperlink': wb([sheet({}), sheet({ name: '目标' })], { hyperlinks: 4 }),
    'sheet-note': wb([sheet({ notes: 2 })]),
    'sheet-drawing': wb([sheet({ floatingImages: 1 })], { cellImages: 1 }),
    'sheet-protection': wb([sheet({}), sheet({ name: '整表保护' })]),
    'sheet-all': wb(
        [...CORE_SHEETS, sheet({ name: '功能', conditionalFormats: 6, dataValidations: 1, notes: 1, floatingImages: 1 }), sheet({ name: '筛选', filter: FILTER })],
        { definedNames: 1, formulas: 6, richTextCells: 1, cellImages: 1, hyperlinks: 2 },
    ),
    'doc-text': doc({ textLength: 123, namedStyles: HEADINGS }),
    'doc-list': doc({ textLength: 54, lists: LISTS }),
    'doc-hyperlink': doc({ textLength: 20, hyperlinks: 2 }),
    'doc-table': doc({ textLength: 52, tables: 1 }),
    'doc-drawing': doc({ textLength: 29, images: { inline: 1, floating: 1, facade: 2 } }),
    'doc-all': doc({ textLength: 230, namedStyles: HEADINGS, lists: LISTS, tables: 1, images: { inline: 1, floating: 1, facade: 2 }, hyperlinks: 2 }),
};

/** 各文档类型的单元类型编号（UniverInstanceType）：资源 hook 的 businesses 按它过滤。 */
export const BUSINESS = { sheet: 2, doc: 1 } as const;
