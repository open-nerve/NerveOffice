import type { EditorHandle } from '../harness/create-editor';
import type { EditorProfile } from '../profiles/types';

import { useEffect, useRef, useState } from 'react';
import { createEditor } from '../harness/create-editor';
import { pageEvents } from '../harness/events';
import { loadFixture } from '../harness/fixtures';
import { readPageParams } from '../harness/params';

interface EditorShellProps {
    profile: EditorProfile;
    defaultSample: string;
    createWorker: () => Worker;
}

type Status = 'loading' | 'ready' | 'error';

/**
 * 编辑器页面的宿主：顶部状态栏 + 编辑器容器。
 * Univer 实例的生命周期不交给 React 管理：整页只创建一次，离开页面即整页卸载（00 号计划书 §10.2）。
 */
export function EditorShell({ profile, defaultSample, createWorker }: EditorShellProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const startedRef = useRef(false);
    const [status, setStatus] = useState<Status>('loading');
    const [message, setMessage] = useState('');
    const params = readPageParams(defaultSample);

    useEffect(() => {
        const container = containerRef.current;
        if (container == null || startedRef.current) return;
        startedRef.current = true;

        const workerStats = { created: 0, messagesToWorker: 0, messagesFromWorker: 0 };
        // 包一层计数，用来证明 Worker 确实参与了计算或排版。
        const createCountingWorker = (): Worker => {
            const worker = createWorker();
            workerStats.created++;
            worker.addEventListener('message', () => workerStats.messagesFromWorker++);
            const post = worker.postMessage.bind(worker) as (...args: unknown[]) => void;
            worker.postMessage = ((...args: unknown[]) => {
                workerStats.messagesToWorker++;
                post(...args);
            }) as Worker['postMessage'];
            return worker;
        };

        const ready = (async (): Promise<EditorHandle> => {
            if (params.mode === 'read') {
                throw new Error('阅读模式在 P3 实现');
            }
            const data = await loadFixture(profile.kind, params.sample);
            return createEditor({
                profile,
                container,
                data,
                createWorker: params.worker ? createCountingWorker : undefined,
            });
        })();

        window.__m0 = { kind: profile.kind, ready, events: pageEvents, params: { ...params }, workerStats };

        ready.then(
            (editor) => {
                window.__m0!.editor = editor;
                setStatus('ready');
                setMessage(`steady ${Math.round(editor.timings.steady ?? -1)} ms`);
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
                <span>样本：{params.sample}</span>
                <span>模式：{params.mode}</span>
                <span>Worker：{params.worker ? '开' : '关'}</span>
                <span data-testid="m0-status">{status}</span>
                <span>{message}</span>
            </header>
            <div className="m0-editor" ref={containerRef} />
        </div>
    );
}
