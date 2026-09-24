import type { EditorHandle, SampleBuilder } from '../harness/create-editor';
import type { EditorProfile } from '../profiles/types';

import { useEffect, useRef, useState } from 'react';
import { createEditor } from '../harness/create-editor';
import { waitForCapture } from '../harness/capture-timing';
import * as content from '../harness/content-compare';
import * as perf from '../harness/perf';
import { enterReadMode, READ_STRATEGIES } from '../harness/read-mode';
import * as guard from '../harness/resource-guard';
import { auditMenus } from '../harness/menu-audit';
import { pageEvents } from '../harness/events';
import { loadFixture } from '../harness/fixtures';
import { readPageParams } from '../harness/params';
import { runSelftest } from '../harness/selftest';
import { resourceLoadFailures } from '../harness/guarded-resource-manager';
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

        const open = async (mode: 'edit' | 'read', data: Record<string, unknown>, ro: string): Promise<EditorHandle> => {
            if (mode === 'read' && !READ_STRATEGIES.includes(ro as never)) throw new Error(`没有这种阅读模式方案：${ro}`);
            window.__m0!.loadedText = JSON.stringify(data);
            const editor = await createEditor({
                profile,
                container,
                data,
                createWorker: params.worker ? createCountingWorker : undefined,
                without: params.without,
                guard: params.guard,
                ui: profile.ui[mode],
                largeSheetSplit: params.split,
                calcMode: params.calc,
                formulaIntervalCount: params.interval,
            });
            window.__m0!.readMode = mode === 'read' ? await enterReadMode(editor, ro as never) : undefined;
            return editor;
        };

        const ready = (async (): Promise<EditorHandle> => {
            const data = params.doc != null ? await loadStoredDocument(params.doc) : await loadFixture(profile.kind, params.sample);
            if (params.unit != null) data.id = params.unit;
            return open(params.mode, data, params.ro);
        })();

        // 销毁当前实例，按指定模式从文档存储重新创建（V09 的"销毁重建"）
        const remount = async (opts: { mode: 'edit' | 'read'; doc: string; ro?: string }): Promise<{ ms: number }> => {
            const t0 = performance.now();
            window.__m0!.editor?.dispose();
            window.__m0!.editor = undefined;
            const editor = await open(opts.mode, await loadStoredDocument(opts.doc), opts.ro ?? params.ro);
            window.__m0!.editor = editor;
            return { ms: performance.now() - t0 };
        };

        const persist = async (id: string): Promise<void> => {
            const editor = await ready;
            const res = await fetch(`/api/docs/${encodeURIComponent(id)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(editor.save()),
            });
            if (!res.ok) throw new Error(`写回失败：${res.status}`);
        };

        const enterRead = async (ro: string, options?: Parameters<typeof enterReadMode>[2]) => {
            const editor = await ready;
            window.__m0!.readMode = await enterReadMode(window.__m0!.editor ?? editor, ro as never, options);
            return window.__m0!.readMode;
        };
        const audit = () => auditMenus(window.__m0!.editor!.univer);

        window.__m0 = {
            kind: profile.kind, ready, events: pageEvents, params: { ...params }, workerStats, persist, remount, builders, resourceLoadFailures, perf, guard,
            enterReadMode: enterRead,
            auditMenus: audit,
            content,
            waitForCapture: async (options) => waitForCapture(window.__m0!.editor ?? await ready, options),
        };

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
                <span>模式：{params.mode}{params.mode === 'read' ? `（${params.ro}）` : ''}</span>
                <span>Worker：{params.worker ? '开' : '关'}</span>
                <span data-testid="m0-status">{status}</span>
                <span>{message}</span>
            </header>
            <div className="m0-editor" ref={containerRef} />
        </div>
    );
}
