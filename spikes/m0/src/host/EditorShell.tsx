import type { EditorHandle, SampleBuilder } from '../harness/create-editor';
import type { EditorProfile } from '../profiles/types';

import { useEffect, useRef, useState } from 'react';
import { createEditor } from '../harness/create-editor';
import { pageEvents } from '../harness/events';
import { loadFixture } from '../harness/fixtures';
import { readPageParams } from '../harness/params';
import { runSelftest } from '../harness/selftest';
import { countingWorkerFactory, createWorkerStats } from '../harness/worker-stats';

interface EditorShellProps {
    profile: EditorProfile;
    defaultSample: string;
    createWorker: () => Worker;
    /** 样本构建器（P2），通过 window.__m0.builders 供验证脚本调用。 */
    builders?: Record<string, SampleBuilder>;
}

/** 从验证服务的文档存储读取快照。 */
async function loadStoredDocument(id: string): Promise<Record<string, unknown>> {
    const res = await fetch(`/api/docs/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`文档不存在：${id}`);
    return (await res.json()) as Record<string, unknown>;
}

type Status = 'loading' | 'ready' | 'error';

/**
 * 编辑器页面的宿主：顶部状态栏 + 编辑器容器。
 * Univer 实例的生命周期不交给 React 管理：整页只创建一次，离开页面即整页卸载（00 号计划书 §10.2）。
 */
export function EditorShell({ profile, defaultSample, createWorker, builders }: EditorShellProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const startedRef = useRef(false);
    const [status, setStatus] = useState<Status>('loading');
    const [message, setMessage] = useState('');
    const params = readPageParams(defaultSample);

    useEffect(() => {
        const container = containerRef.current;
        if (container == null || startedRef.current) return;
        startedRef.current = true;

        const workerStats = createWorkerStats();
        const createCountingWorker = countingWorkerFactory(createWorker, workerStats);

        const ready = (async (): Promise<EditorHandle> => {
            if (params.mode === 'read') {
                throw new Error('阅读模式在 P3 实现');
            }
            const data = params.doc != null ? await loadStoredDocument(params.doc) : await loadFixture(profile.kind, params.sample);
            if (params.unit != null) data.id = params.unit;
            return createEditor({
                profile,
                container,
                data,
                createWorker: params.worker ? createCountingWorker : undefined,
                without: params.without,
            });
        })();

        const persist = async (id: string): Promise<void> => {
            const editor = await ready;
            const res = await fetch(`/api/docs/${encodeURIComponent(id)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(editor.save()),
            });
            if (!res.ok) throw new Error(`写回失败：${res.status}`);
        };

        window.__m0 = { kind: profile.kind, ready, events: pageEvents, params: { ...params }, workerStats, persist, builders };

        ready.then(
            async (editor) => {
                window.__m0!.editor = editor;
                setStatus('ready');
                setMessage(`steady ${Math.round(editor.timings.steady ?? -1)} ms`);
                if (params.selftest != null) {
                    await runSelftest(editor, params.selftest, { events: pageEvents, workerStats });
                    if (params.next != null) location.href = params.next;
                }
            },
            (error: unknown) => {
                setStatus('error');
                setMessage(error instanceof Error ? error.message : String(error));
            },
        );
    }, []);

    return (
        <div className="m0-shell">
            <header className="m0-bar" data-status={status} data-testid="m0-bar">
                <strong>{profile.id}</strong>
                <span>{params.doc != null ? `文档：${params.doc}` : `样本：${params.sample}`}</span>
                {params.without.length > 0 && <span>去掉：{params.without.join('、')}</span>}
                <span>模式：{params.mode}</span>
                <span>Worker：{params.worker ? '开' : '关'}</span>
                <span data-testid="m0-status">{status}</span>
                <span>{message}</span>
            </header>
            <div className="m0-editor" ref={containerRef} />
        </div>
    );
}
