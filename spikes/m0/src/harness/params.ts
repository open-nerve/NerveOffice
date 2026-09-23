export type EditorMode = 'edit' | 'read';

export interface PageParams {
    sample: string;
    /** 从验证服务的文档存储加载（优先于 sample）。 */
    doc?: string;
    /** 去掉的插件组。 */
    without: string[];
    /** 覆盖样本的 unitId（只用于从空白样本生成新样本，此时还没有任何资源引用它）。 */
    unit?: string;
    mode: EditorMode;
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
        mode: q.get('mode') === 'read' ? 'read' : 'edit',
        worker: q.get('worker') === '1',
        selftest: q.get('selftest') ?? undefined,
        next: q.get('next') ?? undefined,
    };
}
