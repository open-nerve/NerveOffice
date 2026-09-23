export type EditorMode = 'edit' | 'read';

export interface PageParams {
    sample: string;
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
        mode: q.get('mode') === 'read' ? 'read' : 'edit',
        worker: q.get('worker') === '1',
        selftest: q.get('selftest') ?? undefined,
        next: q.get('next') ?? undefined,
    };
}
