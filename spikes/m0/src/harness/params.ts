export type EditorMode = 'edit' | 'read';

export interface PageParams {
    sample: string;
    mode: EditorMode;
    worker: boolean;
}

export function readPageParams(defaultSample: string): PageParams {
    const q = new URLSearchParams(location.search);
    return {
        sample: q.get('sample') ?? defaultSample,
        mode: q.get('mode') === 'read' ? 'read' : 'edit',
        worker: q.get('worker') === '1',
    };
}
