export type EditorMode = 'edit' | 'read';

export interface PageParams {
    sample: string;
    /** 从验证服务的文档存储加载（优先于 sample）。 */
    doc?: string;
    /** 去掉的插件组。 */
    without: string[];
    /** 覆盖样本的 unitId（只用于从空白样本生成新样本，此时还没有任何资源引用它）。 */
    unit?: string;
    /** 启用资源加载错误捕获（V04）。 */
    guard: boolean;
    mode: EditorMode;
    /** 阅读模式的方案（V09）：facade / points / firewall。 */
    ro: string;
    /** 公式计算模式：forced 表示打开时强制重算全部公式（V07 的基准）。 */
    calc: 'default' | 'forced';
    /** 大表操作拆分：split=0 关掉（V06）。 */
    split: boolean;
    worker: boolean;
    /** 真实 Safari 自检：场景名；完成后跳转到 next。 */
    selftest?: string;
    next?: string;
}

export function readPageParams(defaultSample: string): PageParams {
    const q = new URLSearchParams(location.search);
    return {
        sample: q.get('sample') ?? defaultSample,
        doc: q.get('doc') ?? undefined,
        without: (q.get('without') ?? '').split(',').filter((x) => x !== ''),
        unit: q.get('unit') ?? undefined,
        guard: q.get('guard') === '1',
        mode: q.get('mode') === 'read' ? 'read' : 'edit',
        ro: q.get('ro') ?? 'points',
        calc: q.get('calc') === 'forced' ? 'forced' : 'default',
        split: q.get('split') !== '0',
        worker: q.get('worker') === '1',
        selftest: q.get('selftest') ?? undefined,
        next: q.get('next') ?? undefined,
    };
}
