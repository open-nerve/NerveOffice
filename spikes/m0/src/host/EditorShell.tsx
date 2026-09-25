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
import { imageEvents } from '../harness/platform-image-io';
import { docPolicyEvents } from '../harness/doc-policy';
import { installImeRecorder } from '../harness/ime-recorder';
import { installOutbox } from '../harness/outbox/index';
import type { MutationLogger } from '../harness/mutation-log';
import { clearLog, readLog, replayEntries, startMutationLogger } from '../harness/mutation-log';
import { createStyleTracker, enrichParams, preloadStyles } from '../harness/mutation-log-enrich';
import { IImageIoService } from '@univerjs/core';
import { DocSelectionManagerService } from '@univerjs/docs';
import type { ImageFunctionPolicy } from '../harness/image-function-policy';

interface EditorShellProps {
    profile: EditorProfile;
    defaultSample: string;
    /** 创建 Worker：表格为公式 Worker（P4 起经 name 传入 IMAGE() 的处理），文字文档为排版 Worker。 */
    createWorker: (options: { imageFunction: ImageFunctionPolicy }) => Worker;
    /** 样本构建器（P2），通过 window.__m0.builders 供验证脚本调用。 */
    builders?: Record<string, SampleBuilder>;
}

/** 从验证服务的文档存储读取快照；服务端当前的修订号（P6）记进 window.__m0.loadedRevision。 */
async function loadStoredDocument(id: string): Promise<Record<string, unknown>> {
    const res = await fetch(`/api/docs/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`文档不存在：${id}`);
    if (window.__m0 != null) window.__m0.loadedRevision = Number(res.headers.get('X-Revision') ?? '0');
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
        const createCountingWorker = countingWorkerFactory(() => createWorker({ imageFunction: params.imagefn }), workerStats);

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
                imageService: params.img,
                imageFunction: params.imagefn,
                docPolicy: params.docpolicy,
                outline: params.outline,
                tocBlock: params.tocblock,
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
            images: { events: imageEvents, io: () => (window.__m0!.editor!).univer.__getInjector().get(IImageIoService) },
            docPolicy: { events: docPolicyEvents },
            activeTextRange: () => {
                const r = window.__m0!.editor!.univer.__getInjector().get(DocSelectionManagerService).getActiveTextRange();
                return r == null ? null : { startOffset: r.startOffset, endOffset: r.endOffset, segmentId: r.segmentId ?? '' };
            },
        };

        // mutation 增量日志（P6，V15）：每个编辑器实例一个记录器，日志 id 带会话随机串
        let logger: MutationLogger | null = null;
        const startLogger = (editor: EditorHandle) => {
            logger?.dispose();
            const logId = `${params.doc ?? editor.unitId()}:${Math.random().toString(36).slice(2, 10)}`;
            logger = startMutationLogger(editor.univer, editor.unitId(), logId, {
                exclude: profile.changeDetectionExclude,
                enrich: params.mutlogEnrich ? (id, p) => enrichParams(editor.univer, id, p) : undefined,
                styles: params.mutlogEnrich ? createStyleTracker(editor.univer, editor.unitId()) as () => Record<string, unknown> | null : undefined,
            });
        };

        // 用给定的快照重建编辑器（P6：从发件箱恢复）
        const reopen = async (data: Record<string, unknown>): Promise<EditorHandle> => {
            window.__m0!.editor?.dispose();
            window.__m0!.editor = undefined;
            const editor = await open('edit', data, params.ro);
            window.__m0!.editor = editor;
            if (params.mutlog) startLogger(editor);
            return editor;
        };

        ready.then(
            async (editor) => {
                window.__m0!.editor = editor;
                if (params.imelog && profile.kind === 'doc') window.__m0!.imeRecorder = installImeRecorder(editor);
                setStatus('ready');
                setMessage(`steady ${Math.round(editor.timings.steady ?? -1)} ms`);
                if (params.mutlog && params.mode === 'edit') {
                    startLogger(editor);
                    window.__m0!.mutlog = {
                        logger: () => logger!,
                        read: readLog,
                        replay: async (logId, afterSeq = 0) => {
                            const entries = await readLog(logId, afterSeq);
                            const current = window.__m0!.editor!;
                            const before = (e: { styles?: Record<string, unknown> }) => preloadStyles(current.univer, current.unitId(), e.styles as never);
                            return { ...replayEntries(current.univerAPI, entries, before), entries: entries.length };
                        },
                        clear: clearLog,
                    };
                }
                // 发件箱（P6）在编辑器就绪之后安装：用例用 window.__m0.outbox 是否出现来判断装好了没有
                if (params.outbox !== 'off' && params.mode === 'edit') {
                    try {
                        window.__m0!.outbox = await installOutbox({
                            editor: () => window.__m0!.editor!,
                            reopen,
                            user: params.user,
                            docId: params.doc ?? editor.unitId(),
                            revision: window.__m0!.loadedRevision ?? 0,
                            placement: params.outbox,
                            durability: params.durability,
                            logMark: params.mutlog ? () => (logger == null ? null : { logId: logger.logId, logSeq: logger.seq() }) : undefined,
                        });
                    } catch (error) {
                        window.__m0!.outboxError = error instanceof Error ? error.message : String(error);
                    }
                }

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
