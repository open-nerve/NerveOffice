// 本机发件箱的加密（P6，00 号计划书 §7.6）：AES-GCM-256。
// - 密钥按用户由服务端下发（验证服务的 /api/keys/:user），导入为不可导出的 CryptoKey，只放在内存里，不写进任何存储；
// - 每条记录一个随机的 96 位 IV；
// - 附加数据（AAD）绑定用户、文档与本地序号：记录被调换或篡改时解密失败。
// 主线程与发件箱 Worker 共用（不依赖 DOM）。

export interface UserKey {
    key: CryptoKey;
    /** 密钥版本：吊销后服务端换新密钥，版本加一。 */
    version: number;
}

export interface Sealed {
    iv: Uint8Array<ArrayBuffer>;
    ciphertext: ArrayBuffer;
}

/** 从验证服务取当前用户的密钥（生产由 M3 按会话鉴权下发）。 */
export async function fetchUserKey(user: string): Promise<UserKey> {
    const res = await fetch(`/api/keys/${encodeURIComponent(user)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`取密钥失败：${res.status}`);
    const body = (await res.json()) as { key: string; version: number };
    const raw = Uint8Array.from(atob(body.key), (c) => c.charCodeAt(0));
    try {
        const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
        return { key, version: body.version };
    } finally {
        raw.fill(0);
    }
}

/** 附加数据：用户、文档与本地序号。 */
export function aadOf(userId: string, docId: string, localSeq: number): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(`${userId}\n${docId}\n${localSeq}`);
}

export async function seal(key: CryptoKey, plain: Uint8Array<ArrayBuffer>, aad: Uint8Array<ArrayBuffer>): Promise<Sealed> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plain);
    return { iv, ciphertext };
}

/** 解密；密钥不对、记录被调换或篡改时抛出（OperationError）。 */
export async function unseal(key: CryptoKey, sealed: Sealed, aad: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv, additionalData: aad }, key, sealed.ciphertext));
}

export async function gzipBytes(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzipBytes(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
