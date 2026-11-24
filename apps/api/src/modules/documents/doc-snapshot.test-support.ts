// 测试用的文字文档快照（M6-P1 S4）：M0 里经 SDK 保存的形状（spikes/m0/fixtures/doc 与 e2e/results/v03/s1），规则的单元测试与整条检查共用

/** M0 里经 SDK 保存的文字文档的资源；图片与链接两项的 data 可以换 */
export function savedDocResources(drawing = '{"data":{},"order":[]}', links = '{"links":[]}'): { name: string, data: string }[] {
  return [
    { name: 'DOC_OBJECT_PERMISSION_PLUGIN', data: '[]' },
    { name: 'DOC_WORD_STYLES_PLUGIN', data: '' },
    { name: 'DOC_NOTE_PLUGIN', data: '' },
    { name: 'DOC_DRAWING_PLUGIN', data: drawing },
    { name: 'DOC_HYPER_LINK_PLUGIN', data: links },
  ]
}

/**
 * 一份 SDK 保存形状的文字文档（M0 样本的 14 个顶层键）：两段正文，dataStream 是“第一段\r第二段\r\n”（段落的 startIndex 是 \r 的下标 3 与 7，
 * 文末的 \n 在 8）。overrides 改顶层，body 改正文（值为 undefined 的键等于没有）
 */
export function docSnapshot(unitId: string, overrides: Record<string, unknown> = {}, body: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: unitId,
    body: { dataStream: '第一段\r第二段\r\n', paragraphs: [{ startIndex: 3 }, { startIndex: 7 }], sectionBreaks: [], tables: [], customRanges: [], customBlocks: [], textRuns: [], ...body },
    documentStyle: { documentFlavor: 2, defaultHeaderId: '', defaultFooterId: '', evenPageHeaderId: '', firstPageHeaderId: '' },
    drawings: {},
    drawingsOrder: [],
    headers: {},
    footers: {},
    notes: {},
    noteSettings: {},
    settings: {},
    tableSource: {},
    locale: 'zhCN',
    title: '',
    resources: savedDocResources(),
    ...overrides,
  }
}
