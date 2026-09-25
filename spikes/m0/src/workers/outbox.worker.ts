// 发件箱 Worker（P6，outbox=worker）：主线程只做 save()、序列化与编码，把字节转移过来；这里做去重哈希、gzip、加密与写入。
// 密钥以 CryptoKey 的形式经 postMessage 传入（结构化克隆，不可导出的密钥也能传），不经过原始字节。
// 序号由主线程在捕获的同步段里分配；同一份文档的写入在 OutboxWriter 里排队执行。
import type { UserKey } from '../harness/outbox/crypto';
import type { OutboxTarget, WriteOptions } from '../harness/outbox/writer';

import { openOutbox } from '../harness/outbox/store';
import { OutboxWriter } from '../harness/outbox/writer';

type Request =
    | { id: number; type: 'init'; key: UserKey }
    | { id: number; type: 'hash'; docId: string; contentHash?: string }
    | { id: number; type: 'write'; target: OutboxTarget; bytes: Uint8Array<ArrayBuffer>; options: WriteOptions };

let writer: OutboxWriter | null = null;

self.onmessage = async (e: MessageEvent<Request>) => {
    const m = e.data;
    try {
        if (m.type === 'init') {
            writer = new OutboxWriter(await openOutbox(), m.key);
            self.postMessage({ id: m.id, ok: true });
            return;
        }
        if (writer == null) throw new Error('发件箱 Worker 还没初始化');
        if (m.type === 'hash') {
            writer.setLastHash(m.docId, m.contentHash);
            self.postMessage({ id: m.id, ok: true });
            return;
        }
        const t0 = performance.now();
        const result = await writer.write(m.target, m.bytes, m.options);
        self.postMessage({ id: m.id, ok: true, result: { ...result, workerMs: performance.now() - t0 } });
    } catch (error) {
        self.postMessage({ id: m.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
};
