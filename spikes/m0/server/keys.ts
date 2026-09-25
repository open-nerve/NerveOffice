// 本机发件箱的密钥（P6，00 号计划书 §7.6）：密钥按用户生成，服务端保存，登录后下发给客户端；客户端只放在内存里。
// 验证服务只模拟下发与吊销：密钥在进程内按用户固定（重启服务即失效），不做鉴权，只监听 127.0.0.1。
// 生产实现由 M3 设计：服务端用主密钥加密保存，按会话鉴权下发。
import type { IncomingMessage, ServerResponse } from 'node:http';

import { randomBytes } from 'node:crypto';

interface UserKey {
    version: number;
    key: Buffer;
}

const keys = new Map<string, UserKey>();
const KEY_PATH = /^\/api\/keys\/([\w.-]+)(\/revoke)?$/;

function keyOf(user: string): UserKey {
    let k = keys.get(user);
    if (k == null) {
        k = { version: 1, key: randomBytes(32) };
        keys.set(user, k);
    }
    return k;
}

/** GET /api/keys/:user 下发密钥；POST /api/keys/:user/revoke 吊销（换新密钥，旧密钥加密的本机记录随即作废）。 */
export function handleKeys(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    const m = KEY_PATH.exec(url.pathname);
    if (m == null) return false;
    const user = m[1];
    if (m[2] != null) {
        if (req.method !== 'POST') {
            res.writeHead(405).end();
            return true;
        }
        const old = keyOf(user);
        keys.set(user, { version: old.version + 1, key: randomBytes(32) });
        res.writeHead(204).end();
        return true;
    }
    if (req.method !== 'GET') {
        res.writeHead(405).end();
        return true;
    }
    const k = keyOf(user);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ user, version: k.version, key: k.key.toString('base64') }));
    return true;
}
