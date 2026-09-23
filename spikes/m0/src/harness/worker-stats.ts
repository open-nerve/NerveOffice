// 包一层计数，记录与 Worker 往来的 RPC 消息（方法名与响应类型），用来证明 Worker 确实参与了计算或排版。
// 消息结构见 @univerjs/rpc：请求 { seq, type, channelName, method }，响应 { seq, type, data }。

const REQUEST_TYPES: Record<number, string> = { 50: 'REQUEST_INITIALIZATION', 100: 'CALL', 101: 'SUBSCRIBE', 102: 'UNSUBSCRIBE' };
const RESPONSE_TYPES: Record<number, string> = {
    0: 'INITIALIZE',
    201: 'CALL_SUCCESS',
    202: 'CALL_FAILURE',
    300: 'SUBSCRIBE_NEXT',
    301: 'SUBSCRIBE_ERROR',
    302: 'SUBSCRIBE_COMPLETE',
};

export interface WorkerStats {
    created: number;
    toWorker: Record<string, number>;
    fromWorker: Record<string, number>;
}

export function createWorkerStats(): WorkerStats {
    return { created: 0, toWorker: {}, fromWorker: {} };
}

function describe(message: unknown): string {
    if (message == null || typeof message !== 'object') return 'other';
    const m = message as { type?: number; channelName?: string; method?: string };
    if (typeof m.channelName === 'string') return `${REQUEST_TYPES[m.type ?? -1] ?? m.type} ${m.channelName}.${m.method}`;
    if (typeof m.type === 'number') return REQUEST_TYPES[m.type] ?? RESPONSE_TYPES[m.type] ?? `type ${m.type}`;
    return 'other';
}

function bump(map: Record<string, number>, key: string): void {
    map[key] = (map[key] ?? 0) + 1;
}

export function countingWorkerFactory(createWorker: () => Worker, stats: WorkerStats): () => Worker {
    return () => {
        const worker = createWorker();
        stats.created++;
        worker.addEventListener('message', (event: MessageEvent) => bump(stats.fromWorker, describe(event.data)));
        const post = worker.postMessage.bind(worker) as (...args: unknown[]) => void;
        worker.postMessage = ((...args: unknown[]) => {
            bump(stats.toWorker, describe(args[0]));
            post(...args);
        }) as Worker['postMessage'];
        return worker;
    };
}
