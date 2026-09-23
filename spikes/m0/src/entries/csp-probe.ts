// CSP 阳性对照页面：分别在页面与 Worker 中触发一次跨源请求和动态代码执行，
// 用来确认"策略确实生效"以及"各采集渠道能否看到违规"。
import '../harness/events';

import type { ProbeResult } from '../harness/csp-probe-actions';

import { runProbes } from '../harness/csp-probe-actions';
import { pageEvents } from '../harness/events';

declare global {
    interface Window {
        __probe?: { page: ProbeResult; worker: ProbeResult | { error: string }; events: typeof pageEvents };
    }
}

const target = new URLSearchParams(location.search).get('target') ?? 'http://127.0.0.1:4701/index.html';

async function main(): Promise<void> {
    const page = await runProbes(`${target}?from=page`);
    const worker = new Worker(new URL('../workers/csp-probe.worker.ts', import.meta.url), { type: 'module' });
    const workerResult = await new Promise<ProbeResult | { error: string }>((resolve) => {
        worker.onmessage = (e: MessageEvent<ProbeResult>) => resolve(e.data);
        worker.onerror = (e) => resolve({ error: e.message || 'worker error' });
        worker.postMessage({ target: `${target}?from=worker` });
    });
    worker.terminate();
    window.__probe = { page, worker: workerResult, events: pageEvents };
    document.body.dataset.probe = 'done';

    // 真实 Safari 自检：把结果交回验证服务，再跳转到下一步
    const q = new URLSearchParams(location.search);
    if (q.get('report') != null) {
        await new Promise((r) => setTimeout(r, 1500));
        await fetch('/__selftest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: 'probe', mode: q.get('report'), target, userAgent: navigator.userAgent, timestamp: new Date().toISOString(), page, worker: workerResult, events: pageEvents }),
        });
        const next = q.get('next');
        if (next != null) location.href = next;
    }
}

void main();
